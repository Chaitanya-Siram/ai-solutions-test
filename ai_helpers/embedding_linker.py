"""Incremental embedding-based story grouping (``similar_group_id``).

Every article gets a persisted embedding vector (``tagged_articles.embedding``) and a
``similar_group_id`` — a uuid4 shared by every telling of the same story. A newly
arrived batch is grouped in two steps:

  1. **Within the batch.** The new articles are clustered against each other by cosine
     similarity (single-link union-find over ``SIMILAR_EMBED_THRESHOLD``), so one fetch's
     several tellings of one story land in one group.
  2. **Against earlier runs.** Each cluster's representative — its earliest-published
     member — searches the project's already-grouped pool for a match within
     ``SIMILAR_GROUP_LOOKBACK_DAYS`` of its own date. If one clears the threshold the
     whole cluster adopts that group id; otherwise the cluster mints a fresh uuid4.

This replaces the old ``similar_of`` pointer, which named the group's *primary* article.
That made membership derivable only when the primary was also visible, so a session
whose window excluded the primary saw the story fragment into one row per member — and
the linker's own comparison pool, read through the same window, could not match a
newcomer against a primary outside it. A group id is intrinsic to the row: no window can
break it, and step 2 searches the whole project pool by date band rather than by window
(:func:`~db_helpers.repository.tagged_articles_db.list_group_candidates`).

Every article ends up with a group id — a story told once gets a group of one. That is
what lets a later arrival join it instead of the two of them needing to arrive together.

Strictly incremental: a row that already carries a ``similar_group_id`` is never
re-grouped, so what the review page shows stays stable between runs. There is no primary
any more, and so no primary re-election either.

Same failure contract as before: any embedding/API failure is logged and leaves the rows
ungrouped; they are retried on the next pass. Note that "processed" means *vector and
group id* — a run that stored vectors and then died before writing the groups heals
itself on the next pass without paying to embed again.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import numpy as np
from sqlalchemy.orm import Session

from configs import envs, logger
from ai_helpers.embedding_service import current_embedding_model, embed_texts, embedding_text
from db_helpers.repository.article_scope import ArticleScope
from db_helpers.repository.tagged_articles_db import (
    list_embedding_rows,
    list_group_candidates,
    patch_tagged_articles,
    store_embeddings,
)


# Rows per pairwise-clustering pass. The similarity matrix is O(n²), so this caps the
# allocation at a few hundred MB even when a first pass over an untouched window hands us
# far more rows than a normal hourly fetch would.
_GROUP_CHUNK = 2000


def _date_key(row: dict[str, Any]) -> tuple[str, int]:
    """Earliest-published first; a missing date sorts last (mirrors
    article_linker._date_key). Ties break on the row id, i.e. whichever was ingested
    first — numerically, so id 9 still sorts before id 10."""
    return (str(row.get("date") or "9999"), int(row.get("id") or 0))


def _unit(vector: list[float]) -> np.ndarray:
    v = np.asarray(vector, dtype=np.float32)
    return v / (np.linalg.norm(v) + 1e-12)


def _utc(value: Any) -> datetime | None:
    """A comparable UTC datetime, or None. The ``date`` column is timezone-aware, but a
    value that arrived naive (an older row, a direct SQL insert) is read as UTC rather
    than crashing the comparison — same rule as ``article_scope._as_utc``."""
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _embeddable(row: dict[str, Any]) -> bool:
    """Whether the row is a grouping candidate at all: a syndicated copy inherits its
    main's group instead of being matched, and a row with no text can't be embedded."""
    return not row["syndication_of"] and bool(row["title"] or row["similar_text"])


def _has_current_vector(row: dict[str, Any], tag: str) -> bool:
    return bool(row["embedding"]) and row["embedding_model"] == tag


def assign_similar_incremental(db: Session, scope: ArticleScope) -> int:
    """Embed and group the scope's not-yet-grouped articles. Returns the number of
    articles that gained a ``similar_group_id``; 0 on failure (logged, never raised)."""
    try:
        return _assign(db, scope)
    except Exception:
        logger.exception(
            f"Story grouping failed for {scope.describe()}; "
            "leaving similar_group_id blank"
        )
        return 0


def _cluster(rows: list[dict[str, Any]], threshold: float) -> list[list[dict[str, Any]]]:
    """Partition ``rows`` into story clusters by pairwise cosine similarity.

    Single-link union-find, the same shape (and the same transitivity trade-off) as
    :func:`ai_helpers.article_linker.link_syndication`: A~B and B~C put A, B and C in one
    cluster even when A and C alone wouldn't clear the threshold.
    """
    if len(rows) == 1:
        return [rows]

    matrix = np.stack([_unit(r["embedding"]) for r in rows])
    sims = matrix @ matrix.T

    parent = list(range(len(rows)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x: int, y: int) -> None:
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry

    # Upper triangle only (k=1): each pair once, never a row against itself.
    for i, j in zip(*np.nonzero(np.triu(sims >= threshold, k=1))):
        union(int(i), int(j))

    clusters: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for index, row in enumerate(rows):
        clusters[find(index)].append(row)
    return list(clusters.values())


class _GroupIndex:
    """The project's already-grouped pool rows, searchable by vector + date band.

    Read once per run over the union of every representative's band, then masked per
    representative — one database round-trip instead of one per cluster.
    """

    def __init__(self, candidates: list[dict[str, Any]], dim: int, lookback: timedelta):
        usable = [c for c in candidates if len(c["embedding"] or ()) == dim and _utc(c["date"])]
        self._groups = [c["similar_group_id"] for c in usable]
        self._matrix = (
            np.stack([_unit(c["embedding"]) for c in usable])
            if usable
            else np.empty((0, dim), dtype=np.float32)
        )
        self._stamps = np.array(
            [_utc(c["date"]).timestamp() for c in usable], dtype=np.float64
        )
        self._window = lookback.total_seconds()

    def __len__(self) -> int:
        return len(self._groups)

    def best_group(self, vector: np.ndarray, when: datetime, threshold: float) -> str:
        """The group id of the closest candidate within the date band, or ``""``."""
        if not self._groups:
            return ""
        in_band = np.abs(self._stamps - when.timestamp()) <= self._window
        if not in_band.any():
            return ""
        sims = np.where(in_band, self._matrix @ vector, -np.inf)
        best = int(np.argmax(sims))
        return self._groups[best] if float(sims[best]) >= threshold else ""


def _group_batch(
    db: Session,
    scope: ArticleScope,
    batch: list[dict[str, Any]],
    tag: str,
    threshold: float,
    lookback: timedelta,
) -> tuple[dict[str, dict[str, Any]], int]:
    """Group one batch. Returns ``({ref: patch}, joined-an-existing-group count)``."""
    # Step 2's candidate read: one query covering every representative's band, rather
    # than one per cluster. Rows in this batch can't appear in it — they have no group id
    # yet, and the read requires one.
    dim = len(batch[0]["embedding"])
    stamps = [d for d in (_utc(r["date"]) for r in batch) if d is not None]
    index = _GroupIndex([], dim, lookback)
    if stamps and lookback:
        index = _GroupIndex(
            list_group_candidates(
                db, scope.project_id, min(stamps) - lookback, max(stamps) + lookback, tag
            ),
            dim,
            lookback,
        )

    patches: dict[str, dict[str, Any]] = {}
    joined = 0
    # Earliest cluster first, so a run's log reads chronologically.
    clusters = sorted(_cluster(batch, threshold), key=lambda c: _date_key(min(c, key=_date_key)))
    for cluster in clusters:
        representative = min(cluster, key=_date_key)
        when = _utc(representative["date"])
        # Only the representative searches — one comparison decides the whole cluster. A
        # row with no parseable date has nothing to place it in time by, so it starts a
        # group rather than matching against an arbitrary band.
        group_id = (
            index.best_group(_unit(representative["embedding"]), when, threshold)
            if when is not None
            else ""
        )
        if group_id:
            joined += len(cluster)
        else:
            group_id = str(uuid4())
        for row in cluster:
            patches[row["id"]] = {"similar_group_id": group_id}
    return patches, joined


def _assign(db: Session, scope: ArticleScope) -> int:
    rows = list_embedding_rows(db, scope)
    tag = current_embedding_model()
    threshold = envs.SIMILAR_EMBED_THRESHOLD
    lookback = timedelta(days=max(envs.SIMILAR_GROUP_LOOKBACK_DAYS, 0))

    # Needs a group: everything embeddable that hasn't got one. Assignments are never
    # re-derived, so a row that already carries a group id is left exactly as it is.
    pending = [r for r in rows if not r["similar_group_id"] and _embeddable(r)]
    # Needs a vector: the pending rows, plus already-grouped rows whose vector is from
    # another provider:model. Re-embedding those keeps them usable as match candidates
    # after a model switch (their group is untouched) — without it, existing groups
    # would become unjoinable until `backfill_embeddings` had run.
    to_embed = [r for r in rows if _embeddable(r) and not _has_current_vector(r, tag)]

    if to_embed:
        vectors = embed_texts([embedding_text(r["title"], r["similar_text"]) for r in to_embed])
        store_embeddings(db, scope, {r["id"]: v for r, v in zip(to_embed, vectors)}, tag)
        for r, v in zip(to_embed, vectors):
            r["embedding"] = v
            r["embedding_model"] = tag

    # Rows the embedding pass couldn't give a usable vector to can't be grouped this run.
    groupable = [r for r in pending if _has_current_vector(r, tag)]

    # Assigned group per ref, seeded with what the scope already has so a syndicated copy
    # can follow a main that was grouped in an earlier run.
    group_of: dict[str, str] = {
        r["id"]: r["similar_group_id"] for r in rows if r["similar_group_id"]
    }
    patched = 0
    joined = 0
    # Date-ordered chunks: _cluster's pairwise matrix is O(n²) in the batch, and the
    # first pass over an untouched window (or a big catch-up fetch) can hand us thousands
    # of rows. Each chunk's patches are committed before the next one reads its
    # candidates, so a later chunk can still match an earlier chunk's story — through the
    # step-2 candidate read rather than through the pairwise matrix.
    groupable.sort(key=_date_key)
    for start in range(0, len(groupable), _GROUP_CHUNK):
        patches, chunk_joined = _group_batch(
            db, scope, groupable[start:start + _GROUP_CHUNK], tag, threshold, lookback
        )
        joined += chunk_joined
        group_of.update({ref: p["similar_group_id"] for ref, p in patches.items()})
        if patches:
            patch_tagged_articles(db, scope, patches)
            patched += len(patches)

    # A syndicated copy is never embedded, so this is the only thing that puts it in a
    # group: it takes its main's, whichever run grouped that main. Runs even when nothing
    # was grouped above — an article the review page has just demoted to a copy has to
    # join its main's group, and by then that main was grouped in an earlier run.
    copies = {}
    for row in rows:
        group_id = group_of.get(row["syndication_of"], "") if row["syndication_of"] else ""
        if group_id and row["similar_group_id"] != group_id:
            copies[row["id"]] = {"similar_group_id": group_id}
    if copies:
        patch_tagged_articles(db, scope, copies)
        patched += len(copies)

    if patched or to_embed:
        logger.info(
            f"Story grouping for {scope.describe()}: {len(to_embed)} article(s) embedded, "
            f"{len(groupable)} grouped ({joined} joined a group from an earlier run), "
            f"{len(copies)} syndicated copy(ies) inherited their main's group"
        )
    return patched

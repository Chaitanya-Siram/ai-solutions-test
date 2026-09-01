"""Link syndicated copies of an article after tagging.

Adds a ``syndication_of`` pointer to each tagged article that is a republished
copy — same title, different source — referencing the EARLIEST-published article
in the group (the canonical "main" article). Detected lexically (normalized title
equality / prefix / high ratio). Deterministic, no LLM.

The pointer names the other article by whatever ``id`` the articles in hand carry: a
run-local ``A{n}`` label pre-storage (which ``tagged_articles_db`` then resolves to a row
id), or a stored article's id when re-linking an already-persisted set. Run AFTER
reorder_by_confidence, so a pre-storage pass points at that step's final labels.

Grouping the *retellings* of a story (same story, different wording) used to be done here
too, by an LLM clustering pass that wrote a ``similar_of`` pointer at each group's primary
article. It is now a ``similar_group_id`` uuid assigned incrementally from persisted
embeddings — see :mod:`ai_helpers.embedding_linker`.
"""
from __future__ import annotations

import re
from collections import defaultdict
from difflib import SequenceMatcher
from typing import Any

from configs import logger


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _normalize(title: Any) -> str:
    """Lowercase, drop punctuation, collapse whitespace — a comparable title key."""
    t = str(title or "").lower()
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _date_key(article: dict) -> tuple[str, str]:
    """Sort key making the earliest-published article first. ISO dates sort
    lexically; a missing date sorts last so it never wrongly becomes the main."""
    return (str(article.get("date") or "9999"), str(article.get("id") or ""))


def _earliest(members: list[dict]) -> dict:
    return sorted(members, key=_date_key)[0]


def _prepare(articles: list[dict], reset: tuple[str, ...] = ()) -> list[dict]:
    """The linkable subset of `articles`, with the pointer field initialised.

    ``setdefault`` rather than assignment: an article that already carries a pointer
    from an earlier pass keeps it.

    `reset` names the fields to blank first, which a re-link over an already-linked set
    needs. A linker only ever *writes* the pointers it finds — it never clears one — so
    without this an article that stopped being a copy would keep the pointer an earlier
    run gave it, and a former cluster primary demoted by a newly-arrived earlier article
    would end up both owning copies and pointing at someone else.
    """
    items = [a for a in articles if isinstance(a, dict) and a.get("id")]
    for a in items:
        for field in reset:
            a[field] = ""
        a.setdefault("syndication_of", "")
    return items


# ---------------------------------------------------------------------------
# Syndication — lexical (same title, different source)
# ---------------------------------------------------------------------------

def _syndication_match(a: str, b: str) -> bool:
    """True when two normalized titles are effectively the same headline. Handles
    aggregator suffixes (one title is a prefix of the other) and minor edits."""
    if not a or not b:
        return False
    if a == b:
        return True
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    # e.g. "… asco 2026" is a prefix of "… asco 2026 business timesargus com".
    if longer.startswith(shorter) and len(shorter) >= 0.6 * len(longer):
        return True
    return SequenceMatcher(None, a, b).ratio() >= 0.95


def link_syndication(articles: list[dict], reset: bool = False) -> list[dict]:
    """Annotate articles in place with ``syndication_of`` and return them.

    Clusters near-identical titles (union-find) and points every copy at the earliest
    article in its cluster. Deterministic and free — no LLM call — so it is safe to
    run on its own. Story grouping is a separate, embedding-based pass
    (:mod:`ai_helpers.embedding_linker`) and is not touched here.

    `reset` discards the ``syndication_of`` pointers the articles already carry, for a
    re-link over a set a previous run linked (see :func:`_prepare`).
    """
    items = _prepare(articles, reset=("syndication_of",) if reset else ())
    ids = [a["id"] for a in items]
    norms = {a["id"]: _normalize(a.get("title")) for a in items}
    by_id = {a["id"]: a for a in items}

    parent = {i: i for i in ids}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x: str, y: str) -> None:
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry

    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            if _syndication_match(norms[ids[i]], norms[ids[j]]):
                union(ids[i], ids[j])

    clusters: dict[str, list[str]] = defaultdict(list)
    for i in ids:
        clusters[find(i)].append(i)

    copies: set[str] = set()
    for member_ids in clusters.values():
        if len(member_ids) < 2:
            continue
        members = [by_id[i] for i in member_ids]
        primary = _earliest(members)
        for m in members:
            if m["id"] != primary["id"]:
                m["syndication_of"] = primary["id"]
                copies.add(m["id"])
    logger.info(f"Syndication linking: {len(copies)} copy(ies) across {len(items)} article(s)")
    return articles

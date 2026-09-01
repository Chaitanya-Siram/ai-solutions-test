"""Persistence for tagged articles.

The tagged stage used to be a single JSON file per session on S3, which every
mutation (approve, edit, add, delete, promote/demote, move-section) had to
download, rewrite in full, and upload again. It is now one row per article in
``tagged_articles``, so each of those endpoints updates only the rows it touches
— which also removes the lost-update race the whole-file rewrite had.

Every function here is keyed by an
:class:`~db_helpers.repository.article_scope.ArticleScope` rather than a bare
session id, because a row belongs either to one session (an upload, a merge) or to
the project pool the hourly scheduler tags into. Callers resolve the scope once —
:func:`~db_helpers.repository.article_scope.scope_for_session` — and pass it down,
so no request can end up addressing only half the store.

Callers still get the canonical article dict — exactly the shape the review UI and
the chart builders consume, so every endpoint's response is unchanged — but ``data``
is no longer the whole of it. ``title``, ``content`` and ``similar_group_id`` live only
in their own columns and are stripped from the JSONB (:data:`_COLUMN_BACKED_FIELDS`) —
for the two text fields because a second copy of the largest values on the row doubled
the storage for no gain, and for the group id because it is written by the similarity
linker rather than by the pipeline. Every read puts them back (:func:`_hydrate_row`).
The rest of the promoted columns are a denormalized copy kept in sync by
:func:`_apply_hot_columns`.

An article's ``id`` is its row's primary key, as a string. It used to be a per-scope
``A{n}`` ref in an ``article_ref`` column, which meant every write path had to renumber a
run's refs to continue the scope's sequence and then re-resolve the relation pointers those
refs named. The pipeline still labels articles ``A1..An`` while it works — ``clean_articles``
assigns them and ``link_syndication`` points at them — but those labels are in-memory only
and are never stored: the insert paths resolve them to row ids once the rows exist
(:func:`_resolve_run_relations`) and drop them.

Three consequences worth knowing before touching this module:
  * Always write through :func:`_apply_hot_columns`, never by setting ``row.data``
    directly, or the columns and the JSONB drift apart.
  * Never treat a raw ``row.data`` as an article — it has no id, title or body. Read it
    through :func:`_hydrate_row`.
  * Every read whose result is hydrated must select ``id``, ``title``,
    ``similar_group_id``, ``syndication_of`` and the two approval lists; they live only
    in their columns.
  * An article dict's ``is_approved`` / ``is_approved_for_monitoring`` are true *for one
    session*, not for the article. Hydrate with the session doing the reading
    (:func:`_viewer_of`) and write them only through :func:`set_approval`.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any, NamedTuple

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from configs import envs, logger
from db_helpers.models.tagged_article_model import TaggedArticleModel
from db_helpers.repository.article_scope import ArticleScope
from db_helpers.repository.sessions_db import get_session_project_id
from file_helpers.cleaing_data import json_safe, to_datetime
from file_helpers.merge_helper import article_id_for_url

_INSERT_CHUNK = 500


def _as_int(value: Any) -> int | None:
    """Best-effort int for the promoted ``reach`` column (it arrives from the reach
    lookup as an int, a float, a digit string, or None)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _as_row_id(value: Any) -> int | None:
    """A row id from a caller-supplied article id, or None.

    Anything that isn't a plain integer reads as "not a row id": an empty value, a stale
    client id, or a run-local ``A{n}`` label the insert paths haven't resolved yet. Those
    resolve in a second pass (:func:`_resolve_run_relations`) once the rows exist.
    """
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _row_ids(ids: list[str]) -> list[int]:
    """The given article ids as row ids, dropping any that aren't. A client sending a
    stale or malformed id gets "no such article" rather than an error."""
    return [rid for rid in (_as_row_id(i) for i in ids) if rid is not None]


# Fields held in a column and therefore NOT kept inside `data`. `title` and `content`
# are the two biggest text fields on a row, so a JSONB copy of them was pure duplicated
# storage. `article_text` — the cleaned body some uploads carry — folds into `content`:
# it is the same text under another name, and every reader already falls back between
# the two. Stripped on write by `_apply_hot_columns`, put back on read by `_hydrate`.
# `embedding` / `embedding_model` are column-only and never hydrated back: a
# 1,500-float vector inside every article dict would bloat each read for a value only
# the similarity linker uses. They are written solely by :func:`store_embeddings` —
# `_apply_hot_columns` leaves the columns untouched, so review-page patches can never
# wipe a stored vector.
_COLUMN_BACKED_FIELDS = (
    "id",
    "title",
    "content",
    "article_text",
    "syndication_of",
    "similar_group_id",
    "embedding",
    "embedding_model",
    "is_approved",
    "is_approved_for_monitoring",
)


def _viewer_of(scope: ArticleScope) -> int | None:
    """The session an approval read or write is about — the one doing the looking.

    A window session views the pool (``view_session_id``); an upload or a merge owns its
    rows (``session_id``). A scope with neither is a whole-pool pass with no viewpoint —
    the relinker and the embedder — and approval means nothing to it.
    """
    return scope.view_session_id if scope.is_pool else scope.session_id


def _session_ids(value: Any) -> list[int]:
    """The session ids in an approval list. Tolerates the JSON ``null`` some rows hold
    in place of an empty list."""
    if not isinstance(value, list):
        return []
    return [v for v in value if isinstance(v, int) and not isinstance(v, bool)]


def _hydrate(
    data: dict[str, Any] | None,
    row_id: int | None,
    title: str | None,
    content: str | None = None,
    *,
    with_body: bool = True,
    syndication_of: int | None = None,
    similar_group_id: str | None = None,
    dashboard_approvals: Any = None,
    monitoring_approvals: Any = None,
    for_session: int | None = None,
) -> dict[str, Any]:
    """``data`` with the column-backed fields put back — the canonical article dict.

    An empty column comes back as ``""``, not None: callers concatenate these straight
    into strings, and before the split a missing key already read as ``""``. With
    ``with_body=False`` the body is left out entirely (the caller didn't select it), so
    the key is absent rather than misleadingly empty.

    ``id`` is the row's primary key as a string — the identity every endpoint and the
    review UI address articles by. It, ``syndication_of`` and ``similar_group_id`` are
    passed separately for the same reason ``title`` is: they live only in their columns,
    so a read that forgets to select one hands back an article that looks unidentified,
    unlinked or ungrouped.

    The two approval flags are membership tests over the row's session lists, resolved
    for ``for_session`` — the same article reads as approved through one window session
    and not through another. A read with no session behind it (a whole-pool pass) has no
    one to ask, so both come back False.
    """
    article = dict(data or {})
    article["id"] = "" if row_id is None else str(row_id)
    article["title"] = title or ""
    article["syndication_of"] = str(syndication_of) if syndication_of else ""
    article["similar_group_id"] = similar_group_id or ""
    article["is_approved"] = for_session in _session_ids(dashboard_approvals)
    article["is_approved_for_monitoring"] = for_session in _session_ids(monitoring_approvals)
    if with_body:
        article["content"] = content or ""
    return article


def _hydrate_row(
    row: TaggedArticleModel, *, with_body: bool = True, for_session: int | None = None
) -> dict[str, Any]:
    """The canonical article dict for a fully-loaded row, as ``for_session`` sees it."""
    return _hydrate(
        row.data,
        row.id,
        row.title,
        row.content,
        with_body=with_body,
        syndication_of=row.syndication_of,
        similar_group_id=row.similar_group_id,
        dashboard_approvals=row.dashboard_approvals,
        monitoring_approvals=row.monitoring_approvals,
        for_session=for_session,
    )


def _apply_hot_columns(row: TaggedArticleModel, data: dict[str, Any]) -> None:
    """Split a whole article dict across ``row``'s columns and its ``data``.

    The single writer for a tagged row, so the columns can never drift from the
    JSONB. ``data`` is assigned (not mutated) because SQLAlchemy doesn't track
    in-place changes to a plain JSONB dict, and sanitized first — NaN reaches here
    from empty spreadsheet cells and JSONB refuses it.

    The column-backed fields are read off the dict into their columns and then dropped,
    so what lands in ``data`` is only the remainder. Callers must therefore read the
    stored article back with :func:`_hydrate_row`, never off ``row.data``.
    """
    data = json_safe(data)
    row.article_id = article_id_for_url(data.get("url"))
    row.title = _as_str(data.get("title"))
    row.content = _as_str(data.get("content") or data.get("article_text"))
    if data.get("is_subscription") is None:
        data["is_subscription"] = (row.content or "").strip() == "Subscription"
    row.url = _as_str(data.get("url"))
    row.date = to_datetime(data.get("date"))
    row.sentiment = _as_str(data.get("sentiment"))
    row.theme = _as_str(data.get("theme"))
    row.section = _as_str(data.get("section"))
    row.reach = _as_int(data.get("reach"))
    row.priority_watch = bool(data.get("priority_watch"))
    # An article is relevant unless the gate explicitly said otherwise.
    row.is_relevant = data.get("is_relevant", True) is not False

    if data.get("onedrive_file_id") is not None:
        row.onedrive_file_id = _as_row_id(data.get("onedrive_file_id"))
    # Approval is deliberately not written here: it belongs to a (session, article) pair
    # and this function has no idea which session is writing. `set_approval` owns it.
    # Only overwritten when the caller actually carries the field: a patch that never
    # mentions the group must not un-group the article. `_hydrate` always supplies it
    # (as "" when unset), so a genuine clear still comes through.
    if "similar_group_id" in data:
        row.similar_group_id = _as_str(data.get("similar_group_id"))
    # A relation the caller names by row id resolves here. One named by a run-local `A{n}`
    # label doesn't (it isn't a row id) and is left for _resolve_run_relations.
    if "syndication_of" in data:
        row.syndication_of = _as_row_id(data.get("syndication_of"))
    row.data = {k: v for k, v in data.items() if k not in _COLUMN_BACKED_FIELDS}


def _new_row(
    session_id: int | None,
    project_id: int,
    data: dict[str, Any],
    for_session: int | None = None,
) -> TaggedArticleModel:
    """A new row for ``data``. Approvals the article arrives already carrying — a merge
    reuses a source session's review work (``agents.tagging_agent.tag_reuse``) — are seeded for
    ``for_session``, the only session that can be meant by them here. A monitoring
    approval carries the dashboards one with it, as it does on the approve endpoint."""
    row = TaggedArticleModel(session_id=session_id, project_id=project_id, sessions_id=[])
    if for_session is not None:
        monitoring = bool(data.get("is_approved_for_monitoring"))
        row.dashboard_approvals = [for_session] if (data.get("is_approved") or monitoring) else []
        row.monitoring_approvals = [for_session] if monitoring else []
    _apply_hot_columns(row, data)
    return row


def _scope_criteria(scope: ArticleScope) -> tuple:
    """SQL criteria selecting the rows that *belong to* `scope`.

    Ownership only — the window a pool scope reads through is applied on top of this
    by :func:`_read_criteria`, so a write can never be narrowed by a date filter.
    """
    if scope.is_pool:
        return (
            TaggedArticleModel.project_id == scope.project_id,
            TaggedArticleModel.session_id.is_(None),
        )
    return (TaggedArticleModel.session_id == scope.session_id,)


def _read_criteria(scope: ArticleScope) -> tuple:
    """Criteria for *reading* `scope` — ownership plus, for a pool scope with a
    window, the articles that window shows.

    An article is in the window when its ``date`` falls inside it, or when this
    session has already been stamped onto the row: an article added or promoted from
    the review page keeps showing up even if its date sits outside the bounds, which
    is what the person who added it expects. A row with no parseable date is left out
    — there is nothing to place it in time by.
    """
    criteria = _scope_criteria(scope)
    if not scope.is_pool or scope.window is None:
        return criteria
    start, end = scope.window
    in_window = TaggedArticleModel.date.between(start, end)
    if scope.view_session_id is None:
        return criteria + (in_window,)
    return criteria + (
        or_(in_window, TaggedArticleModel.sessions_id.contains([scope.view_session_id])),
    )


def _project_id_of(db: Session, scope: ArticleScope) -> int:
    """The project the scope's rows are stamped with."""
    if scope.is_pool:
        return scope.project_id
    project_id = get_session_project_id(db, scope.session_id)
    if project_id is None:
        raise ValueError(
            f"Session {scope.session_id} does not exist; cannot store tagged articles for it."
        )
    return project_id


def _owner_session_id(scope: ArticleScope) -> int | None:
    """What goes in the row's ``session_id`` — NULL for the pool."""
    return None if scope.is_pool else scope.session_id


# Relation fields — columns holding the row id of another article. The pipeline names the
# other end by its run-local `A{n}` label, which `_resolve_run_relations` turns into an id
# once the rows exist. Story membership used to be one of these (`similar_of`, a pointer at
# the group's primary); it is now the intrinsic `similar_group_id` column instead, which
# names no article and so needs no resolution.
_RELATION_FIELDS = ("syndication_of",)


class _PendingRow(NamedTuple):
    """A row being inserted, beside the source article it came from and the run-local
    ``A{n}`` label that article carried. The label and the source dict are only needed
    until :func:`_resolve_run_relations` has turned the run's pointers into row ids."""

    local_id: str
    article: dict[str, Any]
    row: TaggedArticleModel


def _local_id_of(article: dict[str, Any], fallback_index: int) -> str:
    """The article's run-local label — its ``id`` (``A{n}``) as assigned by
    ``clean_articles``. Falls back to a positional label so a record that somehow lost its
    id still has a unique, non-null one for the relation map below to key on. Never
    stored: the row's own primary key is its identity."""
    local = str(article.get("id") or "").strip()
    return local or f"A{fallback_index}"


def _resolve_run_relations(rows: list["_PendingRow"]) -> int:
    """Point each row's relation columns at row ids. Returns how many rows have one.

    Must run after a flush, since the pipeline assigns its ``A{n}`` labels long before any
    row has an id. The pointers are read off the *source* article rather than off
    ``row.data``, because ``_apply_hot_columns`` has already stripped them from the JSONB
    (they are column-backed) — reading the stored dict here would find nothing.

    A pointer naming nothing in this run is cleared rather than left to resolve elsewhere:
    a bare ``A5`` would otherwise silently address whichever article happens to hold that
    label in some other run. A pointer that already named a real row id was resolved by
    ``_apply_hot_columns`` and is left alone.
    """
    local_to_id = {pending.local_id: pending.row.id for pending in rows}
    linked = 0
    for pending in rows:
        for field in _RELATION_FIELDS:
            if getattr(pending.row, field) is not None:
                continue  # already a row id; nothing to map
            pointer = str(pending.article.get(field) or "").strip()
            if pointer:
                setattr(pending.row, field, local_to_id.get(pointer))
        if any(getattr(pending.row, field) for field in _RELATION_FIELDS):
            linked += 1
    return linked


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------
def replace_tagged_articles(
    db: Session, scope: ArticleScope, articles: list[dict[str, Any]]
) -> int:
    """Make ``articles`` the scope's tagged set, replacing whatever was there.

    Called at the end of a whole-dataset tagging run with the full result (tagged +
    reused + syndicated copies + the blank-tagged irrelevant articles). Returns the
    number of rows inserted.

    Not for the pool: replacing a project's whole pool would throw away every earlier
    hour's work. The incremental :func:`append_tagged_run` is the pool's write path.
    """
    clean = [a for a in articles if isinstance(a, dict)]
    project_id = _project_id_of(db, scope)
    owner = _owner_session_id(scope)
    viewer = _viewer_of(scope)

    db.query(TaggedArticleModel).filter(*_scope_criteria(scope)).delete(synchronize_session=False)

    # De-dup on the run-local label: it keys the relation map below, so two records
    # carrying the same one would make a pointer at it ambiguous.
    seen: set[str] = set()
    pending: list[_PendingRow] = []
    for i, article in enumerate(clean, start=1):
        local = _local_id_of(article, i)
        if local in seen:
            logger.warning(f"Duplicate article id '{local}' in {scope.describe()}; keeping the first.")
            continue
        seen.add(local)
        pending.append(
            _PendingRow(local, article, _new_row(owner, project_id, article, for_session=viewer))
        )

    rows = [p.row for p in pending]
    for start in range(0, len(rows), _INSERT_CHUNK):
        db.add_all(rows[start:start + _INSERT_CHUNK])
        db.flush()

    # Second pass: now that every row has an id, resolve the run's relation pointers.
    linked = _resolve_run_relations(pending)

    db.commit()
    logger.info(
        f"Stored {len(rows)} tagged article(s) for {scope.describe()} ({linked} with relations)"
    )
    return len(rows)


def patch_tagged_articles(
    db: Session, scope: ArticleScope, patches: dict[str, dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    """Merge a per-article patch into each given article, in one round-trip.

    ``patches`` maps ``article id -> {field: new value}``; each patch is layered
    over the stored dict (so unmentioned fields are untouched) and the promoted
    columns are re-derived. Ids with no matching row are skipped.

    A patch may re-point a relation (the review page can re-parent a syndicated copy) —
    it names the new parent by *its* article id, which ``_apply_hot_columns`` resolves
    straight to the column. No lookup pass is needed the way it was when the pointer was
    an ``A{n}`` ref.

    On a pool scope this writes the one shared row, so an edit made from one window
    session's review page is what every other overlapping window reads. The two approval
    flags are the exception and are ignored here — they are per-session, and
    :func:`set_approval` is the only thing that writes them.

    Returns ``{article id: updated article dict}`` for the rows that changed —
    the endpoints hand these straight back to the client.
    """
    wanted = _row_ids(list(patches))
    if not wanted:
        return {}

    rows = (
        db.query(TaggedArticleModel)
        .filter(*_scope_criteria(scope), TaggedArticleModel.id.in_(wanted))
        .all()
    )

    viewer = _viewer_of(scope)
    updated: dict[str, dict[str, Any]] = {}
    for row in rows:
        patch = patches.get(str(row.id))
        if not patch:
            continue
        _apply_hot_columns(row, {**_hydrate_row(row, for_session=viewer), **patch})
        updated[str(row.id)] = _hydrate_row(row, for_session=viewer)

    if updated:
        db.commit()
    return updated


def set_approval(
    db: Session,
    scope: ArticleScope,
    ids: list[str],
    for_monitoring: bool,
    approved: bool,
) -> list[str]:
    """Approve or un-approve the given articles for the session doing the asking.

    The one writer for the two approval lists. A pool row is shared by every window
    session its dates fall into, so approving it here adds only this session to the list
    — the other windows keep whatever they decided, and a report built from one is
    unaffected by a review done in another.

    Addressed within the scope's whole set rather than through the window, for the same
    reason :func:`get_tagged_articles` is: the page can only send ids it was given.

    Args:
        db: Database session.
        scope: The scope whose session is approving.
        ids: Article ids to change.
        for_monitoring: Target the Media Monitoring list rather than the dashboards one.
        approved: True to approve, False to withdraw.

    Returns:
        The ids that matched a row, changed or already in that state.
    """
    session_id = _viewer_of(scope)
    if session_id is None:
        raise ValueError(f"{scope.describe()} has no session, so it cannot approve articles.")

    wanted = _row_ids(ids)
    if not wanted:
        return []

    field = "monitoring_approvals" if for_monitoring else "dashboard_approvals"
    rows = (
        db.query(TaggedArticleModel)
        .filter(*_scope_criteria(scope), TaggedArticleModel.id.in_(wanted))
        .all()
    )

    changed = 0
    for row in rows:
        current = _session_ids(getattr(row, field))
        if approved and session_id not in current:
            # Assigned, not appended in place: SQLAlchemy doesn't track mutation of a
            # plain JSONB list.
            setattr(row, field, current + [session_id])
            changed += 1
        elif not approved and session_id in current:
            setattr(row, field, [s for s in current if s != session_id])
            changed += 1

    if changed:
        db.commit()
    logger.info(
        f"{field}={approved} for session_id={session_id} on {changed} of "
        f"{len(rows)} article(s) in {scope.describe()}"
    )
    return [str(row.id) for row in rows]


def clear_approvals(db: Session, scope: ArticleScope, ids: list[str]) -> None:
    """Withdraw both approvals for the asking session — an article it just demoted to
    irrelevant can't stay in its dashboards or its report."""
    if _viewer_of(scope) is None:
        return
    set_approval(db, scope, ids, for_monitoring=False, approved=False)
    set_approval(db, scope, ids, for_monitoring=True, approved=False)


def reset_all_approvals(db: Session, scope: ArticleScope, ids: list[str]) -> int:
    """Drop every session's approval of the given articles. Returns the rows changed.

    For a maintenance pass that changed an article enough that no earlier review of it
    still stands — the url re-decode, say — so every session has to look again. Distinct
    from :func:`set_approval`, which only ever speaks for one session, and usable from a
    scope that has no session at all.
    """
    wanted = _row_ids(ids)
    if not wanted:
        return 0
    changed = (
        db.query(TaggedArticleModel)
        .filter(*_scope_criteria(scope), TaggedArticleModel.id.in_(wanted))
        .update(
            {"dashboard_approvals": [], "monitoring_approvals": []},
            synchronize_session=False,
        )
    )
    db.commit()
    logger.info(f"Reset every approval on {changed} article(s) in {scope.describe()}")
    return int(changed or 0)


def append_tagged_articles(
    db: Session, scope: ArticleScope, articles: list[dict[str, Any]], view_session_id: int | None = None
) -> list[dict[str, Any]]:
    """Append manually-added articles, each identified by its new row's primary key.

    ``view_session_id`` stamps the new pool rows as belonging to the window session they
    were added from, so they show there even if their date falls outside its bounds.
    Returns the created article dicts — hydrated after the flush, so each one carries the
    id the client needs to address it by.
    """
    project_id = _project_id_of(db, scope)
    owner = _owner_session_id(scope)
    viewer = view_session_id or _viewer_of(scope)
    rows: list[TaggedArticleModel] = []
    for article in articles:
        if not isinstance(article, dict):
            continue
        row = _new_row(owner, project_id, article, for_session=viewer)
        if view_session_id is not None:
            row.sessions_id = [view_session_id]
        rows.append(row)

    if not rows:
        return []

    db.add_all(rows)
    db.flush()  # assigns the ids the hydrated dicts below report back
    db.commit()
    logger.info(f"Appended {len(rows)} tagged article(s) to {scope.describe()}")
    return [_hydrate_row(row, for_session=viewer) for row in rows]


def append_tagged_run(
    db: Session, scope: ArticleScope, articles: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Append a whole tagging run's output to what the scope already has tagged.

    :func:`replace_tagged_articles` owns its set outright, which is right for a run
    over a whole uploaded dataset; an hourly run instead tags only the articles
    fetched since the last one, so its output has to land beside the earlier hours'
    rows.

    The run labelled its articles ``A1..An`` in isolation. Nothing has to be renumbered
    for them to coexist with the earlier hours' rows — each row's identity is its own
    primary key — so the labels are simply resolved to ids and dropped
    (:func:`_resolve_run_relations`). ``similar_group_id`` needs no resolution either: it
    is a uuid that names no article, and the linker assigns it after the append.

    Returns the created article dicts, as stored.
    """
    # De-dup on the run-local label: it keys the relation map, so two records carrying the
    # same one would make a pointer at it ambiguous. (A run legitimately emits two records
    # with the same URL — a syndicated copy carries its own — so URL is not the key here.)
    seen: set[str] = set()
    clean: list[tuple[str, dict[str, Any]]] = []
    for i, article in enumerate(articles, start=1):
        if not isinstance(article, dict):
            continue
        local = _local_id_of(article, i)
        if local in seen:
            logger.warning(f"Duplicate article id '{local}' in {scope.describe()}; keeping the first.")
            continue
        seen.add(local)
        clean.append((local, article))
    if not clean:
        return []

    project_id = _project_id_of(db, scope)
    owner = _owner_session_id(scope)
    viewer = _viewer_of(scope)
    pending = [
        _PendingRow(local, article, _new_row(owner, project_id, article, for_session=viewer))
        for local, article in clean
    ]

    rows = [p.row for p in pending]
    for start in range(0, len(rows), _INSERT_CHUNK):
        db.add_all(rows[start:start + _INSERT_CHUNK])
        db.flush()

    linked = _resolve_run_relations(pending)

    db.commit()
    logger.info(
        f"Appended {len(rows)} tagged article(s) to {scope.describe()} "
        f"({linked} with relations)"
    )
    # Hydrated after the flush, so each dict carries the id it was actually stored under.
    return [_hydrate_row(row, for_session=viewer) for row in rows]


def delete_tagged_article(db: Session, scope: ArticleScope, article_id: str) -> bool:
    """Delete one article by id. Returns True when a row was removed.

    Any relation pointing at the deleted row is cleared first — there is no FK to do
    it, and a column left pointing at a gone row would read as a live relation.
    """
    row_id = _as_row_id(article_id)
    if row_id is None:
        return False
    row = (
        db.query(TaggedArticleModel)
        .filter(*_scope_criteria(scope), TaggedArticleModel.id == row_id)
        .first()
    )
    if row is None:
        return False

    for field in _RELATION_FIELDS:
        db.query(TaggedArticleModel).filter(
            *_scope_criteria(scope),
            getattr(TaggedArticleModel, field) == row.id,
        ).update({field: None}, synchronize_session=False)

    db.delete(row)
    db.commit()
    return True


def delete_tagged_articles_for_session(db: Session, session_id: int) -> int:
    """Drop the whole tagged set a session owns (a re-tag replaces it wholesale).

    Session-owned rows only, by id — a window session owns none, and deleting the
    project pool is never what a caller means.
    """
    deleted = (
        db.query(TaggedArticleModel)
        .filter(TaggedArticleModel.session_id == session_id)
        .delete(synchronize_session=False)
    )
    db.commit()
    return int(deleted or 0)


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------
def list_tagged_articles(
    db: Session, scope: ArticleScope, relevant_only: bool = False, include_body: bool = True
) -> list[dict[str, Any]]:
    """The scope's tagged articles as plain dicts, oldest row first.

    For a window scope this is the project pool narrowed to the window (see
    :func:`_read_criteria`) — the read the review table, the dashboards and the
    report agent all go through, so they always agree on what the session contains.

    ``relevant_only=True`` drops the articles the relevancy gate rejected — they
    live here (with blank tags) purely so the review UI can list and later promote
    them, and every chart excludes them.

    ``include_body=False`` leaves ``content`` out of both the SELECT and the returned
    dicts. It is the heaviest field on a row by an order of magnitude, and the review
    table doesn't render it (it shows ``is_subscription`` instead) — now that the body
    is a column of its own, that read can skip it in the database rather than fetching
    and discarding it. Anything that classifies or summarizes text needs the default.
    """
    columns = [
        TaggedArticleModel.id,
        TaggedArticleModel.data,
        TaggedArticleModel.title,
        TaggedArticleModel.syndication_of,
        TaggedArticleModel.similar_group_id,
        TaggedArticleModel.dashboard_approvals,
        TaggedArticleModel.monitoring_approvals,
    ]
    if include_body:
        columns.append(TaggedArticleModel.content)
    query = db.query(*columns).filter(*_read_criteria(scope))
    if relevant_only:
        query = query.filter(TaggedArticleModel.is_relevant.is_(True))
    rows = query.order_by(TaggedArticleModel.id).all()
    viewer = _viewer_of(scope)
    return [
        _hydrate(
            row.data,
            row.id,
            row.title,
            getattr(row, "content", None),
            with_body=include_body,
            syndication_of=row.syndication_of,
            similar_group_id=row.similar_group_id,
            dashboard_approvals=row.dashboard_approvals,
            monitoring_approvals=row.monitoring_approvals,
            for_session=viewer,
        )
        for row in rows
        if isinstance(row.data, dict)
    ]


def stamp_view_session(db: Session, scope: ArticleScope) -> int:
    """Record the viewing session on every pool article its window shows.

    Called when a window session's review page reads its articles, so each pool row
    carries the list of sessions it has appeared in. Only rows that don't already
    name the session are written. No-op for a session that owns its articles (they
    are already tied to it by ``session_id``). Returns the number of rows stamped.
    """
    if not scope.is_pool or scope.view_session_id is None:
        return 0

    rows = (
        db.query(TaggedArticleModel)
        .filter(
            *_read_criteria(scope),
            ~TaggedArticleModel.sessions_id.contains([scope.view_session_id]),
        )
        .all()
    )
    for row in rows:
        # Assigned, not appended in place: SQLAlchemy doesn't track mutation of a
        # plain JSONB list.
        current = list(row.sessions_id or [])
        row.sessions_id = current + [scope.view_session_id]
    if rows:
        db.commit()
        logger.info(
            f"Stamped session_id={scope.view_session_id} onto {len(rows)} pool article(s) "
            f"for project_id={scope.project_id}"
        )
    return len(rows)


def get_tagged_articles(
    db: Session, scope: ArticleScope, ids: list[str]
) -> dict[str, dict[str, Any]]:
    """``{article id: article dict}`` for the given ids; missing ids are absent.

    Addressed by id within the scope's whole set, not through the window: the review
    page can only send ids it was given, and a mutation shouldn't fail because an
    edit moved the article's date out of the window.
    """
    wanted = _row_ids(ids)
    if not wanted:
        return {}
    rows = (
        db.query(
            TaggedArticleModel.id,
            TaggedArticleModel.data,
            TaggedArticleModel.title,
            TaggedArticleModel.content,
            TaggedArticleModel.syndication_of,
            TaggedArticleModel.similar_group_id,
            TaggedArticleModel.dashboard_approvals,
            TaggedArticleModel.monitoring_approvals,
        )
        .filter(*_scope_criteria(scope), TaggedArticleModel.id.in_(wanted))
        .all()
    )
    viewer = _viewer_of(scope)
    return {
        str(row.id): _hydrate(
            row.data,
            row.id,
            row.title,
            row.content,
            syndication_of=row.syndication_of,
            similar_group_id=row.similar_group_id,
            dashboard_approvals=row.dashboard_approvals,
            monitoring_approvals=row.monitoring_approvals,
            for_session=viewer,
        )
        for row in rows
        if isinstance(row.data, dict)
    }


def count_tagged_articles(db: Session, scope: ArticleScope) -> int:
    return (
        db.query(func.count(TaggedArticleModel.id)).filter(*_read_criteria(scope)).scalar()
        or 0
    )


def has_tagged_articles(db: Session, scope: ArticleScope) -> bool:
    """Whether the scope has anything tagged — replaces the old ``session.tagged_file``
    null check that gated every tagged-article endpoint. Window-aware, so a window
    with no articles in it reads as "nothing to show" even when the pool is full."""
    return db.query(TaggedArticleModel.id).filter(*_read_criteria(scope)).first() is not None


def find_syndication_children(
    db: Session, scope: ArticleScope, main_ids: list[str]
) -> dict[str, list[str]]:
    """``{main article id: [syndicated copy ids]}`` for the given mains.

    Section / sentiment / theme / story-group edits on a main article cascade to its
    syndicated copies (same story on other domains, so those must stay in sync). One query
    on the indexed ``syndication_of`` column, which holds the main's row id outright — no
    ref-to-id lookup pass. Not window-filtered: a copy must follow its main even when
    their dates straddle the window's edge.
    """
    wanted = _row_ids(main_ids)
    if not wanted:
        return {}

    rows = (
        db.query(TaggedArticleModel.id, TaggedArticleModel.syndication_of)
        .filter(*_scope_criteria(scope), TaggedArticleModel.syndication_of.in_(wanted))
        .all()
    )
    children: dict[str, list[str]] = defaultdict(list)
    for child_id, main_id in rows:
        children[str(main_id)].append(str(child_id))
    return dict(children)


def prior_tags_by_article_id(
    db: Session, session_ids: list[int] | None
) -> dict[str, dict[str, Any]]:
    """``{article_id: prior tagged article}`` across a merged session's sources.

    Replaces the old "download each source session's tagged file from S3" step.
    First occurrence wins, in ``session_ids`` order, matching the raw-merge dedupe
    policy. Returns ``{}`` when there are no sources, so non-merged sessions are
    unaffected.
    """
    ids = [s for s in (session_ids or []) if s]
    if not ids:
        return {}

    rows = (
        db.query(
            TaggedArticleModel.id,
            TaggedArticleModel.session_id,
            TaggedArticleModel.article_id,
            TaggedArticleModel.data,
            TaggedArticleModel.title,
            TaggedArticleModel.content,
            TaggedArticleModel.syndication_of,
            TaggedArticleModel.similar_group_id,
            TaggedArticleModel.dashboard_approvals,
            TaggedArticleModel.monitoring_approvals,
        )
        .filter(
            TaggedArticleModel.session_id.in_(ids),
            TaggedArticleModel.article_id.isnot(None),
        )
        .order_by(TaggedArticleModel.id)
        .all()
    )
    by_session: dict[int, list[tuple[str, dict[str, Any]]]] = defaultdict(list)
    for row in rows:
        if isinstance(row.data, dict):
            by_session[row.session_id].append(
                (
                    row.article_id,
                    # These rows are session-owned, so the source session is the one
                    # whose approvals the merge is carrying forward.
                    _hydrate(
                        row.data,
                        row.id,
                        row.title,
                        row.content,
                        syndication_of=row.syndication_of,
                        similar_group_id=row.similar_group_id,
                        dashboard_approvals=row.dashboard_approvals,
                        monitoring_approvals=row.monitoring_approvals,
                        for_session=row.session_id,
                    ),
                )
            )

    prior: dict[str, dict[str, Any]] = {}
    for session_id in ids:  # source order decides who wins a collision
        for article_id, data in by_session.get(session_id, []):
            if article_id not in prior:
                prior[article_id] = data
    return prior


# ---------------------------------------------------------------------------
# Similarity embeddings
# ---------------------------------------------------------------------------
def list_embedding_rows(db: Session, scope: ArticleScope) -> list[dict[str, Any]]:
    """The similarity linker's working set: one slim dict per relevant article the
    scope shows, keyed by article id.

    ``similar_text`` is what gets embedded: the tagger's summary when the row has one,
    else the head of the scraped body (``left(content, N)``, so the body is never
    fetched whole). The summary is the same facts in the same neutral style for every
    telling of a story, while the bodies differ per outlet — boilerplate, bylines,
    navigation — which used to drag genuine same-story pairs below the threshold.

    Rows embedded before this switch keep their body-based vector, since the
    ``embedding_model`` tag is unchanged and that tag is what triggers re-embedding.
    """
    rows = (
        db.query(
            TaggedArticleModel.id,
            TaggedArticleModel.date,
            TaggedArticleModel.title,
            TaggedArticleModel.data["summary"].astext.label("summary"),
            func.left(TaggedArticleModel.content, envs.SIMILAR_EMBED_MAX_CHARS).label("content_head"),
            TaggedArticleModel.syndication_of,
            TaggedArticleModel.similar_group_id,
            TaggedArticleModel.embedding,
            TaggedArticleModel.embedding_model,
        )
        .filter(*_read_criteria(scope), TaggedArticleModel.is_relevant.is_(True))
        .order_by(TaggedArticleModel.id)
        .all()
    )
    return [
        {
            "id": str(row.id),
            "date": row.date,
            "title": row.title,
            "similar_text": (row.summary or "").strip() or row.content_head,
            "syndication_of": str(row.syndication_of) if row.syndication_of else "",
            "similar_group_id": row.similar_group_id or "",
            "embedding": row.embedding,
            "embedding_model": row.embedding_model,
        }
        for row in rows
    ]


def list_group_candidates(
    db: Session,
    project_id: int,
    start: Any,
    end: Any,
    model_tag: str,
) -> list[dict[str, Any]]:
    """The project's already-grouped pool rows a newcomer could join, dated in
    ``[start, end]``.

    Deliberately **not** scope-filtered. A story group is a property of the project's
    articles, not of whichever session window happens to be open — reading candidates
    through a window is exactly what let a group fragment when its earliest article fell
    outside the window's bounds. The date band (see ``SIMILAR_GROUP_LOOKBACK_DAYS``) is
    what bounds this read instead, so it stays cheap as the pool grows.

    Syndicated copies are excluded: they inherit their main's group rather than being
    matched on their own, so they are never a match target. So are vectors from another
    ``embedding_model`` — those live in an incompatible space.

    Returns one slim dict per candidate; cosine is computed by the caller, since
    ``embedding`` is a plain ``float8[]`` with no ANN index to push the search into.
    """
    rows = (
        db.query(
            TaggedArticleModel.id,
            TaggedArticleModel.date,
            TaggedArticleModel.similar_group_id,
            TaggedArticleModel.embedding,
        )
        .filter(
            TaggedArticleModel.project_id == project_id,
            TaggedArticleModel.session_id.is_(None),
            TaggedArticleModel.is_relevant.is_(True),
            TaggedArticleModel.syndication_of.is_(None),
            TaggedArticleModel.similar_group_id.isnot(None),
            TaggedArticleModel.embedding.isnot(None),
            TaggedArticleModel.embedding_model == model_tag,
            TaggedArticleModel.date.between(start, end),
        )
        .order_by(TaggedArticleModel.id)
        .all()
    )
    return [
        {
            "id": str(row.id),
            "date": row.date,
            "similar_group_id": row.similar_group_id,
            "embedding": row.embedding,
        }
        for row in rows
        if row.embedding
    ]


def store_embeddings(
    db: Session, scope: ArticleScope, vectors: dict[str, list[float]], model_tag: str
) -> int:
    """Write similarity vectors onto rows by article id. Column-only UPDATE —
    ``data`` and the promoted columns are never touched, so this composes with any
    concurrent review-page edit. Commits; returns the number of rows written."""
    updated = 0
    for article_id, vector in vectors.items():
        row_id = _as_row_id(article_id)
        if row_id is None or not vector:
            continue
        updated += (
            db.query(TaggedArticleModel)
            .filter(*_scope_criteria(scope), TaggedArticleModel.id == row_id)
            .update(
                {"embedding": list(vector), "embedding_model": model_tag},
                synchronize_session=False,
            )
        )
    if updated:
        db.commit()
    return updated

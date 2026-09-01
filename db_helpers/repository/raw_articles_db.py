"""Persistence for a session's raw (pre-tagging) articles.

The raw stage used to be a single JSON/CSV file per session on S3, re-parsed with
``parse_upload`` every time the pipeline needed it. It is now one row per source
record in ``raw_articles``, and nothing is written to S3 — these rows are the only
copy of the parsed source data.

Rows belong either to one session (an upload's or a merge's own set) or to the
project pool the hourly scheduler fetches into — see
``db_helpers.repository.article_scope``.

Whole-dataset ingest (upload, merge) calls :func:`replace_raw_articles` and reads
with :func:`list_raw_articles`, both keyed by session. The scheduler tops a scope up
with :func:`append_raw_articles` and the incremental tagger reads what still needs
tags with :func:`list_untagged_raw_articles`, both keyed by an
:class:`~db_helpers.repository.article_scope.ArticleScope`.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from configs import logger
from db_helpers.models.raw_article_model import RawArticleModel
from db_helpers.models.tagged_article_model import TaggedArticleModel
from db_helpers.repository.article_scope import ArticleScope
from db_helpers.repository.sessions_db import get_session_project_id
from file_helpers.cleaing_data import json_safe, raw_date_of, to_datetime
from file_helpers.merge_helper import article_id_for_url

_INSERT_CHUNK = 500


def _scope_criteria(scope: ArticleScope) -> tuple:
    """SQL criteria selecting exactly the raw rows in `scope`."""
    if scope.is_pool:
        return (
            RawArticleModel.project_id == scope.project_id,
            RawArticleModel.session_id.is_(None),
        )
    return (RawArticleModel.session_id == scope.session_id,)


def _tagged_scope_criteria(scope: ArticleScope) -> tuple:
    """The same scope, over the tagged rows — for "which of these already has tags?"."""
    if scope.is_pool:
        return (
            TaggedArticleModel.project_id == scope.project_id,
            TaggedArticleModel.session_id.is_(None),
        )
    return (TaggedArticleModel.session_id == scope.session_id,)


def row_from_record(project_id: int, session_id: int | None, query_id: int | None, record: dict[str, Any]) -> RawArticleModel:
    """One raw row from a source record.

    ``data`` keeps the record exactly as the source gave it — including its original
    ``date`` string, whatever format that was. The ``date`` column gets that parsed
    to a UTC timestamp, derived the same way ``clean_articles`` does it (so the
    column and the pipeline agree): rejoin a split date/time column, then parse. An
    unparseable date leaves the column NULL — the original is still in ``data``.

    ``is_relevant`` is normally NULL here (the gate runs later, during tagging), but
    a record can arrive already carrying a verdict — a merged session's sources were
    stamped on their own tagging run — so it is carried over when present.

    ``onedrive_file_id`` is read off the record for the same reason: the OneDrive sync
    stamps it on each record it parses, so deleting that file can take its articles.
    """
    url = record.get("url")
    is_relevant = record.get("is_relevant")
    onedrive_file_id = record.get("onedrive_file_id")
    return RawArticleModel(
        project_id=project_id,
        session_id=session_id,
        generated_query_id=query_id,
        article_id=article_id_for_url(url),
        url=str(url) if url else None,
        date=to_datetime(raw_date_of(record)),
        is_relevant=None if is_relevant is None else bool(is_relevant),
        onedrive_file_id=int(onedrive_file_id) if onedrive_file_id is not None else None,
        data=json_safe(record),
    )


def replace_raw_articles(db: Session, session_id: int, query_id: int | None, records: list[dict[str, Any]]) -> int:
    """Make ``records`` the session's raw set, replacing whatever was there.

    Also clears the session's tagged articles: new raw data invalidates any tags
    derived from the old set, and doing it here means no ingest path can forget to.
    Returns the number of rows inserted.
    """
    clean = [r for r in records if isinstance(r, dict)]

    project_id = get_session_project_id(db, session_id)
    if project_id is None:
        raise ValueError(f"Session {session_id} does not exist; cannot store raw articles for it.")

    db.query(TaggedArticleModel).filter(TaggedArticleModel.session_id == session_id).delete(
        synchronize_session=False
    )
    db.query(RawArticleModel).filter(RawArticleModel.session_id == session_id).delete(
        synchronize_session=False
    )

    for start in range(0, len(clean), _INSERT_CHUNK):
        chunk = clean[start:start + _INSERT_CHUNK]
        db.bulk_save_objects([row_from_record(project_id, session_id, query_id, r) for r in chunk])

    db.commit()
    logger.info(f"Stored {len(clean)} raw article(s) for session_id={session_id}")
    return len(clean)


def existing_article_ids(db: Session, scope: ArticleScope) -> set[str]:
    """The ``article_id``s the scope's raw set already holds (URL-less rows have none,
    so they are absent).

    For a pool scope this is "every article this project has ever fetched" — the set
    an hourly fetch checks against, and the reason a project only ever stores one row
    per article however many queries turn it up.
    """
    rows = (
        db.query(RawArticleModel.article_id)
        .filter(*_scope_criteria(scope), RawArticleModel.article_id.isnot(None))
        .all()
    )
    return {article_id for (article_id,) in rows}


def append_raw_articles(
    db: Session, query_id: int | None, scope: ArticleScope, records: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Add the records the scope doesn't already hold, keeping what's there — and,
    unlike :func:`replace_raw_articles`, the tags derived from it — intact.

    The hourly fetch's ingest path. The same queries are re-fetched every hour into
    the project pool, so most of what comes back is already stored (and already
    tagged). Identity is ``article_id`` (sha256 of the canonical URL), the same key
    the tagged rows and the merge dedupe use, so "already have it" means one thing
    everywhere. A record with no usable URL has no article_id and so couldn't be
    recognised next hour — it is skipped rather than re-appended every hour.

    Returns the records actually inserted, in order.
    """
    if scope.is_pool:
        project_id = scope.project_id
    else:
        project_id = get_session_project_id(db, scope.session_id)
        if project_id is None:
            raise ValueError(f"Session {scope.session_id} does not exist; cannot store raw articles for it.")

    seen = existing_article_ids(db, scope)
    fresh: list[dict[str, Any]] = []
    skipped_no_url = 0
    for record in records:
        if not isinstance(record, dict):
            continue
        article_id = article_id_for_url(record.get("url"))
        if article_id is None:
            skipped_no_url += 1
            continue
        if article_id in seen:
            continue
        seen.add(article_id)  # also de-dups within this batch
        fresh.append(record)

    session_id = None if scope.is_pool else scope.session_id
    for start in range(0, len(fresh), _INSERT_CHUNK):
        chunk = fresh[start:start + _INSERT_CHUNK]
        db.bulk_save_objects([row_from_record(project_id, session_id, query_id, r) for r in chunk])

    db.commit()
    logger.info(
        f"Appended {len(fresh)} new raw article(s) to {scope.describe()} "
        f"({len(records) - len(fresh) - skipped_no_url} already stored"
        + (f", {skipped_no_url} without a URL skipped" if skipped_no_url else "")
        + ")"
    )
    return fresh


def list_raw_articles(db: Session, session_id: int) -> list[dict[str, Any]]:
    """The session's raw records, in insertion order (the order they were fetched
    or read out of the uploaded file). Returns the stored dicts as-is, so the
    tagging pipeline sees exactly what ``parse_upload`` used to hand it."""
    rows = (
        db.query(RawArticleModel.data)
        .filter(RawArticleModel.session_id == session_id)
        .order_by(RawArticleModel.id)
        .all()
    )
    return [row.data for row in rows if isinstance(row.data, dict)]


def list_untagged_raw_articles(db: Session, scope: ArticleScope) -> list[dict[str, Any]]:
    """The scope's raw records that have no tagged row yet, in insertion order.

    What an hourly run has to tag: the articles :func:`append_raw_articles` just
    added, and anything an earlier run fetched but failed to tag (so a failure is
    retried rather than stranded). Matched on ``article_id``, which every tagged row
    carries for a URL-bearing article — including the ones the relevancy gate
    rejected, since those are stored too (with blank tags) and must not be paid for
    twice. Rows without an ``article_id`` can't be matched and are excluded; nothing
    the fetchers store lacks a URL.
    """
    tagged_ids = (
        db.query(TaggedArticleModel.article_id)
        .filter(*_tagged_scope_criteria(scope), TaggedArticleModel.article_id.isnot(None))
        .scalar_subquery()
    )
    rows = (
        db.query(RawArticleModel.data)
        .filter(
            *_scope_criteria(scope),
            RawArticleModel.article_id.isnot(None),
            RawArticleModel.article_id.notin_(tagged_ids),
        )
        .order_by(RawArticleModel.id)
        .all()
    )
    return [row.data for row in rows if isinstance(row.data, dict)]


def count_raw_articles(db: Session, session_id: int) -> int:
    return (
        db.query(func.count(RawArticleModel.id))
        .filter(RawArticleModel.session_id == session_id)
        .scalar()
        or 0
    )


def count_raw_articles_fetched_between(
    db: Session,
    project_id: int,
    generated_query_id: int,
    start: datetime,
    end: datetime,
) -> int:
    """Count a generated query's raw articles fetched into a project between two times.

    Counts on ``created_at`` (when the row was fetched), not ``date`` (when the article
    was published).

    Args:
        db: Database session.
        project_id: Project the rows belong to.
        generated_query_id: Generated query that fetched them.
        start: Range start, inclusive.
        end: Range end, inclusive.

    Returns:
        Number of matching raw article rows.
    """
    return (
        db.query(func.count(RawArticleModel.id))
        .filter(RawArticleModel.project_id == project_id)
        .filter(RawArticleModel.generated_query_id == generated_query_id)
        .filter(RawArticleModel.created_at >= start)
        .filter(RawArticleModel.created_at <= end)
        .scalar()
        or 0
    )


def has_raw_articles(db: Session, session_id: int) -> bool:
    return (
        db.query(RawArticleModel.id)
        .filter(RawArticleModel.session_id == session_id)
        .first()
        is not None
    )


def stamp_relevancy(db: Session, scope: ArticleScope, annotated: list[dict[str, Any]]) -> int:
    """Copy the relevancy gate's ``is_relevant`` / ``relevancy_reason`` /
    ``relevancy_confidence`` verdicts back onto the raw rows, matched by
    ``article_id`` — into the ``is_relevant`` column (queryable) and into
    ``data`` (alongside the reason and score).

    Audit-only: ``apply_relevancy`` recomputes relevancy from scratch on every
    run and never reads these back, so a record with no URL (and therefore no
    article_id) simply doesn't get stamped. Best-effort — a failure here must
    never fail the tagging run. Returns the number of rows updated.
    """
    try:
        verdicts: dict[str, tuple[bool, str, Any]] = {}
        for article in annotated:
            if not isinstance(article, dict):
                continue
            key = article_id_for_url(article.get("url"))
            if key:
                verdicts[key] = (
                    bool(article.get("is_relevant", True)),
                    str(article.get("relevancy_reason") or ""),
                    article.get("relevancy_confidence"),
                )
        if not verdicts:
            return 0

        rows = (
            db.query(RawArticleModel)
            .filter(
                *_scope_criteria(scope),
                RawArticleModel.article_id.in_(list(verdicts)),
            )
            .all()
        )
        for row in rows:
            verdict = verdicts.get(row.article_id or "")
            if verdict is None:
                continue
            is_relevant, reason, score = verdict
            row.is_relevant = is_relevant
            row.data = {
                **(row.data or {}),
                "is_relevant": is_relevant,
                "relevancy_reason": reason,
                "relevancy_confidence": score,
            }
        db.commit()
        logger.info(f"Stamped relevancy onto {len(rows)} raw article row(s) for {scope.describe()}")
        return len(rows)
    except Exception:  # noqa: BLE001
        logger.exception("Failed to stamp relevancy flags onto the raw articles; continuing.")
        db.rollback()
        return 0

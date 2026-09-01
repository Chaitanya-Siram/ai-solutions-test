"""Fetch articles for a set of queries and store them as raw articles — so fetched
news feeds the same tagging → charts pipeline as an uploaded file.

Queries arrive in the query-builder's shape ([{"label": ..., "queries": [...]}]),
either off a session's `queries` column or off a generated query's. We flatten
those, fetch Google News for every query, merge + de-dup, then store the shaped
records as `raw_articles` rows — nothing is written to S3.

Two destinations, and the difference matters:

  * :func:`fetch_and_save_for_session` makes the results a session's own raw set,
    replacing whatever was there. That's an upload-shaped, one-shot dataset.
  * :func:`fetch_and_append_for_project` adds them to the project's article pool,
    keeping everything already there. That's the hourly fetch: it runs against the
    same queries over and over, so it asks Google News for a short window and skips
    every result the project already stores *before* paying to download its body.
"""
from __future__ import annotations

from typing import Any
from sqlalchemy.orm import Session
from configs import logger, envs
from data_source_helpers.beone_fetcher import gather_beone_articles
from data_source_helpers.trane_fetcher import gather_trane_articles
from db_helpers.models.session_model import SessionModel
from db_helpers.repository.article_scope import pool_scope
from db_helpers.repository.sessions_db import reset_session_for_new_raw, update_session_name
from db_helpers.repository.projects_db import get_project
from db_helpers.repository.raw_articles_db import (
    append_raw_articles,
    existing_article_ids,
    replace_raw_articles,
)
from data_source_helpers.google_news_rss import google_news_rss_scraper
from file_helpers.merge_helper import article_id_for_url

# # How far back an hourly fetch asks Google News to look. An hour of overlap on top of
# # the hourly cadence, so an article Google indexes a little late still gets picked up
# # — the pool's article_id dedupe drops the repeats for free.
# HOURLY_FETCH_HOURS = 2

# # The top-up a window session's review page runs when it opens: the last hour, as the
# # newest slice the hourly job may not have reached yet.
# REVIEW_FETCH_HOURS = 1

# _BEONE_MAX_RESULTS_PER_QUERY = 200


def _flatten_queries(queries: Any) -> list[dict[str, str]]:
    """Flatten stored query groups into [{group, query}, ...].

    Tolerates the query-builder shape ([{"label", "queries": [...]}]) as well as a
    bare list of query strings.
    """
    flat: list[dict[str, str]] = []
    if not isinstance(queries, list):
        return flat
    for entry in queries:
        if isinstance(entry, dict) and isinstance(entry.get("queries"), list):
            label = str(entry.get("label") or "Queries")
            for q in entry["queries"]:
                q = str(q).strip()
                if q:
                    flat.append({"group": label, "query": q})
        elif isinstance(entry, str) and entry.strip():
            flat.append({"group": "Queries", "query": entry.strip()})
    return flat


def _to_source_record(article: dict[str, Any]) -> dict[str, Any]:
    """Shape a SerpAPI article so parse_upload keeps it: it needs a non-empty
    canonical `date`, plus title/content/url. Carry the group through for slicing."""
    return {
        "title": article.get("title", ""),
        "content": article.get("content", ""),
        "url": article.get("url", ""),
        "source": article.get("source", ""),
        "domain": article.get("domain", ""),
        "date": article.get("date") or "",
        "group": article.get("group", ""),
        "query": article.get("query", ""),
        "author": article.get("author", ""),
        "keyword_matched": article.get("keyword_matched", []),
        "decode_error": article.get("decode_error", "")
    }


def save_source_records(
    session: SessionModel,
    db: Session,
    records: list[dict[str, Any]],
    source_name: str,
    name_hint: str | None = None,
) -> SessionModel:
    """Store fetched records as the session's raw articles. Nothing goes to S3.

    The rows in `raw_articles` are what the tagging pipeline reads. The session rolls
    back to "Uploaded" since this raw set supersedes anything tagged before, and takes
    `name_hint` as its display name if it doesn't already have one — that name is all
    the frontend has to label the session with. Returns the updated session.
    """
    if name_hint and not (session.name or "").strip():
        update_session_name(db, session, name_hint)

    updated = reset_session_for_new_raw(db, session)
    replace_raw_articles(db, updated.id, records)
    logger.info(f"Stored {len(records)} {source_name} article(s) for session id={session.id}")
    return updated


# ---------------------------------------------------------------------------
# Gatherers — one per source pipeline, each returning shaped source records
# ---------------------------------------------------------------------------
def _gather_google_news_records(
    queries: Any,
    language: str,
    country: str,
    on_progress=None,
    recency_hours: int | None = None,
    skip_url=None,
    label: str = "",
) -> list[dict[str, Any]]:
    """Fetch Google News for every one of `queries`, shaped as source records.

    Raises ValueError if there are no queries or nothing was found. `recency_hours`
    and `skip_url` are the hourly fetch's economy measures — see the module docstring.
    """
    flat = _flatten_queries(queries)
    if not flat:
        raise ValueError("No queries to fetch articles for.")

    logger.info(f"Fetching GoogleNews articles for {label}: {len(flat)} query/queries")
    kwargs: dict[str, Any] = {
        "language": language,
        "country": country,
        "on_progress": on_progress,
        "skip_url": skip_url,
    }
    if recency_hours is not None:
        kwargs["recency_hours"] = recency_hours
    articles = google_news_rss_scraper.fetch_google_news_feedparser_boolean_query(flat, **kwargs)
    if not articles:
        raise ValueError("No articles were fetched from GoogleNews for these queries.")

    return [_to_source_record(a) for a in articles]


def _gather_beone_records(
    queries: Any,
    language: str,
    country: str,
    on_progress=None,
    recency_hours: int | None = None,
    skip_url=None,
    label: str = "",
) -> list[dict[str, Any]]:
    """Gather BeOne articles (full runAgentLoop port), shaped as source records.

    The Google-News query set comes from `queries` (the same query-builder groups the
    standard fetch uses); the BeOne-specific RSS feeds + publication scrape run
    alongside. With no queries, the built-in BeOne sweep is used as a fallback. Raises
    ValueError if nothing was found.
    """
    query_groups = _flatten_queries(queries) or None
    if query_groups:
        logger.info(f"BeOne fetch using {len(query_groups)} query/queries for {label}")
    else:
        logger.info(f"BeOne fetch for {label} has no queries; using built-in BeOne sweep")

    articles = gather_beone_articles(
        query_groups=query_groups,
        language=language,
        country=country,
        on_progress=on_progress,
        recency_hours=recency_hours,
        skip_url=skip_url,
    )
    if not articles:
        raise ValueError("No BeOne articles were fetched.")

    records = [_to_source_record(a) for a in articles]
    # Final count after dedupe/shaping, so the client's counter lands on the
    # number that actually gets saved.
    if on_progress is not None:
        try:
            on_progress(len(records))
        except Exception:
            logger.exception("on_progress callback failed")

    return records


def _gather_trane_records(
    queries: Any,
    language: str,
    country: str,
    on_progress=None,
    label: str = "",
) -> list[dict[str, Any]]:
    """Gather Trane / HVAC articles (competitor newsroom scrape + Google News over
    `queries`), shaped as source records.

    The competitor newsroom pages are always scraped. Raises ValueError if nothing was
    found. This pipeline is currently disabled in the dispatch below, so it doesn't
    take the hourly fetch's recency / skip arguments.
    """
    query_groups = _flatten_queries(queries) or None
    if query_groups:
        logger.info(f"Trane fetch using {len(query_groups)} query/queries for {label}")
    else:
        logger.info(f"Trane fetch for {label} has no queries; scraping newsrooms only")

    articles = gather_trane_articles(
        query_groups=query_groups,
        language=language,
        country=country,
        on_progress=on_progress,
    )
    if not articles:
        raise ValueError("No Trane articles were fetched.")

    records = [_to_source_record(a) for a in articles]
    # Final count after dedupe/shaping, so the client's counter lands on the
    # number that actually gets saved.
    if on_progress is not None:
        try:
            on_progress(len(records))
        except Exception:
            logger.exception("on_progress callback failed")

    return records


# ---------------------------------------------------------------------------
# Dispatch — pick the pipeline from the project
# ---------------------------------------------------------------------------
def is_beone_project(name: str) -> bool:
    """True for the BeOne (BeiGene) project — matched case-insensitively so
    "BeOne", "Beone", "BeOne Medicines", and "BeiGene" all route to the BeOne
    pipeline."""
    norm = (name or "").strip().lower()
    return norm == "beone" or norm.startswith("beone ") or "beigene" in norm


def is_trane_project(name: str) -> bool:
    """True for the Trane (Trane Technologies) project — matched case-insensitively
    so "Trane", "Trane Technologies", and "TraneTechnologies" all route to the
    Trane pipeline."""
    norm = (name or "").strip().lower()
    return norm == "trane" or norm.startswith("trane ") or "trane technologies" in norm


def gather_for_project(
    db: Session,
    project_id: int,
    queries: Any,
    language: str = "en",
    country: str = "us",
    on_progress=None,
    recency_hours: int = envs.DEFAULT_RSS_RECENCY_HOURS,
    skip_url=None,
    label: str = "",
) -> tuple[list[dict[str, Any]], str]:
    """Gather source records for a project's queries, choosing the pipeline by project.

    The single place the routing lives: BeOne projects use the dedicated BeOne source
    set, Trane projects scrape competitor newsrooms + Google News (currently
    disabled), and every other project fetches the queries it was given. Returns
    (records, source label for logging, default name hint) so the replace and the
    append ingest paths route identically.
    """
    project = get_project(db, project_id)
    project_name = project.name if project and project.name else ""
    label = label or f"project_id={project_id}"
    if is_beone_project(project_name):
        logger.info(f"Project '{project_name}' -> BeOne fetch pipeline for {label}")
        records = _gather_beone_records(
            queries,
            language,
            country,
            on_progress,
            recency_hours,
            skip_url,
            label,
        )
        return records, project_name
    # elif is_trane_project(project_name):
    #     logger.info(f"Project '{project_name}' -> Trane fetch pipeline for {label}")
    #     return _gather_trane_records(queries, language, country, on_progress, label), "Trane", "trane"
    else:
        logger.info(f"Project '{project_name}' -> standard fetch pipeline for {label}")
        records = _gather_google_news_records(
            queries, language, country, on_progress, recency_hours, skip_url, label
        )
        return records, project_name


# ---------------------------------------------------------------------------
# Ingest paths
# ---------------------------------------------------------------------------
def fetch_and_append_for_project(
    db: Session,
    project_id: int,
    query_id: int,
    queries: Any,
    recency_hours: int = envs.DEFAULT_RSS_RECENCY_HOURS,
    on_progress=None,
    label: str = "",
) -> list[dict[str, Any]]:
    """Fetch `queries` and add to the project's pool only the articles it doesn't
    already hold. Nothing already stored is touched, and no session is involved.

    The hourly fetch. Because the same queries run again and again, two things keep it
    cheap: Google News is asked for `recency_hours` rather than days, and every result
    the project already stores is dropped straight after its URL is decoded — before
    its body would be downloaded, which is the part that costs real time.

    Returns the newly-appended source records (empty when nothing new turned up).
    Raises ValueError if there are no queries, or if the fetch found no articles at
    all — note that "found nothing new" is not an error and returns [].
    """
    scope = pool_scope(project_id)
    label = label or f"project_id={project_id} pool"

    # Snapshot of what the project already has, so the fetch can skip those before
    # scraping. append_raw_articles re-checks against the database at insert time, so
    # anything that lands here in the meantime still can't be stored twice.
    known = existing_article_ids(db, scope)

    def already_stored(url: Any) -> bool:
        article_id = article_id_for_url(url)
        return article_id is not None and article_id in known

    records, project_name = gather_for_project(
        db,
        project_id,
        queries,
        on_progress=on_progress,
        recency_hours=recency_hours,
        skip_url=already_stored,
        label=label,
    )

    fresh = append_raw_articles(db, query_id, scope, records)
    logger.info(
        f"{len(fresh)} new {project_name} article(s) of {len(records)} fetched for {label} "
        f"(last {recency_hours}h)"
    )
    return fresh

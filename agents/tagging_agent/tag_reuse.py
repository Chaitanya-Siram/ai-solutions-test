"""Reuse existing tags when tagging a merged session.

A merged session (``session_type == "merged"``) concatenates the raw articles of
several source sessions. Some of those sources may already be tagged — their tags
live in the ``tagged_articles`` rows for those sessions. Re-running the LLM on
those already-tagged articles just wastes tokens and time, so before tagging we:

  1. build an ``article_id -> prior tagged article`` map from the source sessions'
     tagged rows (:func:`load_prior_tags`),
  2. split the articles into "needs tagging" vs "already tagged"
     (:func:`partition_untagged`), and
  3. synthesize tag-only records for the reused articles keyed to the current
     run's ids (:func:`build_reused_taggings`) so they flow through the same
     merge + reorder steps as freshly-tagged articles.

Matching is by ``article_id`` — sha256 of the canonical URL, see
:func:`file_helpers.merge_helper.article_id_for_url` — because the ``A{n}`` labels a run
works with are run-local and never stored, and a stored article's id is its own row's
primary key, which says nothing about whether two rows are the same article.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from agents.tagging_agent.tagging_common import FIELDS_CONFIG
from db_helpers.repository.tagged_articles_db import prior_tags_by_article_id
from file_helpers.merge_helper import article_id_for_url

# Tag fields carried over from a prior tagged article, plus review metadata that
# would otherwise be lost (approvals gate what the dashboards show; added_type
# marks manually-added articles). `id` is intentionally excluded — the reused
# tags are re-keyed to the current run's ids by build_reused_taggings.
TAG_REUSE_FIELDS: tuple[str, ...] = tuple(
    f for f in (FIELDS_CONFIG.fields + FIELDS_CONFIG.list_fields) if f != "id"
) + ("is_approved", "is_approved_for_monitoring", "added_type")


def load_prior_tags(db: Session, merged_session_ids: list[int] | None) -> dict[str, dict[str, Any]]:
    """Map article_id -> prior tagged article across the merged sources.

    First occurrence wins (in ``merged_session_ids`` order), matching the raw-merge
    dedupe policy. Returns ``{}`` when there are no merged sources, so non-merged
    sessions are unaffected.
    """
    return prior_tags_by_article_id(db, merged_session_ids)


def partition_untagged(
    non_copies: list[dict[str, Any]],
    prior_tags: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split non-syndicated articles into (to_tag, reused).

    ``reused`` are articles whose article_id already has tags in ``prior_tags``;
    ``to_tag`` is everything else (sent to the LLM).
    """
    if not prior_tags:
        return list(non_copies), []
    to_tag: list[dict[str, Any]] = []
    reused: list[dict[str, Any]] = []
    for article in non_copies:
        if article_id_for_url(article.get("url")) in prior_tags:
            reused.append(article)
        else:
            to_tag.append(article)
    return to_tag, reused


def build_reused_taggings(
    reused: list[dict[str, Any]],
    prior_tags: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Tag-only records for the reused articles, keyed to their current-run ids.

    The output mirrors the shape of ``tag_articles`` output ({id, tag fields})
    so it can be concatenated with the LLM output and fed through
    ``merge_tagged_with_syndication`` uniformly.
    """
    out: list[dict[str, Any]] = []
    for article in reused:
        key = article_id_for_url(article.get("url"))
        prior = prior_tags.get(key) if key else None
        if not prior:
            continue
        tags = {f: prior[f] for f in TAG_REUSE_FIELDS if f in prior}
        tags["id"] = article.get("id")
        out.append(tags)
    return out

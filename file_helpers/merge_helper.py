"""Merge raw records from several sessions into one deduplicated list.

Deduplication is by article URL. Two URLs that differ only by a trailing slash
(e.g. ".../story" vs ".../story/") are treated as the same article, and casing
of the scheme/host is ignored. Records without a usable URL can't be deduped, so
they are always kept.

:func:`article_id_for_url` turns that same canonical URL into the stable
``article_id`` stored on the ``raw_articles`` / ``tagged_articles`` rows, so
"is this the same article?" means one thing everywhere.
"""
from __future__ import annotations

import hashlib
from typing import Any


def normalize_url(url: Any) -> str:
    """Canonical form of a URL used as the dedup key.

    Strips surrounding whitespace and any trailing slash(es), and lowercases the
    scheme+host so "https://Example.com/a/" and "http... " variants that only
    differ by a trailing slash collapse to one key. Returns "" for empty input.
    """
    if not isinstance(url, str):
        return ""
    u = url.strip()
    if not u:
        return ""
    # Drop trailing slashes (but keep a bare "http://host" intact).
    u = u.rstrip("/")
    # Lowercase only the scheme + host so query strings / paths keep their case.
    if "://" in u:
        scheme, rest = u.split("://", 1)
        host, sep, tail = rest.partition("/")
        u = f"{scheme.lower()}://{host.lower()}{sep}{tail}"
    return u


def article_id_for_url(url: Any) -> str | None:
    """Stable cross-session identity for an article: sha256 of its canonical URL.

    Used as the ``article_id`` column on raw / tagged article rows, so the same
    story fetched into two different sessions carries the same id — that's what
    lets a merged session reuse tags from its sources with a plain SQL match
    instead of re-reading their files.

    Returns None when the record has no usable URL (those rows keep a NULL
    article_id and are simply never matched across sessions).
    """
    key = normalize_url(url)
    if not key:
        return None
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def dedupe_by_url(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return records with URL-duplicates removed, keeping the first occurrence.

    Records with no URL are always kept (they can't be compared). Order is
    otherwise preserved so the first file's articles win on a collision.
    """
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        key = normalize_url(record.get("url"))
        if key:
            if key in seen:
                continue
            seen.add(key)
        unique.append(record)
    return unique

"""Trane Technologies article-gathering pipeline.

Trane counterpart to data_source_helpers/beone_fetcher.py. Gathers HVAC-industry
articles from two source families and merges + de-duplicates them:

    1. Competitor newsroom scrape — the press-release / newsroom pages for Trane
       and its peers (Honeywell, Carrier, Johnson Controls, Daikin, Lennox). Each
       page's headlines are extracted and tagged with the company they came from.
    2. Google News RSS — run against the session's own DB queries (the same
       query-builder groups the standard fetch path uses), so the Google-News
       coverage is driven by the session, not a hard-coded sweep.

Every returned article is a plain dict shaped for file_helpers/file_parser and
data_source_helpers/fetching_service._to_source_record:
    {title, url, content, source, domain, date, author, group, query, keyword_matched}
"""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Optional

from configs import logger
from data_source_helpers.google_news_rss import google_news_rss_scraper
from data_source_helpers.newspaper_helper import article_content_fetch
from data_source_helpers.scrapper_utils import filter_recent_articles
# Reuse the generic scrape/dedupe helpers that already live in beone_fetcher — they
# are company-agnostic (HTML fetch, <a>-headline extraction, URL-normalized dedupe).
from data_source_helpers.beone_fetcher import (
    _fetch_html,
    _extract_links,
    normalize_url,
    dedupe_articles,
)

# Concurrency for the per-article content fetch (newspaper3k download + parse is
# IO-bound, so threads help; each download is time-bounded by newspaper's config).
_ENRICH_WORKERS = 20


TRANE_NAME = "Trane"

# Competitor newsroom / press-release pages, grouped by company. Each page is an
# HTML listing whose article links are scraped (these are first-party newsrooms,
# so every release is relevant — no title keyword filter is applied). Articles are
# tagged with their company as `group`/`source` so downstream slicing can split by
# competitor.
TRANE_NEWSROOM_SOURCES: dict[str, list[str]] = {
    "Trane Technologies": [
        "https://investors.tranetechnologies.com/news-and-events/news-releases/default.aspx",
        "https://www.trane.com/commercial/north-america/us/en/about-us/newsroom/press-releases.html",
        "https://trane.eu/uk/about-trane/press-releases.html",
        "https://www.thermoking.com/na/en/newsroom.html",
        "https://europe.thermoking.com/media-room",
        "https://www.mitsubishicomfort.com/press-room",
    ],
    "Honeywell": [
        "https://www.honeywell.com/us/en/press?tab=View+All",
    ],
    "Carrier Global": [
        "https://ir.carrier.com/news/default.aspx",
        "https://www.carrier.com/carrier/en/worldwide/news/",
        "https://www.carrier.com/us/en/news/",
        "https://www.carrier.com/commercial/en/us/news/",
        "https://www.carrier.com/truck-trailer/en/eu/news/",
        "https://www.carrier.com/commercial/en/uk/news/",
        "https://www.viessmann-climatesolutions.com/en/newsroom.html",
    ],
    "Johnson Controls": [
        "https://investors.johnsoncontrols.com/news-and-events/press-releases/johnson-controls-international-plc/2026",
        "https://www.johnsoncontrols.com/media-center/news#sort=%40insightdate%20descending",
        "https://me.johnsoncontrols.com/media-center/news#sort=%40insightdate%20descending",
        "https://www.johnsoncontrols.com/building-insights#sort=%40insightdate%20descending",
    ],
    "Daikin": [
        "https://www.daikin.com/press",
        "https://www.daikinmea.com/en_us/press-releases.html#!?s=recent&offset=0&language=en&includeArchived=false",
        "https://www.daikin-ce.com/en_us/press-releases.html#!?offset=0&s=recent&language=en&includeArchived=false",
        "https://www.daikinapplied.com/news",
        "https://www.daikinapplied.uk/news-centre",
        "https://www.northamerica-daikin.com/news",
    ],
    "Lennox International": [
        "https://lennoxinternational.gcs-web.com/news-events/news-releases",
    ],
}


# ---------------------------------------------------------------------------
# Newsroom scrape source
# ---------------------------------------------------------------------------

def _enrich_article(a: dict[str, Any]) -> dict[str, Any]:
    """Fetch the full article for a scraped headline (content/date/author) via
    newspaper3k and merge the result back onto the scraped dict, preserving the
    provenance fields set during scraping (source/domain/group/sourceType).

    A scraped link only carries a title + url; without a real `date` the record is
    dropped downstream by file_parser.filter_articles_with_date, which is why the
    newsroom rows were vanishing before the Google-News merge. article_content_fetch
    reads `url`/`title`/`published`, so the scraped `date` is passed as `published`.
    """
    fetched = article_content_fetch({
        "url": a.get("url", ""),
        "title": a.get("title", ""),
        "published": a.get("date") or "",
    })
    a["title"] = fetched.get("title") or a.get("title", "")
    a["content"] = fetched.get("content") or a.get("content", "")
    a["date"] = fetched.get("date") or a.get("date", "")
    a["author"] = fetched.get("author") or a.get("author", "")
    return a


def scrape_newsrooms(
    sources: Optional[dict[str, list[str]]] = None,
    on_progress=None,
) -> list[dict[str, Any]]:
    """Scrape every competitor newsroom page and return full articles.

    Two phases: (1) extract press-release headlines + links from every newsroom
    page in parallel, tagging each with its company as `group`/`source`; (2) fetch
    the full article behind every unique URL (content/date/author) via
    newspaper3k, so each record has a real date and body — otherwise the scraped
    rows are dropped downstream by file_parser.filter_articles_with_date. Enriched
    articles are then freshness-filtered (undated ones are kept).

    `on_progress(count)` (optional) is called with the running fetched-article
    count during the content-fetch phase (the slow one).
    """
    src = sources if sources is not None else TRANE_NEWSROOM_SOURCES
    # Flatten to (company, url) work items so every page is one parallel task.
    tasks: list[tuple[str, str]] = [(company, url) for company, urls in src.items() for url in urls]
    if not tasks:
        return []

    def _scrape_page(company: str, url: str) -> list[dict[str, Any]]:
        html = _fetch_html(url)
        if not html:
            return []
        links = _extract_links(html, url, company)
        # Tag with the company so downstream can slice by competitor.
        for a in links:
            a["group"] = company
        return links

    # Phase 1 — extract headline links from every newsroom page.
    links: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(10, len(tasks))) as pool:
        futures = {pool.submit(_scrape_page, company, url): (company, url) for company, url in tasks}
        for fut in as_completed(futures):
            company, url = futures[fut]
            try:
                links.extend(fut.result())
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[trane] newsroom scrape failed for {company} ({url}): {exc}")

    # Dedupe by normalized URL so the same release linked from several pages is
    # fetched only once.
    unique: dict[str, dict[str, Any]] = {}
    for a in links:
        key = normalize_url(a.get("url") or "")
        if key and key not in unique:
            unique[key] = a
    to_enrich = list(unique.values())
    logger.info(f"[trane] scraped {len(links)} link(s) -> {len(to_enrich)} unique; fetching full content")

    # Phase 2 — fetch full content/date/author per article.
    enriched: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(_ENRICH_WORKERS, len(to_enrich))) as pool:
        futures = [pool.submit(_enrich_article, a) for a in to_enrich]
        for fut in as_completed(futures):
            try:
                enriched.append(fut.result())
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[trane] article content fetch failed: {exc}")
                continue
            if on_progress is not None:
                try:
                    on_progress(len(enriched))
                except Exception:
                    logger.exception("[trane] on_progress callback failed")

    return filter_recent_articles(enriched)


# ---------------------------------------------------------------------------
# The gather loop
# ---------------------------------------------------------------------------

def gather_trane_articles(
    query_groups: Optional[list[dict[str, str]]] = None,
    language: str = "en",
    country: str = "us",
    on_progress=None,
) -> list[dict[str, Any]]:
    """Gather Trane / HVAC-industry articles, deduped by URL.

    Two source families run concurrently and are merged:
      - Competitor newsroom scrape (TRANE_NEWSROOM_SOURCES).
      - Google News RSS over `query_groups` — the session's own DB queries as
        [{group, query}]. When no queries are given, the Google-News stage is
        skipped and only the newsrooms are scraped.

    `on_progress(count)` (optional) is called with the running total across both
    source families. May be called from worker threads — the counter is
    lock-guarded here.
    """
    pool: list[dict[str, Any]] = []

    # Running per-source counts feeding the live "N fetched" counter.
    counts: dict[str, int] = {}
    counts_lock = threading.Lock()

    def _report(tag: str, n: int) -> None:
        if on_progress is None:
            return
        with counts_lock:
            counts[tag] = n
            total = sum(counts.values())
        try:
            on_progress(total)
        except Exception:
            logger.exception("[trane] on_progress callback failed")

    with ThreadPoolExecutor(max_workers=2) as pool_exec:
        scrape_future = pool_exec.submit(
            scrape_newsrooms,
            TRANE_NEWSROOM_SOURCES,
            on_progress=lambda n: _report("newsrooms", n),
        )
        gn_future = None
        if query_groups:
            gn_future = pool_exec.submit(
                google_news_rss_scraper.fetch_google_news_feedparser_boolean_query,
                query_groups,
                language=language,
                country=country,
                on_progress=lambda n: _report("google_news", n),
            )
        else:
            logger.info("[trane] no session queries provided; skipping Google News stage")

        futures = [("newsrooms", scrape_future)]
        if gn_future is not None:
            futures.append(("google_news", gn_future))
        for tag, fut in futures:
            try:
                articles = fut.result()
                pool.extend(articles)
                logger.info(f"[trane] {tag} -> {len(articles)} article(s) (pool={len(pool)})")
                if tag == "newsrooms":  # google_news already reported per query
                    _report(tag, len(articles))
            except Exception as exc:  # noqa: BLE001
                logger.exception(f"[trane] source {tag} failed: {exc}")

    deduped = dedupe_articles(pool)
    logger.info(f"[trane] gathered {len(pool)} article(s) -> {len(deduped)} after dedupe")
    return deduped

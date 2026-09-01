"""Full BeOne (BeiGene) article-gathering pipeline.

Faithful Python port of pr_intelligence_trusna's runAgentLoop (lib/agent/agent.ts)
for the BeOne company, plus the sources it calls:

    lib/agent/agent.ts        -> gather_beone_articles()  (the 3-stage loop)
    lib/sources/google-news   -> Google News RSS (via feedparser_helper)
    lib/sources/rss.ts        -> search_rss()
    lib/sources/scrape.ts     -> scrape_publications()
    lib/agent/dedupe.ts       -> dedupe_articles()
    lib/freshness.ts          -> lookback_hours() / when_clause() / parse_published_at()
    data/companies.ts (BeOne) -> BEONE_COMPANY config
    data/beone-searches.ts    -> beone_searches.BEONE_SEARCHES (curated sweep)

Gathering is deterministic — every source is called directly (no LLM decides what
to fetch), exactly like the TS pipeline. Optional NewsAPI / Bing sources from the
TS loop are omitted (that app gates them behind API keys; this app uses Google
News RSS + curated feeds). Downstream ranking/classification is the Python app's
own tagging pipeline, so it is not ported here.

Every returned article is a plain dict shaped for file_helpers/file_parser and
data_source_helpers/fetching_service._to_source_record:
    {title, url, content, source, domain, date, author, group, query, keyword_matched}
"""
from __future__ import annotations

import math
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode, urljoin

import feedparser
import requests
from bs4 import BeautifulSoup

from configs import logger
from data_source_helpers.google_news_rss import google_news_rss_scraper
from data_source_helpers.scrapper_utils import filter_recent_articles


# ---------------------------------------------------------------------------
# BeOne company config — ported from pr_intelligence_trusna/data/companies.ts
# ---------------------------------------------------------------------------

BEONE_NAME = "BeOne"

BEONE_KEYWORDS: list[str] = [
    "BeOne", "BeiGene", "Brukinsa", "zanubrutinib",
    "Tevimbra", "tislelizumab", "Zanidatamab", "ZIIHERA",
    "John Oyler", "BTK inhibitor",
    "CLL", "Chronic Lymphocytic Leukemia", "SLL", "Small Lymphocytic Lymphoma",
    "Mantle cell lymphoma", "Non-Hodgkin Lymphoma", "DLBCL",
    "cancer", "oncology", "drug",
]

# (rss_url, publisher) — the feeds() keys in companies.ts resolved to their
# actual feed URLs from lib/publications.ts, plus BeOne's extra explicit feeds.
BEONE_RSS_FEEDS: list[tuple[str, str]] = [
    ("https://ascopost.com/rss/", "The ASCO Post"),
    ("https://oncozine.com/feed/", "Onco'Zine"),
    ("https://cllsociety.org/feed/", "CLL Society"),
    ("https://medcitynews.com/feed/", "MedCity News"),
    ("https://www.medscape.com/cx/rssfeeds/2700.xml", "Medscape"),
    ("https://www.forbes.com/innovation/feed2/", "Forbes"),
    ("https://fortune.com/feed/", "Fortune"),
    ("https://www.fastcompany.com/latest/rss", "Fast Company"),
    ("https://endpts.com/feed/", "Endpoints News"),
    ("https://www.fiercepharma.com/rss/xml", "Fierce Pharma"),
    ("https://www.fiercebiotech.com/rss/xml", "Fierce Biotech"),
    ("https://www.statnews.com/feed/", "STAT News"),
    ("https://www.medpagetoday.com/rss/headlines.xml", "MedPage Today"),
    ("https://www.healthcaredive.com/feeds/news/", "Healthcare Dive"),
    ("https://medicalxpress.com/rss-feed/", "Medical Xpress"),
    ("https://www.pharmaceutical-technology.com/feed/", "Pharmaceutical Technology"),
    ("https://www.businesswire.com/rss/home/rss_news.rss", "Business Wire"),
]

BEONE_SCRAPE_TARGETS: list[str] = ["fiercepharma.com", "endpts.com", "onclive.com", "cancernetwork.com"]

# Scrape registry — ported from lib/sources/scrape.ts TARGETS. Only these domains
# are scrapeable; a company scrapeTarget not listed here is skipped (as in TS,
# where TARGETS[d] resolves to undefined and is filtered out). So BeOne effectively
# scrapes fiercepharma.com + endpts.com.
SCRAPE_TARGETS: dict[str, dict[str, Any]] = {
    "fiercepharma.com": {"start_urls": ["https://www.fiercepharma.com/"], "source": "FiercePharma"},
    "statnews.com": {"start_urls": ["https://www.statnews.com/category/pharma/"], "source": "STAT News"},
    "endpts.com": {"start_urls": ["https://endpts.com/"], "source": "Endpoints News"},
    "autonews.com": {"start_urls": ["https://www.autonews.com/"], "source": "Auto News"},
}

# Category/franchise keywords — these get paired-context queries in the sweep
# (agent.ts GENERIC set + NEWS_CONTEXT_FIXED). Ported verbatim so BeOne's generic
# keywords (cancer / drug / oncology) get the same paired treatment as in TS.
GENERIC: set[str] = {
    "pharmaceutical", "biotech", "pharma", "vaccine", "vaccines",
    "respiratory", "meningitis", "shingles", "flu", "influenza",
    "cancer", "drug", "drugs", "oncology",
    "gout", "thyroid eye", "thyroid eye disease", "ted",
    "sjögren", "sjogren", "sjögren's", "sjogren's",
    "hvac", "refrigeration", "sustainability", "cooling",
    "doctor", "nurse", "pharmacist", "physician", "psychiatrist",
    "practitioner", "anesthesiologist", "surgeon",
    "opioid use disorder", "oud", "addiction treatment",
    "drug price", "drug prices", "drug pricing", "drug cost", "drug costs",
    "price negotiation",
    "most favored nation", "most-favored nation", "most-favored-nation", "mfn",
    "340b", "psychedelic", "psychedelics",
}
NEWS_CONTEXT_FIXED = ["outbreak", "vaccination"]

_USER_AGENT = "pr-intelligence/3.0 (+python)"
# lib/freshness.ts DEFAULT_LOOKBACK_HOURS = 48 (2 days). Analyst reports include
# articles up to ~5 days old, so the window is a week, not a day.
DEFAULT_LOOKBACK_HOURS = 48


# ---------------------------------------------------------------------------
# Freshness — port of lib/freshness.ts
# ---------------------------------------------------------------------------

def lookback_hours() -> int:
    """Configured lookback window in hours (env FRESHNESS_HOURS, else 168)."""
    raw = os.getenv("FRESHNESS_HOURS")
    if not raw:
        return DEFAULT_LOOKBACK_HOURS
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_LOOKBACK_HOURS
    return int(n) if n > 0 else DEFAULT_LOOKBACK_HOURS


def parse_published_at(value: Any) -> Optional[datetime]:
    """Best-effort parse of an RSS date into an aware UTC datetime, else None."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, time.struct_time):
        try:
            return datetime.fromtimestamp(time.mktime(value), tz=timezone.utc)
        except (OverflowError, ValueError):
            return None
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        # feedparser usually gives RFC 822; email.utils handles it robustly.
        from email.utils import parsedate_to_datetime
        try:
            dt = parsedate_to_datetime(s)
            if dt is not None:
                return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            pass
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


# ---------------------------------------------------------------------------
# RSS source — port of lib/sources/rss.ts
# ---------------------------------------------------------------------------

def _domain(url: str) -> str:
    if not url:
        return ""
    return re.sub(r"^https?://(www\.)?", "", url).split("/")[0].lower()


def _pick_snippet(entry: Any) -> str:
    """Prefer content:encoded, then content/summary; strip HTML; cap 800 chars."""
    raw = ""
    content = entry.get("content")
    if isinstance(content, list) and content:
        raw = content[0].get("value") or ""
    if not raw:
        raw = entry.get("summary") or entry.get("description") or ""
    text = re.sub(r"<[^>]+>", " ", str(raw))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:800]


def _pick_author(entry: Any) -> str:
    for key in ("author", "dc_creator", "creator"):
        val = entry.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _parse_feed(feed_url: str) -> Any:
    """Fetch a feed via requests (browser UA, follows redirects) and hand the bytes
    to feedparser — mirrors the TS rss-parser, which fetches then parses.

    A failed request yields an empty parse result, which ``_fetch_one_feed`` already
    treats as "this feed had nothing". There is deliberately no
    ``feedparser.parse(feed_url)`` fallback: letting feedparser fetch means urllib with
    the socket default timeout — i.e. no timeout — and a single unanswered socket there
    hangs the whole scheduled run.
    """
    try:
        res = requests.get(
            feed_url,
            headers={"User-Agent": f"Mozilla/5.0 {_USER_AGENT}"},
            timeout=9,
            allow_redirects=True,
        )
        if res.status_code == 200 and res.content:
            return feedparser.parse(res.content)
        logger.warning(f"[beone] feed {feed_url} returned {res.status_code}")
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[beone] feed request failed for {feed_url}: {exc}")
    return feedparser.parse(b"")


def _fetch_one_feed(feed_url: str, source: str, cutoff: datetime) -> list[dict[str, Any]]:
    """Parse one RSS feed, keeping items newer than cutoff (undated items KEPT)."""
    try:
        parsed = _parse_feed(feed_url)
        out: list[dict[str, Any]] = []
        for entry in (parsed.entries or [])[:80]:
            title = (entry.get("title") or "").strip()
            link = (entry.get("link") or entry.get("id") or "").strip()
            if not title or not link:
                continue
            raw_date = entry.get("published") or entry.get("updated") or None
            pub_dt = parse_published_at(entry.get("published_parsed") or raw_date)
            # Source-level freshness filter: drop dated items older than cutoff.
            if pub_dt and pub_dt < cutoff:
                continue
            out.append({
                "title": title,
                "url": link,
                "content": _pick_snippet(entry),
                "source": source,
                "domain": _domain(link),
                "date": str(raw_date or (pub_dt.isoformat() if pub_dt else "")),
                "author": _pick_author(entry),
                "group": "RSS Feeds",
                "sourceType": "rss",
            })
        return out
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[beone] RSS fetch failed for {source} ({feed_url}): {exc}")
        return []


def search_rss(
    feeds: list[tuple[str, str]] = BEONE_RSS_FEEDS,
    extra_terms: Optional[list[str]] = None,
) -> list[dict[str, Any]]:
    """Fetch all of BeOne's curated RSS feeds in parallel, freshness-filtered.

    If extra_terms is given, keep only items whose title/content mention one of
    them (matches lib/sources/rss.ts extraTerms behaviour)."""
    cutoff = datetime.now(timezone.utc).timestamp() - lookback_hours() * 3600
    cutoff_dt = datetime.fromtimestamp(cutoff, tz=timezone.utc)

    all_articles: list[dict[str, Any]] = []
    if feeds:
        with ThreadPoolExecutor(max_workers=min(10, len(feeds))) as pool:
            futures = {pool.submit(_fetch_one_feed, url, src, cutoff_dt): src for url, src in feeds}
            for fut in as_completed(futures):
                try:
                    all_articles.extend(fut.result())
                except Exception as exc:  # noqa: BLE001
                    logger.warning(f"[beone] RSS worker failed for {futures[fut]}: {exc}")

    all_articles = filter_recent_articles(all_articles)
    if not extra_terms:
        return all_articles
    lowered = [t.lower() for t in extra_terms]
    return [
        a for a in all_articles
        if any(t in f"{a['title']} {a.get('content', '')}".lower() for t in lowered)
    ]


# ---------------------------------------------------------------------------
# Scrape source — port of lib/sources/scrape.ts
# ---------------------------------------------------------------------------

def _fetch_html(url: str) -> Optional[str]:
    try:
        res = requests.get(url, headers={"User-Agent": f"Mozilla/5.0 {_USER_AGENT}"}, timeout=10)
        if res.status_code != 200:
            return None
        return res.text
    except Exception:  # noqa: BLE001
        return None


def _extract_links(html: str, base_url: str, source: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for el in soup.find_all("a"):
        href = el.get("href")
        title = el.get_text(strip=True)
        if not href or not title or len(title) < 15 or len(title) > 250:
            continue
        try:
            absolute = urljoin(base_url, href)
        except ValueError:
            continue
        if absolute in seen:
            continue
        seen.add(absolute)
        out.append({
            "title": title,
            "url": absolute,
            "content": "",
            "source": source,
            "domain": _domain(absolute),
            "date": "",
            "author": "",
            "group": "Scrape",
            "sourceType": "scrape",
        })
    return out[:100]


def scrape_publications(
    company: str = BEONE_NAME,
    extra_terms: Optional[list[str]] = None,
    domains: Optional[list[str]] = None,
) -> list[dict[str, Any]]:
    """Scrape publication front pages for headlines mentioning the company.

    Only domains present in SCRAPE_TARGETS are scraped (others are skipped, as in
    the TS TARGETS lookup)."""
    keys = domains if domains else list(SCRAPE_TARGETS.keys())
    targets = [(d, SCRAPE_TARGETS[d]) for d in keys if d in SCRAPE_TARGETS]
    if not targets:
        return []

    lowered = [company.lower()] + [t.lower() for t in (extra_terms or [])]
    all_articles: list[dict[str, Any]] = []

    def _scrape_target(target: dict[str, Any]) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        for url in target["start_urls"]:
            html = _fetch_html(url)
            if not html:
                continue
            links = _extract_links(html, url, target["source"])
            found.extend(a for a in links if any(term in a["title"].lower() for term in lowered))
        return found

    with ThreadPoolExecutor(max_workers=min(10, len(targets))) as pool:
        futures = [pool.submit(_scrape_target, t) for _, t in targets]
        for fut in as_completed(futures):
            try:
                all_articles.extend(fut.result())
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[beone] scrape worker failed: {exc}")
    return filter_recent_articles(all_articles)


# ---------------------------------------------------------------------------
# URL normalization + dedup — port of lib/agent/dedupe.ts
# ---------------------------------------------------------------------------

_UTM_KEYS = {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
             "gclid", "fbclid", "_hsenc", "_hsmi"}


def normalize_url(url: str) -> str:
    try:
        u = urlparse(url)
        host = (u.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        query = urlencode([(k, v) for k, v in parse_qsl(u.query) if k not in _UTM_KEYS])
        path = u.path
        if len(path) > 1 and path.endswith("/"):
            path = path[:-1]
        netloc = host + (f":{u.port}" if u.port else "")
        return urlunparse((u.scheme, netloc, path, "", query, ""))
    except Exception:  # noqa: BLE001
        return url.strip().lower()


def _normalize_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def dedupe_articles(articles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse the same article seen via RSS + Google News + scrape into one row,
    matching on normalized URL (title as fallback). Prefers a copy with a snippet
    and preserves a non-empty group/keyword_matched from whichever copy had it."""
    by_url: dict[str, dict[str, Any]] = {}
    by_title: dict[str, dict[str, Any]] = {}

    for a in articles:
        link = (a.get("url") or "").strip()
        title = (a.get("title") or "").strip()
        if not link or not title:
            continue
        norm_url = normalize_url(link)
        norm_title = _normalize_title(title)
        existing = by_url.get(norm_url) or by_title.get(norm_title)

        if existing is None:
            by_url[norm_url] = a
            by_title[norm_title] = a
            continue

        winner = existing
        # Prefer the copy that has content/snippet.
        if not existing.get("content") and a.get("content"):
            winner = a
        loser = a if winner is existing else existing
        # Preserve provenance: keep a group / keyword_matched if either copy had it.
        if not winner.get("group") and loser.get("group"):
            winner["group"] = loser["group"]
        if not winner.get("keyword_matched") and loser.get("keyword_matched"):
            winner["keyword_matched"] = loser["keyword_matched"]

        by_url[norm_url] = winner
        by_title[norm_title] = winner

    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for a in by_url.values():
        k = normalize_url(a.get("url") or "")
        if k in seen:
            continue
        seen.add(k)
        out.append(a)
    return out

# ---------------------------------------------------------------------------
# The gather loop — port of lib/agent/agent.ts runAgentLoop(BeOne)
# ---------------------------------------------------------------------------

def gather_beone_articles(
    query_groups: Optional[list[dict[str, str]]] = None,
    language: str = "en",
    country: str = "us",
    on_progress=None,
    recency_hours: Optional[int] = None,
    skip_url=None,
) -> list[dict[str, Any]]:
    """Gather BeOne articles from every source the TS loop uses, deduped by URL.

    Stage 1: curated RSS feeds + Google News (company name) + publication scrape.
    Stage 2: keyword-coverage sweep (Google News).
    Stage 3: analyst-curated bookmark sweep (Google News, BEONE_SEARCHES).

    All Google-News stages share one parallel feedparser pass (deduped by URL,
    tagged with group + keyword_matched); RSS and scrape run alongside. The three
    pools are merged and de-duplicated. Recency = the lookback window (default 7d,
    env FRESHNESS_HOURS): Google News via `when:`, RSS via a source-side cutoff.

    - `query_groups` (optional) is the [{group, query}] Google-News query set to run —
    pass the session's own DB queries here. When None, falls back to the built-in
    BeOne sweep (_google_news_query_groups). RSS + scrape stages are unaffected.

    - `on_progress(count)` (optional) is called with the running total across all
    three source families as articles come in (Google News reports per query;
    RSS/scrape report when their pool completes). May be called from worker
    threads — the counter itself is lock-guarded here.

    - `recency_hours` (optional) narrows the Google-News lookback for this call — an
    hourly top-up asks for an hour instead of the default window. `skip_url(url)`
    (optional) drops an already-stored Google-News result before its body is
    downloaded. Both only affect the Google-News stage: the curated RSS feeds and
    the publication scrape have their own fixed source-side windows.
    """
    pool: list[dict[str, Any]] = []

    # Running per-source counts feeding the live "N fetched" counter. Google News
    # updates its slot from its own merge thread while this thread updates the
    # rss/scrape slots, hence the lock.
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
            logger.exception("[beone] on_progress callback failed")

    # Run the three source families concurrently.
    with ThreadPoolExecutor(max_workers=3) as pool_exec:
        gn_kwargs: dict[str, Any] = {
            "language": language,
            "country": country,
            "on_progress": lambda n: _report("google_news", n),
            "skip_url": skip_url,
        }
        if recency_hours is not None:
            gn_kwargs["recency_hours"] = recency_hours
        gn_future = pool_exec.submit(
            google_news_rss_scraper.fetch_google_news_feedparser_boolean_query,
            query_groups,
            **gn_kwargs,
        )
        rss_future = pool_exec.submit(search_rss, BEONE_RSS_FEEDS, None)
        scrape_future = pool_exec.submit(scrape_publications, BEONE_NAME, [], BEONE_SCRAPE_TARGETS)

        # for tag, fut in (("rss", rss_future), ("scrape", scrape_future)):
        for tag, fut in (("google_news", gn_future), ("rss", rss_future), ("scrape", scrape_future)):
            try:
                articles = fut.result()
                pool.extend(articles)
                logger.info(f"[beone] {tag} -> {len(articles)} article(s) (pool={len(pool)})")
                if tag != "google_news":  # google_news already reported per query
                    _report(tag, len(articles))
            except Exception as exc:  # noqa: BLE001
                logger.exception(f"[beone] source {tag} failed: {exc}")

    deduped = dedupe_articles(pool)
    logger.info(f"[beone] gathered {len(pool)} article(s) -> {len(deduped)} after dedupe")
    return deduped

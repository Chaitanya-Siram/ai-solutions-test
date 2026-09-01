"""Full-article content fetcher.

article_content_fetch(article) takes a dict with at least {url, title, published}
and returns {title, url, content, date, author, is_subscription}.

Two fetch strategies, tried in order:

  1. Direct browser-UA HTTP fetch. newspaper3k's own Article.download() uses a
     `newspaper/0.2.8` User-Agent with no browser headers, which most press sites
     403-block — so we fetch the HTML ourselves with a real browser UA + headers
     (retrying with a different UA on a block) and hand it to newspaper3k to parse.

  2. Scraping-API fallback. Sites behind Cloudflare/Akamai bot-management (AP,
     Reuters, FiercePharma, Endpoints, …) block any plain HTTP client regardless
     of headers. When the direct fetch is blocked or returns too little, and a
     scraping API is configured (SCRAPER_API_KEY set), the URL is routed through
     that service (which handles proxies + JS rendering) and the returned HTML is
     parsed the same way.

The scraping API is provider-agnostic — it issues a GET to SCRAPER_API_ENDPOINT
with the api-key and target-url as query params. Defaults match ScraperAPI; the
param names are overridable via env for ScrapingBee / ScrapingAnt / etc.:

    SCRAPER_API_KEY          your API key (fetch stays dormant until this is set)
    SCRAPER_API_ENDPOINT     default https://api.scraperapi.com/
    SCRAPER_API_KEY_PARAM    default "api_key"   (ScrapingBee also uses api_key)
    SCRAPER_API_URL_PARAM    default "url"
    SCRAPER_API_RENDER_PARAM default "render"     (ScrapingBee: "render_js")
    SCRAPER_API_RENDER       default "true"       (JS rendering; costs more credits)
    SCRAPER_API_TIMEOUT      default 70 (seconds; rendered fetches are slow)
"""
from __future__ import annotations

import os
from typing import Any, Optional
from urllib.parse import urlencode

import requests
from bs4 import BeautifulSoup
from newspaper import Article, Config

from configs import logger

# A few realistic desktop browser UAs — rotated across retries so a UA-based block
# on one attempt can be retried with another.
_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
]

# Browser-like headers so the request doesn't read as a bot to WAFs.
_DEFAULT_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
}

# One pooled session, reused across the thread pool (requests.Session GETs are
# thread-safe via urllib3's connection pool).
_session = requests.Session()

_REQUEST_TIMEOUT = 15          # seconds per direct attempt
_MAX_ATTEMPTS = 3              # UA rotations before giving up
_BLOCK_STATUSES = {401, 403, 429, 451}
_MIN_CONTENT_CHARS = 200       # below this, try the BeautifulSoup fallback / scraping API

# --- Scraping-API fallback config (all optional; dormant unless SCRAPER_API_KEY set) ---
_SCRAPER_API_KEY = os.getenv("SCRAPER_API_KEY", "").strip()
_SCRAPER_API_ENDPOINT = os.getenv("SCRAPER_API_ENDPOINT", "https://api.scraperapi.com/").strip()
_SCRAPER_API_KEY_PARAM = os.getenv("SCRAPER_API_KEY_PARAM", "api_key").strip()
_SCRAPER_API_URL_PARAM = os.getenv("SCRAPER_API_URL_PARAM", "url").strip()
_SCRAPER_API_RENDER_PARAM = os.getenv("SCRAPER_API_RENDER_PARAM", "render").strip()
_SCRAPER_API_RENDER = os.getenv("SCRAPER_API_RENDER", "true").strip()


def _scraper_api_timeout() -> int:
    try:
        return int(os.getenv("SCRAPER_API_TIMEOUT", "70"))
    except (TypeError, ValueError):
        return 70


def _scraper_api_enabled() -> bool:
    return bool(_SCRAPER_API_KEY)


def _fetch_html_direct(url: str) -> tuple[Optional[str], bool]:
    """Fetch page HTML with a browser UA + headers, retrying with a different UA on
    failure or block. Returns (html, blocked); html is None when nothing usable
    came back, and blocked is True when a WAF/paywall status was seen."""
    if not url:
        return None, False
    blocked = False
    for attempt in range(_MAX_ATTEMPTS):
        headers = {**_DEFAULT_HEADERS, "User-Agent": _USER_AGENTS[attempt % len(_USER_AGENTS)]}
        try:
            res = _session.get(url, headers=headers, timeout=_REQUEST_TIMEOUT, allow_redirects=True)
        except requests.RequestException as exc:
            logger.debug(f"[article_fetch] request error for {url} (attempt {attempt + 1}): {exc}")
            continue
        if res.status_code in _BLOCK_STATUSES:
            blocked = True
            continue
        if res.status_code == 200 and res.text:
            return res.text, False
    return None, blocked


def _fetch_html_via_scraper_api(url: str) -> Optional[str]:
    """Fetch page HTML through the configured scraping API (proxies + JS render).
    Returns None when the API isn't configured or the call fails."""
    if not url or not _scraper_api_enabled():
        return None
    params = {
        _SCRAPER_API_KEY_PARAM: _SCRAPER_API_KEY,
        _SCRAPER_API_URL_PARAM: url,
    }
    if _SCRAPER_API_RENDER_PARAM and _SCRAPER_API_RENDER:
        params[_SCRAPER_API_RENDER_PARAM] = _SCRAPER_API_RENDER
    request_url = f"{_SCRAPER_API_ENDPOINT}?{urlencode(params)}"
    try:
        res = _session.get(request_url, timeout=_scraper_api_timeout())
    except requests.RequestException as exc:
        logger.warning(f"[article_fetch] scraping API error for {url}: {exc}")
        return None
    if res.status_code == 200 and res.text:
        return res.text
    logger.warning(f"[article_fetch] scraping API returned {res.status_code} for {url}")
    return None


def _extract_with_bs4(html: str) -> str:
    """Fallback body extraction: join the paragraphs of the main article container."""
    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception:  # noqa: BLE001
        return ""
    container = soup.find("article") or soup.find("main") or soup
    paras = [p.get_text(" ", strip=True) for p in container.find_all("p")]
    return "\n\n".join(p for p in paras if len(p) > 30).strip()


def _parse_article(url: str, html: str, fallback_title: str, fallback_date: str) -> dict[str, Any]:
    """Parse HTML into an article dict via newspaper3k, with a BeautifulSoup body
    fallback. `content` may come back empty when nothing extractable was found."""
    config = Config()
    config.browser_user_agent = _USER_AGENTS[0]
    config.request_timeout = _REQUEST_TIMEOUT
    config.fetch_images = False
    config.memoize_articles = False

    parsed = Article(url, config=config)
    parsed.download(input_html=html)   # parse the HTML we already fetched
    parsed.parse()

    content = (parsed.text or "").strip()
    if len(content) < _MIN_CONTENT_CHARS:
        bs_text = _extract_with_bs4(html)
        if len(bs_text) > len(content):
            content = bs_text

    date = str(
        parsed.publish_date
        or parsed.meta_data.get("iso-8601-publish-date", None)
        or fallback_date
        or ""
    )
    return {
        "title": (parsed.title or "").strip() or fallback_title,
        "url": parsed.url or url,
        "content": content,
        "date": date,
        "author": ", ".join(parsed.authors) if parsed.authors else "",
    }


def _is_thin(result: Optional[dict[str, Any]]) -> bool:
    """True when a parse result has no usable body (so the scraping API is worth trying)."""
    return not result or len((result.get("content") or "").strip()) < _MIN_CONTENT_CHARS


def article_content_fetch2(article: dict[str, Any]) -> dict[str, Any]:
    """Fetch and parse the full article at article["url"].

    Tries a direct browser-UA HTTP fetch first, then (if that's blocked or thin and
    a scraping API is configured) the scraping-API fallback. Returns
    {title, url, content, date, author}. On total failure, content is "Subscription"
    (unchanged contract), so callers can still tell the fetch yielded no body.
    """
    url = article.get("url", "")
    fallback_title = article.get("title", "") or ""
    fallback_date = article.get("published") or ""

    result: Optional[dict[str, Any]] = None
    try:
        # 1) Direct browser-UA fetch.
        html, blocked = _fetch_html_direct(url)
        if html:
            result = _parse_article(url, html, fallback_title, fallback_date)

        # 2) Scraping-API fallback when the direct fetch failed/blocked or came back thin.
        if _is_thin(result) and _scraper_api_enabled():
            logger.info(f"[article_fetch] direct fetch {'blocked' if blocked else 'thin'}; using scraping API for {url}")
            api_html = _fetch_html_via_scraper_api(url)
            if api_html:
                api_result = _parse_article(url, api_html, fallback_title, fallback_date)
                # Keep whichever gave more body.
                if result is None or len(api_result["content"]) > len(result["content"]):
                    result = api_result
    except Exception as exc:  # noqa: BLE001
        logger.debug(f"[article_fetch] failed for {url}: {exc}")

    if result is None:
        return {
            "title": fallback_title,
            "url": url,
            "content": "Subscription",
            "date": fallback_date,
            "author": "",
        }
    # Empty body => mark as Subscription so downstream treats it as a failed fetch.
    if not (result.get("content") or "").strip():
        result["content"] = "Subscription"
    return result


def article_content_fetch(article):
    decode_error = article.get("decode_error") or article.get("error")
    try:
        fetched_article = Article(article["url"])
        fetched_article.download()
        fetched_article.parse()
        content = fetched_article.text
        json_article = {
            "title": fetched_article.title,
            "url": fetched_article.url,
            "content": content,
            "date": str(fetched_article.publish_date or fetched_article.meta_data.get("iso-8601-publish-date", None) or article["published"] or ""),
            "author": ", ".join(fetched_article.authors) if fetched_article.authors else "",
            "is_subscription": (content or "").strip() == "Subscription"
        }
    except:
        json_article = {
            "title": article["title"],
            "url": article["url"],
            "content": "Subscription",
            "date": article["published"],
            "author": "",
            "is_subscription": True
        }
    if decode_error:
        json_article["decode_error"] = decode_error
    return json_article
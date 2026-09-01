import codecs
import io
import json
from typing import Any
import pandas as pd

SUPPORTED_EXTENSIONS = {"csv", "xlsx", "xls", "json"}

# UTF-32 BOMs must be tested before UTF-16: the LE forms share a 2-byte prefix.
_BOM_ENCODINGS = (
    (codecs.BOM_UTF8, "utf-8-sig"),
    (codecs.BOM_UTF32_LE, "utf-32"),
    (codecs.BOM_UTF32_BE, "utf-32"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
)

_DELIMITERS = ("\t", ",", ";", "|")


def _ext(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def _decode_text(content: bytes) -> str:
    """Decode file bytes, honoring a BOM if present.

    Media-monitoring exports (BeOne, Meltwater) are often UTF-16 with a BOM, so
    a plain utf-8 decode blows up on the very first byte.

    Args:
        content: Raw file bytes.

    Returns:
        Decoded text with any BOM stripped.
    """
    for bom, encoding in _BOM_ENCODINGS:
        if content.startswith(bom):
            return content.decode(encoding)
    try:
        return content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return content.decode("latin-1")


def _read_csv(content: bytes) -> pd.DataFrame:
    """Read CSV bytes into a DataFrame, detecting encoding and delimiter.

    Args:
        content: Raw file bytes.

    Returns:
        Parsed DataFrame.
    """
    text = _decode_text(content)
    header = next((line for line in text.splitlines() if line.strip()), "")
    delimiter = max(_DELIMITERS, key=header.count)
    return pd.read_csv(io.StringIO(text), sep=delimiter)


def _sniff_json(content: bytes) -> Any:
    """Return the parsed JSON payload when `content` is actually JSON, else None.

    Lets us round-trip a source file as JSON (e.g. after the pipeline writes the
    is_relevant column back onto the raw file) even if the S3 key keeps its
    original .csv/.xlsx extension. Only triggers when the content really is a JSON
    object/array, so genuine CSV/Excel bytes fall through untouched.
    """
    text = _decode_text(content).lstrip()
    if not text or text[0] not in "[{":
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _records_from_json(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return filter_articles_with_date(update_columns_name([r for r in payload if isinstance(r, dict)]))
    if isinstance(payload, dict):
        for key in ("data", "articles", "items", "results", "records"):
            if key in payload and isinstance(payload[key], list):
                return filter_articles_with_date(update_columns_name([r for r in payload[key] if isinstance(r, dict)]))
        return filter_articles_with_date(update_columns_name([payload]))
    raise ValueError("JSON payload must be a list of objects or a dict containing one.")


def parse_upload(filename: str, content: bytes) -> list[dict[str, Any]]:
    """Parse a CSV/Excel/JSON file into a list of records with normalized keys.

    All keys are lowercased; known column variants (title/content/date/audience/
    engagement/url) are renamed to their canonical form. The JSON file may be
    either a list of objects or a dict containing a list under one of the
    common keys (data, articles, items, results).

    JSON content is detected by sniffing the bytes first, so a file whose key
    still ends in .csv/.xlsx but whose content has been rewritten as JSON (the
    pipeline does this to stamp the is_relevant column onto the raw file) is still
    parsed correctly.
    """
    sniffed = _sniff_json(content)
    if sniffed is not None:
        return _records_from_json(sniffed)

    ext = _ext(filename)
    if ext not in SUPPORTED_EXTENSIONS:
        raise ValueError(f"Unsupported file type '.{ext}'. Use one of: {sorted(SUPPORTED_EXTENSIONS)}")

    if ext == "csv":
        df = _read_csv(content)
        json_data = df_to_records(df)
        updated_data = update_columns_name(json_data)
        filtered_data = filter_articles_with_date(updated_data)
        return filtered_data

    if ext in {"xlsx", "xls"}:
        df = pd.read_excel(io.BytesIO(content))
        json_data = df_to_records(df)
        updated_data = update_columns_name(json_data)
        filtered_data = filter_articles_with_date(updated_data)
        return filtered_data

    # json (by extension)
    payload = json.loads(_decode_text(content))
    return _records_from_json(payload)


def df_to_records(df: pd.DataFrame) -> list[dict[str, Any]]:
    """Convert a DataFrame to records, coercing pandas/numpy Timestamps to ISO
    strings so downstream code can treat date fields as plain strings (the
    charts rely on `date[:10]` to get the YYYY-MM-DD prefix).
    """
    df = df.astype(object).where(pd.notnull(df), None)
    records = df.to_dict(orient="records")
    for record in records:
        for key, value in record.items():
            if isinstance(value, pd.Timestamp):
                record[key] = value.isoformat()
            elif not isinstance(value, str) and hasattr(value, "isoformat"):
                record[key] = value.isoformat()
    return records


TITLE_FIELD_CANDIDATES = ("title", "headline", "subject")

TEXT_FIELD_CANDIDATES = ("article", "article_text", "content", "body", "text", "description", "story", "summary", "opening text")

PUB_DATE_FIELD_CANDIDATES = ("pub_date", "publication_date", "date", "created_at", "timestamp", "publisheddate", "publish date", "pubdate", "date published")

FOLLOWERS_FIELD_CANDIDATES = ("followers", "followers_count", "audience")

ENGAGEMENT_FIELD_CANDIDATES = ("engagement", "engagements", "engagement_count", "interactions", "interaction")

URL_FIELD_CANDIDATES = ("url", "link", "article_url", "post_url", "post url", "post link")

MEDIA_TYPE_FIELD_CANDIDATES = ("media_type", "type", "channel", "media type", "channel type", "media_types", "media types")

AUTHOR_FIELD_CANDIDATES = ("author", "influencer", "creator", "author name", "author_name", "writer", "authors", "authorbyline", "journalist/author", "journalist")


_STANDARD_FIELD_MAP: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("title", TITLE_FIELD_CANDIDATES),
    ("content", TEXT_FIELD_CANDIDATES),
    ("date", PUB_DATE_FIELD_CANDIDATES),
    ("audience", FOLLOWERS_FIELD_CANDIDATES),
    ("engagement", ENGAGEMENT_FIELD_CANDIDATES),
    ("url", URL_FIELD_CANDIDATES),
    ("media_type", MEDIA_TYPE_FIELD_CANDIDATES),
    ("author", AUTHOR_FIELD_CANDIDATES),
)

def rename_record(record: dict[str, Any]) -> dict[str, Any]:
    """Lowercase every key in `record`, rename known variants (title/content/
    date/audience/engagement/url) to their canonical names. On case collisions
    the first occurrence wins so original ordering is preserved."""
    lower_keys = {k.lower(): k for k in record.keys() if isinstance(k, str)}

    # Build a map of lowercased original key -> canonical name (for matched candidates).
    canonical_map: dict[str, str] = {}
    for standard_name, candidates in _STANDARD_FIELD_MAP:
        for cand in candidates:
            if cand in lower_keys:
                canonical_map[cand] = standard_name
                break

    out: dict[str, Any] = {}
    for k, v in record.items():
        if not isinstance(k, str):
            out[k] = v
            continue
        lk = k.lower()
        new_key = canonical_map.get(lk, lk)
        if new_key in out:
            continue  # collision (e.g. both 'Title' and 'title') — first wins
        out[new_key] = v
    return out


def update_columns_name(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize every record's keys: lowercase + rename known variants to
    canonical names. Returns a new list; non-dict entries are skipped."""
    return [rename_record(r) for r in records if isinstance(r, dict)]


def filter_articles_with_date(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop records that don't have a usable `date` value. Run AFTER
    update_columns_name so the date variants have already been renamed to the
    canonical `date` key."""
    filtered_articles = []
    for item in records:
        if not isinstance(item, dict):
            continue
        date_val = item.get("date")
        if isinstance(date_val, str) and date_val.strip():
            filtered_articles.append(item)
        if item.get("title") is None and item.get("content") is None:
            continue  # skip records that have no title or content after filtering
        elif len(item.get("title", "") or "") == 0 and len(item.get("content", "") or "") == 0:
            continue
    return filtered_articles

from collections import defaultdict
from db_helpers.schema import ChartResult


def apply_section_order(result: dict, sections_orders) -> dict:
    """Reorder a {section: articles} map by the given ordered section names: listed
    sections first (empty list if a listed section is absent), then any leftover
    sections in their original order. Matching is case-insensitive."""
    if not sections_orders:
        return result
    by_lower = {k.lower(): k for k in result}
    ordered: dict = {}
    used: set = set()
    for name in sections_orders:
        key = by_lower.get(str(name).strip().lower())
        if key is not None:
            ordered[key] = result[key]
            used.add(key)
        else:
            ordered[str(name)] = []  # listed section with no articles
    for key, articles in result.items():
        if key not in used:
            ordered[key] = articles  # section in data but not in the list
    return ordered


def media_monitoring_charts(data, sections_orders=None):
    """
    Return the top articles per media-monitoring section for the dashboard:
    up to 20 articles for every section present in the data.

    One entry per *story*, not per article: articles sharing a `similar_group_id` are
    collapsed to their highest-reach member, and the rest of the story is returned under
    that entry's `similar_articles`. Syndicated copies are left out entirely.

    Within each section, priority_watch=True articles come first, then the
    remainder is ordered by reach descending. Sections are taken directly from
    each article's `section` label — no section names are hardcoded.

    When `sections_orders` (the project's ordered section names) is provided, the
    response sections follow that order: listed sections come first (in order, with
    an empty list when a section has no articles), then any leftover sections found
    in the data are appended at the end.
    """

    def _reach_int(item) -> int:
        try:
            return int(item.get("reach") or 0)
        except (TypeError, ValueError):
            return 0

    # One feed entry per story, not per article. Articles are bucketed by
    # `similar_group_id` — the uuid every telling of one story shares — and the bucket's
    # highest-reach member represents it, with the others listed beneath as
    # "Similar Articles: domain1, domain2".
    #
    # Bucketing by group id rather than by a pointer at the story's "main" article is
    # what keeps a story whole when the session window excludes the article the group
    # started from: there is no main to be missing. A row with no group id (one that
    # predates the grouping backfill) stands alone under its own key.
    groups: dict[str, list[dict]] = defaultdict(list)
    for item in data:
        # Syndicated copies never appear in the feed — they are the same article
        # republished, and they carry their main's group id.
        if item.get("syndication_of"):
            continue
        groups[item.get("similar_group_id") or f"__ungrouped__{item.get('id')}"].append(item)

    # Map each representative's id -> {domain: url} for the rest of its story.
    similar_map: dict[str, dict[str, str]] = defaultdict(dict)
    representatives: list[dict] = []
    for members in groups.values():
        # Highest reach represents the story, falling back to the earliest published so
        # the choice is stable when nothing has a reach figure.
        members = sorted(members, key=lambda a: (-_reach_int(a), str(a.get("date") or "9999")))
        main, rest = members[0], members[1:]
        representatives.append(main)
        for other in rest:
            domain = other.get("domain_name") or other.get("url") or ""
            if domain:
                similar_map[main.get("id")][domain] = other.get("url") or ""

    sections_data: dict[str, list[dict]] = defaultdict(list)
    for item in representatives:
        section = item.get("section") or "Uncategorized"
        sections_data[section].append({
            "id": item.get("id"),
            "title": item.get("title"),
            "content": item.get("content"),
            "summary": item.get("summary"),
            "sentiment": item.get("sentiment"),
            "date": item.get("date"),
            "url": item.get("url"),
            "domain": item.get("domain_name"),
            "author": item.get("author"),
            "reach": item.get("reach"),
            "priority": item.get("priority_watch"),
            "similar_articles": dict(similar_map.get(item.get("id"), {})),
        })

    # Top N per section (priority-watch first, then by reach desc), preserving
    # the order sections first appear in the data.
    result: dict[str, list[dict]] = {}
    for section, articles in sections_data.items():
        articles.sort(
            key=lambda a: (0 if a.get("priority") else 1, -_reach_int(a))
        )
        result[section] = articles

    # Order sections by the project's sections_orders when provided.
    result = apply_section_order(result, sections_orders)

    # Regroup the final selected articles by date (chronological). Each
    # entry carries its `section` so the frontend can render the day-wise
    # feed without losing context.
    date_grouped: dict[str, list[dict]] = {}
    for section, articles in result.items():
        for article in articles:
            date_key = str(article.get("date") or "")[:10] or "unknown"
            date_grouped.setdefault(date_key, []).append({**article, "section": section})

    grouped_articles = dict(sorted(date_grouped.items()))

    charts_data = ChartResult(
        chart_id="section_articles",
        title="Top Articles by Section",
        description="Top 20 articles per media-monitoring section, with priority-watch items first, then ordered by reach.",
        chart_type="table",
        data=result,
        series=[],
        x_label="",
        y_label="",
    )

    return charts_data, grouped_articles

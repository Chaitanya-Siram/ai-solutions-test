from datetime import date

from sqlalchemy.orm import Session

from db_helpers.models.report_comparison_model import (
    ReportComparisonModel,
    ReportMissingArticles,
    ReportSectionMismatches,
)
from db_helpers.models.tagged_article_model import TaggedArticleModel


def get_session_articles(db: Session, session_id: int) -> list[dict]:
    """URL, section and relevancy of every tagged article listing `session_id`.

    Args:
        db: Database session.
        session_id: Session whose articles to collect.

    Returns:
        List of dicts with `url`, `section` and `is_relevant`.
    """
    rows = (
        db.query(
            TaggedArticleModel.url,
            TaggedArticleModel.section,
            TaggedArticleModel.is_relevant,
        )
        .filter(TaggedArticleModel.sessions_id.contains([session_id]))
        .all()
    )
    return [
        {"url": url, "section": section, "is_relevant": is_relevant}
        for url, section, is_relevant in rows
        if url
    ]


def list_report_comparisons(db: Session, project_id: int) -> list[dict]:
    """A project's comparisons oldest-first, with missing and section-mismatched rows.

    Oldest-first because the screen plots them as a time series.

    Args:
        db: Database session.
        project_id: Project to list comparisons for.

    Returns:
        List of comparison dicts, each carrying `missing` and `section_mismatches`.
    """
    rows = (
        db.query(ReportComparisonModel)
        .filter(ReportComparisonModel.project_id == project_id)
        .order_by(ReportComparisonModel.report_date)
        .all()
    )
    if not rows:
        return []

    comparison_ids = [r.id for r in rows]
    missing = (
        db.query(ReportMissingArticles)
        .filter(ReportMissingArticles.comparison_id.in_(comparison_ids))
        .all()
    )
    by_comparison: dict[int, list[dict]] = {}
    for article in missing:
        by_comparison.setdefault(article.comparison_id, []).append(
            {
                "id": article.id,
                "title": article.title,
                "url": article.url,
                "keywords": article.keywords,
                "reason_for_not_found": article.reason_for_not_found,
            }
        )

    mismatches = (
        db.query(ReportSectionMismatches)
        .filter(ReportSectionMismatches.comparison_id.in_(comparison_ids))
        .all()
    )
    mismatches_by_comparison: dict[int, list[dict]] = {}
    for article in mismatches:
        mismatches_by_comparison.setdefault(article.comparison_id, []).append(
            {
                "id": article.id,
                "title": article.title,
                "url": article.url,
                "ai_section": article.ai_section,
                "correct_section": article.correct_section,
            }
        )

    return [
        {
            "id": row.id,
            "project_id": row.project_id,
            "report_date": row.report_date,
            "total_session_articles": row.total_session_articles,
            "total_report_articles": row.total_report_articles,
            "total_articles_found_in_tool": row.total_articles_found_in_tool,
            "tagged_irrelevant": row.tagged_irrelevant,
            "created_at": row.created_at,
            "missing": by_comparison.get(row.id, []),
            "section_mismatches": mismatches_by_comparison.get(row.id, []),
        }
        for row in rows
    ]


def update_missing_article_fields(
    db: Session, article_id: int, fields: dict
) -> ReportMissingArticles | None:
    """Set the user-editable fields on one missing-article row.

    Args:
        db: Database session.
        article_id: The `report_missing_articles` row to update.
        fields: Any of `keywords` / `reason_for_not_found`; blank values clear the
            field, and a key left out is not touched.

    Returns:
        The updated row, or None when no such row exists.
    """
    row = (
        db.query(ReportMissingArticles)
        .filter(ReportMissingArticles.id == article_id)
        .first()
    )
    if row is None:
        return None

    for name in ("keywords", "reason_for_not_found"):
        if name in fields:
            cleaned = (fields[name] or "").strip()
            setattr(row, name, cleaned or None)

    db.commit()
    db.refresh(row)
    return row


def upsert_report_comparison(
    db: Session,
    project_id: int,
    session_id: int,
    report_date: date,
    total_session_articles: int,
    total_report_articles: int,
    total_articles_found_in_tool: int,
    tagged_irrelevant: int,
    missing: list[dict],
    section_mismatches: list[dict],
) -> ReportComparisonModel:
    """Store the comparison counts, missing articles and section mismatches.

    Any prior run for the same project/session/date is replaced.

    Args:
        db: Database session.
        project_id: Project the report belongs to.
        report_date: Date the report covers.
        total_session_articles: Article count the session holds.
        total_report_articles: Article count in the uploaded report.
        total_articles_found_in_tool: How many of those the tool already has.
        tagged_irrelevant: How many of the found ones the tool marked not relevant.
        missing: Report rows with no match, each with `headline` and `url`.
        section_mismatches: Found rows whose report section differs from the tagged
            one, each with `headline`, `url`, `ai_section` and `correct_section`.

    Returns:
        The saved row.
    """
    row = (
        db.query(ReportComparisonModel)
        .filter(
            ReportComparisonModel.project_id == project_id,
            ReportComparisonModel.session_id == session_id,
            ReportComparisonModel.report_date == report_date,
        )
        .first()
    )
    if row is None:
        row = ReportComparisonModel(project_id=project_id, session_id=session_id, report_date=report_date)
        db.add(row)
        db.flush()

    row.total_session_articles = total_session_articles
    row.total_report_articles = total_report_articles
    row.total_articles_found_in_tool = total_articles_found_in_tool
    row.tagged_irrelevant = tagged_irrelevant

    # Re-uploading a corrected report replaces the previous run's missing rows
    # rather than appending a second set beside them.
    db.query(ReportMissingArticles).filter(
        ReportMissingArticles.comparison_id == row.id
    ).delete(synchronize_session=False)
    for article in missing:
        db.add(
            ReportMissingArticles(
                comparison_id=row.id,
                title=article.get("headline") or None,
                url=article["url"],
            )
        )

    db.query(ReportSectionMismatches).filter(
        ReportSectionMismatches.comparison_id == row.id
    ).delete(synchronize_session=False)
    for article in section_mismatches:
        db.add(
            ReportSectionMismatches(
                comparison_id=row.id,
                title=article.get("headline") or None,
                url=article["url"],
                ai_section=article.get("ai_section") or None,
                correct_section=article.get("correct_section") or None,
            )
        )

    db.commit()
    db.refresh(row)
    return row

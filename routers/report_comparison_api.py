from datetime import date

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from configs import logger
from db_helpers.database import get_db
from db_helpers.models.report_comparison_model import (
    MissingArticleKeywordsRequest,
    ReportComparisonResponse,
    ReportMissingArticleResponse,
)
from db_helpers.repository.report_comparisons_db import (
    get_session_articles,
    list_report_comparisons,
    update_missing_article_fields,
    upsert_report_comparison,
)
from db_helpers.repository.sessions_db import get_session_project_id
from reports_helpers.excel_comparison import compare_rows, read_report_rows

router = APIRouter(tags=["report-comparison"])


@router.get("/projects/{project_id}/report-comparisons")
def get_project_report_comparisons(project_id: int, db: Session = Depends(get_db)) -> list[dict]:
    """A project's report comparisons, oldest first, with their per-article details.

    Args:
        project_id: Project to list comparisons for.
        db: Database session.

    Returns:
        The comparison rows, each carrying `missing` and `section_mismatches` lists.
    """
    return list_report_comparisons(db, project_id)


@router.put("/report-comparisons/missing-articles/{article_id}")
def put_missing_article_fields(
    article_id: int,
    payload: MissingArticleKeywordsRequest,
    db: Session = Depends(get_db),
) -> ReportMissingArticleResponse:
    """Update the keywords and/or not-found reason on one missing article.

    Args:
        article_id: The missing-article row to update.
        payload: New keywords and/or reason; blank clears a field, and a field
            left out of the body is not touched.
        db: Database session.

    Returns:
        The updated missing-article row.
    """
    fields = payload.model_dump(exclude_unset=True)
    row = update_missing_article_fields(db, article_id, fields)
    if row is None:
        raise HTTPException(status_code=404, detail="Missing article not found.")
    return ReportMissingArticleResponse.model_validate(row)


@router.post("/report-comparison")
async def compare_report_excel(
    session_id: int = Form(..., description="Session whose tagged articles to compare against."),
    report_date: date = Form(..., description="Date the report covers (YYYY-MM-DD)."),
    file: UploadFile = File(..., description="The delivered report .xlsx."),
    db: Session = Depends(get_db),
) -> dict:
    """Compare a delivered report workbook against a session's tagged articles.

    Reads the article URLs from every sheet, checks each against the URLs of the
    session's articles, then stores the counts (including how many of the matched
    articles the relevancy gate had marked irrelevant), the report rows with no
    match, and the matched rows whose report `Section Name` differs from the tagged
    section. Re-uploading the same project/date replaces the previous run.

    Args:
        session_id: Session whose tagged articles to compare against.
        report_date: Date the report covers.
        file: The delivered report .xlsx.
        db: Database session.

    Returns:
        The saved comparison row, the report rows with no match, and the
        section mismatches.
    """
    if not file.filename or not file.filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(status_code=400, detail="Upload an .xlsx report file.")

    project_id = get_session_project_id(db, session_id)
    if project_id is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    try:
        rows = read_report_rows(await file.read())
    except Exception as exc:
        logger.exception(f"Failed to read report workbook '{file.filename}'")
        raise HTTPException(status_code=400, detail=f"Could not read the workbook: {exc}") from exc

    if not rows:
        raise HTTPException(
            status_code=400,
            detail="No article URLs found. Each sheet needs a URL column, or the article link on its headline cell.",
        )

    session_articles = get_session_articles(db, session_id)
    result = compare_rows(rows, session_articles)
    row = upsert_report_comparison(
        db,
        project_id=project_id,
        session_id=session_id,
        report_date=report_date,
        total_session_articles=len(session_articles),
        total_report_articles=result["total_report_articles"],
        total_articles_found_in_tool=result["total_articles_found_in_tool"],
        tagged_irrelevant=result["tagged_irrelevant"],
        missing=result["missing"],
        section_mismatches=result["section_mismatches"],
    )
    logger.info(
        f"Report comparison for project_id={project_id} date={report_date}: "
        f"{result['total_articles_found_in_tool']}/{result['total_report_articles']} found, "
        f"{len(result['section_mismatches'])} section mismatches, "
        f"{result['tagged_irrelevant']} tagged irrelevant"
    )
    return {
        "comparison": ReportComparisonResponse.model_validate(row),
        "missing": result["missing"],
        "section_mismatches": result["section_mismatches"],
    }

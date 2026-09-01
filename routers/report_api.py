import json
from datetime import datetime
from typing import Any
from urllib.parse import quote
from fastapi import APIRouter, HTTPException, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from db_helpers.database import get_db
from db_helpers.repository.sessions_db import get_session
from db_helpers.repository.projects_db import get_project
from file_helpers.s3_file import s3_file
from configs import logger
from reports_helpers.beone_report import (
    build_media_monitoring_report,
    sections_from_charts_data,
)
from reports_helpers.trane_report import build_media_monitoring_report as build_trane_report
from reports_helpers.otsuka_report import build_media_monitoring_report as build_otsuka_report
from reports_helpers.otsuka_report_2 import build_media_monitoring_report as build_otsuka_report2
from agents.otsuka_report_agent.otsuka_report_synthesizer import synthesize_otsuka_report

router = APIRouter(tags=["reports"])


def _filename_date(value, fmt):
    """Format a report date for a filename, falling back to today.

    Args:
        value: A datetime, a `YYYY-MM-DD` string, or None.
        fmt: strftime format string.

    Returns:
        The formatted date string.
    """
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            value = None
    return (value or datetime.today()).strftime(fmt)


@router.get("/media-monitoring/report")
def media_monitoring_report(
    session_id: int,
    days: list[str] = Query(default_factory=list),
    variant: str = Query(default="coverage"),
    db: Session = Depends(get_db),
) -> Any:
    """Download the media-monitoring articles as a BeOne-style .docx report.

    Reads the session's cached charts data from S3, builds the report from the
    media-monitoring section table, and streams it back as a Word document.
    Pass `days` (repeated YYYY-MM-DD values) to limit the report to specific
    dates; omit it for the full feed. `variant` selects between the two Otsuka
    layouts ("coverage" or "summary") and is ignored by every other brand.
    """
    record = get_session(db, session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    if not record.charts_data_file:
        raise HTTPException(status_code=404, detail="Charts not generated yet for this session.")

    raw = s3_file.download_file(record.charts_data_file)
    charts_data = json.loads(raw, parse_constant=lambda _: None)

    # Normalize the day filter (drop empties) so an empty list means "all dates".
    day_filter = [d for d in (days or []) if d]
    sections = sections_from_charts_data(charts_data, days=day_filter or None)
    if not sections:
        raise HTTPException(status_code=404, detail="No media-monitoring data available for this session.")

    # The report is dated by the end of the window it covers: the last day the
    # user filtered to, else the session's end. None leaves the builder's own
    # default (latest article date, then today) in place for windowless sessions.
    report_date = max(day_filter) if day_filter else record.end_datetime

    # Keywords come from the project (not the session).
    project = get_project(db, record.project_id)
    brand_keywords = (project.brand_keywords if project else None) or []
    competitor_keywords = (project.competitor_keywords if project else None) or []
    brand = brand_keywords[0] if brand_keywords else "BeOne"

    # Each brand can use its own report layout; everyone else gets the BeOne style.
    brand_lower = brand.lower()
    try:
        if "trane" in brand_lower:
            doc_bytes = build_trane_report(sections, brand=brand, report_date=report_date)
            filename = f"Daily Monitoring Trane - {_filename_date(report_date, '%m.%d.%y')}.docx"
        elif "otsuka" in brand_lower:
            if variant == "summary":
                # LLM-write the executive summary + per-article point-wise summaries.
                synth = synthesize_otsuka_report(sections, brand_keywords, competitor_keywords)
                doc_bytes = build_otsuka_report2(
                    synth["sections"],
                    brand=brand,
                    report_date=report_date,
                    summary_paragraphs=synth["overall_summary"],
                    brand_keywords=brand_keywords,
                    competitor_keywords=competitor_keywords,
                )
                filename = f"Otsuka IRA News Monitoring - {_filename_date(report_date, '%m.%d.%y')}.docx"
            else:
                doc_bytes = build_otsuka_report(sections, brand=brand, report_date=report_date)
                filename = f"Otsuka Corporate Communications News Coverage - {_filename_date(report_date, '%m.%d.%y')}.docx"
        else:
            doc_bytes = build_media_monitoring_report(sections, brand=brand, report_date=report_date)
            filename = f"Daily News Summary Report - {_filename_date(report_date, '%B %d, %Y')}.docx"
    except Exception as exc:
        logger.exception(f"Failed to build media-monitoring report for session_id={session_id}")
        raise HTTPException(status_code=500, detail=f"Failed to build report: {exc}") from exc

    headers = {
        "Content-Disposition": f"attachment; filename=\"{filename}\"; filename*=UTF-8''{quote(filename)}",
    }
    return StreamingResponse(
        iter([doc_bytes]),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers=headers,
    )

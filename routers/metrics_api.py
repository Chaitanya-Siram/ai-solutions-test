from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from db_helpers.database import get_db
from db_helpers.repository.llm_usage_db import (
    get_metrics_summary,
    list_sessions_with_usage,
    get_session_agent_breakdown,
    get_daily_usage,
    get_agent_totals,
    get_model_totals,
)

router = APIRouter(prefix="/metrics", tags=["metrics"])


@router.get("/summary")
def metrics_summary(
    start_date: str | None = Query(None),
    end_date: str | None = Query(None),
    db: Session = Depends(get_db),
):
    return get_metrics_summary(db, start_date=start_date, end_date=end_date)


@router.get("/daily")
def metrics_daily(
    days: int = Query(14, ge=1, le=365),
    start_date: str | None = Query(None),
    end_date: str | None = Query(None),
    db: Session = Depends(get_db),
):
    return get_daily_usage(db, days=days, start_date=start_date, end_date=end_date)


@router.get("/agents")
def metrics_agents(
    start_date: str | None = Query(None),
    end_date: str | None = Query(None),
    db: Session = Depends(get_db),
):
    return get_agent_totals(db, start_date=start_date, end_date=end_date)


@router.get("/models")
def metrics_models(
    start_date: str | None = Query(None),
    end_date: str | None = Query(None),
    db: Session = Depends(get_db),
):
    return get_model_totals(db, start_date=start_date, end_date=end_date)


@router.get("/sessions")
def metrics_sessions(db: Session = Depends(get_db)):
    return list_sessions_with_usage(db)


@router.get("/sessions/{session_id}")
def metrics_session_detail(session_id: int, db: Session = Depends(get_db)):
    return get_session_agent_breakdown(db, session_id)

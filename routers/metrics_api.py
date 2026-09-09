from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from db_helpers.database import get_db
from db_helpers.repository.llm_usage_db import get_metrics_summary, list_sessions_with_usage, get_session_agent_breakdown

router = APIRouter(prefix="/metrics", tags=["metrics"])


@router.get("/summary")
def metrics_summary(db: Session = Depends(get_db)):
    return get_metrics_summary(db)


@router.get("/sessions")
def metrics_sessions(db: Session = Depends(get_db)):
    return list_sessions_with_usage(db)


@router.get("/sessions/{session_id}")
def metrics_session_detail(session_id: int, db: Session = Depends(get_db)):
    return get_session_agent_breakdown(db, session_id)

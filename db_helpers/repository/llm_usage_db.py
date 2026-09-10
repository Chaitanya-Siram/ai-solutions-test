from datetime import datetime, timedelta, timezone

from sqlalchemy import cast, func, Date
from sqlalchemy.orm import Session

from db_helpers.models.generated_query_model import GeneratedQueryModel
from db_helpers.models.llm_usage_model import LlmUsageModel
from db_helpers.models.project_model import ProjectModel
from db_helpers.models.session_model import SessionModel


def save_usage(
    db: Session,
    project_id: int,
    session_id: int | None,
    agent_name: str,
    input_tokens: int,
    output_tokens: int,
    cost_usd: float,
    model: str | None = None,
) -> None:
    row = LlmUsageModel(
        project_id=project_id,
        session_id=session_id,
        agent_name=agent_name,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost_usd,
    )
    db.add(row)
    db.commit()


def _apply_date_filter(query, start_date: str | None, end_date: str | None):
    if start_date:
        try:
            dt = datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc)
            query = query.filter(LlmUsageModel.created_at >= dt)
        except ValueError:
            pass
    if end_date:
        try:
            dt = datetime.fromisoformat(end_date).replace(tzinfo=timezone.utc) + timedelta(days=1)
            query = query.filter(LlmUsageModel.created_at < dt)
        except ValueError:
            pass
    return query


def get_metrics_summary(db: Session, start_date: str | None = None, end_date: str | None = None) -> dict:
    projects = db.query(ProjectModel).count()
    sessions = db.query(SessionModel).count()
    generated_queries = db.query(GeneratedQueryModel).count()

    q = db.query(
        func.coalesce(func.sum(LlmUsageModel.cost_usd), 0.0).label("total_cost_usd"),
        func.coalesce(func.sum(LlmUsageModel.input_tokens), 0).label("total_input_tokens"),
        func.coalesce(func.sum(LlmUsageModel.output_tokens), 0).label("total_output_tokens"),
    )
    q = _apply_date_filter(q, start_date, end_date)
    totals = q.one()

    return {
        "projects": projects,
        "sessions": sessions,
        "generated_queries": generated_queries,
        "total_cost_usd": float(totals.total_cost_usd),
        "total_input_tokens": int(totals.total_input_tokens),
        "total_output_tokens": int(totals.total_output_tokens),
    }


def list_sessions_with_usage(db: Session) -> list[dict]:
    rows = (
        db.query(
            SessionModel.id.label("session_id"),
            SessionModel.name.label("session_name"),
            SessionModel.project_id.label("project_id"),
            ProjectModel.name.label("project_name"),
            SessionModel.created_at.label("created_at"),
            SessionModel.status.label("status"),
            func.coalesce(func.sum(LlmUsageModel.input_tokens), 0).label("total_input_tokens"),
            func.coalesce(func.sum(LlmUsageModel.output_tokens), 0).label("total_output_tokens"),
            func.coalesce(func.sum(LlmUsageModel.cost_usd), 0.0).label("total_cost_usd"),
        )
        .join(ProjectModel, SessionModel.project_id == ProjectModel.id)
        .outerjoin(LlmUsageModel, LlmUsageModel.session_id == SessionModel.id)
        .group_by(
            SessionModel.id,
            SessionModel.name,
            SessionModel.project_id,
            ProjectModel.name,
            SessionModel.created_at,
            SessionModel.status,
        )
        .order_by(SessionModel.created_at.desc())
        .limit(200)
        .all()
    )

    result = []
    for r in rows:
        agents = (
            db.query(LlmUsageModel.agent_name)
            .filter(LlmUsageModel.session_id == r.session_id)
            .distinct()
            .all()
        )
        result.append({
            "session_id": r.session_id,
            "session_name": r.session_name,
            "project_id": r.project_id,
            "project_name": r.project_name,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "status": r.status,
            "total_input_tokens": int(r.total_input_tokens),
            "total_output_tokens": int(r.total_output_tokens),
            "total_cost_usd": float(r.total_cost_usd),
            "agents": [a[0] for a in agents],
        })
    return result


def get_daily_usage(db: Session, days: int = 14, start_date: str | None = None, end_date: str | None = None) -> list[dict]:
    q = db.query(
        cast(LlmUsageModel.created_at, Date).label("day"),
        func.sum(LlmUsageModel.input_tokens).label("input_tokens"),
        func.sum(LlmUsageModel.output_tokens).label("output_tokens"),
        func.sum(LlmUsageModel.cost_usd).label("cost_usd"),
    )
    if start_date or end_date:
        q = _apply_date_filter(q, start_date, end_date)
    else:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        q = q.filter(LlmUsageModel.created_at >= cutoff)
    rows = (
        q.group_by(cast(LlmUsageModel.created_at, Date))
        .order_by(cast(LlmUsageModel.created_at, Date))
        .all()
    )
    return [
        {
            "date": str(r.day),
            "input_tokens": int(r.input_tokens),
            "output_tokens": int(r.output_tokens),
            "total_tokens": int(r.input_tokens) + int(r.output_tokens),
            "cost_usd": float(r.cost_usd),
        }
        for r in rows
    ]


def get_agent_totals(db: Session, start_date: str | None = None, end_date: str | None = None) -> list[dict]:
    q = db.query(
        LlmUsageModel.agent_name,
        func.sum(LlmUsageModel.input_tokens).label("input_tokens"),
        func.sum(LlmUsageModel.output_tokens).label("output_tokens"),
        func.sum(LlmUsageModel.cost_usd).label("cost_usd"),
    )
    q = _apply_date_filter(q, start_date, end_date)
    rows = (
        q.group_by(LlmUsageModel.agent_name)
        .order_by(func.sum(LlmUsageModel.input_tokens + LlmUsageModel.output_tokens).desc())
        .all()
    )
    return [
        {
            "agent_name": r.agent_name,
            "input_tokens": int(r.input_tokens),
            "output_tokens": int(r.output_tokens),
            "total_tokens": int(r.input_tokens) + int(r.output_tokens),
            "cost_usd": float(r.cost_usd),
        }
        for r in rows
    ]


def get_model_totals(db: Session, start_date: str | None = None, end_date: str | None = None) -> list[dict]:
    q = db.query(
        func.coalesce(LlmUsageModel.model, "unknown").label("model"),
        func.sum(LlmUsageModel.input_tokens + LlmUsageModel.output_tokens).label("total_tokens"),
        func.sum(LlmUsageModel.cost_usd).label("cost_usd"),
    )
    q = _apply_date_filter(q, start_date, end_date)
    rows = (
        q.group_by(func.coalesce(LlmUsageModel.model, "unknown"))
        .order_by(func.sum(LlmUsageModel.cost_usd).desc())
        .all()
    )
    return [
        {
            "model": r.model,
            "total_tokens": int(r.total_tokens),
            "cost_usd": float(r.cost_usd),
        }
        for r in rows
    ]


def get_session_agent_breakdown(db: Session, session_id: int) -> list[dict]:
    rows = (
        db.query(
            LlmUsageModel.agent_name,
            func.sum(LlmUsageModel.input_tokens).label("input_tokens"),
            func.sum(LlmUsageModel.output_tokens).label("output_tokens"),
            func.sum(LlmUsageModel.cost_usd).label("cost_usd"),
            LlmUsageModel.model,
        )
        .filter(LlmUsageModel.session_id == session_id)
        .group_by(LlmUsageModel.agent_name, LlmUsageModel.model)
        .all()
    )
    return [
        {
            "agent_name": r.agent_name,
            "input_tokens": int(r.input_tokens),
            "output_tokens": int(r.output_tokens),
            "cost_usd": float(r.cost_usd),
            "model": r.model,
        }
        for r in rows
    ]

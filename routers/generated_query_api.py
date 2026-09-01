from datetime import datetime
from typing import Any, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from db_helpers.database import get_db
from configs import logger
from db_helpers.models.generated_query_model import GeneratedQueryResponse
from db_helpers.models.session_model import SessionResponse, SessionType
from db_helpers.repository.generated_query_db import (
    get_generated_query,
    list_generated_query_by_project,
    set_generated_query_schedule,
    update_generated_query,
)
from db_helpers.repository.projects_db import get_project
from db_helpers.repository.sessions_db import create_session


router = APIRouter(tags=["generated-query"])


class ScheduleRequest(BaseModel):
    """Set a recurring hourly schedule. Pass a null/empty time to unschedule."""
    schedule_time: Optional[str] = Field(
        default=None,
        description="Local time-of-day 'HH:MM'. Its minute is the minute past every hour the run fires at.",
    )
    schedule_timezone: Optional[str] = Field(default=None, description="IANA timezone, e.g. 'Asia/Kolkata'.")


class RunRequest(BaseModel):
    """The date window a manual run's session covers.

    Both bounds are required — they are what the session shows the project's article
    pool through. A naive value (no offset) is read as UTC.
    """
    start_datetime: datetime = Field(description="Window start, ISO 8601.")
    end_datetime: datetime = Field(description="Window end, ISO 8601, after the start.")


class GeneratedQueryUpdate(BaseModel):
    """Edit a generated query — its display name and/or its grouped queries."""
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    queries: Optional[Any] = Field(
        default=None,
        description="Grouped queries: [{ 'label': str, 'queries': [str, ...] }, ...].",
    )


def _as_utc(value: datetime) -> datetime:
    """Store window bounds as UTC. A value the client sent without an offset is taken
    as UTC rather than guessed at."""
    return value if value.tzinfo is not None else value.replace(tzinfo=ZoneInfo("UTC"))


def _parse_hhmm(hhmm: str) -> tuple[int, int]:
    """Parse a wall-clock time string into (hour, minute). Tolerates 'H:MM',
    'HH:MM', and 'HH:MM:SS' (seconds ignored) plus surrounding whitespace."""
    parts = str(hhmm).strip().split(":")
    if len(parts) < 2:
        raise ValueError(f"Expected 'HH:MM', got {hhmm!r}.")
    hour, minute = int(parts[0]), int(parts[1])
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"Time out of range: {hhmm!r}.")
    return hour, minute


def _local_hhmm_to_utc(hhmm: str, tzname: str) -> str:
    """Convert a 'HH:MM' wall-clock time in an IANA timezone to the UTC 'HH:MM'
    (snapshot based on today's date — may shift across DST boundaries)."""
    hour, minute = _parse_hhmm(hhmm)
    local_now = datetime.now(ZoneInfo(tzname))
    local_dt = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return local_dt.astimezone(ZoneInfo("UTC")).strftime("%H:%M")


@router.get("/projects/{project_id}/generated-queries", response_model=list[GeneratedQueryResponse])
def list_sessions(project_id: int, db: Session = Depends(get_db)) -> list[GeneratedQueryResponse]:
    """List all generated queries for a project, newest first."""
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    return list_generated_query_by_project(db, project_id)


@router.put(
    "/projects/{project_id}/generated-queries/{query_id}",
    response_model=GeneratedQueryResponse,
)
def edit_generated_query(
    project_id: int, query_id: int, payload: GeneratedQueryUpdate, db: Session = Depends(get_db)
) -> GeneratedQueryResponse:
    """Update a generated query's name and/or its grouped queries."""
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    gq = get_generated_query(db, query_id)
    if gq is None or gq.project_id != project_id:
        raise HTTPException(status_code=404, detail="Generated query not found.")

    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields provided to update.")

    gq = update_generated_query(db, gq, **fields)
    logger.info(f"Updated generated query id={query_id}: {sorted(fields)}")
    return gq


@router.post("/projects/{project_id}/generated-queries/{query_id}/run", response_model=SessionResponse)
def run_generated_query_now(
    project_id: int,
    query_id: int,
    payload: RunRequest,
    db: Session = Depends(get_db),
) -> SessionResponse:
    """Manually trigger a generated query for a date window.

    Creates a fresh QUERY session carrying the window and the query's queries, and
    returns it immediately. The session owns no articles of its own: it is a view of
    the project's article pool, showing the articles dated inside the window. When the
    client opens the review screen with it, the tagging WebSocket tags whatever in the
    pool has no tags yet — fetching first only when this query has no schedule, since a
    scheduled one's pool is the scheduler's to keep current — then the review table reads
    the window.
    """
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    gq = get_generated_query(db, query_id)
    if gq is None or gq.project_id != project_id:
        raise HTTPException(status_code=404, detail="Generated query not found.")
    if not gq.queries:
        raise HTTPException(status_code=400, detail="This query has no search queries to run.")
    if payload.end_datetime <= payload.start_datetime:
        raise HTTPException(status_code=400, detail="The end date/time must be after the start.")

    session = create_session(
        db,
        gq.project_id,
        gq.id,
        session_type=SessionType.QUERY,
        queries=gq.queries,
        name=gq.name,
        start_datetime=_as_utc(payload.start_datetime),
        end_datetime=_as_utc(payload.end_datetime),
    )
    logger.info(
        f"Manual run: created QUERY session id={session.id} for generated query id={query_id} "
        f"({gq.name}) over {session.start_datetime} .. {session.end_datetime}"
    )
    return session


@router.put(
    "/projects/{project_id}/generated-queries/{query_id}/schedule",
    response_model=GeneratedQueryResponse,
)
def schedule_generated_query(
    project_id: int, query_id: int, payload: ScheduleRequest, db: Session = Depends(get_db)
) -> GeneratedQueryResponse:
    """Set (or clear) a recurring hourly schedule for a generated query. Stores the
    local time + timezone and the equivalent UTC time; a background scheduler runs the
    fetch+tag pipeline every hour at that time's minute past the hour, appending each
    hour's new articles to the day's session."""
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    gq = get_generated_query(db, query_id)
    if gq is None or gq.project_id != project_id:
        raise HTTPException(status_code=404, detail="Generated query not found.")

    time_utc = None
    if payload.schedule_time:
        if not payload.schedule_timezone:
            raise HTTPException(status_code=400, detail="A timezone is required to schedule.")
        try:
            time_utc = _local_hhmm_to_utc(payload.schedule_time, payload.schedule_timezone)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"Invalid time or timezone: {exc}") from exc

    gq = set_generated_query_schedule(
        db, gq, payload.schedule_time, payload.schedule_timezone, time_utc
    )
    logger.info(
        f"Scheduled generated query id={query_id}: {gq.schedule_time} {gq.schedule_timezone} "
        f"(UTC {gq.schedule_time_utc}) status={gq.status}"
    )
    return gq

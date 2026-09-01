from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from configs import logger
from db_helpers.database import get_db
from db_helpers.models.session_model import SessionResponse
from db_helpers.repository.projects_db import get_project
from db_helpers.repository.raw_articles_db import list_raw_articles, replace_raw_articles
from db_helpers.repository.sessions_db import create_merged_session, get_session
from file_helpers.merge_helper import dedupe_by_url

router = APIRouter(tags=["merge"])


class MergeRequest(BaseModel):
    session_ids: list[int]


@router.post("/projects/{project_id}/merge", response_model=SessionResponse)
def merge_sessions(project_id: int, payload: MergeRequest, db: Session = Depends(get_db)) -> SessionResponse:
    """Merge the raw data of several sessions into one new "merged" session.

    Reads each selected session's raw articles, concatenates them, drops
    URL-duplicates (trailing-slash-insensitive), and creates a session that tracks
    the merged ids with the unique articles as its raw set. The
    merged session is then tagged like any other upload — and its tagging run
    reuses the sources' existing tags (see ``agents.tagging_agent.tag_reuse``).
    """
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    session_ids = list(dict.fromkeys(payload.session_ids))  # de-dup + keep order
    if len(session_ids) < 2:
        raise HTTPException(status_code=400, detail="Select at least two files to merge.")

    logger.info(f"Merging sessions {session_ids} for project_id={project_id}")

    all_records: list[dict] = []
    created_dates: list = []
    for sid in session_ids:
        session = get_session(db, sid)
        if session is None or session.project_id != project_id:
            raise HTTPException(status_code=404, detail=f"Session {sid} not found in this project.")
        if session.created_at is not None:
            created_dates.append(session.created_at)
        records = list_raw_articles(db, sid)
        if not records:
            raise HTTPException(status_code=400, detail=f"Session {sid} has no raw articles to merge.")
        all_records.extend(records)

    if not all_records:
        raise HTTPException(status_code=400, detail="No records found in the selected files.")

    unique = dedupe_by_url(all_records)
    logger.info(f"Merged {len(all_records)} records -> {len(unique)} unique by url")

    # Date the merged session as the newest of its source sessions so it groups
    # with that day (rather than "today").
    merged_created_at = max(created_dates) if created_dates else None
    merged_name = f"Merged ({len(session_ids)} files)"
    session = create_merged_session(
        db, project_id, session_ids, created_at=merged_created_at, name=merged_name
    )
    replace_raw_articles(db, session.id, None, unique)
    logger.info(f"Created merged session id={session.id} from {session_ids} (created_at={merged_created_at})")
    return session

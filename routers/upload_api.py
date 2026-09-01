from fastapi import APIRouter, File, Form, HTTPException, UploadFile, Depends
from pydantic import BaseModel
from configs import logger
from db_helpers.repository.sessions_db import create_session
from db_helpers.repository.projects_db import get_project
from db_helpers.repository.raw_articles_db import replace_raw_articles
from file_helpers.file_parser import parse_upload
from sqlalchemy.orm import Session
from db_helpers.database import get_db

router = APIRouter(tags=["upload"])


class UploadResponse(BaseModel):
    session_id: int
    name: str
    record_count: int


@router.post("/upload", response_model=UploadResponse)
def upload(
    project_id: int = Form(..., description="ID of the project this upload belongs to."),
    file: UploadFile = File(..., description="CSV, Excel (.xlsx/.xls), or JSON file."),
    db: Session = Depends(get_db),
) -> UploadResponse:
    logger.info(f"Upload received for filename='{file.filename}' project_id={project_id}")

    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    file_content = file.file.read()
    if not file_content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    
    # File Validation and Parsing
    try:
        records = parse_upload(file.filename or "", file_content)
    except ValueError as exc:
        logger.warning(f"Parse failed for '{file.filename}': {exc}")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception(f"Unexpected parse failure for '{file.filename}'")
        raise HTTPException(status_code=400, detail=f"Failed to parse file: {exc}") from exc

    if not records:
        raise HTTPException(status_code=400, detail="No records found in the uploaded file.")
    
    # The parsed records are stored as raw_articles rows — nothing is written to S3.
    # The original filename is kept as the session's display name.
    original_filename = file.filename or ""
    session = create_session(db, project_id, query_id=None, name=original_filename or None)
    replace_raw_articles(db, session.id, None, records)

    logger.info(f"Stored {len(records)} uploaded records for session id={session.id} ('{original_filename}')")
    return UploadResponse(session_id=session.id, name=original_filename, record_count=len(records))

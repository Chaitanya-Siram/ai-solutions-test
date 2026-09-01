from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from configs import logger
from data_source_helpers.onedrive_client import DELETED_SUBFOLDER, move_file_to_deleted
from db_helpers.database import get_db
from db_helpers.models.onedrive_files_model import OnedriveFilesResponse
from db_helpers.repository.onedrive_files_db import (
    delete_onedrive_file,
    get_onedrive_file_by_id,
    list_onedrive_files,
)
from db_helpers.repository.projects_db import get_project

router = APIRouter(tags=["onedrive"])


@router.get("/projects/{project_id}/onedrive-files", response_model=list[OnedriveFilesResponse])
def list_project_onedrive_files(
    project_id: int, db: Session = Depends(get_db)
) -> list[OnedriveFilesResponse]:
    """List the OneDrive files synced for a project, newest first.

    Args:
        project_id: Project to list files for.
        db: Database session.

    Returns:
        The project's synced OneDrive file records.
    """
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    files = list_onedrive_files(db, project_id)
    logger.info(f"Listed {len(files)} OneDrive file(s) for project_id={project_id}")
    return files


@router.delete("/onedrive-files/{file_id}")
def delete_project_onedrive_file(file_id: int, db: Session = Depends(get_db)) -> dict:
    """Delete a synced OneDrive file record, its articles, and move the file aside.

    The file itself is moved to `{folder}/Deleted` in OneDrive rather than removed, so
    the next sync doesn't re-ingest it. That move happens first: if it fails the record
    is kept and the call 502s, leaving the whole thing retryable.

    Args:
        file_id: The synced file to delete.
        db: Database session.

    Returns:
        Counts of the article rows removed and where the file was moved to.
    """
    row = get_onedrive_file_by_id(db, file_id)
    if row is None:
        raise HTTPException(status_code=404, detail="OneDrive file not found.")

    file_name = row.file_name
    folder_name = row.folder_name

    # Move in OneDrive first. The `onedrive_files` row is what marks a file as already
    # processed, so dropping the row while the file sits in its folder would have the
    # next sync re-ingest it. Failing here leaves everything intact for a retry.
    moved_as = None
    if folder_name:
        try:
            moved_as = move_file_to_deleted(folder_name, file_name)
        except Exception as exc:
            logger.exception(f"Moving {folder_name}/{file_name} to Deleted failed")
            raise HTTPException(
                status_code=502,
                detail=f"Could not move the file to {folder_name}/Deleted in OneDrive: {exc}",
            ) from exc

    deleted = delete_onedrive_file(db, row)
    moved_to = f"{folder_name}/{DELETED_SUBFOLDER}/{moved_as}" if moved_as else None
    logger.info(
        f"Deleted OneDrive file id={file_id} ({file_name}): {deleted['raw']} raw and "
        f"{deleted['tagged']} tagged article(s); "
        + (f"moved to {moved_to}" if moved_to else "no folder recorded, nothing moved")
    )
    return {
        "id": file_id,
        "file_name": file_name,
        "deleted": deleted,
        "moved_to": moved_to,
    }

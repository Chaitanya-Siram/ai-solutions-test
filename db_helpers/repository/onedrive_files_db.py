from sqlalchemy import func, select
from sqlalchemy.orm import Session

from db_helpers.models.onedrive_files_model import OnedriveFiles
from db_helpers.models.raw_article_model import RawArticleModel
from db_helpers.models.tagged_article_model import TaggedArticleModel


def get_onedrive_file(db: Session, project_id: int, folder_name: str, file_name: str) -> OnedriveFiles | None:
    """Look up an already-logged file by its project, folder and name.

    Args:
        db: Database session.
        project_id: Owning project id.
        folder_name: OneDrive folder the file sits in.
        file_name: File name.

    Returns:
        The row, or None if this file has not been logged yet.
    """
    return (
        db.query(OnedriveFiles)
        .filter(
            OnedriveFiles.project_id == project_id,
            OnedriveFiles.folder_name == folder_name,
            OnedriveFiles.file_name == file_name,
        )
        .first()
    )


def create_onedrive_file(db: Session, project_id: int, folder_name: str, file_name: str) -> OnedriveFiles:
    """Log a fetched OneDrive file.

    Args:
        db: Database session.
        project_id: Owning project id.
        folder_name: OneDrive folder the file sits in.
        file_name: File name.

    Returns:
        The created row.
    """
    row = OnedriveFiles(project_id=project_id, folder_name=folder_name, file_name=file_name)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get_onedrive_file_by_id(db: Session, file_id: int) -> OnedriveFiles | None:
    """Look up a logged file by its row id.

    Args:
        db: Database session.
        file_id: Row id.

    Returns:
        The row, or None when it doesn't exist.
    """
    return db.query(OnedriveFiles).filter(OnedriveFiles.id == file_id).first()


def delete_onedrive_file(db: Session, row: OnedriveFiles) -> dict[str, int]:
    """Delete a synced file along with the raw and tagged articles it brought in.

    The articles go first and explicitly rather than by relying on the FK's ON DELETE
    CASCADE, so the counts can be reported back and the whole thing is one transaction.

    Args:
        db: Database session.
        row: The file row to delete.

    Returns:
        {"raw": n, "tagged": n} — the article rows removed.
    """
    raw = (
        db.query(RawArticleModel)
        .filter(RawArticleModel.onedrive_file_id == row.id)
        .delete(synchronize_session=False)
    )
    tagged = (
        db.query(TaggedArticleModel)
        .filter(TaggedArticleModel.onedrive_file_id == row.id)
        .delete(synchronize_session=False)
    )
    db.delete(row)
    db.commit()
    return {"raw": int(raw or 0), "tagged": int(tagged or 0)}


def list_onedrive_files(db: Session, project_id: int | None = None) -> list[dict]:
    """List logged OneDrive files, newest first, each with its tagged-article count.

    The count is what deleting the file would remove, so the UI can say so before
    asking. Counted with a correlated subquery rather than a join so a file with no
    articles still comes back (as 0).

    Args:
        db: Database session.
        project_id: Restrict to one project when given.

    Returns:
        List of file dicts, each carrying `article_count`.
    """
    article_count = (
        select(func.count(TaggedArticleModel.id))
        .where(TaggedArticleModel.onedrive_file_id == OnedriveFiles.id)
        .scalar_subquery()
    )
    query = db.query(OnedriveFiles, article_count.label("article_count"))
    if project_id is not None:
        query = query.filter(OnedriveFiles.project_id == project_id)
    rows = query.order_by(OnedriveFiles.created_at.desc()).all()
    return [
        {
            "id": row.id,
            "file_name": row.file_name,
            "folder_name": row.folder_name,
            "project_id": row.project_id,
            "created_at": row.created_at,
            "status": row.status,
            "error": row.error,
            "article_count": int(count or 0),
        }
        for row, count in rows
    ]

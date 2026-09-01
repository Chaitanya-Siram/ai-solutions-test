from typing import Any
from sqlalchemy.orm import Session
from db_helpers.models.session_model import SessionModel, SessionType


def get_session(db: Session, session_id: int) -> SessionModel | None:
    return db.query(SessionModel).filter(SessionModel.id == session_id).first()


def get_session_project_id(db: Session, session_id: int) -> int | None:
    """The project a session belongs to, without loading the whole row.

    Used by the article repositories to stamp ``project_id`` onto raw / tagged rows,
    so that denormalized column is always derived from the session rather than
    passed in by a caller (where it could disagree).
    """
    return db.query(SessionModel.project_id).filter(SessionModel.id == session_id).scalar()


def list_sessions_by_project(db: Session, project_id: int) -> list[SessionModel]:
    return (
        db.query(SessionModel)
        .filter(SessionModel.project_id == project_id)
        .order_by(SessionModel.id.desc())
        .all()
    )


def get_last_session_by_project(db: Session, project_id: int) -> SessionModel | None:
    """The most recently created session of a project, or None if it has none.

    Args:
        db: Database session.
        project_id: Project to look in.

    Returns:
        The latest SessionModel, or None.
    """
    return (
        db.query(SessionModel)
        .filter(SessionModel.project_id == project_id)
        .order_by(SessionModel.created_at.desc())
        .first()
    )


def delete_session(db: Session, session: SessionModel) -> None:
    db.delete(session)
    db.commit()

def create_session(
    db: Session,
    project_id: int,
    query_id: int | None,
    session_type: SessionType | str = SessionType.UPLOAD,
    queries: Any | None = None,
    name: str | None = None,
    start_datetime: Any | None = None,
    end_datetime: Any | None = None,
) -> SessionModel:
    """Create a session. Passing both `start_datetime` and `end_datetime` makes it a
    window session: it owns no articles, and shows the project pool's articles dated
    inside the window (see ``db_helpers.repository.article_scope``)."""
    new_session = SessionModel(
        project_id=project_id,
        generated_query_id=query_id,
        session_type=session_type,
        queries=queries,
        name=name,
        start_datetime=start_datetime,
        end_datetime=end_datetime,
    )
    db.add(new_session)
    db.commit()
    db.refresh(new_session)
    return new_session


def create_merged_session(
    db: Session,
    project_id: int,
    merged_session_ids: list[int],
    created_at: Any | None = None,
    name: str | None = None,
) -> SessionModel:
    """Create a "merged" session recording the ids of the sessions it was merged
    from; the merged articles are stored separately as its raw set. When
    `created_at` is given it overrides the default now() (the merge uses the newest
    source session's date so the merged session groups with that day)."""
    new_session = SessionModel(
        project_id=project_id,
        session_type=SessionType.MERGED,
        merged_session_ids=merged_session_ids,
        name=name,
    )
    if created_at is not None:
        new_session.created_at = created_at
    db.add(new_session)
    db.commit()
    db.refresh(new_session)
    return new_session


def update_session_name(db: Session, session: SessionModel, name: str) -> SessionModel:
    """Rename a session (the display file name shown on the frontend)."""
    session.name = name
    db.commit()
    db.refresh(session)
    return session


def reset_session_for_new_raw(db: Session, session: SessionModel) -> SessionModel:
    """Roll a session back to "Uploaded" because fresh raw data is replacing its old.

    The raw articles themselves are stored by ``raw_articles_db.replace_raw_articles``,
    which also clears the session's tagged articles — new raw data invalidates the
    tags derived from the old set, so neither the tags nor the cached charts survive
    and the status can no longer claim "Tagged".
    """
    session.charts_data_file = None
    session.status = "Uploaded"
    db.commit()
    db.refresh(session)
    return session


def mark_session_tagged(db: Session, session: SessionModel) -> SessionModel:
    """Flip a session to "Tagged" once its tagged articles are stored, dropping any
    cached charts so the dashboards rebuild from the new tags."""
    session.charts_data_file = None
    session.status = "Tagged"
    db.commit()
    db.refresh(session)
    return session


def update_session_charts_data_file(db: Session, session: SessionModel, charts_data_file: str) -> SessionModel:
    session.charts_data_file = charts_data_file
    session.status = "Completed"
    db.commit()
    db.refresh(session)
    return session


def invalidate_session_charts(db: Session, session: SessionModel) -> SessionModel:
    """Drop any cached charts (e.g. after the tagged articles are edited) so the
    dashboards regenerate next time. Leaves the tagged articles untouched and rolls
    a "Completed" session back to "Tagged"."""
    session.charts_data_file = None
    if session.status == "Completed":
        session.status = "Tagged"
    db.commit()
    db.refresh(session)
    return session


def update_session_status(db: Session, session: SessionModel, status: str) -> SessionModel:
    session.status = status
    db.commit()
    db.refresh(session)
    return session


def update_session_workflow(db: Session, session: SessionModel, workflow: Any | None) -> SessionModel:
    """Persist the visual pipeline graph (nodes + edges) for a session."""
    session.workflow = workflow
    db.commit()
    db.refresh(session)
    return session
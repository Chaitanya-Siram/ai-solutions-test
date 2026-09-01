from sqlalchemy.orm import Session
from db_helpers.models.project_model import ProjectModel

# Fields a client is allowed to change via update_project.
_UPDATABLE_FIELDS = {
    "name",
    "description",
    "is_active",
    "brand_keywords",
    "competitor_keywords",
    "message_keywords",
}


def create_project(
    db: Session,
    name: str,
    description: str | None = None,
    brand_keywords: list[str] | None = None,
    competitor_keywords: list[str] | None = None,
    message_keywords: list[str] | None = None,
) -> ProjectModel:
    project = ProjectModel(
        name=name,
        description=description,
        brand_keywords=brand_keywords or [],
        competitor_keywords=competitor_keywords or [],
        message_keywords=message_keywords or [],
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def get_project(db: Session, project_id: int) -> ProjectModel | None:
    return db.query(ProjectModel).filter(ProjectModel.id == project_id).first()


def list_projects(
    db: Session,
    include_inactive: bool = True,
    skip: int = 0,
    limit: int = 100,
) -> list[ProjectModel]:
    query = db.query(ProjectModel)
    if not include_inactive:
        query = query.filter(ProjectModel.is_active.is_(True))
    return (
        query.order_by(ProjectModel.created_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )


def update_project(db: Session, project: ProjectModel, **fields) -> ProjectModel:
    """Partial update: only the whitelisted fields actually passed are applied."""
    for key, value in fields.items():
        if key in _UPDATABLE_FIELDS:
            setattr(project, key, value)
    db.commit()
    db.refresh(project)
    return project


def set_sections_prompt(
    db: Session,
    project: ProjectModel,
    sections_prompt: str | None,
    sections_orders: list[str] | None = None,
) -> ProjectModel:
    """Set (or clear) the monitoring sections prompt used during tagging, along with
    the ordered section names extracted from it."""
    project.monitoring_sections_prompt = sections_prompt
    project.sections_orders = sections_orders
    db.commit()
    db.refresh(project)
    return project


def set_relevancy_prompt(
    db: Session,
    project: ProjectModel,
    relevancy_prompt: str | None,
    relevancy_domains: dict[str, list[str]] | None = None,
) -> ProjectModel:
    """Set (or clear) the relevancy prompt the relevancy agent uses to decide which
    articles are relevant to the project before tagging.

    Args:
        db: Open session.
        project: The project row to update.
        relevancy_prompt: The criteria text, or None to clear it.
        relevancy_domains: ``{"include": [...], "exclude": [...]}`` extracted from
            the prompt; written alongside it so the two never disagree.

    Returns:
        The refreshed project.
    """
    project.relevancy_prompt = relevancy_prompt
    project.relevancy_domains = relevancy_domains
    db.commit()
    db.refresh(project)
    return project


def set_sections_orders(db: Session, project: ProjectModel, sections_orders: list[str] | None) -> ProjectModel:
    """Set the ordered section names (e.g. after the user drags sections to reorder)."""
    project.sections_orders = sections_orders
    db.commit()
    db.refresh(project)
    return project


def delete_project(db: Session, project: ProjectModel) -> None:
    """Hard-delete a project. Sessions referencing it are removed by the
    ON DELETE CASCADE on sessions.project_id."""
    db.delete(project)
    db.commit()

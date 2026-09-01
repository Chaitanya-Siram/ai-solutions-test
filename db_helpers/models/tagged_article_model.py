"""
Tagged Article Model
"""
from datetime import datetime
from typing import Any, Optional
from pydantic import BaseModel, ConfigDict
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from db_helpers.database import Base


class TaggedArticleModel(Base):
    __tablename__ = "tagged_articles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    session_id = Column(Integer, ForeignKey("sessions.id", ondelete="CASCADE"), nullable=True, index=True)
    sessions_id = Column(JSONB, nullable=False, server_default="[]", default=list)
    generated_query_id = Column(Integer, ForeignKey("generated_queries.id", ondelete="CASCADE"), nullable=True, index=True)
    # sha256 of the canonical URL — the identity the fetch/tag dedupe matches
    article_id = Column(String, nullable=True, index=True)
    title = Column(Text, nullable=True)
    content = Column(Text, nullable=True)
    url = Column(Text, nullable=True)
    date = Column(DateTime(timezone=True), nullable=True, index=True)
    sentiment = Column(String, nullable=True, index=True)
    theme = Column(String, nullable=True)
    section = Column(String, nullable=True, index=True)
    reach = Column(Integer, nullable=True)
    priority_watch = Column(Boolean, nullable=False, default=False)
    is_relevant = Column(Boolean, nullable=False, default=True, index=True)
    monitoring_approvals = Column(JSONB, nullable=False, server_default="[]", default=list)
    dashboard_approvals = Column(JSONB, nullable=False, server_default="[]", default=list)
    # Canonical full article dict.
    data = Column(JSONB, nullable=False)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    syndication_of = Column(Integer, nullable=True, index=True)
    similar_group_id = Column(String(36), nullable=True, index=True)
    embedding = Column(ARRAY(Float), nullable=True)
    embedding_model = Column(String, nullable=True)
    onedrive_file_id = Column(Integer, ForeignKey("onedrive_files.id", ondelete="CASCADE"), nullable=True, index=True)

    __table_args__ = (
        Index("ix_tagged_project_article", "project_id", "article_id"),
        Index("ix_tagged_project_date", "project_id", "date"),
        Index("ix_tagged_project_group", "project_id", "similar_group_id"),
    )


class TaggedArticleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    session_id: Optional[int] = None
    sessions_id: list[int] = []
    data: Any
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

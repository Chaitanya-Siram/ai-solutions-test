"""Raw (pre-tagging) articles — one row per source record.

Replaces the old "one JSON file per session under raw_data/ on S3" layout. The
``data`` holds each source record verbatim — untouched, so it stays auditable —
while the columns beside it are normalized for querying (see the ``date`` note
below). Nothing raw is stored on S3; these rows are the only copy.
"""
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB

from db_helpers.database import Base


class RawArticleModel(Base):
    __tablename__ = "raw_articles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    session_id = Column(Integer, ForeignKey("sessions.id", ondelete="CASCADE"), nullable=True, index=True)
    generated_query_id = Column(Integer, ForeignKey("generated_queries.id", ondelete="CASCADE"), nullable=True, index=True)
    # sha256(url without trailing slash)
    article_id = Column(String, nullable=True, index=True)
    url = Column(Text, nullable=True)
    date = Column(DateTime(timezone=True), nullable=True, index=True)
    is_relevant = Column(Boolean, nullable=True, index=True)
    onedrive_file_id = Column(Integer, ForeignKey("onedrive_files.id", ondelete="CASCADE"), nullable=True, index=True)
    data = Column(JSONB, nullable=False)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("ix_raw_session_article", "session_id", "article_id"),
        Index("ix_raw_project_article", "project_id", "article_id"),
        Index(
            "uq_raw_pool_project_article",
            "project_id",
            "article_id",
            unique=True,
            postgresql_where=text("session_id IS NULL"),
        ),
    )


class RawArticleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    session_id: int
    article_id: Optional[str] = None
    url: Optional[str] = None
    date: Optional[datetime] = None
    is_relevant: Optional[bool] = None
    data: Any
    created_at: Optional[datetime] = None

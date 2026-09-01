from datetime import datetime
import enum
from typing import Any, Optional
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, JSON, func
from db_helpers.database import Base
from db_helpers.mutable_json import NestedMutableDict


class SessionType(str, enum.Enum):
    """How a session was created."""
    UPLOAD = "upload"   # from an uploaded file
    QUERY = "query"     # from the query-builder agent
    MERGED = "merged"   # merged from several other sessions (deduped by url)


class SessionModel(Base):
    __tablename__ = "sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    generated_query_id = Column(Integer, ForeignKey("generated_queries.id", ondelete="CASCADE"), nullable=True, index=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    session_type = Column(String, nullable=False, default="upload")
    name = Column(String, nullable=True)
    charts_data_file = Column(String, nullable=True)
    queries = Column(NestedMutableDict.as_mutable(JSON), nullable=True)
    # Visual pipeline graph (nodes + edges) built in the workflow designer.
    workflow = Column(NestedMutableDict.as_mutable(JSON), nullable=True)
    merged_session_ids = Column(JSON, nullable=True)
    # The date window a query session covers, chosen by the user when they run a generated query.
    start_datetime = Column(DateTime(timezone=True), nullable=True)
    end_datetime = Column(DateTime(timezone=True), nullable=True)
    status = Column(String, nullable=False, default="Uploaded")


class SessionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    session_type: Optional[str] = None
    name: Optional[str] = None
    charts_data_file: Optional[str] = None
    queries: Optional[Any] = None
    workflow: Optional[Any] = None
    merged_session_ids: Optional[list[int]] = None
    start_datetime: Optional[datetime] = None
    end_datetime: Optional[datetime] = None
    status: str
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, JSON, func
from db_helpers.database import Base
from db_helpers.mutable_json import NestedMutableDict


class GeneratedQueryModel(Base):
    __tablename__ = "generated_queries"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name = Column(String, nullable=False)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    brand_keywords = Column(JSON, nullable=False)
    competitor_keywords = Column(JSON, nullable=False)
    message_keywords = Column(JSON, nullable=False)
    queries = Column(NestedMutableDict.as_mutable(JSON), nullable=True)
    status = Column(String, nullable=False, default="Unscheduled")
    schedule_time = Column(String, nullable=True)
    schedule_timezone = Column(String, nullable=True)
    schedule_time_utc = Column(String, nullable=True)
    # An instant, not a wall-clock reading, so it must carry its offset: as a naive
    # column PostgreSQL converted the aware UTC value written to it into the session's
    # TimeZone and dropped the offset, and the scheduler read that local wall time back
    # as UTC — shifting every stamp by the session's offset (see scheduler._is_due).
    last_run_at = Column(DateTime(timezone=True), nullable=True)



class GeneratedQueryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    name: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    brand_keywords: list[str] = []
    competitor_keywords: list[str] = []
    message_keywords: list[str] = []
    queries: Optional[Any] = None
    status: str
    schedule_time: Optional[str] = None
    schedule_timezone: Optional[str] = None
    schedule_time_utc: Optional[str] = None
    last_run_at: Optional[datetime] = None
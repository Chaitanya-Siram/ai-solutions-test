from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, func
from db_helpers.database import Base


class OnedriveFiles(Base):
    __tablename__ = "onedrive_files"

    id = Column(Integer, primary_key=True, autoincrement=True)
    file_name = Column(String, nullable=False)
    folder_name = Column(String, nullable=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now())
    status = Column(String, nullable=True)
    error = Column(String, nullable=True)


class OnedriveFilesResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    file_name: str
    folder_name: Optional[str] = None
    project_id: int
    created_at: Optional[datetime] = None
    status: Optional[str] = None
    error: Optional[str] = None
    article_count: int = 0

from typing import Optional
from fastapi import UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, JSON, Text, func
from db_helpers.database import Base

class ProjectModel(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    description = Column(String, nullable=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    is_active = Column(Boolean, default=True)
    monitoring_sections_prompt = Column(Text, nullable=True)
    relevancy_prompt = Column(Text, nullable=True)
    sections_orders = Column(JSON, nullable=True)
    # {"include": [...], "exclude": [...]} — domain lists for the relevancy gate.
    relevancy_domains = Column(JSON, nullable=True)
    brand_keywords = Column(JSON, nullable=False)
    competitor_keywords = Column(JSON, nullable=False)
    message_keywords = Column(JSON, nullable=False)
    # created_by = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

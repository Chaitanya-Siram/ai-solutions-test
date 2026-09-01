"""
Report Comparison Model — how many of a delivered report's articles the tool found.
"""
from datetime import date, datetime
from typing import Optional
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Column, Date, DateTime, ForeignKey, Integer, Text, func
from db_helpers.database import Base


class ReportComparisonModel(Base):
    __tablename__ = "report_comparisons"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    session_id = Column(Integer, ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    report_date = Column(Date, nullable=False, index=True)
    total_session_articles = Column(Integer, nullable=False, default=0)
    total_report_articles = Column(Integer, nullable=False, default=0)
    total_articles_found_in_tool = Column(Integer, nullable=False, default=0)
    # Of the found articles, how many the relevancy gate had marked not relevant.
    tagged_irrelevant = Column(Integer, nullable=False, server_default="0", default=0)
    created_at = Column(DateTime(timezone=True), default=func.now())


class ReportComparisonResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    session_id: int
    report_date: date
    total_session_articles: int
    total_report_articles: int
    total_articles_found_in_tool: int
    tagged_irrelevant: int = 0
    created_at: Optional[datetime] = None


class ReportMissingArticles(Base):
    __tablename__ = "report_missing_articles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    comparison_id = Column(Integer, ForeignKey("report_comparisons.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(Text, nullable=True)
    url = Column(Text, nullable=False)
    keywords = Column(Text, nullable=True)
    reason_for_not_found = Column(Text, nullable=True)


class ReportMissingArticleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    comparison_id: int
    title: Optional[str] = None
    url: str
    keywords: Optional[str] = None
    reason_for_not_found: Optional[str] = None


class ReportSectionMismatches(Base):
    """A report article the tool did find, but filed under a different section."""

    __tablename__ = "report_section_mismatches"

    id = Column(Integer, primary_key=True, autoincrement=True)
    comparison_id = Column(Integer, ForeignKey("report_comparisons.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(Text, nullable=True)
    url = Column(Text, nullable=False)
    ai_section = Column(Text, nullable=True)
    correct_section = Column(Text, nullable=True)


class ReportSectionMismatchResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    comparison_id: int
    title: Optional[str] = None
    url: str
    ai_section: Optional[str] = None
    correct_section: Optional[str] = None


class MissingArticleKeywordsRequest(BaseModel):
    """Either field may be omitted; an omitted field is left unchanged."""

    keywords: Optional[str] = None
    reason_for_not_found: Optional[str] = None
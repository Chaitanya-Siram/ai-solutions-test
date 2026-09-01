from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr
from sqlalchemy import Boolean, Column, DateTime, Integer, String, func

from db_helpers.database import Base


class UserModel(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    email = Column(String, nullable=False, unique=True, index=True)
    full_name = Column(String, nullable=True)
    hashed_password = Column(String, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    is_admin = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())


class UserResponse(BaseModel):
    """Public view of a user — never exposes the password hash."""
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: EmailStr
    full_name: Optional[str] = None
    is_active: bool
    is_admin: bool
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

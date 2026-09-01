from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from auth_helpers.dependencies import get_current_user
from configs import logger
from db_helpers.database import get_db
from db_helpers.models.user_model import UserModel, UserResponse
from db_helpers.repository.users_db import (
    create_user,
    delete_user,
    get_user,
    get_user_by_email,
    list_users,
    update_user,
)

router = APIRouter(prefix="/users", tags=["users"])


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=6, max_length=128)
    full_name: Optional[str] = None
    is_admin: bool = False


class UserUpdate(BaseModel):
    email: Optional[EmailStr] = None
    password: Optional[str] = Field(default=None, min_length=6, max_length=128)
    full_name: Optional[str] = None
    is_active: Optional[bool] = None
    is_admin: Optional[bool] = None


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def create(payload: UserCreate, db: Session = Depends(get_db)) -> UserResponse:
    """Register a new user. Open endpoint so the first user can be bootstrapped."""
    if get_user_by_email(db, payload.email) is not None:
        raise HTTPException(status_code=409, detail="Email already registered.")

    user = create_user(
        db,
        email=payload.email.lower(),
        password=payload.password,
        full_name=payload.full_name,
        is_admin=payload.is_admin,
    )
    logger.info(f"Created user id={user.id} email={user.email!r}")
    return user


@router.get("", response_model=list[UserResponse])
def list_all(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    _current: UserModel = Depends(get_current_user),
) -> list[UserResponse]:
    """List users, newest first. Requires authentication."""
    return list_users(db, skip=skip, limit=limit)


@router.get("/{user_id}", response_model=UserResponse)
def retrieve(
    user_id: int,
    db: Session = Depends(get_db),
    _current: UserModel = Depends(get_current_user),
) -> UserResponse:
    """Fetch a single user by id. Requires authentication."""
    user = get_user(db, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    return user


@router.put("/{user_id}", response_model=UserResponse)
def update(
    user_id: int,
    payload: UserUpdate,
    db: Session = Depends(get_db),
    _current: UserModel = Depends(get_current_user),
) -> UserResponse:
    """Partially update a user (only the fields provided are changed)."""
    user = get_user(db, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")

    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields provided to update.")

    # Guard uniqueness when email is being changed.
    new_email = fields.get("email")
    if new_email and new_email != user.email:
        existing = get_user_by_email(db, new_email.lower())
        if existing is not None and existing.id != user_id:
            raise HTTPException(status_code=409, detail="Email already registered.")

    user = update_user(db, user, **fields)
    logger.info(f"Updated user id={user_id}: {sorted(fields)}")
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete(
    user_id: int,
    db: Session = Depends(get_db),
    _current: UserModel = Depends(get_current_user),
) -> None:
    """Delete a user. Requires authentication."""
    user = get_user(db, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    delete_user(db, user)
    logger.info(f"Deleted user id={user_id}")

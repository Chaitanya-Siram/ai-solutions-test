from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from auth_helpers.dependencies import get_current_user
from auth_helpers.security import create_access_token, verify_password
from configs import logger
from db_helpers.database import get_db
from db_helpers.models.user_model import UserModel, UserResponse
from db_helpers.repository.refresh_tokens_db import (
    create_refresh_token,
    get_active_refresh_token,
    revoke_all_for_user,
    revoke_refresh_token,
)
from db_helpers.repository.users_db import get_user, get_user_by_email

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(..., min_length=1)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserResponse


def _issue_tokens(db: Session, user: UserModel) -> TokenResponse:
    """Mint a fresh access token + a new DB-stored refresh token for a user."""
    access_token = create_access_token(subject=user.id, extra_claims={"email": user.email})
    _, raw_refresh = create_refresh_token(db, user.id)
    return TokenResponse(access_token=access_token, refresh_token=raw_refresh, user=user)


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    """Authenticate with email + password and receive access + refresh tokens."""
    user = get_user_by_email(db, payload.email.lower())
    if user is None or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user.")

    logger.info(f"User logged in id={user.id} email={user.email!r}")
    return _issue_tokens(db, user)


@router.post("/refresh", response_model=TokenResponse)
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)) -> TokenResponse:
    """Exchange a valid refresh token for a new access + refresh pair.
    The presented refresh token is rotated (revoked) so it cannot be reused."""
    record = get_active_refresh_token(db, payload.refresh_token)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token.",
        )

    user = get_user(db, record.user_id)
    if user is None or not user.is_active:
        # Token orphaned or user deactivated — burn it and reject.
        revoke_refresh_token(db, record)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User is no longer active.")

    # Rotate: revoke the used token, then issue a brand-new pair.
    revoke_refresh_token(db, record)
    logger.info(f"Refreshed tokens for user id={user.id}")
    return _issue_tokens(db, user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(payload: RefreshRequest, db: Session = Depends(get_db)) -> None:
    """Revoke a refresh token (this device's session). Idempotent — an unknown
    or already-revoked token is treated as success."""
    record = get_active_refresh_token(db, payload.refresh_token)
    if record is not None:
        revoke_refresh_token(db, record)
        logger.info(f"Logged out (refresh token revoked) user id={record.user_id}")


@router.post("/logout-all", status_code=status.HTTP_204_NO_CONTENT)
def logout_all(
    current_user: UserModel = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Revoke every refresh token for the authenticated user (logout everywhere)."""
    revoked = revoke_all_for_user(db, current_user.id)
    logger.info(f"Logged out everywhere for user id={current_user.id}; revoked {revoked} token(s)")


@router.get("/me", response_model=UserResponse)
def me(current_user: UserModel = Depends(get_current_user)) -> UserResponse:
    """Return the currently authenticated user."""
    return current_user

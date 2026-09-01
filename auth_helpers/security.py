"""Password hashing (bcrypt), JWT access-token, and refresh-token helpers."""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import bcrypt
import jwt

from configs import envs


def hash_password(password: str) -> str:
    """Hash a plaintext password with bcrypt and return it as a utf-8 string."""
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Check a plaintext password against a stored bcrypt hash."""
    try:
        return bcrypt.checkpw(
            plain_password.encode("utf-8"), hashed_password.encode("utf-8")
        )
    except (ValueError, TypeError):
        return False


def create_access_token(
    subject: str | int,
    extra_claims: Optional[dict[str, Any]] = None,
) -> str:
    """Create a signed JWT whose `sub` claim identifies the user."""
    minutes = envs.ACCESS_TOKEN_EXPIRE_MINUTES
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": str(subject),
        "iat": now,
        "exp": now + timedelta(minutes=minutes),
    }
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, envs.JWT_SECRET_KEY, algorithm=envs.JWT_ALGORITHM)


def decode_access_token(token: str) -> dict[str, Any]:
    """Decode and validate a JWT. Raises jwt.PyJWTError on any problem."""
    return jwt.decode(token, envs.JWT_SECRET_KEY, algorithms=[envs.JWT_ALGORITHM])


def generate_refresh_token() -> str:
    """Generate a new opaque, URL-safe refresh token (the raw value handed to the client)."""
    return secrets.token_urlsafe(48)


def hash_refresh_token(raw_token: str) -> str:
    """Hash a raw refresh token for storage/lookup. Only the hash is persisted."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def refresh_token_expiry() -> datetime:
    """Absolute expiry timestamp for a newly issued refresh token."""
    return datetime.now(timezone.utc) + timedelta(days=envs.REFRESH_TOKEN_EXPIRE_DAYS)

"""FastAPI dependencies that enforce authentication via a JWT Bearer token.

Works for both HTTP routes (token in the `Authorization: Bearer` header) and
WebSocket routes (token in the `?token=` query param, since browsers cannot set
custom headers on a WS handshake). Because it reads from the shared
`HTTPConnection` base class, a single `include_router(dependencies=[...])` can
guard a router's HTTP *and* WebSocket routes alike.
"""
import jwt
from fastapi import Depends, HTTPException, WebSocketException, status
from sqlalchemy.orm import Session
from starlette.requests import HTTPConnection

from auth_helpers.security import decode_access_token
from db_helpers.database import get_db
from db_helpers.models.user_model import UserModel
from db_helpers.repository.users_db import get_user


def _extract_token(conn: HTTPConnection) -> str:
    """Pull the bearer token from the Authorization header, falling back to the
    `token` query parameter (used by browser WebSocket clients)."""
    auth = conn.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[len("Bearer "):].strip()
    return conn.query_params.get("token", "")


def _reject(conn: HTTPConnection, detail: str) -> Exception:
    """Build the right rejection for the connection type (WS close vs HTTP 401)."""
    if conn.scope.get("type") == "websocket":
        return WebSocketException(code=status.WS_1008_POLICY_VIOLATION, reason=detail)
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user(conn: HTTPConnection, db: Session = Depends(get_db)) -> UserModel:
    """Resolve the authenticated user from the token, or reject the connection."""
    token = _extract_token(conn)
    if not token:
        raise _reject(conn, "Not authenticated.")
    try:
        payload = decode_access_token(token)
        subject = payload.get("sub")
        if subject is None:
            raise _reject(conn, "Could not validate credentials.")
        user_id = int(subject)
    except (jwt.PyJWTError, ValueError):
        raise _reject(conn, "Could not validate credentials.")

    user = get_user(db, user_id)
    if user is None:
        raise _reject(conn, "Could not validate credentials.")
    if not user.is_active:
        raise _reject(conn, "Inactive user.")
    return user


def get_current_admin(current_user: UserModel = Depends(get_current_user)) -> UserModel:
    """Require the authenticated user to be an admin."""
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin privileges required."
        )
    return current_user

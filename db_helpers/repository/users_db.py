from sqlalchemy.orm import Session

from auth_helpers.security import hash_password
from db_helpers.models.user_model import UserModel

# Fields a client is allowed to change via update_user (password handled separately).
_UPDATABLE_FIELDS = {
    "email",
    "full_name",
    "is_active",
    "is_admin",
}


def create_user(
    db: Session,
    email: str,
    password: str,
    full_name: str | None = None,
    is_admin: bool = False,
) -> UserModel:
    user = UserModel(
        email=email,
        full_name=full_name,
        hashed_password=hash_password(password),
        is_admin=is_admin,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def get_user(db: Session, user_id: int) -> UserModel | None:
    return db.query(UserModel).filter(UserModel.id == user_id).first()


def get_user_by_email(db: Session, email: str) -> UserModel | None:
    return db.query(UserModel).filter(UserModel.email == email).first()


def list_users(db: Session, skip: int = 0, limit: int = 100) -> list[UserModel]:
    return (
        db.query(UserModel)
        .order_by(UserModel.created_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )


def update_user(db: Session, user: UserModel, **fields) -> UserModel:
    """Partial update: only the whitelisted fields actually passed are applied.
    Pass `password` to also (re)hash and set a new password."""
    password = fields.pop("password", None)
    for key, value in fields.items():
        if key in _UPDATABLE_FIELDS:
            setattr(user, key, value)
    if password:
        user.hashed_password = hash_password(password)
    db.commit()
    db.refresh(user)
    return user


def delete_user(db: Session, user: UserModel) -> None:
    db.delete(user)
    db.commit()

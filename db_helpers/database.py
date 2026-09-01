from sqlalchemy import MetaData, create_engine, text
from sqlalchemy.orm import declarative_base
from sqlalchemy.orm import sessionmaker
from configs import envs, logger

# All tables live under a dedicated schema (default "ai_solution") instead of
# PostgreSQL's "public". Setting the schema on the shared MetaData applies it to
# every model and automatically resolves string ForeignKey references within it.
DB_SCHEMA = envs.DB_SCHEMA
Base = declarative_base(metadata=MetaData(schema=DB_SCHEMA))

DATABASE_URL = f'postgresql://{envs.DB_USER}:{envs.DB_PASSWORD}@{envs.DB_HOST}:{envs.DB_PORT}/{envs.DB_NAME}'
engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_recycle=1800)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


# Dependency to get DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Columns added to tables that already exist in a live database. create_all skips
# any table it finds, so a new column on one is invisible to it and has to be
# added here as well as on the model. (table, column, type-and-default).
_ADDED_COLUMNS = [
    ("report_comparisons", "tagged_irrelevant", "INTEGER NOT NULL DEFAULT 0"),
]


def init_db() -> None:
    """Create any tables that don't exist yet, then apply pending schema changes:
    column additions, index additions, and retired-column drops (in that order).

    Imports model modules first so Base.metadata knows about every table
    before create_all runs. Safe to call repeatedly — create_all is a no-op
    for tables that already exist, and every DDL below is IF (NOT) EXISTS.
    """
    from .models import (
        generated_query_model,
        onedrive_files_model,
        project_model,
        raw_article_model,
        refresh_token_model,
        report_comparison_model,
        session_model,
        tagged_article_model,
        user_model,
    )

    # Ensure the target schema exists before creating tables inside it.
    with engine.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{DB_SCHEMA}"'))

    Base.metadata.create_all(bind=engine)

    with engine.begin() as conn:
        for table, column, spec in _ADDED_COLUMNS:
            conn.execute(
                text(
                    f'ALTER TABLE "{DB_SCHEMA}"."{table}" '
                    f'ADD COLUMN IF NOT EXISTS "{column}" {spec}'
                )
            )
    logger.info(f"init_db: schema ready ({len(_ADDED_COLUMNS)} column additions applied)")

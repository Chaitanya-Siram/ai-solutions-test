"""Canonical S3 key layout for the pipeline's generated charts payload.

    ai_solutions/
      project_{id}/
        {YYYY-MM-DD}/
          charts_data/   <- generated dashboard/chart JSON  [all that is on S3]

Raw and tagged articles live in the `raw_articles` / `tagged_articles` tables, so
the charts payload is the only thing still written to S3.

The charts key is built from the session itself — (project, session id, the day the
session was created) — so it is stable: regenerating a session's dashboards
overwrites its own object instead of accumulating new ones, and sessions still group
under the date folder they were created on.
"""
from __future__ import annotations
import re
from datetime import datetime
from typing import Any
from configs import envs

S3_ROOT = "ai_solutions"
CHARTS_DIR = "charts_data"

if envs.ENVIRONMENT.lower() == "local":
    S3_ROOT = "local_ai_solutions"


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def stage_key(project_id: int, date: str, stage: str, filename: str) -> str:
    """Build a key like ai_solutions/project_5/2026-07-01/charts_data/foo.json."""
    return f"{S3_ROOT}/project_{project_id}/{date}/{stage}/{filename}"


def date_of(value: Any) -> str:
    """A YYYY-MM-DD date string from a datetime, a date-ish string, or a key that has
    a date path segment. Falls back to today when nothing usable is found."""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    text = str(value or "")
    if _DATE_RE.match(text[:10]):
        return text[:10]
    for seg in text.split("/"):
        if _DATE_RE.match(seg):
            return seg
    return today()


def charts_key(project_id: int, session_id: int, created_at: Any = None) -> str:
    """Charts-file key for a session: its own project + creation-date folder, named
    after the session id so regenerating overwrites the same object."""
    return stage_key(project_id, date_of(created_at), CHARTS_DIR, f"session_{session_id}.json")

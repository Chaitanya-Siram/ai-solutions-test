"""Which articles a request addresses.

There are two places a project's articles can live, and the difference is the whole
reason this type exists:

  * **A session's own set.** An upload or a merge brings its articles with it, so
    they belong to that session and nothing else — ``session_id`` on the row is that
    session.
  * **The project pool.** The hourly scheduler fetches into the project itself, not
    into any session (``session_id`` is NULL). One row per article per project, no
    matter how many queries turned it up or how many sessions display it.

A session created by a manual run is a *view* over the pool: it carries a
start/end window and shows the pool articles whose ``date`` falls inside it. It owns
no articles of its own, which is why editing one from its review page changes the
pool row every other overlapping window reads.

:func:`scope_for_session` is the single place that decides which of the two a
session means; pass the result down instead of a bare ``session_id`` so a caller
can't accidentally address only half the store.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Optional


def _as_utc(value: datetime | None) -> datetime | None:
    """Make a stored datetime comparable. The window columns are timezone-aware, but
    a value that arrived naive (an older row, a direct SQL insert) is read as UTC
    rather than crashing the comparison."""
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


@dataclass(frozen=True)
class ArticleScope:
    """The set of articles an operation may see and touch.

    ``session_id is None`` means the project pool. ``window`` and ``view_session_id``
    only apply to pool reads: the window narrows them to the viewing session's date
    range, and ``view_session_id`` is the session stamped onto each article that
    the read returns (see ``tagged_articles_db.list_tagged_articles``).
    """

    project_id: int
    session_id: Optional[int] = None
    window: Optional[tuple[datetime, datetime]] = None
    view_session_id: Optional[int] = None

    @property
    def is_pool(self) -> bool:
        return self.session_id is None

    def describe(self) -> str:
        """Short form for log lines."""
        if not self.is_pool:
            return f"session_id={self.session_id}"
        if self.window:
            start, end = self.window
            return f"project_id={self.project_id} pool [{start.isoformat()} .. {end.isoformat()}]"
        return f"project_id={self.project_id} pool"


def pool_scope(project_id: int) -> ArticleScope:
    """The project's whole pool — what the hourly scheduler writes into."""
    return ArticleScope(project_id=project_id)


def scope_for_session(session) -> ArticleScope:
    """Where this session's articles live.

    A session with both window bounds set is a view over the project pool; anything
    else (an upload, a merge, a query session from before the pool existed) owns its
    articles directly.
    """
    start = _as_utc(session.start_datetime)
    end = _as_utc(session.end_datetime)
    if start is not None and end is not None:
        return ArticleScope(
            project_id=session.project_id,
            session_id=None,
            window=(start, end),
            view_session_id=session.id,
        )
    return ArticleScope(project_id=session.project_id, session_id=session.id)


def widen_window_to_days(scope: ArticleScope) -> ArticleScope:
    """The same scope with its window rounded out to whole days.

    A session's window carries the run's clock time, so a read through it hides
    articles that share the start/end date but fall outside those hours. Reads that
    should show everything dated inside the range widen it to 00:00:00 .. 23:59:59.

    Args:
        scope: Scope to widen; returned unchanged if it has no window.

    Returns:
        An ArticleScope whose window spans full days.
    """
    if not scope.window:
        return scope
    start, end = scope.window
    return replace(
        scope,
        window=(
            start.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc),
            end.replace(hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc),
        ),
    )

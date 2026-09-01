"""Background scheduler for recurring generated-query runs.

A lightweight asyncio loop (started on app startup) ticks once a minute and, for
every scheduled generated query, runs the fetch -> tag pipeline once an hour — at
the minute of its `schedule_time`, in its timezone. No external dependency.

A run creates no session. It fetches into the project's article pool: one row per
article per project, however many queries turn it up, and only the articles that
aren't already there get fetched and tagged. Sessions come later and separately — a
manual run creates one with a date window, and that session shows the pool's articles
dated inside it (see db_helpers.repository.article_scope).
"""
from __future__ import annotations

import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from configs import logger, envs
from db_helpers.database import SessionLocal
from db_helpers.repository.generated_query_db import (
    get_generated_query,
    list_scheduled_generated_queries,
    mark_generated_query_run,
)

TICK_SECONDS = 60


class _Run:
    """Bookkeeping for one in-flight scheduled run: which query, and since when.

    The object's identity is what tells two runs of the same query apart, which is what
    lets a release know whether the entry it is about to clear is still its own.
    """

    __slots__ = ("gq_id", "started")

    def __init__(self, gq_id: int) -> None:
        self.gq_id = gq_id
        self.started = time.monotonic()


# Query ids currently executing — the guard against overlap. Runs are released either by
# the run itself finishing (`_run_and_release`) or, if it never finishes, by the reaper on
# a later tick. That second path is the point: `run_generated_query` swallows exceptions,
# so the only thing that used to strand an id here forever was a worker thread blocked on
# a network call with no timeout — and a stranded id meant every later hourly slot for
# that query was skipped silently, for the lifetime of the process.
_running: dict[int, _Run] = {}

# Reaped, but the thread never came back. A Python thread cannot be cancelled, so it runs
# on — holding a scheduler worker and its database connection — until its own call returns.
# Tracked so the loss of capacity is visible in the logs instead of looking like health.
_leaked: dict[int, _Run] = {}

# A dedicated pool rather than asyncio.to_thread's default executor: that one is shared
# with every request handler's to_thread call, so a leaked scheduler thread there degrades
# unrelated endpoints.
_EXECUTOR = ThreadPoolExecutor(
    max_workers=envs.SCHEDULER_MAX_CONCURRENT_RUNS,
    thread_name_prefix="scheduler-run",
)

# How late a schedule that has never run may still start the current hour. Without
# it, a query scheduled at 14:32 to run at ":15" past the hour would fire the moment
# it was saved (14:15 is in the past and nothing has run yet), which reads as the
# schedule being ignored; with it, the first run lands on the next :15.
FIRST_RUN_GRACE = timedelta(minutes=5)


def _schedule_minute(gq) -> int | None:
    """The minute past the hour this query runs at, from its "HH:MM" schedule_time.

    Only the minute drives the cadence — the hour is kept because that's what the
    user picked in the time field. Returns None when there is nothing usable.
    """
    try:
        minute = int(str(gq.schedule_time).strip().split(":")[1])
    except Exception:
        return None
    return minute if 0 <= minute <= 59 else None


def _timezone_of(gq) -> ZoneInfo | timezone:
    try:
        return ZoneInfo(gq.schedule_timezone) if gq.schedule_timezone else timezone.utc
    except Exception:
        return timezone.utc


def _slot_start(local_now: datetime, minute: int) -> datetime:
    """The most recent hourly slot at `minute` past the hour, at or before `local_now`."""
    slot = local_now.replace(minute=minute, second=0, microsecond=0)
    if local_now < slot:
        slot -= timedelta(hours=1)
    return slot


def _is_due(gq, now_utc: datetime) -> bool:
    """Due when the current hour's slot hasn't run yet.

    Comparing `last_run_at` against the slot (rather than counting ticks) means a
    slot missed while the app was down still runs — at the next tick — and no slot
    ever runs twice, however the ticks land.
    """
    if not gq.schedule_time or not gq.schedule_timezone:
        return False
    minute = _schedule_minute(gq)
    if minute is None:
        return False

    tz = _timezone_of(gq)
    local_now = now_utc.astimezone(tz)
    slot = _slot_start(local_now, minute)

    last = gq.last_run_at
    if last is None:
        return local_now - slot <= FIRST_RUN_GRACE
    # `last_run_at` is timestamptz, so this is a guard for a database that predates
    # that migration (see db_helpers.database._COLUMN_TYPE_CHANGES), not the norm.
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return last.astimezone(tz) < slot


def run_generated_query(gq_id: int) -> None:
    """One hourly pass for a generated query: fetch its queries into the project's
    article pool, then tag whatever came in that isn't tagged yet.

    Runs against its own DB session; failures are logged, not raised.
    """
    # Imported here to avoid an import cycle at module load (routers import heavy deps).
    from routers.tagging_api import fetch_and_tag_project_pool

    db = SessionLocal()
    try:
        gq = get_generated_query(db, gq_id)
        if gq is None:
            return

        # Stamp the attempt before running it. The tick fires every minute, so a run
        # that failed without recording an attempt would be retried a minute later —
        # and every minute after that — instead of at the next hourly slot.
        mark_generated_query_run(db, gq, datetime.now(timezone.utc))

        logger.info(
            f"[scheduler] Hourly run for generated query id={gq_id} ({gq.name}) "
            f"-> project_id={gq.project_id} pool"
        )
        counts = fetch_and_tag_project_pool(
            db,
            gq.project_id,
            gq.id,
            gq.queries,
            recency_hours=envs.SCHEDULER_FETCH_HOURS,
            label=f"generated query id={gq_id}",
        )
        logger.info(
            f"[scheduler] Completed generated query id={gq_id}: "
            f"{counts['fetched']} new article(s) fetched, {counts['tagged']} tagged"
        )
    except Exception:
        logger.exception(f"[scheduler] Run failed for generated query id={gq_id}")
    finally:
        db.close()


async def _run_and_release(run: _Run) -> None:
    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(_EXECUTOR, run_generated_query, run.gq_id)
    finally:
        # Clear the entry only while it is still this run's. A run the reaper gave up on
        # can return long after a fresh run for the same query started; deleting that
        # one's entry would let a third run start alongside it.
        if _running.get(run.gq_id) is run:
            del _running[run.gq_id]
        if _leaked.get(run.gq_id) is run:
            del _leaked[run.gq_id]
            logger.info(
                f"[scheduler] Generated query id={run.gq_id} returned after being declared "
                f"stuck ({(time.monotonic() - run.started) / 60:.1f} min); its worker "
                f"thread is free again"
            )


def _reap_stuck_runs() -> None:
    """Release ids whose run has outlived the deadline, so their next slot can fire.

    Deliberately not ``asyncio.wait_for``: the run is a thread, and a thread cannot be
    cancelled, so a timeout there would cancel only the future and hide the leak. Doing it
    here keeps the leak visible and costs at most one extra tick of delay, which is
    nothing against an hourly cadence.
    """
    deadline = envs.SCHEDULER_RUN_TIMEOUT_SECONDS
    now = time.monotonic()
    for gq_id, run in list(_running.items()):
        elapsed = now - run.started
        if elapsed < deadline:
            continue
        del _running[gq_id]
        _leaked[gq_id] = run
        logger.error(
            f"[scheduler] Generated query id={gq_id} has been running for "
            f"{elapsed / 60:.1f} min, past its {deadline / 60:.1f} min deadline — releasing "
            f"it so the next slot can run. Its worker thread cannot be killed and still "
            f"holds a database connection; {len(_leaked)} of "
            f"{envs.SCHEDULER_MAX_CONCURRENT_RUNS} scheduler worker(s) now leaked."
        )


async def _tick() -> None:
    _reap_stuck_runs()

    db = SessionLocal()
    try:
        scheduled = list_scheduled_generated_queries(db)
    finally:
        db.close()

    now_utc = datetime.now(timezone.utc)
    for gq in scheduled:
        if gq.id in _running:
            continue
        if not _is_due(gq, now_utc):
            continue
        # Every worker leaked means a submission would queue behind a thread that never
        # returns — the scheduler would look busy while running nothing. Say so instead.
        if len(_leaked) >= envs.SCHEDULER_MAX_CONCURRENT_RUNS:
            logger.error(
                f"[scheduler] Not starting generated query id={gq.id}: all "
                f"{envs.SCHEDULER_MAX_CONCURRENT_RUNS} worker thread(s) are held by runs "
                f"that never returned (ids {sorted(_leaked)}). Restart the app."
            )
            continue
        run = _Run(gq.id)
        _running[gq.id] = run
        asyncio.create_task(_run_and_release(run))


async def scheduler_loop() -> None:
    """Run forever, ticking every TICK_SECONDS. Started from the app's startup hook."""
    logger.info("[scheduler] started")
    while True:
        try:
            await _tick()
        except Exception:
            logger.exception("[scheduler] tick error")
        await asyncio.sleep(TICK_SECONDS)

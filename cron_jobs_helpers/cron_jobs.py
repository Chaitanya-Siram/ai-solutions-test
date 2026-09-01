"""Cron-scheduled jobs, run in-process by APScheduler.

Started from `main.py`'s startup hook. Distinct from `scheduler.py`, which is the
hand-rolled hourly loop over each generated query's own `schedule_time`; this module
is for jobs on a fixed cron, independent of any query's stored schedule.
"""
from __future__ import annotations
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from configs import logger, envs
from cron_jobs_helpers.cron_daily_reporting import cron_job_daily_reporting_mail
from cron_jobs_helpers.cron_onedrive_files_sync import cron_job_fetch_and_tag_onedrive_files

# Daily run times, as hours past midnight in CRON_TIMEZONE.
RUN_HOURS = (14, 17)

# The OneDrive sync polls on a fixed interval rather than at named hours.
ONEDRIVE_SYNC_MINUTES = envs.ONEDRIVE_SYNC_MINUTES

def start_cron_jobs() -> AsyncIOScheduler:
    """Start the APScheduler cron jobs on the running event loop.

    Returns:
        The started scheduler.
    """
    scheduler = AsyncIOScheduler(timezone=envs.CRON_TIMEZONE)

    # Scheduler for Daily Mail for Ingested Data
    scheduler.add_job(
        cron_job_daily_reporting_mail,
        CronTrigger(hour=",".join(str(h) for h in RUN_HOURS), minute=0),
        id="cron_job_daily_reporting_mail",
        max_instances=1,
        coalesce=True,
        misfire_grace_time=3600,
    )

    # Scheduler for Onedrive Files Sync
    scheduler.add_job(
        cron_job_fetch_and_tag_onedrive_files,
        CronTrigger(minute=f"*/{ONEDRIVE_SYNC_MINUTES}"),
        id="cron_job_fetch_and_tag_onedrive_files",
        max_instances=1,
        coalesce=True,
        misfire_grace_time=ONEDRIVE_SYNC_MINUTES * 60,
    )

    scheduler.start()
    logger.info("[cron] Cron Job Scheduled..........")
    return scheduler

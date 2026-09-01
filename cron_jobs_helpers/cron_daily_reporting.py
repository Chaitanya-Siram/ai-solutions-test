from __future__ import annotations
from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from configs import logger, envs
from db_helpers.database import SessionLocal
from db_helpers.repository.generated_query_db import list_scheduled_generated_queries
from db_helpers.repository.projects_db import get_project
from db_helpers.repository.raw_articles_db import count_raw_articles_fetched_between
from db_helpers.repository.sessions_db import get_last_session_by_project
from mail_helpers.template_renderer import render_template
from mail_helpers.zepto_helper import ZeptoMail

# Daily run times, as hours past midnight in CRON_TIMEZONE.
RUN_HOURS = (14, 17)

EMAILS = {
    "beone": ["sunil1.nayak@infovision.com", "harish.thulasiram@infovision.com", "tonoy.barman@infovision.com"],
    "trane": ["sunil1.nayak@infovision.com", "harish.thulasiram@infovision.com", "tonoy.barman@infovision.com"],
    "otsuka": ["sunil1.nayak@infovision.com", "harish.thulasiram@infovision.com", "sridevi.upadhya@infovision.com"]
}


def cron_job_daily_reporting_mail():
    """Fetch every scheduled generated query and log it.
    
    Returns:
        None.
    """
    db = SessionLocal()
    try:
        queries = list_scheduled_generated_queries(db)
        logger.info(f"[cron] Fetched {len(queries)} scheduled generated query(ies)")
        for gq in queries:
            if gq.schedule_time is not None:
                project_id = gq.project_id
                project = get_project(db, project_id)
                # Get last session created_date of the project
                session = get_last_session_by_project(db, project_id)
                if session is None:
                    continue
                start_date = session.created_at
                end_date = datetime.now()

                # Fetch the last raw articles count fetched for the project in the start_date and end_date
                raw_count = count_raw_articles_fetched_between(
                    db, project_id, gq.id, start_date, end_date
                )
                logger.info(
                    f"[cron]   id={gq.id} name={gq.name!r} project_id={project_id} "
                    f"{raw_count} raw article(s) fetched between {start_date} and {end_date}"
                )

                emails = None
                if "beone" in project.name.lower():
                    emails = EMAILS["beone"]
                elif "trane" in project.name.lower():
                    emails = EMAILS["trane"]
                elif "otsuka" in project.name.lower():
                    emails = EMAILS["otsuka"]

                # Send email
                if emails:
                    content = render_template(
                        "daily_reporting.html",
                        project_name=project.name,
                        query_name=gq.name,
                        raw_count=raw_count,
                        start_date=start_date.strftime("%d %b %Y, %H:%M"),
                        end_date=end_date.strftime("%d %b %Y, %H:%M"),
                    )
                    result = ZeptoMail.send_email(
                        subject=f"{project.name} — {raw_count} new article(s)",
                        content=content,
                        to_email=emails,
                    )
                    logger.info(
                        f"[cron]   mail to {len(emails)} recipient(s) for project_id="
                        f"{project_id}: {result['status']}"
                    )

    except Exception:
        logger.exception("[cron] Failed to fetch scheduled generated queries")
    finally:
        db.close()
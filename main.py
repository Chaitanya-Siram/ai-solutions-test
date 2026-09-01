import asyncio
from fastapi import Depends, FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from exception_handlers import validation_exception_handler
from auth_helpers.dependencies import get_current_user
from db_helpers.database import init_db
from routers import (
    upload_router, merge_router, tagging_router, charts_router, report_router, agent_router,
    project_router, session_router, query_builder_router, generated_query_router,
    auth_router, user_router, onedrive_router, report_comparison_router
)

init_db()

app = FastAPI(title="AI Solutions", version="1.0.0")
app.add_exception_handler(RequestValidationError, validation_exception_handler)


@app.on_event("startup")
async def _start_scheduler() -> None:
    """Launch the recurring hourly generated-query scheduler in the background."""
    from scheduler import scheduler_loop
    asyncio.create_task(scheduler_loop())

@app.on_event("startup")
async def _start_cron_jobs() -> None:
    """Launch the daily cron jobs (see cron_jobs.py)."""
    from cron_jobs_helpers.cron_jobs import start_cron_jobs
    start_cron_jobs()

# CORS — allow the Vite dev server (and any origin) to call the API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    # Without this the browser hides Content-Disposition from JS, so downloads
    # silently fall back to the frontend's hardcoded filename.
    expose_headers=["Content-Disposition"],
)

# Public routers: authentication and user registration/CRUD.
# (User CRUD enforces auth per-endpoint; registration is intentionally open.)
app.include_router(auth_router)
app.include_router(user_router)

# All other routers require a valid JWT Bearer token.
_auth = [Depends(get_current_user)]
# app.include_router(health_router)
app.include_router(upload_router, dependencies=_auth)
app.include_router(merge_router, dependencies=_auth)
app.include_router(tagging_router, dependencies=_auth)
app.include_router(charts_router, dependencies=_auth)
app.include_router(report_router, dependencies=_auth)
app.include_router(agent_router, dependencies=_auth)
app.include_router(project_router, dependencies=_auth)
app.include_router(session_router, dependencies=_auth)
app.include_router(query_builder_router, dependencies=_auth)
app.include_router(generated_query_router, dependencies=_auth)
app.include_router(onedrive_router, dependencies=_auth)
app.include_router(report_comparison_router, dependencies=_auth)

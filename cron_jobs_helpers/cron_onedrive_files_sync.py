"""Ingest files from OneDrive into their project's article pool.

Each project has a OneDrive folder (`Sunil/Beone`, `Sunil/Trane`, `Sunil/Otsuka`),
matched to the project by name. Per file not seen before: log it in `onedrive_files`,
append its articles to the project pool stamped `data_source="Onedrive"`, then run the
pool's incremental tagging pass (which also links syndication and story groups).

Files already logged for that project and folder are skipped, so re-running is safe —
the row in `onedrive_files` is the "have we processed this?" record.
"""
from __future__ import annotations
import requests
from configs import logger
from data_source_helpers.onedrive_client import (
    get_app_access_token,
    list_folder_children,
)
from db_helpers.database import SessionLocal
from db_helpers.repository.article_scope import pool_scope
from db_helpers.repository.onedrive_files_db import create_onedrive_file, get_onedrive_file
from db_helpers.repository.projects_db import list_projects
from db_helpers.repository.raw_articles_db import append_raw_articles
from file_helpers.file_parser import parse_upload
from routers.tagging_api import tag_new_pool_articles

# Project name substring -> its OneDrive folder. Same string-matching dispatch the
# fetch pipeline and report layouts use (see is_beone_project / is_trane_project).
PROJECT_FOLDERS = {
    "beone": "Sunil/Beone",
    "trane": "Sunil/Trane",
    "otsuka": "Sunil/Otsuka",
}

# Files processed per folder per pass. Bounds one run's work: a folder with a backlog
# is drained a few files at a time across successive passes rather than in one long run.
FILES_PER_PASS = 5


def _folder_for(project_name: str) -> str | None:
    """The OneDrive folder for a project, or None when it has none."""
    name = (project_name or "").lower()
    for key, folder in PROJECT_FOLDERS.items():
        if key in name:
            return folder
    return None


def cron_job_fetch_and_tag_onedrive_files() -> list[dict]:
    """Ingest each project's new OneDrive files into its pool and tag them.

    Returns:
        List of dicts, one per newly processed file.
    """
    token = get_app_access_token()

    db = SessionLocal()
    try:
        processed: list[dict] = []

        for project in list_projects(db):
            folder_path = _folder_for(project.name)
            if folder_path is None:
                continue

            items = list_folder_children(folder_path, token, top=FILES_PER_PASS)
            if items is None:
                continue

            for item in items:
                if "file" not in item:  # skip subfolders
                    continue

                file_name = item["name"]
                if get_onedrive_file(db, project.id, folder_path, file_name):
                    continue

                download_url = item.get("@microsoft.graph.downloadUrl")
                if not download_url:
                    logger.warning(f"[onedrive] no download url for {folder_path}/{file_name}")
                    continue

                row = create_onedrive_file(db, project.id, folder_path, file_name)
                try:
                    content = requests.get(download_url).content
                    records = parse_upload(file_name, content)

                    for record in records:
                        record["data_source"] = "Onedrive"
                        record["onedrive_file_id"] = row.id
                    fresh = append_raw_articles(db, None, pool_scope(project.id), records)

                    # Tags the pool's untagged rows and appends — syndication and story
                    # groups included. Skipped when this file added nothing new.
                    tagged = tag_new_pool_articles(db, project.id) if fresh else []

                    row.status = "processed" if fresh else "no_new_articles"
                    row.error = None
                except Exception as exc:
                    logger.exception(f"[onedrive] processing {folder_path}/{file_name} failed")
                    row.status = "failed"
                    row.error = str(exc)[:500]
                    records, fresh, tagged = [], [], []
                db.commit()

                processed.append(
                    {
                        "id": row.id,
                        "file_name": row.file_name,
                        "folder_name": row.folder_name,
                        "project_id": row.project_id,
                        "created_at": row.created_at,
                        "status": row.status,
                        "articles_added": len(fresh),
                        "articles_tagged": len(tagged),
                    }
                )
                logger.info(
                    f"[onedrive] {folder_path}/{file_name} -> {project.name} "
                    f"(id={project.id}): {row.status}, {len(fresh)} new article(s) "
                    f"of {len(records)} parsed, {len(tagged)} tagged"
                )

        logger.info(f"[onedrive] processed {len(processed)} new file(s)")
        return processed
    finally:
        db.close()

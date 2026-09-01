"""Microsoft Graph client for the OneDrive sync — auth, listing, download, move.

Kept separate from `cron_jobs_helpers/cron_onedrive_files_sync.py` because that module
imports the tagging pipeline (and so, transitively, the routers). The delete endpoint
needs the move helper without dragging the pipeline in behind it.
"""
from __future__ import annotations
from typing import Any
import requests
from configs import logger, envs

CLIENT_ID = envs.MICROSOFT_CLIENT_ID
CLIENT_SECRET = envs.MICROSOFT_CLIENT_SECRET
TENANT_ID = envs.MICROSOFT_TENANT_ID
USER_EMAIL = envs.MICROSOFT_USER_EMAIL

GRAPH_BASE = f"https://graph.microsoft.com/v1.0/users/{USER_EMAIL}/drive"

# Where a file goes when its record is deleted: "{project folder}/Deleted". The sync's
# listing loop only reads files, so this subfolder needs no special case there.
DELETED_SUBFOLDER = "Deleted"


def get_app_access_token() -> str:
    """Get a Graph access token via client credentials (no user interaction).

    Returns:
        The access token string.
    """
    url = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"
    data = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "client_credentials",
        "scope": "https://graph.microsoft.com/.default",
    }
    response = requests.post(url, data=data)
    response.raise_for_status()
    return response.json().get("access_token")


def list_folder_children(
    folder_path: str, token: str, top: int | None = None
) -> list[dict[str, Any]] | None:
    """List a folder's items.

    Args:
        folder_path: Folder to list, e.g. "Sunil/Beone".
        token: Graph access token.
        top: Cap the page size, so one pass processes at most this many items.

    Returns:
        The item dicts, or None when the folder can't be listed (missing, no access).
    """
    url = f"{GRAPH_BASE}/root:/{folder_path}:/children"
    if top:
        url += f"?$top={top}"
    response = requests.get(url, headers={"Authorization": f"Bearer {token}"})
    if response.status_code != 200:
        logger.warning(
            f"[onedrive] listing {folder_path} failed ({response.status_code}): "
            f"{response.text[:200]}"
        )
        return None
    return response.json().get("value", [])


def move_file_to_deleted(folder_path: str, file_name: str) -> str:
    """Move a synced file into `{folder_path}/Deleted` in OneDrive.

    Called when the file's record is deleted, so the next sync doesn't pick the file up
    again — the `onedrive_files` row is what marks a file as processed, so removing the
    row while the file sits in place would re-ingest it within the interval.

    The subfolder is created on first use. A file already in Deleted under that name
    doesn't block the move: Graph would 409, so the mover renames instead (" 1", " 2").

    Args:
        folder_path: The project's OneDrive folder, e.g. "Sunil/Beone".
        file_name: Name of the file to move.

    Returns:
        The name the file ended up with in the Deleted folder.

    Raises:
        requests.HTTPError: If the token, folder creation, or move fails.
    """
    token = get_app_access_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # Create the Deleted subfolder if it isn't there yet. "fail" on conflict means an
    # existing folder comes back as 409, which is success for our purposes.
    made = requests.post(
        f"{GRAPH_BASE}/root:/{folder_path}:/children",
        headers=headers,
        json={
            "name": DELETED_SUBFOLDER,
            "folder": {},
            "@microsoft.graph.conflictBehavior": "fail",
        },
    )
    if made.status_code not in (200, 201, 409):
        made.raise_for_status()

    moved = requests.patch(
        f"{GRAPH_BASE}/root:/{folder_path}/{file_name}",
        headers=headers,
        json={
            "parentReference": {"path": f"/drive/root:/{folder_path}/{DELETED_SUBFOLDER}"},
            "@microsoft.graph.conflictBehavior": "rename",
        },
    )
    moved.raise_for_status()
    return moved.json().get("name") or file_name

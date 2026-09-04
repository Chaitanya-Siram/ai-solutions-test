"""WebSocket endpoint for the query-builder intake agent.

A single long-lived connection drives the whole multi-turn conversation; the
AgentState lives for the life of the socket.

Client flow:
  1. Connect to  ws://<host>/ws/query-builder?project_id=<id>
  2. Receive the agent's opening turn immediately (no input needed).
  3. Send  {"message": "<user text>"}  each turn — or, when a "confirm" frame is
     shown, {"action": "save"} / {"action": "cancel"}.
  4. Receive a stream of typed frames per turn, ending with a "state" frame.

Server frame types:
  - {"type": "agent", "stage": int, "message": str, "options": [str, ...]}
        (one per agent message; "options" are selectable choices — empty when none)
  - {"type": "artifact", "artifact": "brand"|"competitors"|"query_groups", ...}
        (a confirmed-value card, interleaved in display order)
  - {"type": "confirm", "stage": int}        (show Save / Cancel buttons)
  - {"type": "saved", "session": {...}}      (Save succeeded — DB row created)
  - {"type": "state", "stage": int, "state": {...}, "usage": {...}}
        (last frame of every turn; "usage" carries this-turn and running-session
        token counts + cost so the client can show a live meter — see UsageTracker
        in agents/chart_generator/llm_client.py)
  - {"type": "error", "detail": str}
"""
import asyncio
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from agents.chart_generator.llm_client import UsageTracker, track_usage
from agents.query_builder_agent.agent import (
    begin_session,
    build_session_payload,
    process_turn,
)
from configs import logger
from db_helpers.database import SessionLocal
from db_helpers.models.agent_state_model import AgentState
from db_helpers.repository.generated_query_db import create_generated_query_record

router = APIRouter(tags=["query-builder"])


def _usage_payload(turn_usage: UsageTracker, session_totals: dict[str, float]) -> dict[str, Any]:
    """Fold this turn's usage into the running session totals and return both,
    so the client can show a live per-turn delta plus a running total/cost."""
    session_totals["input_tokens"] += turn_usage.input_tokens
    session_totals["output_tokens"] += turn_usage.output_tokens
    session_totals["cost_usd"] += turn_usage.cost_usd
    return {
        "turn_input_tokens": turn_usage.input_tokens,
        "turn_output_tokens": turn_usage.output_tokens,
        "turn_cost_usd": turn_usage.cost_usd,
        "session_input_tokens": session_totals["input_tokens"],
        "session_output_tokens": session_totals["output_tokens"],
        "session_cost_usd": session_totals["cost_usd"],
    }


async def _emit_turn(
    websocket: WebSocket,
    state: AgentState,
    result: dict[str, Any],
    turn_usage: UsageTracker,
    session_totals: dict[str, float],
) -> None:
    """Replay the ordered turn events (messages, artifact cards, Save/Cancel prompts),
    then the state frame. Non-message events (artifact / confirm) are forwarded as-is
    with the current stage attached, so they land exactly where the agent emitted them."""
    for ev in result.get("turns", []):
        if ev.get("type") == "message":
            await websocket.send_json({
                "type": "agent",
                "stage": state.stage,
                "message": ev.get("message", ""),
                "options": ev.get("options") or [],
            })
        else:
            await websocket.send_json({**ev, "stage": state.stage})
    await websocket.send_json({
        "type": "state",
        "stage": state.stage,
        "state": state.model_dump(),
        "usage": _usage_payload(turn_usage, session_totals),
    })


def _save_session(project_id: int, state: AgentState) -> dict[str, Any]:
    """Persist the gathered config as a Session row. Runs in a worker thread
    (blocking DB I/O). Returns a small session summary."""
    payload = build_session_payload(state)
    db = SessionLocal()
    try:
        generated_query = create_generated_query_record(
            db,
            project_id=project_id,
            name=payload["name"],
            brand_keywords=payload["brand_keywords"],
            competitor_keywords=payload["competitor_keywords"],
            message_keywords=payload["message_keywords"],
            queries=payload["queries"],
        )

        # session = create_session(
        #     db,
        #     project_id=project_id,
        #     session_type=payload["session_type"],
        #     queries=payload["queries"],
        # )
        summary = {
            "id": generated_query.id,
            "project_id": generated_query.project_id,
            "name": generated_query.name,
            "session_type": payload["session_type"],
            "brand_keywords": generated_query.brand_keywords,
            "competitor_keywords": generated_query.competitor_keywords,
            "message_keywords": generated_query.message_keywords,
            "status": generated_query.status,
        }
    finally:
        db.close()
    return summary


@router.websocket("/ws/query-builder")
async def query_builder_stream(websocket: WebSocket) -> None:
    await websocket.accept()

    project_id: int | None = None
    raw_pid = websocket.query_params.get("project_id")
    if raw_pid is not None:
        try:
            project_id = int(raw_pid)
        except (TypeError, ValueError):
            project_id = None

    state = AgentState()
    session_totals = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
    try:
        # Opening turn (Stage 1 greeting) — runs off the event loop (LLM call).
        with track_usage() as usage:
            opening = await asyncio.to_thread(begin_session, state)
        await _emit_turn(websocket, state, opening, usage, session_totals)

        while True:
            payload = await websocket.receive_json()
            action = payload.get("action") if isinstance(payload, dict) else None

            if action == "save":
                if project_id is None:
                    await websocket.send_json({"type": "error", "detail": "Missing project_id — cannot save."})
                    continue
                try:
                    summary = await asyncio.to_thread(_save_session, project_id, state)
                    await websocket.send_json({"type": "saved", "session": summary})
                except Exception as exc:  # noqa: BLE001
                    logger.exception("Query-builder save failed")
                    await websocket.send_json({"type": "error", "detail": f"Could not save session: {exc}"})
                continue

            if action == "cancel":
                await websocket.send_json({
                    "type": "agent",
                    "stage": state.stage,
                    "message": "No problem — nothing saved. Tell me what you'd like to change, or say “new” to start over.",
                    "options": [],
                })
                continue

            message = payload.get("message") if isinstance(payload, dict) else None
            if not isinstance(message, str) or not message.strip():
                await websocket.send_json({"type": "error", "detail": "Send a non-empty 'message'."})
                continue

            with track_usage() as usage:
                result = await asyncio.to_thread(process_turn, state, message)
            await _emit_turn(websocket, state, result, usage, session_totals)

    except WebSocketDisconnect:
        logger.info("Query-builder websocket disconnected by client")
    except Exception as exc:  # noqa: BLE001
        logger.exception("Query-builder websocket failed")
        try:
            await websocket.send_json({"type": "error", "detail": f"Agent failed: {exc}"})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass

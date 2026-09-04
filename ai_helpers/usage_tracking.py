"""Shared LLM token/cost metering, used by every LLM call site in the repo
(agents/chart_generator/llm_client.py, agents/tagging_agent/*_service.py,
agents/relevancy_agent/relevancy_agent.py) so there is one pricing table and one
accumulation mechanism instead of three.

Usage is recorded against whichever `UsageTracker` is active on the current
context when `record_usage()` is called — set with `track_usage()`. This
propagates through `asyncio.to_thread` automatically (it copies the context),
but NOT through a bare `concurrent.futures.ThreadPoolExecutor.submit()`/`map()` —
those call sites must copy the context explicitly, e.g.:

    ctx = contextvars.copy_context()
    pool.submit(ctx.run, fn, *args)
"""
from __future__ import annotations

import contextvars
from contextlib import contextmanager
from typing import Any

from configs import logger

# $ per 1M tokens (input, output). Update if the deployed model or its list price
# changes — this is a static table, not fetched from either provider.
PRICING: dict[str, tuple[float, float]] = {
    "claude-sonnet-4-5": (3.00, 15.00),
    "gpt-4.1": (2.00, 8.00),
}

_usage_ctx: contextvars.ContextVar["UsageTracker | None"] = contextvars.ContextVar(
    "_usage_ctx", default=None
)


class UsageTracker:
    """Accumulates token usage/cost for every LLM call made while active.

    `calls.append` is the only mutation, which is atomic under the GIL, so
    concurrent worker threads sharing one tracker (tagging's batch pool) don't
    need an extra lock.
    """

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    @property
    def input_tokens(self) -> int:
        return sum(c["input_tokens"] for c in self.calls)

    @property
    def output_tokens(self) -> int:
        return sum(c["output_tokens"] for c in self.calls)

    @property
    def cost_usd(self) -> float:
        return sum(c["cost_usd"] for c in self.calls)

    def as_dict(self) -> dict[str, Any]:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": self.cost_usd,
        }


@contextmanager
def track_usage():
    """Meter every `record_usage()` call made within this block."""
    tracker = UsageTracker()
    token = _usage_ctx.set(tracker)
    try:
        yield tracker
    finally:
        _usage_ctx.reset(token)


def record_usage(provider: str, model: str, input_tokens: int, output_tokens: int) -> None:
    rates = PRICING.get(model)
    if rates is None:
        logger.warning(f"No pricing entry for model '{model}' — cost will show as $0 for this call.")
        cost = 0.0
    else:
        in_rate, out_rate = rates
        cost = (input_tokens / 1_000_000) * in_rate + (output_tokens / 1_000_000) * out_rate

    tracker = _usage_ctx.get()
    if tracker is not None:
        tracker.calls.append({
            "provider": provider,
            "model": model,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_usd": cost,
        })

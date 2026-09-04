"""Provider-agnostic LLM text / JSON completion for the agents package.

Switches between Anthropic Claude and Azure OpenAI based on `envs.LLM_PROVIDER`,
mirroring the alias sets used in ai_helpers. The agent pipeline is a sequence of
single-turn completions (classify intent, generate code, answer question) rather
than a provider-specific tool-call loop, so a single text/JSON surface keeps both
providers behaving identically.
"""
from __future__ import annotations

import json
import re
from typing import Any

from configs import envs, logger
from ai_helpers.usage_tracking import UsageTracker, record_usage, track_usage

_CLAUDE_ALIASES = {"claude", "anthropic"}
_AZURE_ALIASES = {"azure_openai", "azure-openai", "azure", "openai", "gpt", "gpt-azure"}

_anthropic_client = None
_azure_client = None

# Re-exported so existing `from agents.chart_generator.llm_client import
# UsageTracker, track_usage` call sites (query_builder_api.py) keep working.
__all__ = ["complete", "complete_web", "complete_json", "complete_json_web", "UsageTracker", "track_usage"]

_record_usage = record_usage


def _get_anthropic():
    global _anthropic_client
    if _anthropic_client is None:
        from anthropic import Anthropic

        if not envs.ANTHROPIC_API_KEY:
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        _anthropic_client = Anthropic(api_key=envs.ANTHROPIC_API_KEY)
    return _anthropic_client


def _get_azure():
    global _azure_client
    if _azure_client is None:
        from openai import AzureOpenAI

        missing = [
            name
            for name, val in (
                ("AZURE_OPENAI_API_KEY", envs.AZURE_OPENAI_API_KEY),
                ("AZURE_OPENAI_ENDPOINT", envs.AZURE_OPENAI_ENDPOINT),
                ("AZURE_OPENAI_MODEL", envs.AZURE_OPENAI_MODEL),
            )
            if not val
        ]
        if missing:
            raise RuntimeError(f"Azure OpenAI is not configured. Missing: {', '.join(missing)}")
        _azure_client = AzureOpenAI(
            api_key=envs.AZURE_OPENAI_API_KEY,
            azure_endpoint=envs.AZURE_OPENAI_ENDPOINT,
            api_version=envs.AZURE_OPENAI_API_VERSION,
            timeout=600.0,
        )
    return _azure_client


def complete(system: str, user: str, max_tokens: int = 4096, temperature: float = 0.0) -> str:
    """Return the model's plain-text response to (system, user)."""
    provider = envs.LLM_PROVIDER
    if provider in _AZURE_ALIASES:
        client = _get_azure()
        completion = client.chat.completions.create(
            model=envs.AZURE_OPENAI_MODEL,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        if completion.usage:
            _record_usage(
                "azure", envs.AZURE_OPENAI_MODEL,
                completion.usage.prompt_tokens, completion.usage.completion_tokens,
            )
        if not completion.choices:
            raise ValueError("Azure OpenAI returned no choices")
        return (completion.choices[0].message.content or "").strip()

    if provider in _CLAUDE_ALIASES:
        client = _get_anthropic()
        resp = client.messages.create(
            model=envs.CLAUDE_MODEL,
            max_tokens=max_tokens,
            temperature=temperature,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user}],
        )
        if resp.usage:
            _record_usage("claude", envs.CLAUDE_MODEL, resp.usage.input_tokens, resp.usage.output_tokens)
        parts = [getattr(b, "text", "") for b in resp.content if getattr(b, "type", None) == "text"]
        return "".join(parts).strip()

    raise RuntimeError(f"Unknown LLM_PROVIDER='{provider}'. Use 'claude' or 'azure_openai'.")


def complete_web(system: str, user: str, max_tokens: int = 4096, max_uses: int = 5) -> str:
    """Plain-text completion with Claude's server-side `web_search` tool enabled, so
    the model can ground its answer in live web results.

    Web search is a Claude-specific capability, so this prefers Claude whenever an
    Anthropic key is available — even when LLM_PROVIDER is Azure. With no Anthropic
    key it degrades gracefully to a normal, knowledge-only completion.
    """
    if not envs.ANTHROPIC_API_KEY:
        logger.info("complete_web: no ANTHROPIC_API_KEY — falling back to knowledge-only completion")
        return complete(system, user, max_tokens=max_tokens, temperature=0.0)

    client = _get_anthropic()
    resp = client.messages.create(
        model=envs.CLAUDE_MODEL,
        max_tokens=max_tokens,
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user}],
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": max_uses}],
    )
    if resp.usage:
        _record_usage("claude", envs.CLAUDE_MODEL, resp.usage.input_tokens, resp.usage.output_tokens)
    # The model interleaves search/tool blocks with text; the answer is the text.
    parts = [getattr(b, "text", "") for b in resp.content if getattr(b, "type", None) == "text"]
    return "".join(parts).strip()


def _parse_json(raw: str, where: str) -> Any:
    cleaned = _strip_code_fences(raw)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"(\{.*\}|\[.*\])", cleaned, re.DOTALL)
        if match:
            return json.loads(match.group(1))
        logger.warning(f"{where} could not parse model output: {cleaned[:200]}")
        raise


def complete_json_web(system: str, user: str, max_tokens: int = 4096, max_uses: int = 5) -> Any:
    """Like complete_json, but with live web search (Claude). Falls back to
    knowledge-only JSON when no Anthropic key is configured."""
    raw = complete_web(system, user, max_tokens=max_tokens, max_uses=max_uses)
    return _parse_json(raw, "complete_json_web")


def _strip_code_fences(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


def complete_json(system: str, user: str, max_tokens: int = 4096) -> Any:
    """Completion whose response is parsed as JSON. Tolerates markdown fences and
    leading/trailing prose by salvaging the first JSON object/array."""
    raw = complete(system, user, max_tokens=max_tokens, temperature=0.0)
    cleaned = _strip_code_fences(raw)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"(\{.*\}|\[.*\])", cleaned, re.DOTALL)
        if match:
            return json.loads(match.group(1))
        logger.warning(f"complete_json could not parse model output: {cleaned[:200]}")
        raise

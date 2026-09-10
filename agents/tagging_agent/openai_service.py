import json
from typing import Any
from configs import envs, logger
from ai_helpers.usage_tracking import record_usage
from ai_helpers.langfuse_client import observe, LangfuseAzureOpenAI
from .tagging_common import (
    TAG_TOOL_DESCRIPTION,
    TAG_TOOL_NAME,
    align_taggings,
    blank_tagging,
    build_batch_message,
    get_system_prompt,
    build_tag_tool_parameters,
    run_in_batches,
    run_in_batches_streaming,
)

_client: LangfuseAzureOpenAI | None = None


def _get_client() -> LangfuseAzureOpenAI:
    global _client
    if _client is None:
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
        _client = LangfuseAzureOpenAI(
            api_key=envs.AZURE_OPENAI_API_KEY,
            azure_endpoint=envs.AZURE_OPENAI_ENDPOINT,
            api_version=envs.AZURE_OPENAI_API_VERSION,
            timeout=600.0,
        )
    return _client


def _extract_taggings(completion: Any) -> list[dict[str, Any]]:
    if not completion.choices:
        raise ValueError("Azure OpenAI returned no choices")
    choice = completion.choices[0]
    finish_reason = getattr(choice, "finish_reason", None)
    message = choice.message
    tool_calls = getattr(message, "tool_calls", None) or []
    for call in tool_calls:
        if call.function.name == TAG_TOOL_NAME:
            raw = call.function.arguments or "{}"
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning(
                    f"Tool-call JSON truncated (finish_reason={finish_reason}, "
                    f"args_len={len(raw)}) — model hit max_tokens. Returning empty list."
                )
                return []
            taggings = list(payload.get("taggings", []))
            if finish_reason == "length":
                logger.warning(
                    f"finish_reason=length: model returned {len(taggings)} taggings "
                    f"before output token cap. Caller will retry the missing ones."
                )
            return taggings
    raise ValueError(f"Azure OpenAI did not call {TAG_TOOL_NAME}")


def _tag_batch(
    articles: list[dict[str, Any]],
    brand_keywords: list[str],
    competitor_keywords: list[str],
    sections_prompt: str | None = None,
    project_name: str | None = None,
) -> list[dict[str, Any]]:
    # LangfuseAzureOpenAI drop-in auto-instruments the completions call below:
    # model name, tokens, prompt/response are captured without manual decoration.
    ids = [a["id"] for a in articles]
    client = _get_client()
    try:
        logger.info(f"Tagging batch of {len(articles)} articles with Azure OpenAI...")
        completion = client.chat.completions.create(
            model=envs.AZURE_OPENAI_MODEL,
            max_tokens=envs.MAX_OUTPUT_TOKENS,
            messages=[
                {"role": "system", "content": get_system_prompt(brand_keywords, competitor_keywords, sections_prompt, project_name)},
                {"role": "user", "content": build_batch_message(articles)},
            ],
            tools=[
                {
                    "type": "function",
                    "function": {
                        "name": TAG_TOOL_NAME,
                        "description": TAG_TOOL_DESCRIPTION,
                        "parameters": build_tag_tool_parameters(brand_keywords, sections_prompt),
                    },
                }
            ],
            tool_choice={
                "type": "function",
                "function": {
                    "name": TAG_TOOL_NAME
                }
            },
        )
        if completion.usage:
            record_usage(
                "azure", envs.AZURE_OPENAI_MODEL,
                completion.usage.prompt_tokens, completion.usage.completion_tokens,
            )
        taggings = _extract_taggings(completion)
    except Exception as exc:  # noqa: BLE001
        logger.error(f"Azure OpenAI batch tagging failed for {len(articles)} articles: {exc}")
        return [blank_tagging(aid) for aid in ids]
    return align_taggings(ids, taggings)


@observe(name="azure-tag-articles", capture_input=False, capture_output=False)
def tag_articles(
    articles: list[dict[str, Any]],
    brand_keywords: list[str],
    competitor_keywords: list[str],
    sections_prompt: str | None = None,
    project_name: str | None = None,
) -> list[dict[str, Any]]:
    """Tag with Azure OpenAI."""
    from langfuse import get_client as _lf_get_client
    _lf_get_client().update_current_span(
        input={"articles_count": len(articles), "project": project_name},
    )
    def batch_fn(batch: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return _tag_batch(batch, brand_keywords, competitor_keywords, sections_prompt, project_name)
    return run_in_batches(articles, batch_fn)


@observe(name="azure-tag-articles-streaming", capture_input=False, capture_output=False)
def tag_articles_streaming(
    articles: list[dict[str, Any]],
    brand_keywords: list[str],
    competitor_keywords: list[str],
    sections_prompt: str | None = None,
    on_batch_done: Any = None,
    project_name: str | None = None,
) -> list[dict[str, Any]]:
    """Streaming variant: emits on_batch_done(payload) as each chunk finishes."""
    from langfuse import get_client as _lf_get_client
    _lf_get_client().update_current_span(
        input={"articles_count": len(articles), "project": project_name},
    )
    def batch_fn(batch: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return _tag_batch(batch, brand_keywords, competitor_keywords, sections_prompt, project_name)
    cb = on_batch_done if callable(on_batch_done) else (lambda _: None)
    return run_in_batches_streaming(articles, batch_fn, cb)

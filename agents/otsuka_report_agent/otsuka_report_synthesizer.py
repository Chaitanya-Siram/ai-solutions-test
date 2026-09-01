"""Synthesises the LLM-written prose for the Otsuka news-coverage report.

Runs once when the Otsuka .docx report is built, in two separate LLM stages:

  1. **Article summaries** — the articles are sent in batches of 5, each batch a
     forced tool call returning a ``mention_note`` plus exactly 4 summary points
     per article. Batching keeps each call small enough that the model actually
     summarises every article instead of thinning out over a long digest, and a
     failed batch only costs its own 5 articles.
  2. **Overall summary** — the 4-paragraph executive summary, written from the
     *article summaries produced in stage 1* rather than the raw article bodies,
     so it summarises the coverage set as a whole.

The public entry point `synthesize_otsuka_report` returns the overall summary
plus a copy of `sections` with each article enriched in place: ``mention_note``
set and both ``content`` and ``summary`` replaced by the newline-joined summary
points (which the report builder renders one bullet per line). Both fields are
written because the builder prefers ``summary``, so leaving the pipeline's own
1-2 sentence summary in place would silently override the LLM's points. On any
failure it returns whatever it managed to produce, so the report still builds.
"""

import copy
import json
from pathlib import Path
from typing import Any
from configs import envs, logger


_PROMPTS_DIR = Path(__file__).parent / "prompts"
_ARTICLE_PROMPT_TEMPLATE = (_PROMPTS_DIR / "otsuka_article_summarizer.txt").read_text(encoding="utf-8")
_OVERALL_PROMPT_TEMPLATE = (_PROMPTS_DIR / "otsuka_overall_summarizer.txt").read_text(encoding="utf-8")

# Cap what we send so a big report doesn't blow the context window.
_MAX_ARTICLES = 120
_BODY_CHARS = 3000
_BATCH_SIZE = 5

_CLAUDE_ALIASES = {"claude", "anthropic"}
_AZURE_ALIASES = {"azure_openai", "azure-openai", "azure", "openai", "gpt", "gpt-azure"}

_ARTICLE_TOOL_NAME = "record_article_summaries"
_ARTICLE_TOOL_DESCRIPTION = (
    "Record the point-wise summary of every article in this batch for the "
    "Otsuka news-coverage report."
)
_ARTICLE_TOOL_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "articles": {
            "type": "array",
            "description": "One entry per article in the batch — do not drop any.",
            "items": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "The article's id, copied exactly from the batch.",
                    },
                    "mention_note": {
                        "type": "string",
                        "description": "Bullet 1, the mandatory mention statement, exactly as worded in the system prompt.",
                    },
                    "points": {
                        "type": "array",
                        "description": "Bullets 2 to 5 from the system prompt, one bullet per string.",
                        "items": {"type": "string"},
                        "minItems": 4,
                        "maxItems": 4,
                    },
                },
                "required": ["id", "mention_note", "points"],
            },
        },
    },
    "required": ["articles"],
}

_OVERALL_TOOL_NAME = "record_overall_summary"
_OVERALL_TOOL_DESCRIPTION = (
    "Record the 4-paragraph executive summary of the whole Otsuka news-coverage report."
)
_OVERALL_TOOL_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "overall_summary": {
            "type": "array",
            "description": "Exactly 4 paragraphs, each 60 words or fewer, in the order defined in the system prompt: brand mentions, treatment/pipeline/clinical, Medicare/pricing/access, remaining industry and policy. Flowing prose, no markdown, no article ids.",
            "items": {"type": "string"},
            "minItems": 4,
            "maxItems": 4,
        },
    },
    "required": ["overall_summary"],
}


def _render_prompt(template: str, brand_keywords, competitor_keywords) -> str:
    brands = [str(b).strip() for b in (brand_keywords or []) if str(b).strip()]
    comps = [str(c).strip() for c in (competitor_keywords or []) if str(c).strip()]
    brand_str = ", ".join(brands) if brands else "(not specified)"
    comp_str = ", ".join(comps) if comps else "(none specified)"
    return template.replace("{{BRAND}}", brand_str).replace("{{COMPETITORS}}", comp_str)


def _iter_articles(sections):
    for section in sections:
        name = section.get("name") if isinstance(section, dict) else ""
        for art in (section.get("articles", []) if isinstance(section, dict) else []):
            if isinstance(art, dict):
                yield name, art


def _ensure_ids(sections):
    """Guarantee every article has a stable id so LLM output can be merged back."""
    n = 0
    for _section_name, art in _iter_articles(sections):
        if not art.get("id"):
            art["id"] = f"idx{n}"
        n += 1


def _batches(sections) -> list[list[tuple[str, dict[str, Any]]]]:
    """Split the articles into `_BATCH_SIZE`-sized (section_name, article) batches."""
    flat = list(_iter_articles(sections))[:_MAX_ARTICLES]
    return [flat[i:i + _BATCH_SIZE] for i in range(0, len(flat), _BATCH_SIZE)]


def _build_batch_digest(batch) -> str:
    """Compact per-article view for one batch: id | section | source | title | body."""
    lines: list[str] = ["ARTICLES TO SUMMARIZE:", ""]
    for section_name, art in batch:
        aid = str(art.get("id"))
        source = str(art.get("domain") or art.get("source") or "").strip()
        title = str(art.get("title") or "").strip().replace("\n", " ")
        body = str(art.get("content") or art.get("summary") or "").strip().replace("\n", " ")
        lines.append(f"[{aid}] SECTION: {section_name} | SOURCE: {source} | TITLE: {title}")
        lines.append(f"BODY: {body[:_BODY_CHARS]}")
        lines.append("")
    return "\n".join(lines)


def _build_summary_digest(sections, by_id) -> str:
    """The stage-1 summaries, grouped by section, as input to the overall summary."""
    lines: list[str] = ["ARTICLE SUMMARIES FOR TODAY'S COVERAGE (grouped by section):", ""]
    current_section = None
    for section_name, art in _iter_articles(sections):
        enriched = by_id.get(str(art.get("id")))
        if not enriched:
            continue
        if section_name != current_section:
            current_section = section_name
            lines.append("")
            lines.append(f"## SECTION: {section_name}")
        title = str(art.get("title") or "").strip().replace("\n", " ")
        lines.append(f"TITLE: {title}")
        if enriched["mention_note"]:
            lines.append(enriched["mention_note"])
        lines.extend(enriched["points"])
        lines.append("")
    return "\n".join(lines)


def _normalize_articles(raw: Any) -> dict[str, dict[str, Any]]:
    """Return ``{article_id: {mention_note, points}}`` from a stage-1 tool call."""
    by_id: dict[str, dict[str, Any]] = {}
    if not isinstance(raw, dict):
        return by_id
    for item in raw.get("articles") or []:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        points = item.get("points") or []
        if isinstance(points, str):
            points = [points]
        by_id[str(item["id"])] = {
            "mention_note": str(item.get("mention_note") or "").strip(),
            "points": [str(p).strip() for p in points if str(p).strip()],
        }
    return by_id


def _normalize_overall(raw: Any) -> list[str]:
    """Return the overall-summary paragraphs from a stage-2 tool call."""
    if not isinstance(raw, dict):
        return []
    summary = raw.get("overall_summary") or []
    if isinstance(summary, str):
        summary = [summary]
    return [str(p).strip() for p in summary if str(p).strip()]


def _call_claude(system_prompt, user_msg, tool_name, tool_description, parameters) -> Any:
    from anthropic import Anthropic

    if not envs.ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    client = Anthropic(api_key=envs.ANTHROPIC_API_KEY)
    resp = client.messages.create(
        model=envs.CLAUDE_MODEL,
        max_tokens=envs.MAX_OUTPUT_TOKENS,
        system=[{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
        tools=[{
            "name": tool_name,
            "description": tool_description,
            "input_schema": parameters,
        }],
        tool_choice={"type": "tool", "name": tool_name},
        messages=[{"role": "user", "content": user_msg}],
    )
    for block in resp.content:
        if getattr(block, "type", None) == "tool_use" and block.name == tool_name:
            return dict(block.input)
    raise ValueError(f"Claude did not return a {tool_name} tool call")


def _call_azure(system_prompt, user_msg, tool_name, tool_description, parameters) -> Any:
    from openai import AzureOpenAI

    if not (envs.AZURE_OPENAI_API_KEY and envs.AZURE_OPENAI_ENDPOINT and envs.AZURE_OPENAI_MODEL):
        raise RuntimeError("Azure OpenAI is not configured")
    client = AzureOpenAI(
        api_key=envs.AZURE_OPENAI_API_KEY,
        azure_endpoint=envs.AZURE_OPENAI_ENDPOINT,
        api_version=envs.AZURE_OPENAI_API_VERSION,
        timeout=600.0,
    )
    completion = client.chat.completions.create(
        model=envs.AZURE_OPENAI_MODEL,
        max_tokens=envs.MAX_OUTPUT_TOKENS,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ],
        tools=[{
            "type": "function",
            "function": {
                "name": tool_name,
                "description": tool_description,
                "parameters": parameters,
            },
        }],
        tool_choice={"type": "function", "function": {"name": tool_name}},
    )
    if not completion.choices:
        raise ValueError(f"Azure OpenAI returned no choices for {tool_name}")
    tool_calls = getattr(completion.choices[0].message, "tool_calls", None) or []
    for call in tool_calls:
        if call.function.name == tool_name:
            return json.loads(call.function.arguments or "{}")
    raise ValueError(f"Azure OpenAI did not call {tool_name}")


def _call_llm(system_prompt, user_msg, tool_name, tool_description, parameters) -> Any:
    """Forced single tool call against the configured provider."""
    provider = envs.LLM_PROVIDER
    if provider in _AZURE_ALIASES:
        return _call_azure(system_prompt, user_msg, tool_name, tool_description, parameters)
    if provider in _CLAUDE_ALIASES:
        return _call_claude(system_prompt, user_msg, tool_name, tool_description, parameters)
    raise RuntimeError(f"Unknown LLM_PROVIDER='{provider}'")


def _summarize_articles(sections) -> dict[str, dict[str, Any]]:
    """Stage 1: summarize the articles in batches of `_BATCH_SIZE`.

    The prompt is the client's own wording, with Otsuka / Rexulti / Lundbeck and
    the seven mention statements written into it literally, so it takes no brand
    keywords and is sent verbatim. A failed batch is logged and skipped so the
    rest of the report still gets its summaries.
    """
    system_prompt = _ARTICLE_PROMPT_TEMPLATE
    by_id: dict[str, dict[str, Any]] = {}
    batches = _batches(sections)
    for i, batch in enumerate(batches, start=1):
        try:
            raw = _call_llm(
                system_prompt,
                _build_batch_digest(batch),
                _ARTICLE_TOOL_NAME,
                _ARTICLE_TOOL_DESCRIPTION,
                _ARTICLE_TOOL_PARAMETERS,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"Otsuka article batch {i}/{len(batches)} failed: {exc}")
            continue
        by_id.update(_normalize_articles(raw))
    return by_id


def _summarize_overall(sections, by_id, brand_keywords, competitor_keywords) -> list[str]:
    """Stage 2: the 4-paragraph executive summary, written from the stage-1 output."""
    if not by_id:
        return []
    system_prompt = _render_prompt(_OVERALL_PROMPT_TEMPLATE, brand_keywords, competitor_keywords)
    try:
        raw = _call_llm(
            system_prompt,
            _build_summary_digest(sections, by_id),
            _OVERALL_TOOL_NAME,
            _OVERALL_TOOL_DESCRIPTION,
            _OVERALL_TOOL_PARAMETERS,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception(f"Otsuka overall summary failed: {exc}")
        return []
    return _normalize_overall(raw)


def synthesize_otsuka_report(
    sections: list[dict[str, Any]],
    brand_keywords: list[str] | None = None,
    competitor_keywords: list[str] | None = None,
) -> dict[str, Any]:
    """Produce ``{"overall_summary": [str, ...], "sections": <enriched sections>}``.

    `sections` is the ordered ``[{name, articles}]`` the report builder consumes.
    The returned sections are a deep copy with each article's ``mention_note`` set
    and ``content`` replaced by the LLM's newline-joined summary points. Articles
    whose batch failed are returned unchanged.
    """
    sections = copy.deepcopy(sections or [])
    if not sections or not any(s.get("articles") for s in sections):
        return {"overall_summary": [], "sections": sections}

    _ensure_ids(sections)

    by_id = _summarize_articles(sections)
    overall_summary = _summarize_overall(sections, by_id, brand_keywords, competitor_keywords)

    # Merge the per-article summaries back into the sections in place.
    for _section_name, art in _iter_articles(sections):
        enriched = by_id.get(str(art.get("id")))
        if not enriched:
            continue
        if enriched["mention_note"]:
            art["mention_note"] = enriched["mention_note"]
        if enriched["points"]:
            # Write both: the builder reads `summary` first, and the pipeline's
            # own 1-2 sentence summary would otherwise win over these points.
            art["content"] = "\n".join(enriched["points"])
            art["summary"] = art["content"]

    return {"overall_summary": overall_summary, "sections": sections}

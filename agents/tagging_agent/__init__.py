"""Tagging agent.

LLM tagging of articles (sentiment / theme / section). `llm_service` is the only
dispatcher — both providers in `openai_service` / `claude_service` implement
`tag_articles` and `tag_articles_streaming` identically. `tagging_common` holds
the prompt, tool schema, and batching; `tag_reuse` skips re-tagging articles a
merged session's sources already tagged.
"""

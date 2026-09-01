"""Provider-switched text embeddings for article similarity.

Dispatches on ``envs.EMBEDDING_PROVIDER`` the way :mod:`agents.tagging_agent.llm_service`
dispatches tagging: "openai" (Azure OpenAI, the default), "voyage" (Voyage AI) or
"local" (sentence-transformers, no API). ``envs.EMBEDDING_MODEL`` overrides the
provider's default model / deployment name.

Vectors from different models live in incompatible spaces, so every stored vector
is tagged with :func:`current_embedding_model` and comparisons only ever mix
vectors carrying the current tag — switching provider or model simply makes the
old vectors read as "not embedded yet" and they are re-embedded lazily.
"""
from __future__ import annotations

from typing import Any

from configs import envs, logger

_OPENAI_ALIASES = {"openai", "azure", "azure_openai", "azure-openai", "gpt", "gpt-azure"}
_VOYAGE_ALIASES = {"voyage", "voyageai", "voyage-ai"}
_LOCAL_ALIASES = {"local", "sentence-transformers", "sentence_transformers"}

_DEFAULT_MODELS = {
    "openai": "text-embedding-3-small",  # Azure deployment name
    "voyage": "voyage-4",
    "local": "all-MiniLM-L6-v2",
}

_EMBED_BATCH = 100     # inputs per API call; both APIs allow far more, kept small
_MAX_INPUT_CHARS = 8000

_voyage_client = None
_local_model = None


def _provider() -> str:
    name = envs.EMBEDDING_PROVIDER
    if name in _OPENAI_ALIASES:
        return "openai"
    if name in _VOYAGE_ALIASES:
        return "voyage"
    if name in _LOCAL_ALIASES:
        return "local"
    raise RuntimeError(
        f"Unknown EMBEDDING_PROVIDER='{name}'. Use 'openai', 'voyage' or 'local'."
    )


def _model_name() -> str:
    return envs.EMBEDDING_MODEL or _DEFAULT_MODELS[_provider()]


def current_embedding_model() -> str:
    """The '{provider}:{model}' tag stored beside every vector, so vectors from
    different models are never compared to each other."""
    return f"{_provider()}:{_model_name()}"


def embedding_text(title: Any, content: Any) -> str:
    """The text a similarity vector is computed over — the single definition shared
    by the live linking path and the backfill script, because two rows embedded from
    differently-assembled text are not comparable. ``content`` is whatever body text
    the caller resolved (the linker passes the tagger's summary in preference to the
    scraped body — see ``list_embedding_rows``); the title alone is used when it is
    empty."""
    head = str(title or "").strip()
    body = str(content or "").strip()[: envs.SIMILAR_EMBED_MAX_CHARS]
    return f"{head}\n\n{body}".strip()


def embed_texts(texts: list[str]) -> list[list[float]]:
    """One embedding vector per input, in order.

    Raises on missing configuration or API failure — callers decide what a failed
    embedding pass means (the similarity linker degrades to "no links this run").
    """
    if not texts:
        return []
    prepared = [(t or " ")[:_MAX_INPUT_CHARS] or " " for t in texts]
    provider = _provider()
    if provider == "openai":
        return _embed_openai(prepared)
    if provider == "voyage":
        return _embed_voyage(prepared)
    return _embed_local(prepared)


def _embed_openai(texts: list[str]) -> list[list[float]]:
    from agents.chart_generator.llm_client import _get_azure

    client = _get_azure()
    out: list[list[float]] = []
    for start in range(0, len(texts), _EMBED_BATCH):
        resp = client.embeddings.create(
            model=_model_name(), input=texts[start : start + _EMBED_BATCH]
        )
        out.extend(d.embedding for d in sorted(resp.data, key=lambda d: d.index))
    return out


def _embed_voyage(texts: list[str]) -> list[list[float]]:
    global _voyage_client
    if _voyage_client is None:
        import voyageai  # optional dependency; install when EMBEDDING_PROVIDER=voyage

        if not envs.VOYAGE_API_KEY:
            raise RuntimeError("VOYAGE_API_KEY is not set")
        _voyage_client = voyageai.Client(api_key=envs.VOYAGE_API_KEY)
    out: list[list[float]] = []
    for start in range(0, len(texts), _EMBED_BATCH):
        resp = _voyage_client.embed(texts[start : start + _EMBED_BATCH], model=_model_name())
        out.extend(resp.embeddings)
    return out


def _embed_local(texts: list[str]) -> list[list[float]]:
    global _local_model
    if _local_model is None:
        # Optional heavy dependency (pulls in torch); install when EMBEDDING_PROVIDER=local.
        from sentence_transformers import SentenceTransformer

        logger.info(f"Loading local embedding model '{_model_name()}'")
        _local_model = SentenceTransformer(_model_name())
    vectors = _local_model.encode(texts, show_progress_bar=False)
    return [list(map(float, v)) for v in vectors]

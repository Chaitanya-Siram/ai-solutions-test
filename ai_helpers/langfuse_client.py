"""Conditional Langfuse tracing helpers for v4.

Exports:
  observe            — @observe decorator (no-op when keys absent)
  langfuse_context   — update_current_observation / update_current_trace shims
  LangfuseAzureOpenAI — drop-in AzureOpenAI replacement; auto-instruments all
                        chat.completions calls with model name + tokens when
                        Langfuse is enabled, falls back to the real client otherwise.

Import from here instead of from langfuse or openai directly.

IMPORTANT: this module is imported after load_dotenv() runs in configs.py,
so os.getenv reads are always up to date.
"""
import os as _os

_enabled = bool(
    _os.getenv("LANGFUSE_PUBLIC_KEY") and _os.getenv("LANGFUSE_SECRET_KEY")
)

if _enabled:
    from langfuse import observe  # noqa: F401
    from langfuse.openai import AzureOpenAI as LangfuseAzureOpenAI  # noqa: F401

    class _LangfuseContext:
        """Thin compat wrapper around langfuse v4 get_client() methods."""

        def update_current_observation(self, model=None, usage=None, metadata=None, **_):
            from langfuse import get_client
            get_client().update_current_generation(
                model=model,
                usage_details=usage,   # {"input": n, "output": n}
                metadata=metadata,
            )

        def update_current_trace(self, name=None, metadata=None, **_):
            # v4: propagate_attributes is the right hook for cross-span context;
            # set_current_trace_io sets top-level input/output only.
            pass

    langfuse_context = _LangfuseContext()

else:
    from openai import AzureOpenAI as LangfuseAzureOpenAI  # noqa: F401

    def observe(*_args, **_kwargs):
        def decorator(fn):
            return fn
        if _args and callable(_args[0]):
            return _args[0]
        return decorator

    class _NoopContext:
        def update_current_observation(self, **_):
            pass
        def update_current_trace(self, **_):
            pass

    langfuse_context = _NoopContext()

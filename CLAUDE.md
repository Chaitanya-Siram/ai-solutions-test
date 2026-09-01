# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Backend (repo root) — Windows venv is at .venv/Scripts/python.exe
.venv/Scripts/python.exe -m uvicorn main:app --reload --port 8000

# Frontend
cd frontend && npm install && npm run dev      # Vite dev server on :5173
cd frontend && npm run build                   # production build into frontend/dist

# Query-builder agent as a standalone CLI chatbot
python -m agents.query_builder_agent.agent

# Import check (fastest way to validate a backend edit)
python -c "import routers.tagging_api; print('backend OK')"

# Syntax-check a frontend JSX edit without a full build
cd frontend && npx esbuild src/screens/ReviewScreen.jsx --outfile=$TEMP/out.js
```

There is **no test suite, linter, or formatter** configured — no pytest, no eslint. Validate changes by importing the module (backend) or esbuild/`npm run build` (frontend).

Requires a reachable PostgreSQL and a populated `.env` (see `Configs` in [configs.py](configs.py); it logs a warning per missing required var at startup).

Deployment: push to `master` builds [Dockerfile](Dockerfile) → ECR → EKS via [.github/workflows/main.yml](.github/workflows/main.yml), applying [build/ai-solutions.yaml](build/ai-solutions.yaml).

## Architecture

FastAPI backend + React/Vite SPA for PR media monitoring: fetch news → LLM-classify → dashboards → .docx reports.

### The pipeline

Every path through the system is a variation of one flow, and all of it converges on the same two tables:

```
source (upload | Google News RSS | BeOne feeds)
  → raw_articles rows  (verbatim source record in `data`, normalized columns beside it)
  → relevancy gate  (agents/relevancy_agent — LLM, fails OPEN, uses project.relevancy_prompt)
  → reach enrichment (SimilarWeb) + publication name (CSV on S3)
  → syndication link (ai_helpers/article_linker — lexical, no LLM; copies inherit their main's tags)
  → LLM tagging (sentiment / theme / section — ai_helpers/llm_service)
  → tagged_articles rows
  → embedding story groups (ai_helpers/embedding_linker — similar_group_id)
  → charts JSON (cached on S3, the only thing still on S3)
  → .docx report (reports_helpers)
```

`article_id` = sha256 of the canonical URL. It is the identity used for every dedupe and tag-reuse decision across the whole pipeline; row primary keys are not comparable across scopes.

### ArticleScope — read this before touching any article code

[db_helpers/repository/article_scope.py](db_helpers/repository/article_scope.py) is the most important abstraction in the repo. A project's articles live in one of two places:

- **A session's own set** — an upload or merge brings its articles with it (`session_id` set on the row).
- **The project pool** — the hourly scheduler fetches into the *project*, not a session (`session_id IS NULL`). One row per article per project, however many queries turn it up.

A session created by a manual run is a **view** over the pool: it carries a start/end window and shows pool articles dated inside it. It owns nothing, so editing an article from its review page mutates the pool row every other overlapping window reads.

`scope_for_session()` is the single place that decides which of the two a session means. Always thread an `ArticleScope` down through repository calls, never a bare `session_id`.

### Scheduler and the pool lock

[scheduler.py](scheduler.py) is a dependency-free asyncio loop started from `main.py`'s startup hook. It ticks every 60s and runs each scheduled generated query once an hour, at its `schedule_time` minute in its timezone. Dueness is computed by comparing `last_run_at` against the current hour's slot, so a slot missed while the app was down still runs and no slot runs twice.

Two independent guards, and the distinction matters:

- `_running` in the scheduler prevents overlap **per generated query**, with a reaper that releases ids whose run outlived `SCHEDULER_RUN_TIMEOUT_SECONDS` (a Python thread can't be cancelled, so leaked workers are tracked and logged, not killed).
- [data_source_helpers/project_pool_lock.py](data_source_helpers/project_pool_lock.py) serializes the fetch→tag pass **per project** — two passes would each snapshot "what we already have" before the other inserted, tagging the same rows twice. It is **process-local**; scaling the API to multiple workers requires converting it to a Postgres advisory lock.

`fetch_and_tag_project_pool()` in [routers/tagging_api.py](routers/tagging_api.py) is the single ingest path into a pool, shared by the scheduler and by a review page opening. A scheduled query's review page does **not** fetch (the scheduler owns that pool's freshness); an unscheduled one fetches `WS_REVIEW_FETCH_HOURS` itself.

Incremental vs. wholesale tagging is a real distinction: `tag_new_pool_articles` tags only untagged rows and *appends*, because re-running the full pipeline would re-pay for the relevancy gate and tagger and would discard review edits. `tagging_stream` over a session-owned set replaces wholesale.

### WebSockets carry the long-running work

Anything that takes minutes streams typed JSON messages instead of blocking a request: `/ws/tagging`, `/ws/charts`, `/ws/agent`, `/ws/query-builder`. Message-type contracts are documented in each router's docstring (`start` / `batch` / `progress` / `complete` / `error`). Blocking work inside these handlers goes through `asyncio.to_thread`.

### Pluggable providers

- **LLM**: `LLM_PROVIDER` selects `ai_helpers/openai_service.py` (Azure OpenAI) or `ai_helpers/claude_service.py`. `ai_helpers/llm_service.py` is the only dispatcher — both providers must implement `tag_articles` and `tag_articles_streaming` identically.
- **Embeddings**: `EMBEDDING_PROVIDER` = `local` (sentence-transformers, pulls ~2GB of torch), `openai`, or `voyage`.
- **Chart code execution**: LLM-generated Python runs in an E2B sandbox ([agents/chart_generator/sandbox.py](agents/chart_generator/sandbox.py)), retried up to 3× with the error fed back.

### Client-specific behavior is keyed off names, not config

Two separate dispatch points, both string-matched:

- Fetch pipeline, by **project name** — `is_beone_project()` / `is_trane_project()` in [data_source_helpers/fetching_service.py](data_source_helpers/fetching_service.py) route to bespoke source sets. Trane is currently commented out.
- Report layout, by **first brand keyword** — `"trane"` / `"otsuka"` substring checks in [routers/report_api.py](routers/report_api.py), everything else gets the BeOne layout. Otsuka has two layouts picked by a `variant` query param: `"coverage"` (default, static build) vs `"summary"`, which runs the articles through `agents/otsuka_report_agent/otsuka_report_synthesizer.py` first to LLM-write the executive summary and per-article blurbs before building the doc.

Adding a client means touching both, plus a `reports_helpers/<client>_report.py`.

### Schema migrations live in code, not Alembic

`init_db()` in [db_helpers/database.py](db_helpers/database.py) runs at import time of `main.py` and does everything: creates the schema (`DB_SCHEMA`, default `ai_solution`), `create_all`, then applies `_ADDED_COLUMNS`, `_ADDED_INDEXES`, and `_DROPPED_COLUMNS` in that order. Consequences to respect:

- `create_all` skips existing tables **including their indexes**, so a new index on a live table must be added to `_ADDED_INDEXES` as well as the model's `__table_args__`.
- Column drops carry a **SQL guard expression** proving the data was migrated; a false guard leaves the column and logs why. Never drop blind — the drop runs at every startup.

### Layout

`routers/` HTTP+WS endpoints (all JWT-protected except `/auth/*` and user registration) · `db_helpers/models` SQLAlchemy + Pydantic side by side in one file per table · `db_helpers/repository` all query logic · `ai_helpers/` LLM services, linkers, synthesizers, prompts as `.txt` · `agents/` multi-step LLM flows with their own prompts · `data_source_helpers/` fetchers and scrapers · `charts_helpers/` dashboard computation per `DASHBOARDS_ENUM` · `reports_helpers/` .docx builders · `frontend/src/api/` one module per router, all through `apiFetch` in [frontend/src/api/http.js](frontend/src/api/http.js) which handles 401→refresh→retry single-flight.

`pr_intelligence_python/`, `pr_intelligence_trusna/`, `dumps/`, `dump2-fe/`, `build/` are not part of the running app.

## Conventions

- Long explanatory docstrings and comments carry hard-won context about *why* something is shaped the way it is (race conditions, timezone bugs, cost). When editing that code, keep the reasoning accurate rather than deleting it.
- Timezone-aware datetimes everywhere; `DateTime(timezone=True)` on any column holding an instant. A naive column silently shifted every scheduler stamp by the DB session's offset once already.
- Repository functions take `(db, scope, ...)` and return plain dicts/lists; routers own HTTP concerns and never build SQL.
- New env config goes in `Configs` in [configs.py](configs.py) with a default, read via `envs.NAME`.

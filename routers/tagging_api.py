import asyncio
import time
from typing import Any
from urllib.parse import quote
from uuid import uuid4
from fastapi import APIRouter, BackgroundTasks, HTTPException, WebSocket, WebSocketDisconnect, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from agents.tagging_agent.llm_service import tag_articles, tag_articles_streaming
from ai_helpers.usage_tracking import track_usage
from agents.tagging_agent.tagging_common import merge_tagged_with_articles, merge_tagged_with_syndication, build_irrelevant_entries
from ai_helpers.article_linker import link_syndication
from ai_helpers.embedding_linker import assign_similar_incremental
from agents.relevancy_agent.relevancy_agent import apply_relevancy
from agents.tagging_agent.tag_reuse import build_reused_taggings, load_prior_tags, partition_untagged
from configs import logger, envs
from data_source_helpers.fetching_service import fetch_and_append_for_project
from data_source_helpers.newspaper_helper import article_content_fetch
from data_source_helpers.scrapper_utils import find_matched_keywords
from data_source_helpers.project_pool_lock import (
    PoolBusyError,
    pool_lock_guard,
    project_pool_lock,
)
from db_helpers.models.session_model import SessionModel
from db_helpers.repository.article_scope import (
    ArticleScope,
    pool_scope,
    scope_for_session,
    widen_window_to_days,
)
from db_helpers.repository.sessions_db import (
    get_session,
    invalidate_session_charts,
    mark_session_tagged,
    update_session_status,
)
from db_helpers.repository.generated_query_db import get_generated_query
from db_helpers.repository.projects_db import get_project
from db_helpers.repository.raw_articles_db import (
    list_raw_articles,
    list_untagged_raw_articles,
    stamp_relevancy,
)
from db_helpers.repository.tagged_articles_db import (
    append_tagged_articles,
    append_tagged_run,
    clear_approvals,
    count_tagged_articles,
    find_syndication_children,
    has_tagged_articles,
    list_tagged_articles,
    patch_tagged_articles,
    replace_tagged_articles,
    set_approval,
    stamp_view_session,
)
from db_helpers.repository.tagged_articles_db import (
    delete_tagged_article as delete_tagged_article_row,
    get_tagged_articles as fetch_tagged_articles,
)
from db_helpers.schemas.tagging_schema import ApproveRequest, ExportArticlesRequest, FetchArticleRequest, MarkIrrelevantRequest, MarkRelevantRequest, NewTaggedArticle, TaggedArticleUpdate, TagManualRequest
from reports_helpers.articles_excel import EXPORT_FIELDS, build_articles_excel, resolve_field_keys
from file_helpers.cleaing_data import clean_articles, reorder_by_confidence, _to_iso_date, get_domain
from file_helpers.publication_helper import publication_name
from file_helpers.s3_file import s3_file  # only the charts cache still lives on S3
from file_helpers.similare_web_reach import get_reach
from db_helpers.database import get_db


router = APIRouter(tags=["tagging"])


# Per-field confidences, edited as 0–100 percents and stored as 0–1 floats.
_CONFIDENCE_FIELDS = ("sentiment_confidence", "theme_confidence", "section_category_confidence", "relevancy_confidence")

# Edits to these fields on a main article cascade to its syndicated copies
# (same story across domains → these classifications must stay in sync). `similar_group_id`
# is here for the same reason: a copy has no grouping of its own, so re-grouping a main by
# hand has to take its copies with it.
_SYNDICATION_CASCADE_FIELDS = ("section", "sentiment", "theme", "similar_group_id")


# The body fields the review table can edit. Changing either invalidates the tags,
# so an edit to one of these triggers a re-tag (see `_retag_edited_bodies`).
_BODY_FIELDS = ("title", "content")


def _retag_edited_bodies(
    db: Session,
    record: SessionModel,
    stored: dict[str, dict[str, Any]],
    patches: dict[str, dict[str, Any]],
    ids: list[str],
) -> None:
    """Recompute keyword matches and AI tags for articles whose body was edited.

    A paywalled article reaches the review table with no body — its content column
    holds the sentinel "Subscription" — so the tagger only ever saw its title. Once a
    user pastes the real text in, both the tags and the query keywords found in the
    text are stale, and re-deriving them is the whole point of letting the body be
    edited at all.

    ``patches`` is mutated in place: the fresh values are layered *under* what the
    user sent, so an edit made by hand in the same save still wins. Tagging failures
    are swallowed — losing the LLM call must not lose the body the user just typed.
    """
    project = get_project(db, record.project_id)
    brand_keywords = (project.brand_keywords if project else None) or []
    competitor_keywords = (project.competitor_keywords if project else None) or []
    sections_prompt = project.monitoring_sections_prompt if project else None
    project_name = project.name if project else None

    articles: list[dict[str, Any]] = []
    for ref in ids:
        merged = {**stored[ref], **patches[ref]}
        articles.append(merged)
        # Only the terms of the query that found this article can match, so an
        # article with no query (a manual add, an upload) has nothing to recompute.
        query = str(merged.get("query") or "").strip()
        if query:
            patches[ref].setdefault(
                "keyword_matched",
                find_matched_keywords(query, merged.get("title"), merged.get("content")),
            )

    try:
        tagged = tag_articles(articles, brand_keywords, competitor_keywords, sections_prompt=sections_prompt, project_name=project_name)
    except Exception:  # noqa: BLE001 — the body edit itself must still be saved
        logger.exception(f"Re-tagging {len(ids)} edited article(s) failed; keeping their existing tags.")
        return

    retagged = 0
    for tags in tagged:
        ref = str(tags.get("id") or "")
        # A null sentiment is `blank_tagging` — the model gave nothing back for this
        # article, and blank tags are worse than the stale ones they'd replace.
        if ref not in patches or tags.get("sentiment") is None:
            continue
        fresh = {k: v for k, v in tags.items() if k != "id"}
        patches[ref] = {**fresh, **patches[ref]}
        retagged += 1
    logger.info(f"Re-tagged {retagged}/{len(ids)} article(s) after a body edit.")


def _scope_of(db: Session, session_id: int) -> tuple[SessionModel, ArticleScope]:
    """The session and where its articles live. 404s if the session is gone.

    Every article endpoint below starts here, so the choice between "this session's
    own set" and "the project pool, through this session's window" is made once.
    """
    record = get_session(db, session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return record, scope_for_session(record)


def tag_new_pool_articles(
    db: Session, project_id: int, on_batch_done=None
) -> list[dict[str, Any]]:
    """Tag the project pool's articles that don't have tags yet and append them.

    The incremental counterpart to :func:`tagging_stream`, which runs over a whole raw
    set and replaces the tagged set wholesale. The pool is fetched into every hour, so
    re-running the full pipeline would pay the relevancy gate and the tagger again for
    every article an earlier hour already classified — and would drop the review edits
    and approvals made against them in between. Here the pipeline runs over the new
    articles only and the result is appended.

    Callers must hold this project's pool lock (see
    :func:`~data_source_helpers.project_pool_lock.project_pool_lock`); two concurrent
    runs would tag the same rows twice and collide on the pool's ref sequence.

    ``on_batch_done(payload)`` (optional) streams the tagger's per-batch progress; it
    is called from a worker thread. Returns the newly tagged articles ([] when there
    was nothing new).

    One trade-off worth knowing: syndication is detected within the new batch, so an
    article that is a syndicated copy of one fetched in an earlier hour is tagged on
    its own rather than inheriting that article's tags (the re-link pass when a
    review page opens heals that). Similarity has no such gap: it runs after the
    append, nearest-neighbor against the whole pool's stored embeddings.
    """
    scope = pool_scope(project_id)
    raw = list_untagged_raw_articles(db, scope)
    if not raw:
        logger.info(f"Nothing new to tag in the pool for project_id={project_id}")
        return []

    logger.info(f"Pool tagging started for project_id={project_id}: {len(raw)} new raw article(s)")

    # Keywords + section prompt live on the project.
    project = get_project(db, project_id)
    brand_keywords = (project.brand_keywords if project else None) or []
    competitor_keywords = (project.competitor_keywords if project else None) or []
    sections_prompt = project.monitoring_sections_prompt if project else None
    project_name = project.name if project else None
    relevancy_prompt = project.relevancy_prompt if project else None
    relevancy_domains = project.relevancy_domains if project else None

    articles = clean_articles(raw)

    # Same steps as the full run, over the new articles only: relevancy gate, reach
    # enrichment, then link so syndicated copies inherit tags instead of being sent
    # to the model.
    relevant, irrelevant = apply_relevancy(
        articles, brand_keywords, competitor_keywords, relevancy_prompt, relevancy_domains
    )
    stamp_relevancy(db, scope, articles)
    articles = get_reach(relevant)

    articles = link_syndication(articles)
    non_copies = [a for a in articles if not a.get("syndication_of")]
    copies = [a for a in articles if a.get("syndication_of")]
    copy_to_main = {a["id"]: a.get("syndication_of", "") for a in copies}

    logger.info(
        f"Tagging {len(non_copies)} new article(s); {len(copies)} syndicated copies inherit "
        f"their main's tags; {len(irrelevant)} irrelevant"
    )
    started = time.time()
    if not non_copies:
        llm_tagged = []
    elif on_batch_done is not None:
        llm_tagged = tag_articles_streaming(
            non_copies, brand_keywords, competitor_keywords, sections_prompt, on_batch_done,
            project_name=project_name,
        )
    else:
        llm_tagged = tag_articles(
            non_copies, brand_keywords, competitor_keywords, sections_prompt=sections_prompt,
            project_name=project_name,
        )
    logger.info(f"Pool tagging completed in {time.time() - started:.1f}s")

    tagged_full = merge_tagged_with_syndication(non_copies, copies, copy_to_main, llm_tagged)
    # Irrelevant articles are stored too (blank tags) so the review UI can list and
    # later promote them — and so they aren't re-classified next hour.
    final_articles = tagged_full + build_irrelevant_entries(irrelevant)

    # Append beside the earlier hours' rows, renumbering this run's A{n} refs.
    created = append_tagged_run(db, scope, final_articles)
    logger.info(f"Appended {len(created)} newly tagged article(s) to project_id={project_id} pool")

    # Similarity runs after the append — the refs are final only once the run is
    # renumbered — and against the whole pool, so a second telling of a story an
    # earlier hour fetched links to it. Best-effort by design (see embedding_linker).
    assign_similar_incremental(db, scope)
    return created


def fetch_and_tag_project_pool(
    db: Session,
    project_id: int,
    query_id: int,
    queries: Any,
    recency_hours: int,
    on_fetch_progress=None,
    on_batch_done=None,
    label: str = "",
) -> dict[str, int]:
    """One pass of the pool pipeline: fetch a recent window, then tag what's new.

    The single ingest path into a project's articles, shared by the hourly scheduler
    and by a window session's review page when it opens. Serialized per project, so a
    review page opening mid-run waits rather than duplicating the work.

    A fetch that turns up nothing — no results at all, or no queries to run — is
    logged and does not stop the tagging step: articles an earlier pass fetched but
    failed to tag still need it. Returns {"fetched": n, "tagged": n}.

    A pass that can't get the project's lock within POOL_LOCK_TIMEOUT_SECONDS gives up
    and returns zero counts instead of waiting. Waiting forever is what let one wedged
    pass block every later run for the project — and the next hourly slot picks the work
    up anyway, since nothing has been marked as done.
    """
    try:
        # Nothing inside the block acquires this lock (it is not reentrant), so the only
        # PoolBusyError this can catch is the acquire above failing.
        with pool_lock_guard(project_id, envs.POOL_LOCK_TIMEOUT_SECONDS):
            fresh: list[dict[str, Any]] = []
            try:
                fresh = fetch_and_append_for_project(
                    db,
                    project_id,
                    query_id,
                    queries,
                    recency_hours=recency_hours,
                    on_progress=on_fetch_progress,
                    label=label,
                )
            except ValueError as exc:
                logger.warning(f"Pool fetch found nothing for project_id={project_id}: {exc}")

            tagged = tag_new_pool_articles(db, project_id, on_batch_done=on_batch_done)
            return {"fetched": len(fresh), "tagged": len(tagged)}
    except PoolBusyError as exc:
        logger.warning(f"Skipping pool pass for {label or f'project_id={project_id}'}: {exc}")
        return {"fetched": 0, "tagged": 0}


async def _relink_visible_articles(db: Session, scope: ArticleScope) -> int:
    """Re-derive syndication across every article the scope shows, persist the
    pointers that moved, then link the not-yet-processed articles into story groups.
    Returns the number of articles repointed.

    A tagging run links only the articles it fetched, which is all it can do — the
    rest aren't in hand yet. Syndication is lexical and free, so it is still
    re-derived over the window's whole relevant set here, healing copies of articles
    an earlier hour brought in. Story grouping is incremental instead of re-derived:
    each article is embedded once, given a ``similar_group_id`` when its vector is
    first stored, and never re-grouped (see :mod:`ai_helpers.embedding_linker`) — so
    this pass costs no LLM call and, in steady state, no embedding call either.

    Note that the grouping step is deliberately not narrowed by this scope's window
    the way the syndication step is: a group id is a property of the project's
    articles, so a window that excludes a story's earliest article must still show
    the rest of it as one group.

    Irrelevant articles are excluded. They are stored with blank tags purely so the
    review UI can list and promote them, so including them would spend embedding
    calls on articles nobody reads and would let a section/sentiment edit on a main
    cascade into one (see ``_SYNDICATION_CASCADE_FIELDS``).
    """
    visible = await asyncio.to_thread(list_tagged_articles, db, scope, relevant_only=True)
    before = {
        a["id"]: str(a.get("syndication_of") or "")
        for a in visible
        if isinstance(a, dict) and a.get("id")
    }

    visible = await asyncio.to_thread(link_syndication, visible, True)

    patches: dict[str, dict[str, Any]] = {}
    for article in visible:
        ref = article.get("id")
        if not ref:
            continue
        syndication_of = str(article.get("syndication_of") or "")
        if before.get(ref) == syndication_of:
            continue
        patches[ref] = {"syndication_of": syndication_of}

    if patches:
        await asyncio.to_thread(patch_tagged_articles, db, scope, patches)

    linked = await asyncio.to_thread(assign_similar_incremental, db, scope)
    logger.info(
        f"Re-linked {len(visible)} article(s) for {scope.describe()}: "
        f"{len(patches)} syndication change(s), {linked} new story-group link(s)"
    )
    return len(patches) + linked


@router.websocket("/ws/tagging")
async def tagging_stream(websocket: WebSocket, db: Session = Depends(get_db)) -> None:
    """Stream tagging progress over a WebSocket.

    The only entry point for running a tagging job: it emits a message per completed
    batch so the client sees how many article batches have finished in real time.
    Message types: "start", "batch", "complete", "error".

    Serves both kinds of session, differing only where the scope says so. A session that
    owns its articles (an upload or a merge) is tagged whole, with no fetch. A window
    session over the project pool tags only what has no tags yet, and whether it fetches
    first depends on who owns the pool's freshness:

      * **Generated query on a schedule** — no fetch. The hourly scheduler already tops
        this pool up, so the page tags the pool as the database holds it. And if a pass
        happens to be running right now, the page reports the articles already tagged and
        returns rather than waiting; the running pass's articles appear on the next open.
      * **Not scheduled** — nothing else fetches for this project, so the page fetches
        the last ``envs.WS_REVIEW_FETCH_HOURS`` itself, then tags what came in.

    Either way the client reloads with GET /tagging/{session_id} at the end.
    """
    await websocket.accept()
    session = None
    pool_lock = None
    try:
        init = await websocket.receive_json()
    except (WebSocketDisconnect, ValueError) as exc:
        logger.warning(f"Websocket init failed: {exc}")
        await websocket.close()
        return
    try:
        session_id = init.get("session_id") if isinstance(init, dict) else None
        logger.info(f"Tagging stream started for session_id={session_id}")
        if session_id is None or not isinstance(session_id, int):
            await websocket.send_json({"type": "error", "detail": "Missing or invalid 'workflow_id'."})
            await websocket.close()
            return

        session = get_session(db, session_id)
        if session is None:
            await websocket.send_json({"type": "error", "detail": "Workflow not found."})
            return
        scope = scope_for_session(session)

        # Whether the hourly scheduler is responsible for keeping this pool current. If it
        # is, this page must not fetch: the pool it would fetch into is the one the
        # scheduler already tops up, so a page open would duplicate that work and pay for
        # it. Only a window session over the pool can have a schedule behind it.
        scheduled = False
        if scope.is_pool and session.generated_query_id is not None:
            gq = get_generated_query(db, session.generated_query_id)
            # Same test as the scheduler's own list_scheduled_generated_queries.
            scheduled = bool(gq is not None and gq.status == "Scheduled" and gq.schedule_time)

        if scope.is_pool:
            # `pool_lock` stays None unless the acquire below succeeds: the finally at the
            # end of this handler releases whatever it finds there, and threading.Lock is
            # not owner-bound, so naming the lock before acquiring it let a review page
            # release the *scheduler's* lock and undo the mutual exclusion entirely.
            # Acquiring directly (rather than checking `locked()` first) also closes the
            # race between that check and the acquire.
            lock = project_pool_lock(session.project_id)
            if not lock.acquire(blocking=False):
                # A pass is already running for this project — the hourly scheduler, or
                # another review page. Neither wait nor fetch: report what the pool
                # already holds for this window so the review opens, and let the running
                # pass finish. Its articles show up the next time the page is opened.
                logger.info(
                    f"Pool pass already running for project_id={session.project_id}; "
                    f"session_id={session_id} shows the articles already tagged"
                )
                mark_session_tagged(db, session)
                await websocket.send_json({
                    "type": "complete",
                    "total_tagged": count_tagged_articles(db, scope),
                    "relevant_count": 0,
                    "irrelevant_count": 0,
                    "elapsed_seconds": 0,
                })
                return
            pool_lock = lock

        # Re-tagging a session that owns its articles would throw away the review's
        # work. A window session owns none — its pass only adds — so it may run every
        # time the page opens.
        if not scope.is_pool and session.status in ("Tagged", "Completed"):
            await websocket.send_json({"type": "error", "detail": "Workflow already tagged."})
            return

        # Fetching here is for the unscheduled case only. A scheduled query's pool is the
        # scheduler's job, so this page reads it from the database as it stands and tags
        # whatever is still untagged; and a session that owns its articles (an upload or a
        # merge) brought them with it, so there is nothing to fetch for one either.
        if scope.is_pool and not scheduled:
            await websocket.send_json({
                "type": "progress",
                "message": f"Fetching the last {envs.WS_REVIEW_FETCH_HOURS}h of articles…",
            })

            # Bridge the fetcher's per-query count callback (invoked from worker
            # threads) into this async handler via a queue, so the client sees a
            # live "N fetched" counter while the fetch runs. Sentinel = fetch done.
            loop = asyncio.get_running_loop()
            fetch_queue: asyncio.Queue = asyncio.Queue()
            FETCH_DONE = object()

            def on_fetch_progress(fetched: int) -> None:
                loop.call_soon_threadsafe(fetch_queue.put_nowait, fetched)

            # Adds only what the project doesn't already store, so nothing already
            # tagged is disturbed. A fetch that turns up nothing isn't fatal —
            # there may still be earlier articles that failed to tag.
            fetch_task = asyncio.create_task(
                asyncio.to_thread(
                    fetch_and_append_for_project,
                    db,
                    session.project_id,
                    session.generated_query_id,
                    session.queries,
                    envs.WS_REVIEW_FETCH_HOURS,
                    on_fetch_progress,
                    f"session id={session_id}",
                )
            )
            fetch_task.add_done_callback(lambda _: fetch_queue.put_nowait(FETCH_DONE))

            fetched_total = 0
            while True:
                item = await fetch_queue.get()
                if item is FETCH_DONE:
                    break
                if isinstance(item, int) and item != fetched_total:
                    fetched_total = item
                    await websocket.send_json({"type": "fetch_progress", "fetched": fetched_total})

            try:
                await fetch_task  # re-raise any exception from the fetch thread
            except ValueError as exc:
                # "Nothing found" / "no queries" — the pool may still hold untagged
                # articles from an earlier pass, so carry on and tag those.
                logger.warning(f"Pool fetch found nothing for session_id={session_id}: {exc}")
            await websocket.send_json({
                "type": "progress",
                "message": f"Fetched {fetched_total} articles — preparing to tag…" if fetched_total else "Fetched articles — preparing to tag…",
            })

        if scope.is_pool and scheduled:
            logger.info(
                f"session_id={session_id} follows scheduled generated query "
                f"id={session.generated_query_id}; tagging the pool as it stands, no fetch"
            )
            await websocket.send_json(
                {"type": "progress", "message": "Checking for untagged articles…"}
            )

        # A window session tags only what has no tags yet; a session-owned set is
        # tagged whole, replacing any previous run.
        raw = list_untagged_raw_articles(db, scope) if scope.is_pool else list_raw_articles(db, session_id)
        if not raw:
            if scope.is_pool:
                # Nothing new this time — not an error. Let the client reload the
                # window it already has.
                mark_session_tagged(db, session)
                await websocket.send_json({
                    "type": "complete",
                    "total_tagged": count_tagged_articles(db, scope),
                    "relevant_count": 0,
                    "irrelevant_count": 0,
                    "elapsed_seconds": 0,
                })
                return
            await websocket.send_json({"type": "error", "detail": "Workflow has no raw articles to tag."})
            return

        update_session_status(db, session, "Tagging")

        articles = clean_articles(raw)

        # Keywords + section prompt now live on the project (not the session).
        project = get_project(db, session.project_id)
        brand_keywords = (project.brand_keywords if project else None) or []
        competitor_keywords = (project.competitor_keywords if project else None) or []
        if brand_keywords:
            logger.info(f"Aspect-based sentiment for brand keywords: {brand_keywords}")

        sections_prompt = project.monitoring_sections_prompt if project else None
        project_name = project.name if project else None
        relevancy_prompt = project.relevancy_prompt if project else None
        relevancy_domains = project.relevancy_domains if project else None

        # Relevancy gate: annotate is_relevant + reason and split. Only relevant
        # articles are tagged; irrelevant ones are stored as tagged articles with
        # blank tags so the review UI can list and later promote them. Stamp the
        # flags back onto the raw rows too.
        await websocket.send_json({"type": "progress", "message": "Checking article relevancy…"})
        with track_usage() as relevancy_usage:
            relevant, irrelevant = await asyncio.to_thread(
                apply_relevancy, articles, brand_keywords, competitor_keywords, relevancy_prompt, relevancy_domains
            )
        await websocket.send_json({"type": "usage", "step": "relevancy", **relevancy_usage.as_dict()})
        await asyncio.to_thread(stamp_relevancy, db, scope, articles)
        articles = relevant
        if irrelevant:
            await websocket.send_json({
                "type": "progress",
                "message": f"Filtered out {len(irrelevant)} irrelevant article(s); tagging {len(articles)}…",
            })

        # Enrich with reach off the event loop (S3 lookup + SimilarWeb fallback);
        # the S3 reach-file write-back happens in the background inside get_reach.
        await websocket.send_json({"type": "progress", "message": "Fetching reach…"})
        articles = await asyncio.to_thread(get_reach, articles)

        await websocket.send_json({"type": "start", "total_articles": len(articles)})

        # For a merged session, reuse tags already produced by its source
        # sessions (matched by article_id) so we don't pay to re-tag them.
        prior_tags = load_prior_tags(db, session.merged_session_ids)

        # Syndication only, and only to keep the tagger's bill down: a copy inherits its
        # main's tags, so finding copies here means they never reach the LLM. Similarity
        # is deliberately not run yet — the re-link pass after the run is stored redoes
        # both over every article the session shows, which subsumes anything this pass
        # could find on the batch alone.
        await websocket.send_json({"type": "progress", "message": "Finding syndicated copies…"})
        articles = await asyncio.to_thread(link_syndication, articles)
        non_copies = [a for a in articles if not a.get("syndication_of")]
        syndications = [a for a in articles if a.get("syndication_of")]
        syndications_to_main = {a["id"]: a.get("syndication_of", "") for a in syndications}

        # Split the taggable articles: send only the untagged ones to the LLM;
        # reuse tags for the rest from the merged source sessions.
        to_tag, reused = partition_untagged(non_copies, prior_tags)
        logger.info(
            f"Tagging {len(to_tag)} articles; reusing {len(reused)} already-tagged; "
            f"{len(syndications)} syndicated copies inherit their main's tags"
        )
        if reused:
            await websocket.send_json(
                {"type": "progress", "message": f"Reusing tags for {len(reused)} already-tagged article(s)…"}
            )

        logger.info("Running AI tagging (streaming)")
        started = time.time()
        tagging_usage_totals = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
        # Only spin up the streaming worker when there is something to tag; when
        # every article is reused (all sources already tagged) skip it entirely.
        if to_tag:
            # Bridge the synchronous on_batch_done callback (invoked from worker
            # threads) into this async handler via a queue. A sentinel marks the end.
            loop = asyncio.get_running_loop()
            queue: asyncio.Queue = asyncio.Queue()
            DONE = object()

            with track_usage() as tagging_usage:
                def on_batch_done(payload: dict[str, Any]) -> None:
                    # Live running total at the moment this batch finished — read
                    # off the same tracker instance every batch mutates in place.
                    loop.call_soon_threadsafe(
                        queue.put_nowait, {**payload, "usage": tagging_usage.as_dict()}
                    )

                task = asyncio.create_task(
                    asyncio.to_thread(
                        tag_articles_streaming,
                        to_tag,
                        brand_keywords,
                        competitor_keywords,
                        sections_prompt,
                        on_batch_done,
                        project_name,
                    )
                )
                # Sentinel is enqueued only after the worker fully returns, so it always
                # trails every batch payload (call_soon_threadsafe preserves FIFO order).
                task.add_done_callback(lambda _: queue.put_nowait(DONE))

                while True:
                    payload = await queue.get()
                    if payload is DONE:
                        break
                    await websocket.send_json(payload)

                llm_tagged = await task  # re-raise any exception from the tagging thread
            tagging_usage_totals = tagging_usage.as_dict()
        else:
            llm_tagged = []
        logger.info(f"Tagging completed in {time.time() - started:.1f}s")

        # Combine freshly-tagged + reused tags (both keyed by this run's ids), then
        # merge onto every non-copy article and attach the syndicated copies with
        # their main article's tags copied over.
        tagged = llm_tagged + build_reused_taggings(reused, prior_tags)
        tagged_full = merge_tagged_with_syndication(non_copies, syndications, syndications_to_main, tagged)

        # Reorder by Confidence and Reassign Id. reorder_by_confidence remaps the
        # syndication_of / similar_of pointers (set above) onto the new ids.
        # final_articles = reorder_by_confidence(tagged_full)
        # Append the irrelevant articles (blank tags, is_relevant=False) so the
        # tagged set is complete — the review UI filters by is_relevant.
        final_articles = tagged_full + build_irrelevant_entries(irrelevant)

        # Store the tagged articles as rows: a window session's run appends beside the
        # pool's earlier hours (renumbering this run's refs), a session-owned run
        # replaces its previous one.
        if scope.is_pool:
            await asyncio.to_thread(append_tagged_run, db, scope, final_articles)
        else:
            await asyncio.to_thread(replace_tagged_articles, db, scope, final_articles)
        mark_session_tagged(db, session)

        await websocket.send_json({"type": "progress", "message": "Linking related articles…"})
        await _relink_visible_articles(db, scope)

        await websocket.send_json(
            {
                "type": "complete",
                "total_tagged": len(final_articles),
                "relevant_count": len(final_articles) - len(irrelevant),
                "irrelevant_count": len(irrelevant),
                "elapsed_seconds": round(time.time() - started, 1),
                "usage": {
                    "input_tokens": relevancy_usage.input_tokens + tagging_usage_totals["input_tokens"],
                    "output_tokens": relevancy_usage.output_tokens + tagging_usage_totals["output_tokens"],
                    "cost_usd": relevancy_usage.cost_usd + tagging_usage_totals["cost_usd"],
                },
            }
        )
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for session_id={session_id}")
    except Exception as exc:
        logger.exception(f"Tagging stream failed for session_id={session_id}")
        if session is not None:
            update_session_status(db, session, "Failed")
        try:
            await websocket.send_json({"type": "error", "detail": f"Tagging process failed: {exc}"})
        except Exception:
            pass
    finally:
        if pool_lock is not None:
            pool_lock.release()
        try:
            await websocket.close()
        except Exception:
            pass


@router.get("/tagging/{session_id}")
def get_tagged_articles(session_id: int, db: Session = Depends(get_db)) -> Any:
    """
    API to get tagged articles for a session
    Args:
        session_id (int): Session id
    Returns:
        List of articles, without their body text
    """
    try:
        logger.info("")
        logger.info(f"Fetching tagged articles for session_id={session_id}")

        _, scope = _scope_of(db, session_id)

        wide_scope = widen_window_to_days(scope)
        articles = list_tagged_articles(db, wide_scope, include_body=False)
        if not articles:
            raise HTTPException(status_code=404, detail="No tagged articles found for this session.")
        stamp_view_session(db, wide_scope)
        return articles
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f"Fetching tagged articles failed for session_id={session_id}")
        raise HTTPException(status_code=500, detail=f"Fetching tagged articles failed: {exc}") from exc


@router.get("/tagging/export/fields")
def tagging_export_fields() -> Any:
    """
    API to get the columns the review screen's Excel download can include
    Returns:
        List of {key, label, default} in sheet order
    """
    return EXPORT_FIELDS


@router.post("/tagging/{session_id}/export")
def export_tagged_articles(session_id: int, payload: ExportArticlesRequest, db: Session = Depends(get_db)) -> Any:
    """
    API to download a session's articles as an Excel file
    Args:
        session_id (int): Session id
        payload (ExportArticlesRequest): Relevance buckets and columns to include
    Returns:
        The .xlsx file as an attachment
    """
    try:
        types = {str(t).strip().lower() for t in (payload.types or [])}
        unknown = types - {"relevant", "irrelevant"}
        if unknown:
            raise HTTPException(status_code=400, detail=f"Unknown article types: {sorted(unknown)}")
        if not types:
            raise HTTPException(status_code=400, detail="Select at least one article type.")

        fields = resolve_field_keys(payload.fields)
        _, scope = _scope_of(db, session_id)

        # The body is by far the heaviest column, so only read it when asked for.
        articles = list_tagged_articles(db, scope, include_body="content" in fields)
        # An article without the flag counts as relevant (older rows predate the gate).
        wanted = [a for a in articles if ("irrelevant" if a.get("is_relevant") is False else "relevant") in types]
        if not wanted:
            raise HTTPException(status_code=404, detail="No articles to export for the selected types.")

        xlsx = build_articles_excel(wanted, fields)
        filename = f"articles_session_{session_id}.xlsx"
        headers = {
            "Content-Disposition": f"attachment; filename=\"{filename}\"; filename*=UTF-8''{quote(filename)}",
        }
        return StreamingResponse(
            iter([xlsx]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers=headers,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f"Exporting tagged articles failed for session_id={session_id}")
        raise HTTPException(status_code=500, detail=f"Exporting articles failed: {exc}") from exc


@router.post("/tagging/{session_id}/articles/mark-relevant")
def mark_articles_relevant(session_id: int, payload: MarkRelevantRequest, db: Session = Depends(get_db)) -> Any:
    """Promote one or more irrelevant articles to relevant and AI-tag them in place.

    Loads the named articles, runs the tagger over them in one batch (sentiment /
    theme / section / …), sets ``is_relevant=True``, clears the not-relevant
    reason, writes those rows back, and invalidates any cached charts so the
    dashboards rebuild with the newly-relevant articles.
    Returns the list of updated (now fully-tagged) articles."""
    try:
        ids = [str(i) for i in (payload.ids or []) if str(i).strip()]
        if not ids:
            raise HTTPException(status_code=400, detail="No article ids provided.")

        record, scope = _scope_of(db, session_id)

        stored = fetch_tagged_articles(db, scope, ids)
        # Preserve request order, drop unknown / duplicate ids.
        seen: set[str] = set()
        targets: list[dict[str, Any]] = []
        for aid in ids:
            if aid in stored and aid not in seen:
                seen.add(aid)
                targets.append(stored[aid])
        if not targets:
            raise HTTPException(status_code=404, detail=f"None of the provided ids exist: {ids}")

        project = get_project(db, record.project_id)
        brand_keywords = (project.brand_keywords if project else None) or []
        competitor_keywords = (project.competitor_keywords if project else None) or []
        sections_prompt = project.monitoring_sections_prompt if project else None
        project_name = project.name if project else None

        # Enrich with reach (best-effort), then AI-tag the whole batch at once.
        try:
            enriched = get_reach(targets)
        except Exception:  # noqa: BLE001 — reach is a nice-to-have, never block promotion
            logger.warning("Reach enrichment failed during mark-relevant; continuing without it.")
            enriched = targets
        tagged = tag_articles(enriched, brand_keywords, competitor_keywords, sections_prompt=sections_prompt, project_name=project_name)
        merged_list = merge_tagged_with_articles(enriched, tagged)

        # Each merged dict is the article's full new state; layering it over the
        # stored row makes the fresh tags win while keeping any field the tagger
        # didn't carry through.
        patches: dict[str, dict[str, Any]] = {}
        for merged in merged_list:
            ref = str(merged.get("id"))
            if ref in stored:
                patches[ref] = {**merged, "is_relevant": True, "relevancy_reason": "Manually marked relevant."}
        updated = list(patch_tagged_articles(db, scope, patches).values())

        # Newly-relevant, tagged articles change the dashboards → drop the cache.
        if record.charts_data_file:
            try:
                s3_file.delete_file(record.charts_data_file)
            except Exception:  # noqa: BLE001
                logger.warning("Failed to delete stale charts file; continuing.")
        invalidate_session_charts(db, record)

        logger.info(f"Marked {len(updated)} article(s) relevant and tagged them for session_id={session_id}")
        return updated
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f"Mark-relevant failed for session_id={session_id}")
        raise HTTPException(status_code=500, detail=f"Mark-relevant failed: {exc}") from exc


@router.post("/tagging/{session_id}/articles/mark-irrelevant")
def mark_articles_irrelevant(session_id: int, payload: MarkIrrelevantRequest, db: Session = Depends(get_db)) -> Any:
    """Demote one or more relevant articles to irrelevant, keeping their tags.

    Only flips ``is_relevant`` to False and stores the (required) ``reason`` as
    ``relevancy_reason`` — all tag fields (sentiment / theme / section / …) are
    left intact, so a later re-promotion keeps them. Invalidates cached charts so
    the dashboards rebuild without these articles.
    Returns the list of updated articles."""
    try:
        ids = [str(i) for i in (payload.ids or []) if str(i).strip()]
        reason = (payload.reason or "").strip()
        if not ids:
            raise HTTPException(status_code=400, detail="No article ids provided.")
        if not reason:
            raise HTTPException(status_code=400, detail="A reason is required to move an article to irrelevant.")

        record, scope = _scope_of(db, session_id)

        demote = {"is_relevant": False, "relevancy_reason": reason}
        # Keep the tags, but an irrelevant article can't stay "approved" (it's excluded
        # from dashboards) — withdraw this session's approvals. Only this session's:
        # another window may still count the article as relevant and approved.
        clear_approvals(db, scope, ids)
        updated = list(patch_tagged_articles(db, scope, {i: dict(demote) for i in ids}).values())
        if not updated:
            raise HTTPException(status_code=404, detail=f"None of the provided ids exist: {ids}")

        # These articles leave the dashboards → drop the cached charts.
        if record.charts_data_file:
            try:
                s3_file.delete_file(record.charts_data_file)
            except Exception:  # noqa: BLE001
                logger.warning("Failed to delete stale charts file; continuing.")
        invalidate_session_charts(db, record)

        logger.info(f"Moved {len(updated)} article(s) to irrelevant for session_id={session_id}")
        return updated
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f"Mark-irrelevant failed for session_id={session_id}")
        raise HTTPException(status_code=500, detail=f"Mark-irrelevant failed: {exc}") from exc


@router.put("/tagging/{session_id}")
def update_tagged_articles(
    session_id: int,
    updates: list[TaggedArticleUpdate],
    db: Session = Depends(get_db),
) -> Any:
    """Patch tagged fields on one or more of the session's articles.

    Body: a JSON array of `{id, <fields to change>}`. Only the provided fields are
    applied (matched by `id`). Editing `title` or `content` re-runs the tagger and
    the keyword match over the new text and returns those articles' new state under
    `retagged`, so the client doesn't have to refetch. Editing anything here
    invalidates the session's cached dashboards.
    """
    try:
        if not updates:
            raise HTTPException(status_code=400, detail="No articles provided to update.")

        logger.info(f"Updating {len(updates)} tagged articles for session_id={session_id}")

        record, scope = _scope_of(db, session_id)

        requested_ids = [upd.id for upd in updates]
        stored = fetch_tagged_articles(db, scope, requested_ids)
        # Map each main article id -> its syndicated copies (same story, other domains).
        synd_children = find_syndication_children(db, scope, requested_ids)

        patches: dict[str, dict[str, Any]] = {}
        updated_ids: list[str] = []
        not_found_ids: list[str] = []
        cascaded_ids: list[str] = []
        retag_ids: list[str] = []
        for upd in updates:
            if upd.id not in stored:
                not_found_ids.append(upd.id)
                continue
            # Only the explicitly-sent fields; never the id.
            patch = upd.model_dump(exclude_unset=True, exclude={"id"})
            # Confidences arrive as 0–100 percents; persist them as 0–1 floats.
            for cf in _CONFIDENCE_FIELDS:
                if patch.get(cf) is not None:
                    patch[cf] = patch[cf] / 100.0
            # Normalize an edited date to canonical ISO (matches the ingest pipeline).
            if "date" in patch:
                patch["date"] = _to_iso_date(patch["date"])
            # An edited title/content makes the tags stale — re-derive them below.
            if any(f in patch for f in _BODY_FIELDS):
                for f in _BODY_FIELDS:
                    if f in patch:
                        patch[f] = (patch[f] or "").strip()
                # The flag is stored, not derived on read, so a body arriving by hand
                # has to clear it explicitly (and re-set it if the body was cleared).
                if "content" in patch:
                    patch["is_subscription"] = patch["content"] in ("", "Subscription")
                # Two updates for the same id must still cost one tagger call.
                if upd.id not in retag_ids:
                    retag_ids.append(upd.id)
            # Every article belongs to some story group, so clearing the field means
            # "leave this group", not "have none" — mint a fresh id. A blank would drop
            # the row out of the grouped view instead of standing it on its own.
            if "similar_group_id" in patch:
                patch["similar_group_id"] = str(patch["similar_group_id"] or "").strip() or str(uuid4())
            # An edited url recomputes the derived domain / publication name — but
            # an explicitly-edited publication (domain_name) in the same patch wins.
            if "url" in patch:
                url = (patch["url"] or "").strip()
                patch["url"] = url
                if url:
                    patch["domain"] = get_domain(url)
                    patch.setdefault("domain_name", publication_name.get_publication_name_for_domain(patch["domain"]))
                else:
                    patch["domain"] = ""
                    patch.setdefault("domain_name", "")
            patches[upd.id] = {**patches.get(upd.id, {}), **patch}
            updated_ids.append(upd.id)

            # Cascade section / sentiment / theme from a main article to its
            # syndicated copies (they're the same story, so these must match).
            cascade = {f: patch[f] for f in _SYNDICATION_CASCADE_FIELDS if f in patch}
            if cascade:
                for child_ref in synd_children.get(upd.id, []):
                    patches[child_ref] = {**patches.get(child_ref, {}), **cascade}
                    cascaded_ids.append(child_ref)

        if not updated_ids:
            raise HTTPException(
                status_code=404,
                detail=f"None of the provided ids exist for this session: {not_found_ids}",
            )

        if retag_ids:
            _retag_edited_bodies(db, record, stored, patches, retag_ids)
            # The re-tag lands section/sentiment/theme *after* the cascade above already
            # ran, so the syndicated copies have to be brought along a second time —
            # they're the same story and must not keep the pre-edit classification.
            for ref in retag_ids:
                cascade = {f: patches[ref][f] for f in _SYNDICATION_CASCADE_FIELDS if f in patches[ref]}
                if not cascade:
                    continue
                for child_ref in synd_children.get(ref, []):
                    patches[child_ref] = {**patches.get(child_ref, {}), **cascade}
                    if child_ref not in cascaded_ids:
                        cascaded_ids.append(child_ref)

        written = patch_tagged_articles(db, scope, patches)

        # The tags changed, so any dashboards built from the old tags are stale.
        if record.charts_data_file:
            try:
                s3_file.delete_file(record.charts_data_file)
            except Exception:  # noqa: BLE001
                logger.warning("Failed to delete stale charts file; continuing.")
        invalidate_session_charts(db, record)

        logger.info(
            f"Updated {len(updated_ids)} tagged articles for session_id={session_id}"
            f" ({len(cascaded_ids)} syndicated cascades)"
        )
        return {
            "updated_count": len(updated_ids),
            "updated_ids": updated_ids,
            "cascaded_ids": cascaded_ids,
            "not_found_ids": not_found_ids,
            # Re-tagged rows come back in full: the client can't derive the new tags
            # from what it sent, and every other row it already knows.
            "retagged": [written[ref] for ref in retag_ids if ref in written],
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f"Updating tagged articles failed for session_id={session_id}")
        raise HTTPException(status_code=500, detail=f"Updating tagged articles failed: {exc}") from exc


_LIST_FIELDS = ("brand_of_interest", "competitors", "other_competitors",
                "peoples", "countries", "organizations")


@router.post("/tagging/{session_id}/fetch-article")
def fetch_and_tag_article(
    session_id: int,
    payload: FetchArticleRequest,
    db: Session = Depends(get_db),
) -> Any:
    """Fetch a single article by URL, AI-tag it, and return a *preview* (NOT saved).

    The article body is downloaded with newspaper; if it can't be retrieved (e.g.
    a paywalled / subscription-only page), a 422 'Subscription required' is raised.
    Otherwise the article is cleaned, enriched with reach, and tagged exactly like
    the pipeline. Confidences come back as 0–100 percents to match the review form.
    No id is assigned and nothing is persisted — the client reviews/edits the fields
    and then POSTs to /tagging/{session_id}/articles to save."""
    try:
        url = (payload.url or "").strip()
        if not url:
            raise HTTPException(status_code=400, detail="A URL is required.")

        record = get_session(db, session_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Session not found.")

        logger.info(f"Fetching article by URL for session_id={session_id}: {url}")
        fetched = article_content_fetch({"url": url, "title": "", "published": ""})
        content = (fetched.get("content") if isinstance(fetched, dict) else "") or ""
        # article_content_fetch returns content "Subscription" when the download fails.
        if content.strip() in ("", "Subscription"):
            raise HTTPException(
                status_code=422,
                detail="Subscription required — couldn't fetch this article's content.",
            )

        articles = clean_articles([fetched])
        if not articles:
            raise HTTPException(status_code=422, detail="Couldn't parse the fetched article.")

        # Enrich with reach, then tag with the project's brand/competitor/section context.
        articles = get_reach(articles)
        project = get_project(db, record.project_id)
        brand_keywords = (project.brand_keywords if project else None) or []
        competitor_keywords = (project.competitor_keywords if project else None) or []
        sections_prompt = project.monitoring_sections_prompt if project else None
        project_name = project.name if project else None

        tagged = tag_articles(articles, brand_keywords, competitor_keywords, sections_prompt=sections_prompt, project_name=project_name)
        preview = merge_tagged_with_articles(articles, tagged)[0]

        # Confidences are stored 0–1 but the review form edits them as 0–100 percents.
        for cf in _CONFIDENCE_FIELDS:
            v = preview.get(cf)
            if isinstance(v, (int, float)):
                preview[cf] = round(v * 100)
        # No id yet — a fresh A{n} is assigned only when the user saves the article.
        preview.pop("id", None)

        logger.info(f"Fetched and tagged article for session_id={session_id}: {url}")
        return preview
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f"Fetch+tag by URL failed for session_id={session_id}")
        raise HTTPException(status_code=500, detail=f"Fetching article failed: {exc}") from exc


@router.post("/tagging/{session_id}/tag-manual")
def tag_manual_article(
    session_id: int,
    payload: TagManualRequest,
    db: Session = Depends(get_db),
) -> Any:
    """AI-tag a manually-entered article (body typed by the user) and return a
    *preview* (NOT saved). Used when a URL can't be fetched (e.g. paywalled): the
    user fills in title/content/date/author and we tag those directly, skipping
    the content fetch. Same output contract as /fetch-article — confidences come
    back as 0–100 percents and no id is assigned; the client reviews/edits and
    then POSTs to /tagging/{session_id}/articles to save."""
    try:
        title = (payload.title or "").strip()
        content = (payload.content or "").strip()
        if not title and not content:
            raise HTTPException(status_code=400, detail="A title or content is required.")

        record = get_session(db, session_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Session not found.")

        logger.info(f"Tagging manual article for session_id={session_id}")
        manual = {
            "title": title,
            "content": content,
            "url": (payload.url or "").strip(),
            "date": (payload.date or "").strip(),
            "author": (payload.author or "").strip(),
        }

        articles = clean_articles([manual])
        if not articles:
            raise HTTPException(status_code=422, detail="Couldn't parse the entered article.")

        # Enrich with reach, then tag with the project's brand/competitor/section context.
        articles = get_reach(articles)
        project = get_project(db, record.project_id)
        brand_keywords = (project.brand_keywords if project else None) or []
        competitor_keywords = (project.competitor_keywords if project else None) or []
        sections_prompt = project.monitoring_sections_prompt if project else None
        project_name = project.name if project else None

        tagged = tag_articles(articles, brand_keywords, competitor_keywords, sections_prompt=sections_prompt, project_name=project_name)
        preview = merge_tagged_with_articles(articles, tagged)[0]

        # Confidences are stored 0–1 but the review form edits them as 0–100 percents.
        for cf in _CONFIDENCE_FIELDS:
            v = preview.get(cf)
            if isinstance(v, (int, float)):
                preview[cf] = round(v * 100)
        # No id yet — a fresh A{n} is assigned only when the user saves the article.
        preview.pop("id", None)

        logger.info(f"Tagged manual article for session_id={session_id}")
        return preview
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f"Manual tagging failed for session_id={session_id}")
        raise HTTPException(status_code=500, detail=f"Manual tagging failed: {exc}") from exc


@router.post("/tagging/{session_id}/articles")
def add_tagged_articles(
    session_id: int,
    articles_in: list[NewTaggedArticle],
    db: Session = Depends(get_db),
) -> Any:
    """Append one or more new articles (body + tags) to the session's tagged set,
    each assigned a fresh sequential id. Editing the tagged set invalidates any
    cached dashboards. Returns the list of created articles."""
    try:
        if not articles_in:
            raise HTTPException(status_code=400, detail="No articles provided to add.")

        record, scope = _scope_of(db, session_id)

        prepared: list[dict] = []
        for art in articles_in:
            if not (art.title or "").strip() and not (art.content or "").strip():
                raise HTTPException(status_code=400, detail="Each article needs a title or content.")
            new_article = art.model_dump()
            for field_name in _LIST_FIELDS:
                if new_article.get(field_name) is None:
                    new_article[field_name] = []
            # Confidences arrive as 0–100 percents; persist them as 0–1 floats.
            for cf in _CONFIDENCE_FIELDS:
                if new_article.get(cf) is not None:
                    new_article[cf] = round(new_article[cf] / 100, 2)
            # Normalize body fields (whitespace/HTML/date/domain) like the pipeline.
            # clean_articles assigns its own id; append_tagged_articles overwrites it
            # with the session's next sequential ref.
            new_article = clean_articles([new_article])[0]
            new_article["added_type"] = "Manual"  # mark user-added articles
            prepared.append(new_article)

        created = append_tagged_articles(db, scope, prepared, view_session_id=scope.view_session_id)

        # Tags changed → cached dashboards are stale.
        if record.charts_data_file:
            try:
                s3_file.delete_file(record.charts_data_file)
            except Exception:  # noqa: BLE001
                logger.warning("Failed to delete stale charts file; continuing.")
        invalidate_session_charts(db, record)

        logger.info(f"Added {len(created)} article(s) to session_id={session_id}")
        return created
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f"Adding articles failed for session_id={session_id}")
        raise HTTPException(status_code=500, detail=f"Adding articles failed: {exc}") from exc


@router.delete("/tagging/{session_id}/articles/{article_id}")
def delete_tagged_article(
    session_id: int,
    article_id: str,
    db: Session = Depends(get_db),
) -> Any:
    """Delete a manually-added article (added_type == 'Manual') from the session's
    tagged set. Only manual articles can be removed. Invalidates cached dashboards."""
    try:
        record, scope = _scope_of(db, session_id)

        target = fetch_tagged_articles(db, scope, [article_id]).get(article_id)
        if target is None:
            raise HTTPException(status_code=404, detail=f"Article {article_id} not found.")
        if (target.get("added_type") or "") != "Manual":
            raise HTTPException(status_code=400, detail="Only manually-added articles can be deleted.")

        delete_tagged_article_row(db, scope, article_id)

        # Tags changed → cached dashboards are stale.
        if record.charts_data_file:
            try:
                s3_file.delete_file(record.charts_data_file)
            except Exception:  # noqa: BLE001
                logger.warning("Failed to delete stale charts file; continuing.")
        invalidate_session_charts(db, record)

        logger.info(f"Deleted manual article {article_id} from session_id={session_id}")
        return {"deleted_id": article_id}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f"Deleting article failed for session_id={session_id}")
        raise HTTPException(status_code=500, detail=f"Deleting article failed: {exc}") from exc


@router.post("/tagging/{session_id}/approve")
def approve_tagged_articles(
    session_id: int,
    payload: ApproveRequest,
    db: Session = Depends(get_db),
) -> Any:
    """Approve or un-approve the given articles for this session.

    The approval is recorded against this session, not against the article: a pool
    article shown by two overlapping windows is approved in each one separately, so a
    review done here can't add to or remove from another session's dashboards and
    report."""
    try:
        if not payload.ids:
            raise HTTPException(status_code=400, detail="No article ids provided.")

        record, scope = _scope_of(db, session_id)

        # Media Monitoring approves into a separate list so the two review flows
        # don't clobber each other's approvals.
        field = "is_approved_for_monitoring" if payload.for_monitoring else "is_approved"

        matched = set(
            set_approval(db, scope, payload.ids, payload.for_monitoring, payload.is_approved)
        )

        if payload.for_monitoring and payload.is_approved:
            set_approval(db, scope, payload.ids, for_monitoring=False, approved=True)

        approved_ids = [i for i in payload.ids if i in matched]
        not_found_ids = [i for i in payload.ids if i not in matched]
        if not approved_ids:
            raise HTTPException(status_code=404, detail=f"None of the provided ids exist: {not_found_ids}")

        invalidate_session_charts(db, record)

        logger.info(f"Set {field}={payload.is_approved} on {len(approved_ids)} article(s) for session_id={session_id}")
        return {"approved_ids": approved_ids, "not_found_ids": not_found_ids, "is_approved": payload.is_approved, "field": field}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(f"Approving articles failed for session_id={session_id}")
        raise HTTPException(status_code=500, detail=f"Approving articles failed: {exc}") from exc

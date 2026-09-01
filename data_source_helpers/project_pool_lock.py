"""Serialize ingest into a project's article pool.

The pool's fetch → tag pass is not safe to run twice at once for the same project.
Two runs would fetch the same articles (each snapshotting "what we already have"
before the other inserts), and worse, both would read the same untagged rows and
tag them — paying the model twice and storing the same article twice, since each
snapshotted the pool before the other's rows landed.

That isn't hypothetical: a project with several scheduled queries fires them on the
same minute, and a review page's top-up can open while the hourly job is running.

Held around the whole fetch-and-tag pass. It is a process-local lock — enough for the
single-process app (the scheduler's runs and the WebSocket's top-ups are threads of
it), but it does NOT coordinate across multiple worker processes or hosts. If the API
is ever scaled out, this needs to become a database-level lock (a Postgres advisory
lock keyed on the project id).
"""
from __future__ import annotations

import threading
from contextlib import contextmanager

_locks: dict[int, threading.Lock] = {}
_registry_guard = threading.Lock()


class PoolBusyError(RuntimeError):
    """Another pass on this project's pool did not finish in time.

    Raised instead of waiting forever. A blocking acquire was how one wedged pass took
    every later run for the project down with it: the scheduler's overlap guard is keyed
    on the generated-query id, but this lock is keyed on the project, so all of a
    project's scheduled queries queued up behind the stuck holder.
    """

# A window session shows the shared project pool, so its pass has to be the
# only one touching that pool — otherwise a concurrent scheduled run tags the
# same rows twice and both collide on the pool's ref sequence. Acquired off the
# event loop and released in the finally below (threading.Lock isn't bound to
# the thread that took it, which is what lets it span these awaits).
def project_pool_lock(project_id: int) -> threading.Lock:
    """The lock guarding this project's pool ingest, created on first use.

    ``threading.Lock`` deliberately, not ``RLock``: it is released by whichever thread
    finishes the pass, which may not be the one that took it (an async caller bridges
    through ``asyncio.to_thread``), and it must never be re-entered by a nested run.
    """
    with _registry_guard:
        lock = _locks.get(project_id)
        if lock is None:
            lock = threading.Lock()
            _locks[project_id] = lock
        return lock


@contextmanager
def pool_lock_guard(project_id: int, timeout: float):
    """Hold this project's pool lock for the block, waiting at most `timeout` seconds.

    Raises :class:`PoolBusyError` rather than blocking indefinitely — the caller decides
    whether "someone else is mid-pass" means skip this round or tell the user to wait.
    Releases only a lock this block actually acquired, which a bare ``with lock:`` on the
    object from :func:`project_pool_lock` cannot promise.
    """
    lock = project_pool_lock(project_id)
    if not lock.acquire(timeout=timeout):
        raise PoolBusyError(
            f"pool ingest for project_id={project_id} is still running after {timeout}s"
        )
    try:
        yield lock
    finally:
        lock.release()

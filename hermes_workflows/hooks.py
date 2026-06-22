"""Event-driven advance — worker-side kanban lifecycle observers.

Hermes #50349 fires ``kanban_task_completed`` / ``kanban_task_blocked`` plugin
hooks AFTER the board state-transition txn commits. Both fire in the short-lived
kanban WORKER process at the end of its run (when it calls ``kanban_complete`` /
``kanban_block``). Subscribing to them lets a multi-node workflow run advance in
SECONDS on a card completion instead of waiting up to the residual ~2-minute
``advance-all`` tick.

Flow per event (``_on_task_event``):

1. Resolve the owning workflow run from the settled card id via a single cheap
   read of ``runs.db`` — the card id appears as a node's ``hermes_task_id`` (a
   created ``agent_task`` card) or inside ``driven_task_ids`` / ``task_ids_json``
   (an adopt node), and only ACTIVE runs are considered. This one query both
   *identifies* a workflow card and *resolves* its run, so no separate board-
   column probe is needed (the hook payload carries ``task_id`` but not the
   workflow columns). A non-workflow card, or a card whose run is already
   terminal, resolves to ``None`` → nothing happens.
2. Check a per-run filesystem debounce so a burst of parallel-node completions
   (each in its own worker process) coalesces to one advance.
3. Spawn a DETACHED, reparented ``hermes-workflows advance-run <run_id>`` that
   outlives the worker and runs the SAME idempotent advance cycle the tick uses,
   then return. The worker is free to exit immediately; the detached process is
   the real advance runtime (it logs truthfully).

Best-effort throughout: the host treats lifecycle hooks as fire-and-forget
observers (return values ignored, exceptions swallowed), and so does this module
— a non-workflow card, an unknown/terminal run, or any lookup/spawn error logs
and returns. No card transition is ever lost to an observer failure: the
residual tick still advances the run (the crash-safety net).
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

# Run statuses that still need advancing — a terminal run is never re-advanced.
# Mirrors engine.ACTIVE_RUN_STATUSES (kept local so this module stays import-cheap
# and does not pull in the heavy engine at plugin load).
_ACTIVE_RUN_STATUSES = ("created", "running", "waiting")


def register(ctx: Any) -> None:
    """Register the completion/block observers on the host plugin manager.
    Registered unconditionally at plugin load (the observers self-no-op for
    non-workflow cards). Fail-open: a host without ``register_hook``, or any
    error, simply skips the event path — the tick remains the safety net."""
    register_hook = getattr(ctx, "register_hook", None)
    if not callable(register_hook):
        return
    try:
        register_hook("kanban_task_completed", _on_task_completed)
        register_hook("kanban_task_blocked", _on_task_blocked)
    except Exception:
        pass


def _on_task_completed(**kwargs: Any) -> None:
    _on_task_event(kwargs.get("task_id"))


def _on_task_blocked(**kwargs: Any) -> None:
    _on_task_event(kwargs.get("task_id"))


def _on_task_event(task_id: Optional[str]) -> None:
    """Resolve the owning run for a settled card and spawn a scoped advance.
    Never raises into the worker's completion/block path."""
    try:
        if not task_id:
            return
        run_id = _resolve_run_id(str(task_id))
        if run_id is None:
            return  # not a workflow card, or its run is already terminal
        if _debounced(run_id):
            return  # a scoped advance for this run was just spawned — coalesce
        _spawn_advance_run(run_id)
    except Exception as exc:  # noqa: BLE001 - an observer never breaks the worker
        print(
            f"hermes-workflows: lifecycle observer failed for task {task_id}: {exc}",
            file=sys.stderr,
        )


def _like_escape(value: str) -> str:
    """Escape SQL LIKE wildcards (``\\`` ``%`` ``_``) so a value matches
    literally under ``ESCAPE '\\'``."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _resolve_run_id(task_id: str) -> Optional[str]:
    """The ACTIVE workflow run that drives ``task_id``, or ``None``. The card id
    is a node's ``hermes_task_id`` (a created ``agent_task`` card) or appears in
    its JSON ``driven_task_ids`` / ``task_ids_json`` (an adopt node). A terminal
    run needs no advance and is excluded by the status filter."""
    from . import config

    db_path = config.runs_db_path()
    if not Path(db_path).exists():
        return None
    conn = sqlite3.connect(str(db_path))
    try:
        conn.row_factory = sqlite3.Row
        # The runs.db is written by the core (Bun, WAL); tolerate a concurrent
        # writer rather than erroring out of the lookup.
        conn.execute("PRAGMA busy_timeout = 5000")
        status_marks = ",".join("?" for _ in _ACTIVE_RUN_STATUSES)
        # JSON arrays store ids quoted (e.g. ["t_abc"]), so a quoted-substring
        # LIKE isolates the id. Task ids contain ``_`` (a LIKE wildcard), so the
        # pattern is escaped to match the id literally, not as a wildcard.
        like = f'%"{_like_escape(task_id)}"%'
        row = conn.execute(
            f"SELECT n.run_id AS run_id "
            f"FROM workflow_node_runs n "
            f"JOIN workflow_runs r ON r.id = n.run_id "
            f"WHERE r.status IN ({status_marks}) "
            f"  AND (n.hermes_task_id = ? "
            f"       OR n.driven_task_ids LIKE ? ESCAPE '\\' "
            f"       OR n.task_ids_json LIKE ? ESCAPE '\\') "
            f"LIMIT 1",
            (*_ACTIVE_RUN_STATUSES, task_id, like, like),
        ).fetchone()
        return row["run_id"] if row is not None else None
    finally:
        conn.close()


def _debounce_dir() -> Path:
    from . import config

    return config.workflows_dir() / "advance-locks"


def _debounced(run_id: str) -> bool:
    """Whether a scoped advance for ``run_id`` was spawned within the debounce
    window (so this call should coalesce and skip). Otherwise records the spawn
    time and returns ``False``. Cross-process by design — parallel-node cards
    complete in separate worker processes — so the window lives in a per-run
    marker file's mtime. Best-effort: any error falls through to spawning, since
    a double spawn is harmless (the advance cycle is idempotent)."""
    from . import config

    window = config.event_debounce_seconds()
    try:
        directory = _debounce_dir()
        directory.mkdir(parents=True, exist_ok=True)
        marker = directory / f"{run_id}.lock"
        now = time.time()
        if marker.exists() and (now - marker.stat().st_mtime) < window:
            return True
        marker.touch()
        os.utime(marker, (now, now))
        return False
    except Exception:
        return False


def _spawn_advance_run(run_id: str) -> None:
    """Spawn a DETACHED, reparented ``hermes-workflows advance-run <run_id>`` that
    outlives this worker and runs the idempotent advance cycle gateway-side. Same
    entrypoint the cron tick shim execs (``config.command_path()``), invoked with
    the run id directly (no per-run shim file needed for an immediate spawn)."""
    from . import config

    argv = [str(config.command_path()), "advance-run", run_id]
    subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )

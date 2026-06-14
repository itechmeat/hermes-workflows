"""Kanban bridge: create agent_task cards mapped to native Hermes columns, and
read completion outcome from native ``task_runs``.

Design notes:
- ``hermes_cli.kanban_db.create_task`` does not accept the workflow columns or
  ``model_override``, so those are stamped with a follow-up UPDATE, guarded by
  feature detection (older boards simply skip them).
- Idempotency uses the native ``idempotency_key`` so a repeated advance tick
  never creates a duplicate card. The key includes an iteration so a loop
  re-entry (fix -> validate) creates a fresh card.
- Node outcome maps from native ``task_runs.outcome`` (``completed`` -> success,
  anything else -> failure). A worker may override it by writing
  ``{"node_outcome": "success"|"failure"}`` into the run metadata.
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional

from hermes_cli import kanban_db as kb

_WORKFLOW_COLUMNS = ("workflow_template_id", "current_step_key")
CREATED_BY = "hermes-workflows"


def dispatch_board(
    board: str,
    *,
    run: Callable[..., Any] = subprocess.run,
    hermes_bin: str = "hermes",
) -> Any:
    """Run one native dispatcher pass on ``board`` (reclaim stale, promote ready,
    spawn workers). We never write our own worker loop; Hermes owns dispatch and
    its concurrency caps (``kanban.max_in_progress[_per_profile]``)."""
    return run(
        [hermes_bin, "kanban", "--board", board, "dispatch", "--json"],
        capture_output=True,
        text=True,
    )


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def has_workflow_columns(conn: sqlite3.Connection) -> bool:
    return set(_WORKFLOW_COLUMNS).issubset(_columns(conn, "tasks"))


def idempotency_key(run_id: str, node_id: str, iteration: int = 0) -> str:
    return f"{run_id}:{node_id}:{iteration}"


def create_node_task(
    conn: sqlite3.Connection,
    *,
    run_id: str,
    node_id: str,
    workflow_id: str,
    title: str,
    prompt: str,
    assignee: str,
    model: Optional[str] = None,
    skills: Optional[Iterable[str]] = None,
    max_retries: Optional[int] = None,
    workspace: str = "scratch",
    timeout_seconds: Optional[int] = None,
    iteration: int = 0,
) -> str:
    """Create (or reuse, via idempotency) the Kanban task backing an agent_task
    node, stamping native workflow columns when the board supports them."""
    task_id = kb.create_task(
        conn,
        title=title,
        body=prompt,
        assignee=assignee,
        created_by=CREATED_BY,
        workspace_kind=workspace,
        idempotency_key=idempotency_key(run_id, node_id, iteration),
        skills=list(skills) if skills else None,
        max_retries=max_retries,
        max_runtime_seconds=timeout_seconds,
    )
    _stamp_native_columns(conn, task_id, workflow_id, node_id, model)
    return task_id


def _stamp_native_columns(
    conn: sqlite3.Connection,
    task_id: str,
    workflow_id: str,
    node_id: str,
    model: Optional[str],
) -> None:
    assignments: list[str] = []
    params: list[object] = []
    if has_workflow_columns(conn):
        assignments += ["workflow_template_id = ?", "current_step_key = ?"]
        params += [workflow_id, node_id]
    if model and "model_override" in _columns(conn, "tasks"):
        assignments.append("model_override = ?")
        params.append(model)
    if not assignments:
        return
    params.append(task_id)
    conn.execute(f"UPDATE tasks SET {', '.join(assignments)} WHERE id = ?", params)
    conn.commit()


def adopt_task(conn: sqlite3.Connection, task_id: str, *, assignee: str) -> str:
    """Drive an EXISTING board card: assign it to ``assignee`` and promote it into
    the dispatch lane so the gateway dispatcher claims and runs it. Returns the
    same ``task_id`` as the handle (no card is created).

    Native ordering: assign BEFORE promote, because assigning a ``ready`` card
    drops it to ``todo`` (kanban_db). A ``triage`` card takes the native
    ``triage -> todo`` step first, then ``promote_task(force=True)`` raises it to
    ``ready`` regardless of unrelated parent deps (the workflow owns the gating).

    Idempotent: a card already ``running`` / ``review`` is being driven, and a
    ``done`` / ``archived`` card has nothing to drive, so both are a no-op."""
    task = kb.get_task(conn, task_id)
    if task is None:
        raise ValueError(f"adopt: task {task_id} does not exist on this board")
    if task.status in ("running", "review", "done", "archived"):
        return task_id

    kb.assign_task(conn, task_id, assignee)
    current = kb.get_task(conn, task_id).status
    if current == "triage":
        conn.execute(
            "UPDATE tasks SET status = 'todo' WHERE id = ? AND status = 'triage'", (task_id,)
        )
        conn.commit()
        current = "todo"
    if current in ("todo", "blocked"):
        ok, reason = kb.promote_task(conn, task_id, actor=CREATED_BY, force=True)
        if not ok:
            raise ValueError(f"adopt: could not promote {task_id} to ready: {reason}")
    return task_id


def route_to_review(conn: sqlite3.Connection, task_id: str, *, reviewer: str) -> None:
    """Route a just-completed driven card through Hermes' native review stage:
    assign the reviewer and transition ``done -> review`` so the gateway hands it
    to the reviewer via ``claim_review_task`` (``review -> running``). A card not
    in ``done`` is left untouched (only a freshly completed card is reviewable)."""
    kb.assign_task(conn, task_id, reviewer)
    conn.execute(
        "UPDATE tasks SET status = 'review' WHERE id = ? AND status = 'done'", (task_id,)
    )
    conn.commit()


@dataclass
class NodeCompletion:
    found: bool
    settled: bool = False
    status: Optional[str] = None
    outcome: Optional[str] = None  # "success" | "failure" | None
    output: Optional[str] = None


def read_completion(conn: sqlite3.Connection, task_id: str) -> NodeCompletion:
    """Read the current completion state of a node's Kanban task."""
    task = conn.execute("SELECT status, result FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if task is None:
        return NodeCompletion(found=False)

    status = task["status"]
    run = conn.execute(
        "SELECT outcome, summary, metadata FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT 1",
        (task_id,),
    ).fetchone()

    outcome: Optional[str] = None
    output: Optional[str] = task["result"]
    if run is not None:
        output = run["summary"] or output
        override = _node_outcome_override(run["metadata"])
        if override is not None:
            outcome = override
        elif run["outcome"] is not None:
            outcome = "success" if run["outcome"] == "completed" else "failure"

    if outcome is None and status == "done":
        outcome = "success"

    return NodeCompletion(
        found=True,
        settled=status in ("done", "archived"),
        status=status,
        outcome=outcome,
        output=output,
    )


def _node_outcome_override(metadata: Optional[str]) -> Optional[str]:
    if not metadata:
        return None
    try:
        parsed = json.loads(metadata)
    except (ValueError, TypeError):
        return None
    if isinstance(parsed, dict) and parsed.get("node_outcome") in ("success", "failure"):
        return parsed["node_outcome"]
    return None

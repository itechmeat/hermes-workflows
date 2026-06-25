"""P1.2 — KanbanExecutor: schedule creates a stamped, idempotent card; poll maps
native ``task_runs.outcome`` onto the executor's success/failure Completion.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")

from hermes_workflows.executor import Completion, RetryPolicy
from hermes_workflows.executor.kanban_executor import KanbanExecutor

PARAMS = {
    "title": "Plan the feature",
    "prompt": "Write the plan.",
    "assignee": "product-tech-lead",
    "skills": ["brainstorming"],
    "max_retries": 2,
    "workspace": "scratch",
}

# The exhausted-retry sentinel the agent CLI prints on a transient provider
# error while still exiting 0 - the 429 that killed the 2026-06-24 release run.
_TRANSIENT_SENTINEL = "API call failed after 3 retries: HTTP 429: temporarily overloaded"


@pytest.fixture()
def board(tmp_path: Path):
    conn = kb.connect(db_path=tmp_path / "kanban.db")
    yield conn
    conn.close()


def _settle(board: sqlite3.Connection, task_id: str, outcome: str) -> None:
    board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (task_id,))
    board.execute(
        "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
        "VALUES (?, 'done', ?, 'ran', 1, 2)",
        (task_id, outcome),
    )
    board.commit()


def test_schedule_creates_stamped_card(board: sqlite3.Connection) -> None:
    ex = KanbanExecutor(board)
    handle = ex.schedule(
        run_id="run-1", node_id="plan", workflow_id="wf-feature", params=PARAMS
    )
    row = board.execute(
        "SELECT workflow_template_id, current_step_key, assignee FROM tasks WHERE id = ?",
        (handle,),
    ).fetchone()
    assert row["workflow_template_id"] == "wf-feature"
    assert row["current_step_key"] == "plan"
    assert row["assignee"] == "product-tech-lead"


def test_schedule_is_idempotent_per_iteration(board: sqlite3.Connection) -> None:
    ex = KanbanExecutor(board)
    first = ex.schedule(run_id="run-1", node_id="plan", workflow_id="wf", params=PARAMS)
    again = ex.schedule(run_id="run-1", node_id="plan", workflow_id="wf", params=PARAMS)
    assert first == again  # same (run, node, iteration) -> reused card

    looped = ex.schedule(
        run_id="run-1", node_id="plan", workflow_id="wf", params=PARAMS, iteration=1
    )
    assert looped != first  # a fresh loop iteration -> fresh card


def test_poll_before_completion_is_not_settled(board: sqlite3.Connection) -> None:
    ex = KanbanExecutor(board)
    handle = ex.schedule(run_id="run-1", node_id="plan", workflow_id="wf", params=PARAMS)
    completion = ex.poll(handle)
    assert isinstance(completion, Completion)
    assert completion.settled is False
    assert completion.outcome is None


def test_poll_maps_completed_to_success(board: sqlite3.Connection) -> None:
    ex = KanbanExecutor(board)
    handle = ex.schedule(run_id="run-1", node_id="plan", workflow_id="wf", params=PARAMS)
    _settle(board, handle, "completed")
    completion = ex.poll(handle)
    assert completion.settled is True
    assert completion.outcome == "success"
    assert completion.output == "ran"


def test_poll_maps_non_completed_to_failure(board: sqlite3.Connection) -> None:
    ex = KanbanExecutor(board)
    handle = ex.schedule(run_id="run-1", node_id="plan", workflow_id="wf", params=PARAMS)
    _settle(board, handle, "failed")
    completion = ex.poll(handle)
    assert completion.settled is True
    assert completion.outcome == "failure"


def test_poll_unknown_handle_is_not_settled(board: sqlite3.Connection) -> None:
    ex = KanbanExecutor(board)
    completion = ex.poll("t_does_not_exist")
    assert completion.settled is False
    assert completion.outcome is None

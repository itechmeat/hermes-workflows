"""E3.2 — kanban bridge: native-column stamping, idempotency, completion reads."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")

from hermes_workflows.bridge import kanban as bridge


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    connection = kb.connect(db_path=tmp_path / "kanban.db")
    yield connection
    connection.close()


def _finish_task(
    conn: sqlite3.Connection,
    task_id: str,
    *,
    outcome: str = "completed",
    summary: str = "done",
    metadata: str | None = None,
    status: str = "done",
) -> None:
    conn.execute("UPDATE tasks SET status = ? WHERE id = ?", (status, task_id))
    conn.execute(
        "INSERT INTO task_runs (task_id, status, outcome, summary, metadata, started_at, ended_at) "
        "VALUES (?, 'done', ?, ?, ?, 1, 2)",
        (task_id, outcome, summary, metadata),
    )
    conn.commit()


def test_create_stamps_native_columns(conn: sqlite3.Connection) -> None:
    task_id = bridge.create_node_task(
        conn,
        run_id="run-1",
        node_id="implement",
        workflow_id="feature-development",
        title="Implement feature",
        prompt="do the work",
        assignee="fullstack-engineer",
        model="some-model",
    )
    row = conn.execute(
        "SELECT assignee, workflow_template_id, current_step_key, model_override, idempotency_key "
        "FROM tasks WHERE id = ?",
        (task_id,),
    ).fetchone()
    assert row["assignee"] == "fullstack-engineer"
    assert row["workflow_template_id"] == "feature-development"
    assert row["current_step_key"] == "implement"
    assert row["model_override"] == "some-model"
    assert row["idempotency_key"] == "run-1:implement:0"


def test_create_is_idempotent(conn: sqlite3.Connection) -> None:
    common = dict(
        run_id="run-1",
        node_id="implement",
        workflow_id="wf",
        title="t",
        prompt="p",
        assignee="dev",
    )
    first = bridge.create_node_task(conn, **common)
    second = bridge.create_node_task(conn, **common)
    assert first == second

    third = bridge.create_node_task(conn, iteration=1, **common)
    assert third != first  # a loop re-entry gets a fresh card


def test_read_completion_maps_outcome(conn: sqlite3.Connection) -> None:
    task_id = bridge.create_node_task(
        conn, run_id="r", node_id="validate", workflow_id="wf", title="v", prompt="p", assignee="qa"
    )

    pending = bridge.read_completion(conn, task_id)
    assert pending.found is True
    assert pending.settled is False

    _finish_task(conn, task_id, outcome="completed", summary="all green")
    done = bridge.read_completion(conn, task_id)
    assert done.settled is True
    assert done.outcome == "success"
    assert done.output == "all green"


def test_read_completion_failure_and_override(conn: sqlite3.Connection) -> None:
    crashed = bridge.create_node_task(
        conn, run_id="r", node_id="a", workflow_id="wf", title="a", prompt="p", assignee="dev"
    )
    _finish_task(conn, crashed, outcome="crashed", status="done")
    assert bridge.read_completion(conn, crashed).outcome == "failure"

    overridden = bridge.create_node_task(
        conn, run_id="r", node_id="b", workflow_id="wf", title="b", prompt="p", assignee="dev"
    )
    _finish_task(conn, overridden, outcome="completed", metadata='{"node_outcome": "failure"}')
    assert bridge.read_completion(conn, overridden).outcome == "failure"


def test_read_completion_classifies_transient_summary_as_failure(
    conn: sqlite3.Connection,
) -> None:
    """The kanban worker exits 0 and the card lands `done`/`completed` even when
    its LLM call exhausted retries on a 429 - the summary carries the sentinel.
    Trusting `completed` advances the release on garbage (the 2026-06-24 cascade).
    read_completion must classify it a transient failure so the retry policy can
    ride it out."""
    task_id = bridge.create_node_task(
        conn, run_id="r", node_id="lock", workflow_id="wf", title="l", prompt="p", assignee="dev"
    )
    _finish_task(
        conn,
        task_id,
        outcome="completed",
        summary="API call failed after 3 retries: HTTP 429: temporarily overloaded",
    )
    completion = bridge.read_completion(conn, task_id)
    assert completion.outcome == "failure"
    assert completion.kind == "transient"


def test_read_completion_clean_completed_is_success_kind(conn: sqlite3.Connection) -> None:
    task_id = bridge.create_node_task(
        conn, run_id="r", node_id="v", workflow_id="wf", title="v", prompt="p", assignee="qa"
    )
    _finish_task(conn, task_id, outcome="completed", summary="all green")
    completion = bridge.read_completion(conn, task_id)
    assert completion.outcome == "success"
    assert completion.kind == "success"


def test_read_completion_real_failure_is_deterministic_kind(conn: sqlite3.Connection) -> None:
    """A real worker failure (non-`completed` outcome) and a declared
    `node_outcome: failure` are both deterministic - the transient policy must
    never retry them."""
    crashed = bridge.create_node_task(
        conn, run_id="r", node_id="a", workflow_id="wf", title="a", prompt="p", assignee="dev"
    )
    _finish_task(conn, crashed, outcome="crashed")
    assert bridge.read_completion(conn, crashed).kind == "deterministic"

    declared = bridge.create_node_task(
        conn, run_id="r", node_id="b", workflow_id="wf", title="b", prompt="p", assignee="dev"
    )
    _finish_task(conn, declared, outcome="completed", metadata='{"node_outcome": "failure"}')
    declared_completion = bridge.read_completion(conn, declared)
    assert declared_completion.outcome == "failure"
    assert declared_completion.kind == "deterministic"


def test_read_completion_unknown_task(conn: sqlite3.Connection) -> None:
    assert bridge.read_completion(conn, "t_missing").found is False


def test_has_workflow_columns_true_on_current_schema(conn: sqlite3.Connection) -> None:
    assert bridge.has_workflow_columns(conn) is True


def test_stamp_is_graceful_without_columns(tmp_path: Path) -> None:
    bare = sqlite3.connect(tmp_path / "bare.db")
    bare.row_factory = sqlite3.Row
    bare.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT)")
    bare.execute("INSERT INTO tasks (id, status) VALUES ('t_1', 'ready')")
    bare.commit()
    assert bridge.has_workflow_columns(bare) is False
    # Must not raise when the native columns are absent.
    bridge._stamp_native_columns(bare, "t_1", "wf", "node", "model")
    bare.close()

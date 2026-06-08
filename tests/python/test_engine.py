"""E4.3 + E4.5 — the Python orchestrator drives a durable run end to end:
run -> (worker completes Kanban task) -> advance -> ... -> finish, including the
fix loop and idempotent ticks. Uses the real Bun core CLI and a temp board.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")

from hermes_workflows.engine import Engine
from hermes_workflows.executor import DirectExecutor, KanbanExecutor, ScriptExecutor

from conftest import fake_hermes_bin

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "core" / "src" / "cli.ts"
SPEC = ROOT / "examples" / "feature-development.workflow.yaml"
GLOBAL_SPEC = ROOT / "examples" / "blog-daily-signals.workflow.yaml"


@pytest.fixture()
def engine(tmp_path: Path):
    board = kb.connect(db_path=tmp_path / "kanban.db")
    eng = Engine(
        core_cli=["bun", "run", str(CLI)],
        db_path=str(tmp_path / "runs.db"),
        kanban=KanbanExecutor(board),
    )
    yield eng
    board.close()


def _complete(board: sqlite3.Connection, task_id: str, outcome: str = "completed") -> None:
    board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (task_id,))
    board.execute(
        "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
        "VALUES (?, 'done', ?, 'ok', 1, 2)",
        (task_id, outcome),
    )
    board.commit()


def _node(run: dict, node_id: str) -> dict:
    return run["nodes"][node_id]


def test_run_schedules_the_entry_node(engine: Engine) -> None:
    run = engine.run(str(SPEC), "run-1")
    assert run["status"] == "running"
    assert _node(run, "plan")["status"] == "scheduled"
    assert _node(run, "plan")["hermes_task_id"]


def test_idempotent_tick_creates_no_duplicate(engine: Engine) -> None:
    engine.run(str(SPEC), "run-1")
    task_id = engine.status("run-1")["nodes"]["plan"]["hermes_task_id"]
    again = engine.advance(str(SPEC), "run-1")
    assert _node(again, "plan")["hermes_task_id"] == task_id  # same card, no duplicate


def test_full_happy_path_to_finish(engine: Engine) -> None:
    run = engine.run(str(SPEC), "run-1")

    # plan -> implement -> validate
    for step in ("plan", "implement", "validate"):
        _complete(engine.kanban.board_conn, _node(run, step)["hermes_task_id"])
        run = engine.advance(str(SPEC), "run-1")

    # validate succeeded -> human review is waiting
    assert run["status"] == "waiting"
    assert _node(run, "review")["status"] == "waiting_for_review"

    run = engine.decide_review(str(SPEC), "run-1", "review", "approved")
    assert _node(run, "release_notes")["status"] == "scheduled"

    _complete(engine.kanban.board_conn, _node(run, "release_notes")["hermes_task_id"])
    run = engine.advance(str(SPEC), "run-1")
    assert run["status"] == "completed"


def test_fix_loop_reruns_validate(engine: Engine) -> None:
    run = engine.run(str(SPEC), "run-1")
    for step in ("plan", "implement"):
        _complete(engine.kanban.board_conn, _node(run, step)["hermes_task_id"])
        run = engine.advance(str(SPEC), "run-1")

    # validate fails -> fix is scheduled
    _complete(engine.kanban.board_conn, _node(run, "validate")["hermes_task_id"], outcome="crashed")
    run = engine.advance(str(SPEC), "run-1")
    assert _node(run, "fix")["status"] == "scheduled"
    first_validate_task = _node(run, "validate")["hermes_task_id"]

    # fix completes -> validate re-runs on a fresh card
    _complete(engine.kanban.board_conn, _node(run, "fix")["hermes_task_id"])
    run = engine.advance(str(SPEC), "run-1")
    assert _node(run, "validate")["status"] == "scheduled"
    assert _node(run, "validate")["hermes_task_id"] != first_validate_task


def test_global_workflow_runs_via_direct_executor(tmp_path: Path) -> None:
    direct = DirectExecutor(
        hermes_bin=fake_hermes_bin(tmp_path / "hermes"),
        store_dir=tmp_path / "store",
        timeout_seconds=10,
    )
    eng = Engine(
        core_cli=["bun", "run", str(CLI)],
        db_path=str(tmp_path / "runs.db"),
        direct=direct,
    )

    run = eng.run(str(GLOBAL_SPEC), "g-1")
    # No Kanban card: the handle is a direct run:node:iteration token, not a t_ id.
    assert _node(run, "fetch")["hermes_task_id"] == "g-1:fetch:0"

    # The runner threads settle each node asynchronously; keep advancing until
    # the chain (fetch -> summarize -> draft) parks at the review gate.
    run = _advance_until(eng, str(GLOBAL_SPEC), "g-1", lambda r: r["status"] == "waiting")
    assert _node(run, "review")["status"] == "waiting_for_review"

    eng.decide_review(str(GLOBAL_SPEC), "g-1", "review", "approved")
    run = _advance_until(eng, str(GLOBAL_SPEC), "g-1", lambda r: r["status"] == "completed")
    assert _node(run, "publish")["outcome"] == "success"


def _advance_until(eng: Engine, spec: str, run_id: str, predicate, deadline_s: float = 30.0):
    import time

    deadline = time.monotonic() + deadline_s
    while time.monotonic() < deadline:
        run = eng.advance(spec, run_id)
        if predicate(run):
            return run
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} never reached the expected state: {run['status']}")


def test_direct_node_reports_running_while_the_runner_works(tmp_path: Path) -> None:
    """A long agent node must show `running`, not a stale `scheduled`, while
    its runner works — the editor playback and the run inspector both render
    this status live."""
    eng = Engine(
        core_cli=["bun", "run", str(CLI)],
        db_path=str(tmp_path / "runs.db"),
        direct=DirectExecutor(
            hermes_bin=fake_hermes_bin(tmp_path / "hermes", 'sleep 3; echo "ok"'),
            store_dir=tmp_path / "store",
            timeout_seconds=30,
        ),
    )

    run = eng.run(str(GLOBAL_SPEC), "g-r1")
    assert _node(run, "fetch")["status"] == "scheduled"

    # The next advance observes the started marker and flips the node.
    run = eng.advance(str(GLOBAL_SPEC), "g-r1")
    assert _node(run, "fetch")["status"] == "running"
    assert run["status"] == "running"


_MIXED_SPEC = {
    "id": "mixed",
    "name": "Mixed",
    "version": 1,
    "scope": {"type": "project"},
    "trigger": {"type": "manual"},
    "defaults": {"profile": "p"},
    "nodes": [
        {"id": "work", "type": "agent_task", "prompt": "do"},
        {"id": "lint", "type": "script", "command": "echo linted"},
        {"id": "done", "type": "finish"},
    ],
    "edges": [{"from": "work", "to": "lint"}, {"from": "lint", "to": "done"}],
}


def test_mixed_run_routes_agent_to_kanban_and_script_to_script_executor(tmp_path: Path) -> None:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    eng = Engine(
        core_cli=["bun", "run", str(CLI)],
        db_path=str(tmp_path / "runs.db"),
        kanban=KanbanExecutor(board),
        script=ScriptExecutor(store_dir=tmp_path / "scripts", env_allowlist=["PATH"]),
    )
    spec = tmp_path / "mixed.workflow.json"
    spec.write_text(json.dumps(_MIXED_SPEC))

    run = eng.run(str(spec), "m-1")
    # The agent_task is a Kanban card (t_…), not a local script handle.
    work_handle = _node(run, "work")["hermes_task_id"]
    assert not work_handle.startswith("script:")

    # Completing the agent card advances to the script node, which runs locally.
    _complete(board, work_handle)
    run = eng.advance(str(spec), "m-1")
    lint_handle = _node(run, "lint")["hermes_task_id"]
    assert lint_handle.startswith("script:")

    # Polling settles the script via its backend; the run reaches finish.
    run = eng.advance(str(spec), "m-1")
    assert _node(run, "lint")["outcome"] == "success"
    assert "linted" in (_node(run, "lint").get("output") or "")
    assert run["status"] == "completed"
    board.close()


def test_create_records_the_run_without_advancing(engine: Engine) -> None:
    created = engine.create(str(SPEC), "run-c1")
    assert created["status"] == "created"
    # Nothing scheduled: create is the non-blocking half of run().
    persisted = engine.status("run-c1")
    assert persisted["status"] == "created"
    assert all(node["status"] == "pending" for node in persisted["nodes"].values())


def test_run_after_create_advances_the_same_run(engine: Engine) -> None:
    engine.create(str(SPEC), "run-c2")
    advanced = engine.advance(str(SPEC), "run-c2")
    assert advanced["status"] == "running"
    assert _node(advanced, "plan")["status"] == "scheduled"

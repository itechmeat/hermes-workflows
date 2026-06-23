"""Engine settle-merge: when a kanban-backed node settles, the worker's
telemetry sidecar is folded into NodeRunState.telemetry and persisted; the
sidecar is cleaned up after the save. Fail-open: corrupt or missing sidecars
leave the node without telemetry and never stall the run."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")

from conftest import EXAMPLE_PARAMS
from hermes_workflows import telemetry
from hermes_workflows.engine import Engine
from hermes_workflows.executor import KanbanExecutor

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "core" / "src" / "cli.ts"
SPEC = ROOT / "examples" / "feature-development.workflow.yaml"


@pytest.fixture()
def engine(tmp_path: Path):
    board = kb.connect(db_path=tmp_path / "kanban.db")
    eng = Engine(
        core_cli=["bun", "run", str(CLI)],
        db_path=str(tmp_path / "runs.db"),
        kanban=KanbanExecutor(board),
        telemetry_dir=tmp_path / "telemetry",
    )
    yield eng
    board.close()


def _complete(board: sqlite3.Connection, task_id: str) -> None:
    board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (task_id,))
    board.execute(
        "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
        "VALUES (?, 'done', 'completed', 'ok', 1, 2)",
        (task_id,),
    )
    board.commit()


def _seed_sidecar(root: Path, task_id: str, data: dict) -> None:
    root.mkdir(parents=True, exist_ok=True)
    telemetry.sidecar_path(root, task_id).write_text(json.dumps(data))


def test_settled_node_gets_telemetry_and_sidecar_is_cleared(engine: Engine, tmp_path: Path) -> None:
    run = engine.run(str(SPEC), "run-t1", params=EXAMPLE_PARAMS)
    task_id = run["nodes"]["plan"]["hermes_task_id"]
    _seed_sidecar(
        tmp_path / "telemetry",
        task_id,
        {"api_calls": 3, "total_tokens": 120, "tool_calls": 5, "duration_ms": 9000},
    )
    _complete(engine.kanban.board_conn, task_id)
    run = engine.advance(str(SPEC), "run-t1")

    node = run["nodes"]["plan"]
    assert node["status"] == "completed"
    assert node["telemetry"] == {
        "api_calls": 3,
        "total_tokens": 120,
        "tool_calls": 5,
        "duration_ms": 9000,
    }
    # Persisted, not just in-memory: a fresh load carries it too.
    assert engine.status("run-t1")["nodes"]["plan"]["telemetry"]["total_tokens"] == 120
    # The sidecar was consumed.
    assert telemetry.load_node_telemetry(tmp_path / "telemetry", task_id) is None


def test_missing_or_corrupt_sidecar_is_fail_open(engine: Engine, tmp_path: Path) -> None:
    run = engine.run(str(SPEC), "run-t2", params=EXAMPLE_PARAMS)
    task_id = run["nodes"]["plan"]["hermes_task_id"]
    telemetry_root = tmp_path / "telemetry"
    telemetry_root.mkdir(parents=True, exist_ok=True)
    telemetry.sidecar_path(telemetry_root, task_id).write_text("{broken")
    _complete(engine.kanban.board_conn, task_id)
    run = engine.advance(str(SPEC), "run-t2")

    node = run["nodes"]["plan"]
    assert node["status"] == "completed"  # the run advanced normally
    assert "telemetry" not in node
    # The corrupt sidecar was still cleaned up.
    assert not telemetry.sidecar_path(telemetry_root, task_id).exists()


def test_engine_without_telemetry_dir_keeps_todays_behaviour(tmp_path: Path) -> None:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        eng = Engine(
            core_cli=["bun", "run", str(CLI)],
            db_path=str(tmp_path / "runs.db"),
            kanban=KanbanExecutor(board),
        )
        run = eng.run(str(SPEC), "run-t3", params=EXAMPLE_PARAMS)
        task_id = run["nodes"]["plan"]["hermes_task_id"]
        _complete(board, task_id)
        run = eng.advance(str(SPEC), "run-t3")
        assert run["nodes"]["plan"]["status"] == "completed"
        assert "telemetry" not in run["nodes"]["plan"]
    finally:
        board.close()

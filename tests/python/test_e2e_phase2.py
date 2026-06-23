"""P8.1 — end-to-end Phase 2: a project workflow runs to completion on its own
project board (durable cards), a global workflow runs to completion via the
direct profile runner (no cards), and the self-terminating tick advances active
runs and tears its cron down once everything drains.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")

from hermes_workflows.engine import Engine
from hermes_workflows.executor import DirectExecutor, KanbanExecutor

from conftest import EXAMPLE_PARAMS, fake_hermes_bin

ROOT = Path(__file__).resolve().parents[2]
CLI = ["bun", "run", str(ROOT / "packages" / "core" / "src" / "cli.ts")]
PROJECT_SPEC = str(ROOT / "examples" / "feature-development.workflow.yaml")
GLOBAL_SPEC = str(ROOT / "examples" / "blog-daily-signals.workflow.yaml")
ROOTS = [str(ROOT / "examples")]


def _complete(board: sqlite3.Connection, task_id: str) -> None:
    board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (task_id,))
    board.execute(
        "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
        "VALUES (?, 'done', 'completed', 'ok', 1, 2)",
        (task_id,),
    )
    board.commit()


def _node(run: dict, node_id: str) -> dict:
    return run["nodes"][node_id]


def test_project_backend_runs_to_completion_on_project_board(tmp_path: Path) -> None:
    boards: dict[str, sqlite3.Connection] = {}

    def kanban_factory(slug: str) -> KanbanExecutor:
        if slug not in boards:
            boards[slug] = kb.connect(db_path=tmp_path / f"{slug}.db")
        return KanbanExecutor(boards[slug])

    eng = Engine(
        core_cli=CLI,
        db_path=str(tmp_path / "runs.db"),
        kanban_factory=kanban_factory,
        direct=DirectExecutor(store_dir=tmp_path / "s"),
    )

    run = eng.run(PROJECT_SPEC, "p-1", project_id="acme", params=EXAMPLE_PARAMS)
    board = boards["acme"]  # the project's own board was used, not a shared one

    for step in ("plan", "implement", "validate"):
        _complete(board, _node(run, step)["hermes_task_id"])
        run = eng.advance(PROJECT_SPEC, "p-1")
    assert run["status"] == "waiting"

    run = eng.decide_review(PROJECT_SPEC, "p-1", "review", "approved")
    _complete(board, _node(run, "release_notes")["hermes_task_id"])
    run = eng.advance(PROJECT_SPEC, "p-1")
    assert run["status"] == "completed"

    for conn in boards.values():
        conn.close()


def test_global_backend_runs_to_completion_without_cards(tmp_path: Path) -> None:
    eng = Engine(
        core_cli=CLI,
        db_path=str(tmp_path / "runs.db"),
        direct=DirectExecutor(
            hermes_bin=fake_hermes_bin(tmp_path / "hermes"), store_dir=tmp_path / "s"
        ),
    )

    run = eng.run(GLOBAL_SPEC, "g-1")
    assert _node(run, "fetch")["hermes_task_id"] == "g-1:fetch:0"  # direct handle
    for _ in range(3):
        run = eng.advance(GLOBAL_SPEC, "g-1")
    assert run["status"] == "waiting"

    run = eng.decide_review(GLOBAL_SPEC, "g-1", "review", "approved")
    run = eng.advance(GLOBAL_SPEC, "g-1")
    assert run["status"] == "completed"


def test_tick_advances_and_self_terminates(tmp_path: Path) -> None:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    eng = Engine(
        core_cli=CLI, db_path=str(tmp_path / "runs.db"), kanban=KanbanExecutor(board)
    )
    sync_calls: list[bool] = []
    sync = lambda *, active, script: sync_calls.append(active)  # noqa: E731

    try:
        eng.run(PROJECT_SPEC, "t-1", params=EXAMPLE_PARAMS)
        result = eng.tick(ROOTS, sync_tick=sync, tick_script="advance-all")
        assert result["active"] is True
        assert sync_calls[-1] is True  # active run -> tick kept alive

        # Complete the whole workflow, then a final tick drains it.
        run = eng.status("t-1")
        for step in ("plan", "implement", "validate"):
            _complete(board, _node(run, step)["hermes_task_id"])
            run = eng.advance(PROJECT_SPEC, "t-1")
        run = eng.decide_review(PROJECT_SPEC, "t-1", "review", "approved")
        _complete(board, _node(run, "release_notes")["hermes_task_id"])
        eng.advance(PROJECT_SPEC, "t-1")

        result = eng.tick(ROOTS, sync_tick=sync, tick_script="advance-all")
        assert result["active"] is False
        assert sync_calls[-1] is False  # drained -> tick torn down
    finally:
        board.close()

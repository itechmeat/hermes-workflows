"""Event-driven advance — the scoped ``advance-run <run_id>`` surface.

``advance-run`` advances exactly one run (the per-card event path, so a single
completion never re-walks every active run), is idempotent on a re-run with no
new completion, and errors cleanly (no traceback) on an unknown run id.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")

from hermes_workflows import cli  # noqa: E402
from hermes_workflows.engine import Engine  # noqa: E402
from hermes_workflows.executor import KanbanExecutor  # noqa: E402

from conftest import EXAMPLE_PARAMS, sibling_spec  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CLI = ["bun", "run", str(ROOT / "packages" / "core" / "src" / "cli.ts")]
SPEC = ROOT / "examples" / "feature-development.workflow.yaml"
ROOTS = [str(ROOT / "examples")]


@pytest.fixture()
def engine(tmp_path: Path):
    board = kb.connect(db_path=tmp_path / "kanban.db")
    eng = Engine(
        core_cli=CLI, db_path=str(tmp_path / "runs.db"), kanban=KanbanExecutor(board)
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


def test_advance_run_advances_exactly_one_run(engine: Engine, tmp_path: Path) -> None:
    a = engine.run(str(SPEC), "run-a", params=EXAMPLE_PARAMS)
    engine.run(str(sibling_spec(tmp_path, SPEC)), "run-b", params=EXAMPLE_PARAMS)
    _complete(engine.kanban.board_conn, a["nodes"]["plan"]["hermes_task_id"])

    advanced = engine.advance_run([*ROOTS, str(tmp_path)], "run-a")

    # The completed run moved on; the untouched sibling stayed where it was —
    # advance-run scoped to exactly one run.
    assert advanced["run_id"] == "run-a"
    assert engine.status("run-a")["nodes"]["implement"]["status"] == "scheduled"
    assert engine.status("run-b")["nodes"]["plan"]["status"] == "scheduled"


def test_advance_run_is_idempotent(engine: Engine) -> None:
    a = engine.run(str(SPEC), "run-a", params=EXAMPLE_PARAMS)
    _complete(engine.kanban.board_conn, a["nodes"]["plan"]["hermes_task_id"])

    first = engine.advance_run(ROOTS, "run-a")
    # A second advance with no new completion is a no-op: the run state is stable.
    second = engine.advance_run(ROOTS, "run-a")

    assert first["nodes"]["implement"]["status"] == "scheduled"
    assert second["nodes"]["implement"]["status"] == "scheduled"
    assert second["nodes"]["implement"]["hermes_task_id"] == first["nodes"]["implement"]["hermes_task_id"]


def test_advance_run_unknown_run_raises_valueerror(engine: Engine) -> None:
    with pytest.raises(ValueError):
        engine.advance_run(ROOTS, "no-such-run")


def test_cli_advance_run_unknown_run_exits_cleanly() -> None:
    # The CLI converts the engine's ValueError into a clean SystemExit (non-zero
    # with a message), not an unhandled traceback.
    class _Engine:
        def advance_run(self, roots, run_id):
            raise ValueError(f"unknown run '{run_id}'")

    with pytest.raises(SystemExit) as exc:
        cli._advance_run(_Engine(), "no-such-run")
    assert "no-such-run" in str(exc.value)

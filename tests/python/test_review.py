"""P7.1 — channel-agnostic human_review resolution: the engine validates the
decision and node state, and the same resolution is reachable from the model
tool and the CLI.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")
pytest.importorskip("cron.jobs")

from conftest import EXAMPLE_PARAMS
from hermes_workflows import cli, tools
from hermes_workflows.engine import Engine
from hermes_workflows.executor import KanbanExecutor

ROOT = Path(__file__).resolve().parents[2]
CLI = ["bun", "run", str(ROOT / "packages" / "core" / "src" / "cli.ts")]
SPEC = str(ROOT / "examples" / "feature-development.workflow.yaml")
ROOTS = [str(ROOT / "examples")]


def _complete(board: sqlite3.Connection, task_id: str) -> None:
    board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (task_id,))
    board.execute(
        "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
        "VALUES (?, 'done', 'completed', 'ok', 1, 2)",
        (task_id,),
    )
    board.commit()


@pytest.fixture()
def engine(tmp_path: Path):
    board = kb.connect(db_path=tmp_path / "kanban.db")
    eng = Engine(
        core_cli=CLI, db_path=str(tmp_path / "runs.db"), kanban=KanbanExecutor(board)
    )
    yield eng
    board.close()


def _drive_to_review(engine: Engine) -> dict:
    run = engine.run(SPEC, "r", params=EXAMPLE_PARAMS)
    for step in ("plan", "implement", "validate"):
        _complete(engine.kanban.board_conn, run["nodes"][step]["hermes_task_id"])
        run = engine.advance(SPEC, "r")
    assert run["nodes"]["review"]["status"] == "waiting_for_review"
    return run


def test_decide_review_rejects_invalid_decision(engine: Engine) -> None:
    _drive_to_review(engine)
    with pytest.raises(ValueError):
        engine.decide_review(SPEC, "r", "review", "maybe")


def test_decide_review_rejects_non_waiting_node(engine: Engine) -> None:
    engine.run(SPEC, "r", params=EXAMPLE_PARAMS)
    with pytest.raises(ValueError):
        engine.decide_review(SPEC, "r", "plan", "approved")


def test_status_live_surfaces_a_pending_completion(engine: Engine) -> None:
    """status_live read-only-polls active cards so a card that finished between
    ticks shows as settled (a pending completion), without mutating run state."""
    run = engine.run(SPEC, "r", params=EXAMPLE_PARAMS)
    card = run["nodes"]["plan"]["hermes_task_id"]
    # The card finished on the board, but the run has not advanced yet.
    _complete(engine.kanban.board_conn, card)

    live = engine.status_live(SPEC, "r")
    assert live["nodes"]["plan"]["live"]["settled"] is True
    assert "plan" in live["live"]["pending_completions"]
    # Persisted state is untouched: the node is still scheduled until a tick.
    assert engine.status("r")["nodes"]["plan"]["status"] == "scheduled"


def test_decide_review_records_an_optional_note(engine: Engine) -> None:
    _drive_to_review(engine)
    resolved = engine.decide_review(SPEC, "r", "review", "approved", note="chose option 1")
    assert resolved["nodes"]["review"]["review_decision"] == "approved"
    assert resolved["nodes"]["review"]["review_note"] == "chose option 1"
    # The note persists across a reload (it is a real column, not transient).
    assert engine.status("r")["nodes"]["review"]["review_note"] == "chose option 1"


def test_decide_review_treats_blank_note_as_absent(engine: Engine) -> None:
    _drive_to_review(engine)
    resolved = engine.decide_review(SPEC, "r", "review", "approved", note="   ")
    assert "review_note" not in resolved["nodes"]["review"]


def test_tool_resolves_approved_and_advances(engine: Engine) -> None:
    _drive_to_review(engine)
    result = tools.review_workflow(
        "r", "review", "approved", engine=engine, roots=ROOTS, core_cli=CLI
    )
    assert result["decision"] == "approved"
    assert engine.status("r")["nodes"]["release_notes"]["status"] == "scheduled"


def test_tool_rejects_invalid_decision(engine: Engine) -> None:
    _drive_to_review(engine)
    with pytest.raises(ValueError):
        tools.review_workflow("r", "review", "nope", engine=engine, roots=ROOTS, core_cli=CLI)


@pytest.fixture()
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    h = tmp_path / "home"
    (h / "workflows" / "global").mkdir(parents=True)
    shutil.copy(SPEC, h / "workflows" / "global" / "feature-development.workflow.yaml")
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    return tmp_path / "kanban.db"


def test_cli_review_resolves(home: Path, capsys) -> None:
    def _invoke(*argv: str):
        cli.main(list(argv))
        return json.loads(capsys.readouterr().out)

    run = _invoke("run", "feature-development", "--params", json.dumps(EXAMPLE_PARAMS))
    rid = run["run_id"]
    board = sqlite3.connect(str(home))
    try:
        for step in ("plan", "implement", "validate"):
            status = _invoke("status", rid)
            _complete(board, status["nodes"][step]["hermes_task_id"])
            _invoke("advance-all")
        waiting = _invoke("status", rid)
        assert waiting["nodes"]["review"]["status"] == "waiting_for_review"

        resolved = _invoke("review", rid, "review", "approved")
        assert resolved["nodes"]["release_notes"]["status"] == "scheduled"
    finally:
        board.close()

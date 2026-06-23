"""E4.4 — model-visible tools delegate to the engine/CLI and never expose
graph editing."""

from __future__ import annotations

from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")

from conftest import EXAMPLE_PARAMS
from hermes_workflows import tools
from hermes_workflows.engine import Engine
from hermes_workflows.executor import KanbanExecutor

ROOT = Path(__file__).resolve().parents[2]
CLI = ["bun", "run", str(ROOT / "packages" / "core" / "src" / "cli.ts")]
EXAMPLES = str(ROOT / "examples")


@pytest.fixture()
def engine(tmp_path: Path):
    board = kb.connect(db_path=tmp_path / "kanban.db")
    eng = Engine(core_cli=CLI, db_path=str(tmp_path / "runs.db"), kanban=KanbanExecutor(board))
    yield eng
    board.close()


_WORKFLOWS = [
    {"id": "osb-feature-release", "name": "Feature Release"},
    {"id": "nightly-audit", "name": "Nightly Audit"},
]


def test_resolve_nl_command_matches_id_and_keeps_instruction() -> None:
    out = tools.resolve_nl_command("osb-feature-release take 2-3 minor related tasks", _WORKFLOWS)
    assert out == {"workflow_id": "osb-feature-release", "input": "take 2-3 minor related tasks"}


def test_resolve_nl_command_matches_a_multiword_name() -> None:
    out = tools.resolve_nl_command("Feature Release ship it", _WORKFLOWS)
    assert out == {"workflow_id": "osb-feature-release", "input": "ship it"}


def test_resolve_nl_command_bare_target_has_no_input() -> None:
    out = tools.resolve_nl_command("nightly-audit", _WORKFLOWS)
    assert out == {"workflow_id": "nightly-audit", "input": None}


def test_resolve_nl_command_unknown_target_asks() -> None:
    out = tools.resolve_nl_command("do something vague", _WORKFLOWS)
    assert "question" in out and "could not match" in out["question"]


def test_resolve_nl_command_empty_asks() -> None:
    assert "question" in tools.resolve_nl_command("   ", _WORKFLOWS)


def test_workflow_list() -> None:
    result = tools.list_workflows(roots=[EXAMPLES], core_cli=CLI)
    ids = sorted(w["id"] for w in result["workflows"])
    assert ids == ["blog-daily-signals", "feature-development"]


def test_workflow_explain() -> None:
    result = tools.explain_workflow("feature-development", roots=[EXAMPLES], core_cli=CLI)
    assert result["id"] == "feature-development"
    assert len(result["nodes"]) == 7


def test_workflow_explain_unknown_id_raises() -> None:
    with pytest.raises(ValueError):
        tools.explain_workflow("ghost", roots=[EXAMPLES], core_cli=CLI)


def test_workflow_run_and_status(engine: Engine) -> None:
    started = tools.run_workflow(
        "feature-development",
        engine=engine,
        roots=[EXAMPLES],
        core_cli=CLI,
        run_id="run-1",
        params=EXAMPLE_PARAMS,
    )
    assert started["run_id"] == "run-1"
    assert started["status"] == "running"

    state = tools.workflow_status("run-1", engine=engine)
    assert state["status"] == "running"
    assert state["current_node"] == "plan"

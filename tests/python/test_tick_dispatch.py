"""P3.2 — the self-terminating tick: advance every active run, run a dispatcher
pass on each project board that has open cards, and keep the singleton tick
cron alive only while runs remain active.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")

from hermes_workflows.bridge import kanban
from hermes_workflows.engine import Engine
from hermes_workflows.executor import KanbanExecutor

from conftest import EXAMPLE_PARAMS, sibling_spec

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


class _Recorder:
    def __init__(self) -> None:
        self.dispatched: list[str] = []
        self.sync_calls: list[bool] = []

    def dispatch(self, board: str) -> None:
        self.dispatched.append(board)

    def sync_tick(self, *, active: bool, script: str) -> None:
        self.sync_calls.append(active)


def test_dispatch_board_invokes_native_cli() -> None:
    calls: list[list[str]] = []

    def fake_run(argv, **_kwargs):
        calls.append(argv)
        return "ok"

    kanban.dispatch_board("proj-acme", run=fake_run)
    assert calls == [["hermes", "kanban", "--board", "proj-acme", "dispatch", "--json"]]


def test_tick_dispatches_active_boards_and_keeps_tick(engine: Engine, tmp_path: Path) -> None:
    # Two concurrently-active runs need two workflows (single-flight allows at
    # most one active run per workflow); both resolve to the same board here.
    engine.run(str(SPEC), "run-a", params=EXAMPLE_PARAMS)
    engine.run(str(sibling_spec(tmp_path, SPEC)), "run-b", params=EXAMPLE_PARAMS)
    rec = _Recorder()

    result = engine.tick(
        [*ROOTS, str(tmp_path)],
        dispatch=rec.dispatch,
        sync_tick=rec.sync_tick,
        tick_script="hermes-workflows advance-all",
        resolve_board=lambda _run: "proj-board",
    )

    # Both runs have an open card on the same board -> dispatched once, deduped.
    assert rec.dispatched == ["proj-board"]
    assert rec.sync_calls == [True]  # active runs remain -> tick ensured
    assert {r["run_id"] for r in result["advanced"]} == {"run-a", "run-b"}


def test_tick_tears_down_when_drained(engine: Engine) -> None:
    engine.run(str(SPEC), "run-old", params=EXAMPLE_PARAMS)
    old = engine.status("run-old")
    old["status"] = "completed"
    engine._save(old)
    rec = _Recorder()

    engine.tick(
        ROOTS,
        dispatch=rec.dispatch,
        sync_tick=rec.sync_tick,
        tick_script="hermes-workflows advance-all",
        resolve_board=lambda _run: "proj-board",
    )

    assert rec.dispatched == []  # nothing active -> nothing to dispatch
    assert rec.sync_calls == [False]  # drained -> tick torn down


def test_tick_skips_boardless_runs(engine: Engine) -> None:
    engine.run(str(SPEC), "run-a", params=EXAMPLE_PARAMS)
    rec = _Recorder()

    engine.tick(
        ROOTS,
        dispatch=rec.dispatch,
        sync_tick=rec.sync_tick,
        tick_script="x",
        resolve_board=lambda _run: None,  # e.g. a global run with no board
    )

    assert rec.dispatched == []
    assert rec.sync_calls == [True]

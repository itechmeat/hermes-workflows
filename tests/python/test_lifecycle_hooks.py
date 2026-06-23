"""Event-driven advance — worker-side kanban lifecycle observers.

The ``kanban_task_completed`` / ``kanban_task_blocked`` observers fire in the
short-lived kanban worker process after the board txn commits. Each resolves the
owning workflow run from the settled card and spawns a detached scoped
``advance-run`` (intercepted here). Contract: a non-workflow card spawns nothing;
a workflow card spawns exactly one advance; a resolution error never throws and
never spawns; and both hooks are registered on a plugin load.
"""

from __future__ import annotations

from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")

from conftest import EXAMPLE_PARAMS  # noqa: E402
from hermes_workflows import config, hooks, plugin  # noqa: E402
from hermes_workflows.engine import Engine  # noqa: E402
from hermes_workflows.executor import KanbanExecutor  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CLI = ["bun", "run", str(ROOT / "packages" / "core" / "src" / "cli.ts")]
SPEC = ROOT / "examples" / "feature-development.workflow.yaml"


@pytest.fixture()
def engine(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # Point the workflows dir (runs.db + the debounce-lock dir) at tmp so the
    # observer's runs.db lookup finds this test's run.
    monkeypatch.setattr(config, "workflows_dir", lambda: tmp_path)
    monkeypatch.setattr(config, "event_debounce_seconds", lambda: 0.0)
    board = kb.connect(db_path=tmp_path / "kanban.db")
    eng = Engine(
        core_cli=CLI, db_path=str(tmp_path / "runs.db"), kanban=KanbanExecutor(board)
    )
    yield eng
    board.close()


@pytest.fixture()
def spawns(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    captured: list[str] = []
    monkeypatch.setattr(hooks, "_spawn_advance_run", lambda run_id: captured.append(run_id))
    return captured


def test_non_workflow_card_spawns_nothing(engine: Engine, spawns: list[str]) -> None:
    hooks._on_task_completed(task_id="t_not_a_workflow_card", board="some-board")
    assert spawns == []


def test_workflow_card_spawns_one_advance(engine: Engine, spawns: list[str]) -> None:
    run = engine.run(str(SPEC), "run-x", params=EXAMPLE_PARAMS)
    card = run["nodes"]["plan"]["hermes_task_id"]

    hooks._on_task_completed(task_id=card, board="b", run_id=1, summary="done")

    assert spawns == ["run-x"]


def test_blocked_card_spawns_one_advance(engine: Engine, spawns: list[str]) -> None:
    run = engine.run(str(SPEC), "run-x", params=EXAMPLE_PARAMS)
    card = run["nodes"]["plan"]["hermes_task_id"]

    hooks._on_task_blocked(task_id=card, board="b", run_id=1, reason="stuck")

    assert spawns == ["run-x"]


def test_resolution_matches_id_literally_not_as_wildcard(engine: Engine) -> None:
    # Task ids contain '_', a LIKE wildcard. Resolving for "t_abc" must not match
    # a *different* driven id that only the wildcard would catch ("txabc").
    engine.run(str(SPEC), "run-x", params=EXAMPLE_PARAMS)  # creates runs.db + schema
    import sqlite3

    conn = sqlite3.connect(engine.db_path)
    try:
        conn.execute(
            "INSERT INTO workflow_runs (id, workflow_id, status) VALUES (?, ?, 'running')",
            ("run-other", "wf-other"),
        )
        conn.execute(
            "INSERT INTO workflow_node_runs (id, run_id, node_id, status, driven_task_ids) "
            "VALUES (?, ?, 'adopt', 'scheduled', ?)",
            ("n1", "run-other", '["txabc"]'),
        )
        conn.commit()
    finally:
        conn.close()

    assert hooks._resolve_run_id("txabc") == "run-other"  # exact id resolves
    assert hooks._resolve_run_id("t_abc") is None  # the '_' must not match 'x'


def test_lookup_error_never_throws_and_never_spawns(
    engine: Engine, spawns: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    def _boom(_task_id: str):
        raise RuntimeError("runs.db unreadable")

    monkeypatch.setattr(hooks, "_resolve_run_id", _boom)
    # Must not raise into the worker's completion path.
    hooks._on_task_completed(task_id="t_anything", board="b")
    assert spawns == []


def test_hooks_registered_on_plugin_load() -> None:
    class _Ctx:
        def __init__(self) -> None:
            self.hooks: dict[str, list] = {}

        def register_tool(self, **_kwargs) -> None:
            pass

        def register_hook(self, name, callback) -> None:
            self.hooks.setdefault(name, []).append(callback)

    ctx = _Ctx()
    plugin.register(ctx)
    assert "kanban_task_completed" in ctx.hooks
    assert "kanban_task_blocked" in ctx.hooks

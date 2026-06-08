"""C2 - lightweight inline mode (TZ §18.2): when execution.default_mode permits
inline and the advance is inline-eligible (script-only), the engine keeps
advancing synchronously within one run/tick call until the run is terminal,
waiting, or schedules a durable node. default_mode=durable disables the loop.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hermes_workflows.engine import Engine
from hermes_workflows.executor import DirectExecutor, ScriptExecutor

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "core" / "src" / "cli.ts"

# Two script steps then a finish: exercises a multi-step inline drain.
CHAIN_SPEC = {
    "id": "inline-chain",
    "name": "Inline Chain",
    "version": 1,
    "scope": {"type": "global"},
    "trigger": {"type": "manual"},
    "nodes": [
        {"id": "s1", "type": "script", "command": "echo one"},
        {"id": "s2", "type": "script", "command": "echo two"},
        {"id": "done", "type": "finish", "outcome": "success"},
    ],
    "edges": [{"from": "s1", "to": "s2"}, {"from": "s2", "to": "done"}],
}

# script -> condition -> finish: the routing node resolves in-call.
COND_SPEC = {
    "id": "inline-cond",
    "name": "Inline Cond",
    "version": 1,
    "scope": {"type": "global"},
    "trigger": {"type": "manual"},
    "nodes": [
        {"id": "build", "type": "script", "command": "echo ok"},
        {"id": "gate", "type": "condition"},
        {"id": "ok", "type": "finish", "outcome": "success"},
        {"id": "bad", "type": "finish", "outcome": "failure"},
    ],
    "edges": [
        {"from": "build", "to": "gate"},
        {"from": "gate", "to": "ok", "condition": {"type": "node_status", "node": "build", "equals": "success"}},
        {"from": "gate", "to": "bad", "condition": {"type": "node_status", "node": "build", "equals": "failure"}},
    ],
}


def _spec(tmp_path: Path, obj: dict) -> str:
    path = tmp_path / f"{obj['id']}.workflow.json"
    path.write_text(json.dumps(obj))
    return str(path)


def _engine(tmp_path: Path, mode: str) -> Engine:
    return Engine(
        core_cli=["bun", "run", str(CLI)],
        db_path=str(tmp_path / "runs.db"),
        direct=DirectExecutor(store_dir=tmp_path / "direct"),
        script=ScriptExecutor(store_dir=tmp_path / "scripts", env_allowlist=["PATH"]),
        default_mode=mode,
    )


def test_script_only_run_finishes_inline_in_one_call(tmp_path: Path) -> None:
    eng = _engine(tmp_path, "auto")
    spec = _spec(tmp_path, CHAIN_SPEC)
    run = eng.run(spec, "i-1")  # no separate advance / tick
    assert run["status"] == "completed"
    assert run["nodes"]["s1"]["outcome"] == "success"
    assert run["nodes"]["s2"]["outcome"] == "success"


def test_script_condition_finish_completes_inline(tmp_path: Path) -> None:
    eng = _engine(tmp_path, "direct")
    spec = _spec(tmp_path, COND_SPEC)
    run = eng.run(spec, "i-2")
    assert run["status"] == "completed"


def test_durable_mode_disables_the_inline_loop(tmp_path: Path) -> None:
    eng = _engine(tmp_path, "durable")
    spec = _spec(tmp_path, CHAIN_SPEC)
    run = eng.run(spec, "i-3")
    # One step only: s1 scheduled, not yet polled; run still running.
    assert run["status"] == "running"
    assert run["nodes"]["s1"]["status"] == "scheduled"
    assert run["nodes"]["s2"]["status"] == "pending"
    # Durable advances proceed one node per tick - verify each step.
    run = eng.advance(spec, "i-3")
    assert run["nodes"]["s1"]["outcome"] == "success"
    assert run["nodes"]["s2"]["status"] == "scheduled"
    run = eng.advance(spec, "i-3")
    assert run["nodes"]["s2"]["outcome"] == "success"
    run = eng.advance(spec, "i-3")
    assert run["status"] == "completed"


# --- script -> agent_task parks the durable node (needs hermes_cli) --------

MIXED_SPEC = {
    "id": "inline-mixed",
    "name": "Inline Mixed",
    "version": 1,
    "scope": {"type": "project"},
    "trigger": {"type": "manual"},
    "defaults": {"profile": "p"},
    "nodes": [
        {"id": "lint", "type": "script", "command": "echo linted"},
        {"id": "work", "type": "agent_task", "prompt": "do"},
        {"id": "done", "type": "finish", "outcome": "success"},
    ],
    "edges": [{"from": "lint", "to": "work"}, {"from": "work", "to": "done"}],
}


def test_script_then_agent_runs_script_inline_and_parks_the_agent(tmp_path: Path) -> None:
    # importorskip is scoped here so the global-script inline tests above still
    # run where hermes_cli is absent (the core test venv).
    kb = pytest.importorskip("hermes_cli.kanban_db")
    from hermes_workflows.executor import KanbanExecutor

    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        eng = Engine(
            core_cli=["bun", "run", str(CLI)],
            db_path=str(tmp_path / "runs.db"),
            kanban=KanbanExecutor(board),
            script=ScriptExecutor(store_dir=tmp_path / "scripts", env_allowlist=["PATH"]),
            default_mode="auto",
        )
        spec = _spec(tmp_path, MIXED_SPEC)
        run = eng.run(spec, "i-4")
        # The script ran inline; the agent_task is parked as a durable Kanban card.
        assert run["nodes"]["lint"]["outcome"] == "success"
        assert run["nodes"]["work"]["status"] == "scheduled"
        assert not run["nodes"]["work"]["hermes_task_id"].startswith("script:")
        assert run["status"] == "running"
    finally:
        board.close()

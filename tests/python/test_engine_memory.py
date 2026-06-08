"""B3 - the engine writes Open Second Brain memory on lifecycle transitions,
gated by the enforced open_second_brain.* settings and idempotent per (run,
event) via the persisted markers. Memory writes are fail-open and routed
through the core memory CLI; here the write methods are stubbed to record.
"""

from __future__ import annotations

import json
from pathlib import Path

from hermes_workflows.engine import Engine
from hermes_workflows.executor import DirectExecutor, ScriptExecutor

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "core" / "src" / "cli.ts"

OK_SPEC = {
    "id": "mem-ok",
    "name": "Mem OK",
    "version": 1,
    "scope": {"type": "global"},
    "trigger": {"type": "manual"},
    "nodes": [
        {"id": "build", "type": "script", "command": "echo ok"},
        {"id": "done", "type": "finish", "outcome": "success"},
    ],
    "edges": [{"from": "build", "to": "done"}],
}

FAIL_SPEC = {
    "id": "mem-fail",
    "name": "Mem Fail",
    "version": 1,
    "scope": {"type": "global"},
    "trigger": {"type": "manual"},
    "nodes": [
        {"id": "build", "type": "script", "command": "exit 1"},
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


def _engine(tmp_path: Path, memory: dict | None):
    eng = Engine(
        core_cli=["bun", "run", str(CLI)],
        db_path=str(tmp_path / "runs.db"),
        direct=DirectExecutor(store_dir=tmp_path / "direct"),
        script=ScriptExecutor(store_dir=tmp_path / "scripts", env_allowlist=["PATH"]),
        memory=memory,
    )
    calls: list[tuple] = []
    eng._memory_event = lambda spec, kind, title, body: calls.append(("event", kind))
    eng._memory_retro = lambda spec, run: calls.append(("retro", run["run_id"]))
    return eng, calls


def test_completed_run_writes_run_completed_and_retrospective_once(tmp_path: Path) -> None:
    eng, calls = _engine(tmp_path, {"mode": "auto", "write_run_summaries": True})
    spec = _spec(tmp_path, OK_SPEC)
    eng.run(spec, "m-1")
    eng.advance(spec, "m-1")
    assert ("event", "run_completed") in calls
    assert sum(1 for c in calls if c == ("retro", "m-1")) == 1
    assert sum(1 for c in calls if c == ("event", "run_completed")) == 1
    # Re-advancing the still-completed run writes nothing new.
    before = len(calls)
    eng.advance(spec, "m-1")
    assert len(calls) == before


def test_write_run_summaries_false_writes_neither(tmp_path: Path) -> None:
    eng, calls = _engine(tmp_path, {"mode": "auto", "write_run_summaries": False})
    spec = _spec(tmp_path, OK_SPEC)
    eng.run(spec, "m-2")
    eng.advance(spec, "m-2")
    assert not any(c == ("event", "run_completed") for c in calls)
    assert not any(c[0] == "retro" for c in calls)


def test_failed_node_writes_node_failed(tmp_path: Path) -> None:
    eng, calls = _engine(tmp_path, {"mode": "auto", "write_node_failures": True})
    spec = _spec(tmp_path, FAIL_SPEC)
    eng.run(spec, "m-3")
    eng.advance(spec, "m-3")
    assert sum(1 for c in calls if c == ("event", "node_failed")) == 1


def test_mode_none_writes_nothing(tmp_path: Path) -> None:
    eng, calls = _engine(tmp_path, {"mode": "none", "write_run_summaries": True})
    spec = _spec(tmp_path, OK_SPEC)
    eng.run(spec, "m-4")
    eng.advance(spec, "m-4")
    assert calls == []


def test_no_memory_config_writes_nothing(tmp_path: Path) -> None:
    eng, calls = _engine(tmp_path, None)
    spec = _spec(tmp_path, OK_SPEC)
    eng.run(spec, "m-5")
    eng.advance(spec, "m-5")
    assert calls == []


def test_write_node_events_emits_run_started_once(tmp_path: Path) -> None:
    eng, calls = _engine(tmp_path, {"mode": "auto", "write_node_events": True})
    spec = _spec(tmp_path, OK_SPEC)
    eng.run(spec, "m-6")
    eng.advance(spec, "m-6")
    eng.advance(spec, "m-6")
    assert sum(1 for c in calls if c == ("event", "run_started")) == 1

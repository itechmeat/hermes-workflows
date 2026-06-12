"""t_13d09914 - delivery as a first-class workflow-schema concept + [SILENT].

When a workflow declares a `deliver` target, a completed run delivers its
RESULT (the final node output) to that target instead of the terse lifecycle
line; an output carrying `[SILENT]` suppresses delivery. With `deliver` unset,
run-lifecycle delivery is unchanged.
"""

from __future__ import annotations

import json
from pathlib import Path

from hermes_workflows.engine import Engine
from hermes_workflows.executor import DirectExecutor, ScriptExecutor

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "core" / "src" / "cli.ts"

DELIVER_SPEC = {
    "id": "deliver-result",
    "name": "Deliver Result",
    "version": 1,
    "scope": {"type": "global"},
    "trigger": {"type": "manual"},
    "deliver": "team:chan",
    "nodes": [
        {"id": "build", "type": "script", "command": "echo 'the workflow result'"},
        {"id": "done", "type": "finish", "outcome": "success"},
    ],
    "edges": [{"from": "build", "to": "done"}],
}

SILENT_SPEC = {
    "id": "deliver-silent",
    "name": "Deliver Silent",
    "version": 1,
    "scope": {"type": "global"},
    "trigger": {"type": "manual"},
    "deliver": "team:chan",
    "nodes": [
        {"id": "build", "type": "script", "command": "echo '[SILENT]'"},
        {"id": "done", "type": "finish", "outcome": "success"},
    ],
    "edges": [{"from": "build", "to": "done"}],
}

NO_DELIVER_SPEC = {
    "id": "deliver-unset",
    "name": "Deliver Unset",
    "version": 1,
    "scope": {"type": "global"},
    "trigger": {"type": "manual"},
    "nodes": [
        {"id": "build", "type": "script", "command": "echo ok"},
        {"id": "done", "type": "finish", "outcome": "success"},
    ],
    "edges": [{"from": "build", "to": "done"}],
}


class _Recorder:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    def __call__(self, target: str, message: str) -> bool:
        self.sent.append((target, message))
        return True


def _spec(tmp_path: Path, obj: dict) -> str:
    path = tmp_path / f"{obj['id']}.workflow.json"
    path.write_text(json.dumps(obj))
    return str(path)


def _engine(tmp_path: Path, *, sender, default=None) -> Engine:
    return Engine(
        core_cli=["bun", "run", str(CLI)],
        db_path=str(tmp_path / "runs.db"),
        direct=DirectExecutor(store_dir=tmp_path / "direct"),
        script=ScriptExecutor(store_dir=tmp_path / "scripts", env_allowlist=["PATH"]),
        sender=sender,
        default_deliver=default,
    )


def test_declared_deliver_routes_result_to_target(tmp_path: Path) -> None:
    rec = _Recorder()
    eng = _engine(tmp_path, sender=rec, default="fallback:1")
    spec = _spec(tmp_path, DELIVER_SPEC)
    eng.run(spec, "d-1", origin="telegram:7:3")  # origin present, but deliver wins
    run = eng.advance(spec, "d-1")
    assert run["status"] == "completed"
    assert rec.sent, "a completed run with deliver set must deliver its result"
    target, message = rec.sent[-1]
    assert target == "team:chan"  # declared deliver overrides the origin
    assert "the workflow result" in message  # the result, not the lifecycle line
    assert not any("completed" in m for _, m in rec.sent)


def test_silent_result_suppresses_delivery(tmp_path: Path) -> None:
    rec = _Recorder()
    eng = _engine(tmp_path, sender=rec, default="fallback:1")
    spec = _spec(tmp_path, SILENT_SPEC)
    eng.run(spec, "s-1")
    run = eng.advance(spec, "s-1")
    assert run["status"] == "completed"
    assert rec.sent == []  # [SILENT] suppressed the only notice
    # A second advance must not retry the suppressed notice.
    eng.advance(spec, "s-1")
    assert rec.sent == []


def test_deliver_unset_keeps_lifecycle_behaviour(tmp_path: Path) -> None:
    rec = _Recorder()
    eng = _engine(tmp_path, sender=rec, default="fallback:1")
    spec = _spec(tmp_path, NO_DELIVER_SPEC)
    eng.run(spec, "u-1", origin="telegram:7:3")
    run = eng.advance(spec, "u-1")
    assert run["status"] == "completed"
    assert any("completed" in m for _, m in rec.sent)  # terse lifecycle text
    assert rec.sent[-1][0] == "telegram:7:3"  # to the origin, unchanged

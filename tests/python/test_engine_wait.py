"""Worker-free wait node end to end through the engine: it parks active and the
tick polls its predicate (no Kanban card, no executor), settling success on
MERGED, failure on CLOSED, and failure on timeout."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from hermes_workflows.engine import Engine
from hermes_workflows.executor import Completion

ROOT = Path(__file__).resolve().parents[2]
CLI = ["bun", "run", str(ROOT / "packages" / "core" / "src" / "cli.ts")]


class FakeExec:
    """A scope executor that is never actually used by a wait-only workflow."""

    def schedule(self, **_kwargs) -> str:
        return "fake"

    def poll(self, _handle) -> Completion:
        return Completion(settled=False)


def _spec(tmp_path: Path, obj: dict) -> str:
    path = tmp_path / f"{obj['id']}.workflow.json"
    path.write_text(json.dumps(obj))
    return str(path)


def _engine(tmp_path: Path) -> Engine:
    return Engine(core_cli=CLI, db_path=str(tmp_path / "runs.db"), direct=FakeExec())


def _spec_obj(spec_id: str, *, timeout: int | None = None) -> dict:
    merge: dict = {"id": "merge", "type": "wait", "wait_for": {"github_pr_merged": "123"}}
    if timeout is not None:
        merge["timeout_seconds"] = timeout
    return {
        "id": spec_id,
        "name": "Merge wait",
        "version": 1,
        "scope": {"type": "global"},
        "trigger": {"type": "manual"},
        "defaults": {"profile": "p"},
        "nodes": [
            merge,
            {"id": "ok", "type": "finish", "outcome": "success"},
            {"id": "bad", "type": "finish", "outcome": "failure"},
        ],
        "edges": [
            {"from": "merge", "to": "ok", "condition": {"type": "node_status", "node": "merge", "equals": "success"}},
            {"from": "merge", "to": "bad", "condition": {"type": "node_status", "node": "merge", "equals": "failure"}},
        ],
    }


def test_wait_parks_then_settles_success_on_merged(tmp_path: Path, monkeypatch) -> None:
    eng = _engine(tmp_path)
    spec = _spec(tmp_path, _spec_obj("merge-wait-ok"))

    run = eng.run(spec, "r")
    # The wait node parks active (no card, no executor) — nothing scheduled.
    assert run["nodes"]["merge"]["status"] == "running"
    assert run["nodes"]["merge"].get("hermes_task_id") is None

    monkeypatch.setattr("hermes_workflows.wait.github_pr_state", lambda _ref: "OPEN")
    run = eng.advance(spec, "r")
    assert run["nodes"]["merge"]["status"] == "running"  # still waiting

    monkeypatch.setattr("hermes_workflows.wait.github_pr_state", lambda _ref: "MERGED")
    run = eng.advance(spec, "r")
    assert run["nodes"]["merge"]["status"] == "completed"
    assert run["nodes"]["merge"]["outcome"] == "success"
    assert run["status"] == "completed"


def test_long_open_pr_never_blocks_then_settles_on_merge(tmp_path: Path, monkeypatch) -> None:
    """Regression for t_ddd03333: a release PR left OPEN while the operator
    reviews must NOT stall the run. Modeling merge-wait as an agent_task that
    reports failure to "keep waiting" let the dispatcher accrue consecutive
    failures and auto-block the card. A worker-free wait node has no card at all,
    so many OPEN ticks never accrue a failure or auto-block; when the PR finally
    merges the run proceeds with no manual unblock."""
    eng = _engine(tmp_path)
    spec = _spec(tmp_path, _spec_obj("merge-wait-long"))
    eng.run(spec, "r")

    monkeypatch.setattr("hermes_workflows.wait.github_pr_state", lambda _ref: "OPEN")
    for _ in range(12):  # the operator takes their time; far past any auto-block threshold
        run = eng.advance(spec, "r")
        node = run["nodes"]["merge"]
        assert node["status"] == "running"  # parked, still waiting
        assert node.get("hermes_task_id") is None  # no card -> nothing to auto-block
        assert node.get("outcome") is None  # never settled as a failure
        assert run["status"] in ("running", "waiting")  # run stays active, not blocked/failed

    monkeypatch.setattr("hermes_workflows.wait.github_pr_state", lambda _ref: "MERGED")
    run = eng.advance(spec, "r")
    assert run["nodes"]["merge"]["outcome"] == "success"
    assert run["status"] == "completed"


def test_wait_fails_on_closed(tmp_path: Path, monkeypatch) -> None:
    eng = _engine(tmp_path)
    spec = _spec(tmp_path, _spec_obj("merge-wait-closed"))
    eng.run(spec, "r")
    monkeypatch.setattr("hermes_workflows.wait.github_pr_state", lambda _ref: "CLOSED")
    run = eng.advance(spec, "r")
    assert run["nodes"]["merge"]["outcome"] == "failure"
    assert run["status"] == "failed"


def test_wait_fails_on_timeout(tmp_path: Path, monkeypatch) -> None:
    eng = _engine(tmp_path)
    spec = _spec(tmp_path, _spec_obj("merge-wait-timeout", timeout=1))
    eng.run(spec, "r")
    monkeypatch.setattr("hermes_workflows.wait.github_pr_state", lambda _ref: "OPEN")

    base = time.time()
    run = eng.advance(spec, "r")  # records wait_started_at ~ base, still OPEN
    assert run["nodes"]["merge"]["status"] == "running"

    # Travel past the timeout; the next poll settles the node failure.
    monkeypatch.setattr(time, "time", lambda: base + 10)
    run = eng.advance(spec, "r")
    assert run["nodes"]["merge"]["outcome"] == "failure"
    assert "timed out" in (run["nodes"]["merge"]["output"] or "")
    assert run["status"] == "failed"

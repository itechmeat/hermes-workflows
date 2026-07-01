"""Engine-level transient-error retry on the Kanban (project-scope) path.

A transient provider blip (HTTP 429 / overloaded / 5xx) on an ``agent_task``
card must not abort the whole run: the Kanban worker's CLI exits 0 even after it
exhausts its own HTTP retries (it prints ``API call failed after N retries: HTTP
429 ...`` as its final message), so the native dispatcher records the card
``done`` and its own ``max_retries`` never fires. The engine must re-classify the
completion, and on a transient failure re-schedule the node (a fresh card, with
backoff) up to the node's ``max_retries`` before settling failure.

Regression for the aborted 2026 release runs: ``inventory`` died on a single
429 and routed straight to ``notify_failure`` / ``aborted``.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")

from hermes_workflows.engine import Engine
from hermes_workflows.executor import KanbanExecutor, RetryPolicy

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "core" / "src" / "cli.ts"

_TRANSIENT_SUMMARY = (
    "API call failed after 3 retries: HTTP 429: The service may be "
    "temporarily overloaded, please try again later"
)

_SPEC = """\
id: retry-demo
name: Retry Demo
version: 1
scope:
  type: project
  projects: [demo]
trigger: { type: manual }
defaults: { profile: eng, max_retries: 1 }
nodes:
  - id: work
    type: agent_task
    title: Do the work
    prompt: "Do it."
  - id: ok
    type: finish
    outcome: success
  - id: bad
    type: finish
    outcome: failure
edges:
  - { from: work, to: ok, condition: { type: node_status, node: work, equals: success } }
  - { from: work, to: bad, condition: { type: node_status, node: work, equals: failure } }
"""


@pytest.fixture()
def engine(tmp_path: Path):
    board = kb.connect(db_path=tmp_path / "kanban.db")
    eng = Engine(
        core_cli=["bun", "run", str(CLI)],
        db_path=str(tmp_path / "runs.db"),
        kanban=KanbanExecutor(board),
        # base 0 -> no wall-clock backoff wait, so the re-schedule fires on the
        # very next tick and the test needs no sleep.
        retry_policy=RetryPolicy(base_seconds=0.0),
    )
    eng._board = board  # keep a handle for the test to settle cards
    yield eng
    board.close()


def _spec_file(tmp_path: Path) -> str:
    path = tmp_path / "retry-demo.workflow.yaml"
    path.write_text(_SPEC)
    return str(path)


def _settle(board: sqlite3.Connection, task_id: str, *, summary: str, outcome: str) -> None:
    """Mark a card terminal with a task_run carrying ``summary`` and native
    ``outcome`` (``completed`` == exit-0 clean; anything else == worker failure)."""
    board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (task_id,))
    board.execute(
        "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
        "VALUES (?, 'done', ?, ?, 1, 2)",
        (task_id, outcome, summary),
    )
    board.commit()


def _node(run: dict, node_id: str) -> dict:
    return run["nodes"][node_id]


def test_transient_429_retries_then_succeeds(engine: Engine, tmp_path: Path) -> None:
    spec = _spec_file(tmp_path)
    board = engine._board

    run = engine.run(spec, "r1")
    work = _node(run, "work")
    assert work["status"] == "scheduled"
    card0 = work["hermes_task_id"]

    # First attempt returns a transient 429 on a clean exit (native `completed`).
    _settle(board, card0, summary=_TRANSIENT_SUMMARY, outcome="completed")
    run = engine.advance(spec, "r1")
    work = _node(run, "work")
    # NOT settled failure, NOT routed to `bad`; retry is pending.
    assert work["status"] in ("scheduled", "running")
    assert work.get("outcome") != "failure"
    assert work.get("transient_retries") == 1
    assert _node(run, "bad")["status"] == "pending"

    # Next tick re-schedules a fresh card for the node.
    run = engine.advance(spec, "r1")
    work = _node(run, "work")
    card1 = work["hermes_task_id"]
    assert card1 and card1 != card0

    # The retry succeeds -> the node settles success and the run advances to `ok`.
    _settle(board, card1, summary="all good", outcome="completed")
    run = engine.advance(spec, "r1")
    assert _node(run, "work")["outcome"] == "success"
    run = engine.advance(spec, "r1")
    assert _node(run, "ok")["status"] == "completed"


def test_transient_exhausts_retries_then_settles_failure(engine: Engine, tmp_path: Path) -> None:
    spec = _spec_file(tmp_path)
    board = engine._board

    run = engine.run(spec, "r2")
    card0 = _node(run, "work")["hermes_task_id"]
    _settle(board, card0, summary=_TRANSIENT_SUMMARY, outcome="completed")
    run = engine.advance(spec, "r2")  # detect transient, schedule retry
    run = engine.advance(spec, "r2")  # re-schedule fresh card
    card1 = _node(run, "work")["hermes_task_id"]
    assert card1 != card0

    # Second attempt is transient too: max_retries=1 is now exhausted.
    _settle(board, card1, summary=_TRANSIENT_SUMMARY, outcome="completed")
    run = engine.advance(spec, "r2")
    work = _node(run, "work")
    assert work["status"] == "completed"
    assert work["outcome"] == "failure"
    # Routed to the failure branch.
    run = engine.advance(spec, "r2")
    assert _node(run, "bad")["status"] == "completed"


def test_backoff_deadline_is_not_rounded_down(tmp_path: Path) -> None:
    """A non-integer backoff must not let the retry fire early. With a real
    (non-zero) policy the node holds in backoff - it carries a `retry_after`
    deadline at least `delay` in the future and does NOT re-schedule on the very
    next tick, so a fractional/short delay is never truncated to an earlier one."""
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        eng = Engine(
            core_cli=["bun", "run", str(CLI)],
            db_path=str(tmp_path / "runs.db"),
            kanban=KanbanExecutor(board),
            retry_policy=RetryPolicy(base_seconds=30.0, ceiling_seconds=30.0),
        )
        spec = _spec_file(tmp_path)
        run = eng.run(spec, "rb")
        card0 = _node(run, "work")["hermes_task_id"]
        before = time.time()
        _settle(board, card0, summary=_TRANSIENT_SUMMARY, outcome="completed")
        run = eng.advance(spec, "rb")
        work = _node(run, "work")
        assert work.get("transient_retries") == 1
        assert work.get("retry_after") is not None
        # Deadline honours the full delay (>= 30s out), not a rounded-down value.
        assert work["retry_after"] >= before + 30.0
        assert "hermes_task_id" not in work  # handle dropped, awaiting backoff
        # An immediate next tick must NOT re-schedule - still inside the window.
        run = eng.advance(spec, "rb")
        assert "hermes_task_id" not in _node(run, "work")
    finally:
        board.close()


def test_deterministic_failure_is_not_retried(engine: Engine, tmp_path: Path) -> None:
    spec = _spec_file(tmp_path)
    board = engine._board

    run = engine.run(spec, "r3")
    card0 = _node(run, "work")["hermes_task_id"]
    # A real worker failure (native outcome != completed) fails fast, no retry.
    _settle(board, card0, summary="boom: assertion failed", outcome="failed")
    run = engine.advance(spec, "r3")
    work = _node(run, "work")
    assert work["status"] == "completed"
    assert work["outcome"] == "failure"
    assert work.get("transient_retries", 0) == 0

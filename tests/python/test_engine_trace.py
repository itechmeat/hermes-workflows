"""Engine trace instrumentation: with a writer injected, a full run produces a
readable JSONL timeline; with the default (no writer) there is zero trace I/O;
a broken writer never affects run advancement."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")

from conftest import EXAMPLE_PARAMS
from hermes_workflows import trace
from hermes_workflows.engine import Engine
from hermes_workflows.executor import KanbanExecutor

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "core" / "src" / "cli.ts"
SPEC = ROOT / "examples" / "feature-development.workflow.yaml"


def _make_engine(tmp_path: Path, writer) -> tuple[Engine, sqlite3.Connection]:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    return (
        Engine(
            core_cli=["bun", "run", str(CLI)],
            db_path=str(tmp_path / "runs.db"),
            kanban=KanbanExecutor(board),
            trace=writer,
        ),
        board,
    )


def _complete(board: sqlite3.Connection, task_id: str) -> None:
    board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (task_id,))
    board.execute(
        "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
        "VALUES (?, 'done', 'completed', 'ok', 1, 2)",
        (task_id,),
    )
    board.commit()


def _drive_to_completion(engine: Engine, board: sqlite3.Connection, run_id: str) -> dict:
    run = engine.run(str(SPEC), run_id, params=EXAMPLE_PARAMS)
    for step in ("plan", "implement", "validate"):
        _complete(board, run["nodes"][step]["hermes_task_id"])
        run = engine.advance(str(SPEC), run_id)
    run = engine.decide_review(str(SPEC), run_id, "review", "approved")
    _complete(board, run["nodes"]["release_notes"]["hermes_task_id"])
    return engine.advance(str(SPEC), run_id)


def test_full_run_produces_a_timeline(tmp_path: Path) -> None:
    writer = trace.TraceWriter(tmp_path / "traces")
    engine, board = _make_engine(tmp_path, writer)
    try:
        run = _drive_to_completion(engine, board, "run-trace-1")
        assert run["status"] == "completed"
    finally:
        board.close()

    lines = [
        json.loads(line)
        for line in (tmp_path / "traces" / "run-trace-1.jsonl").read_text().splitlines()
    ]
    assert all(line["run_id"] == "run-trace-1" and "ts" in line for line in lines)

    kinds = [line["kind"] for line in lines]
    assert kinds[0] == "run_created"
    for expected in ("node_scheduled", "node_settled", "review_decided", "run_status", "marker"):
        assert expected in kinds, f"missing {expected} in {kinds}"

    # Every work-node transition is on the timeline with its outcome and seq.
    settled = [line["node_id"] for line in lines if line["kind"] == "node_settled"]
    assert settled == ["plan", "implement", "validate", "release_notes"]
    first = next(line for line in lines if line["kind"] == "node_settled")
    assert first["outcome"] == "success"
    assert first["seq"] == 1

    # The review decision is visible even though it happens outside the tick.
    review = next(line for line in lines if line["kind"] == "review_decided")
    assert review == {**review, "node_id": "review", "decision": "approved"}


def test_disabled_tracing_does_no_io(tmp_path: Path) -> None:
    engine, board = _make_engine(tmp_path, None)
    try:
        run = _drive_to_completion(engine, board, "run-trace-2")
        assert run["status"] == "completed"
    finally:
        board.close()
    assert not (tmp_path / "traces").exists()


def test_broken_writer_never_affects_advancement(tmp_path: Path) -> None:
    class ExplodingWriter:
        def emit(self, *_args, **_kwargs) -> None:
            raise RuntimeError("tracer down")

    engine, board = _make_engine(tmp_path, ExplodingWriter())
    try:
        run = _drive_to_completion(engine, board, "run-trace-3")
        assert run["status"] == "completed"
    finally:
        board.close()

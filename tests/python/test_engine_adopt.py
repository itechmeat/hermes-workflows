"""Adopt mode: an agent_task drives EXISTING board cards (assign + promote into
dispatch, then poll to terminal) instead of creating new ones, including a typed
``{{nodes.<id>.output.task_ids}}`` reference that drives every id an upstream
node surfaced, gating completion on all of them.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")

from hermes_workflows.engine import Engine
from hermes_workflows.executor import KanbanExecutor

ROOT = Path(__file__).resolve().parents[2]
CLI = ["bun", "run", str(ROOT / "packages" / "core" / "src" / "cli.ts")]


def _engine(tmp_path: Path, board: sqlite3.Connection) -> Engine:
    return Engine(core_cli=CLI, db_path=str(tmp_path / "runs.db"), kanban=KanbanExecutor(board))


def _spec(tmp_path: Path, obj: dict) -> str:
    path = tmp_path / f"{obj['id']}.workflow.json"
    path.write_text(json.dumps(obj))
    return str(path)


def _complete(board: sqlite3.Connection, task_id: str, outcome: str = "completed") -> None:
    board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (task_id,))
    board.execute(
        "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
        "VALUES (?, 'done', ?, 'ok', 1, 2)",
        (task_id, outcome),
    )
    board.commit()


def _status(board: sqlite3.Connection, task_id: str) -> str:
    return board.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()["status"]


def _adopt_spec(
    task_ref: str,
    *,
    collect: bool = False,
    review_profile: str | None = None,
    sequential: bool = False,
) -> dict:
    drive = {"id": "drive", "type": "agent_task", "prompt": "drive", "profile": "worker",
             "adopt": True, "task_ref": task_ref}
    if review_profile is not None:
        drive["review_profile"] = review_profile
    if sequential:
        drive["sequential"] = True
    nodes = [drive]
    edges = [{"from": "drive", "to": "done"}]
    if collect:
        nodes.insert(0, {"id": "collect", "type": "agent_task", "prompt": "find", "profile": "scout"})
        edges.insert(0, {"from": "collect", "to": "drive"})
    nodes.append({"id": "done", "type": "finish", "outcome": "success"})
    entry = "collect" if collect else "drive"
    return {
        "id": f"adopt-{entry}",
        "name": "Adopt",
        "version": 1,
        "scope": {"type": "project"},
        "trigger": {"type": "manual"},
        "defaults": {"profile": "worker"},
        "nodes": nodes,
        "edges": edges,
    }


def test_adopt_drives_a_literal_existing_card(tmp_path: Path) -> None:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        target = kb.create_task(board, title="real work", created_by="op", triage=True)
        eng = _engine(tmp_path, board)
        spec = _spec(tmp_path, _adopt_spec(target))

        run = eng.run(spec, "r")
        # The node drives the EXISTING card (no new card created): assigned to the
        # node profile and promoted into the dispatch lane.
        assert run["nodes"]["drive"]["driven_task_ids"] == [target]
        assert run["nodes"]["drive"]["hermes_task_id"] == target
        assert run["nodes"]["drive"]["status"] == "scheduled"
        assert _status(board, target) == "ready"
        row = board.execute("SELECT assignee FROM tasks WHERE id = ?", (target,)).fetchone()
        assert row["assignee"] == "worker"

        _complete(board, target)
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["status"] == "completed"
        assert run["nodes"]["drive"]["outcome"] == "success"
        assert run["status"] == "completed"
    finally:
        board.close()


def test_adopt_is_idempotent_on_an_already_running_card(tmp_path: Path) -> None:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        target = kb.create_task(board, title="busy", created_by="op", triage=True)
        # The card is already being run by a worker.
        board.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (target,))
        board.commit()
        eng = _engine(tmp_path, board)
        spec = _spec(tmp_path, _adopt_spec(target))
        run = eng.run(spec, "r")
        # A running card is being driven already: adopt is a no-op, not a re-promote.
        assert run["nodes"]["drive"]["driven_task_ids"] == [target]
        assert _status(board, target) == "running"
    finally:
        board.close()


def test_adopt_fails_loud_on_a_missing_card(tmp_path: Path) -> None:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        eng = _engine(tmp_path, board)
        spec = _spec(tmp_path, _adopt_spec("t_does_not_exist"))
        run = eng.run(spec, "r")
        node = run["nodes"]["drive"]
        assert node["status"] == "completed"
        assert node["outcome"] == "failure"
        assert "adopt failed" in (node["output"] or "")
    finally:
        board.close()


def test_adopt_routes_a_driven_card_through_native_review(tmp_path: Path) -> None:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        target = kb.create_task(board, title="impl", created_by="op", triage=True)
        eng = _engine(tmp_path, board)
        spec = _spec(tmp_path, _adopt_spec(target, review_profile="reviewer"))

        run = eng.run(spec, "r")
        assert run["nodes"]["drive"]["driven_task_ids"] == [target]

        # Worker finishes the card -> the node routes it once through the native
        # review stage instead of settling, and stays active.
        _complete(board, target)
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["status"] in ("scheduled", "running")
        assert run["nodes"]["drive"]["reviewed_task_ids"] == [target]
        assert _status(board, target) == "review"
        row = board.execute("SELECT assignee FROM tasks WHERE id = ?", (target,)).fetchone()
        assert row["assignee"] == "reviewer"

        # The reviewer completes the review (review -> done): now the node settles.
        _complete(board, target)
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["status"] == "completed"
        assert run["nodes"]["drive"]["outcome"] == "success"
    finally:
        board.close()


def test_route_to_review_leaves_a_non_done_card_untouched(tmp_path: Path) -> None:
    from hermes_workflows.bridge import kanban as kbridge

    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        target = kb.create_task(board, title="busy", created_by="op")  # running
        board.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (target,))
        board.commit()
        # A non-done card must not be reassigned or transitioned (no hijack).
        kbridge.route_to_review(board, target, reviewer="qa")
        row = board.execute(
            "SELECT status, assignee FROM tasks WHERE id = ?", (target,)
        ).fetchone()
        assert row["status"] == "running"
        assert row["assignee"] != "qa"
    finally:
        board.close()


def test_adopt_drives_typed_task_ids_from_upstream_output(tmp_path: Path) -> None:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        t1 = kb.create_task(board, title="one", created_by="op", triage=True)
        t2 = kb.create_task(board, title="two", created_by="op", triage=True)
        eng = _engine(tmp_path, board)
        spec = _spec(tmp_path, _adopt_spec("{{nodes.collect.output.task_ids}}", collect=True))

        run = eng.run(spec, "r")
        collect_card = run["nodes"]["collect"]["hermes_task_id"]
        # The scout node surfaces the chosen ids in its output (free text); the
        # typed channel extracts them by their board-id shape.
        board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (collect_card,))
        board.execute(
            "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
            "VALUES (?, 'done', 'completed', ?, 1, 2)",
            (collect_card, f"scope: drive {t1} and {t2} please"),
        )
        board.commit()

        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["driven_task_ids"] == [t1, t2]
        assert _status(board, t1) == "ready"
        assert _status(board, t2) == "ready"

        # The node gates on ALL driven cards: one done is not enough.
        _complete(board, t1)
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["status"] in ("scheduled", "running")

        _complete(board, t2)
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["status"] == "completed"
        assert run["nodes"]["drive"]["outcome"] == "success"
    finally:
        board.close()


def test_adopt_bounds_a_stuck_card_instead_of_polling_forever(tmp_path: Path) -> None:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        target = kb.create_task(board, title="unspawnable", created_by="op", triage=True)
        eng = _engine(tmp_path, board)
        spec = _spec(tmp_path, _adopt_spec(target))

        run = eng.run(spec, "r")
        assert run["nodes"]["drive"]["status"] == "scheduled"

        # The dispatcher cannot spawn a worker: the card bounces back to ready
        # with a climbing consecutive_failures and never reaches terminal.
        board.execute(
            "UPDATE tasks SET status = 'ready', consecutive_failures = 5 WHERE id = ?",
            (target,),
        )
        board.commit()

        run = eng.advance(spec, "r")
        node = run["nodes"]["drive"]
        # Bounded: the node settles failure loudly instead of polling forever.
        assert node["status"] == "completed"
        assert node["outcome"] == "failure"
        assert "stuck" in (node["output"] or "")
        # And it is surfaced for an operator (notice marker recorded once).
        assert "stuck:drive" in (run.get("notified") or [])
    finally:
        board.close()


def test_adopt_does_not_settle_a_running_card_with_prior_failures(tmp_path: Path) -> None:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        target = kb.create_task(board, title="recovering", created_by="op", triage=True)
        eng = _engine(tmp_path, board)
        spec = _spec(tmp_path, _adopt_spec(target))

        run = eng.run(spec, "r")
        # A worker is actively on the card now (running), even though it failed
        # to spawn a few times earlier: it is making progress, do not kill it.
        board.execute(
            "UPDATE tasks SET status = 'running', consecutive_failures = 9 WHERE id = ?",
            (target,),
        )
        board.commit()

        run = eng.advance(spec, "r")
        node = run["nodes"]["drive"]
        assert node["status"] in ("scheduled", "running")
        assert node.get("outcome") is None
    finally:
        board.close()


def test_adopt_time_boxes_a_blocked_card_instead_of_polling_forever(tmp_path: Path) -> None:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        target = kb.create_task(board, title="will-block", created_by="op", triage=True)
        eng = _engine(tmp_path, board)
        # Time-box to zero so the first blocked observation settles immediately.
        eng.adopt_blocked_timeout_seconds = 0
        spec = _spec(tmp_path, _adopt_spec(target))

        run = eng.run(spec, "r")
        assert run["nodes"]["drive"]["status"] == "scheduled"

        # A worker ran `kanban block` (consecutive_failures stays 0): the card is
        # blocked and never reaches terminal on its own. Without the time-box the
        # node would poll it forever - the silent 15h+ hang this guards against.
        board.execute(
            "UPDATE tasks SET status = 'blocked', consecutive_failures = 0 WHERE id = ?",
            (target,),
        )
        board.commit()

        run = eng.advance(spec, "r")
        node = run["nodes"]["drive"]
        assert node["status"] == "completed"
        assert node["outcome"] == "failure"
        assert "blocked" in (node["output"] or "")
        assert node.get("adopt_blocked_since") is None
    finally:
        board.close()


def test_adopt_keeps_polling_a_blocked_card_within_the_window(tmp_path: Path) -> None:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        target = kb.create_task(board, title="blocked-but-recoverable", created_by="op", triage=True)
        eng = _engine(tmp_path, board)
        eng.adopt_blocked_timeout_seconds = 3600  # generous window: do not settle yet
        spec = _spec(tmp_path, _adopt_spec(target))

        run = eng.run(spec, "r")
        board.execute("UPDATE tasks SET status = 'blocked' WHERE id = ?", (target,))
        board.commit()

        run = eng.advance(spec, "r")
        node = run["nodes"]["drive"]
        # Within the window the node stays active and records when the block began.
        assert node["status"] in ("scheduled", "running")
        assert node.get("outcome") is None
        assert node.get("adopt_blocked_since") is not None
        assert "blocked:drive" in (run.get("notified") or [])
    finally:
        board.close()


def test_adopt_blocked_time_box_accumulates_across_ticks(tmp_path: Path) -> None:
    """The block clock must survive a tick (node state is reloaded from runs.db
    each tick): a non-zero window settles only because `adopt_blocked_since` is
    PERSISTED. If it were dropped on save, every tick would re-stamp now, elapsed
    would stay 0, and the run would hang forever (the bug this guards)."""
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        target = kb.create_task(board, title="long-blocked", created_by="op", triage=True)
        eng = _engine(tmp_path, board)
        eng.adopt_blocked_timeout_seconds = 100  # non-zero: must accumulate, not settle now
        spec = _spec(tmp_path, _adopt_spec(target))

        run = eng.run(spec, "r")
        board.execute("UPDATE tasks SET status = 'blocked' WHERE id = ?", (target,))
        board.commit()

        # Tick 1: records the block start and keeps polling (within the window).
        run = eng.advance(spec, "r")
        node = run["nodes"]["drive"]
        assert node["status"] in ("scheduled", "running")
        assert node.get("adopt_blocked_since") is not None

        # Rewind the PERSISTED start past the window, then reload+advance. The
        # next tick reads the stored timestamp (proving it round-tripped through
        # runs.db) and settles. A dropped field would re-stamp now and never fire.
        loaded = eng._load("r")
        loaded["nodes"]["drive"]["adopt_blocked_since"] = int(time.time()) - 10_000
        eng._save(loaded)

        run = eng.advance(spec, "r")
        node = run["nodes"]["drive"]
        assert node["status"] == "completed"
        assert node["outcome"] == "failure"
        assert "blocked" in (node["output"] or "")
    finally:
        board.close()


def test_adopt_blocked_clock_resets_when_the_card_recovers(tmp_path: Path) -> None:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        target = kb.create_task(board, title="recovers", created_by="op", triage=True)
        eng = _engine(tmp_path, board)
        eng.adopt_blocked_timeout_seconds = 3600
        spec = _spec(tmp_path, _adopt_spec(target))

        run = eng.run(spec, "r")
        board.execute("UPDATE tasks SET status = 'blocked' WHERE id = ?", (target,))
        board.commit()
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"].get("adopt_blocked_since") is not None

        # The card is unblocked and a worker is now on it: the block clock clears
        # so a later block starts a fresh window rather than counting stale time.
        board.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (target,))
        board.commit()
        run = eng.advance(spec, "r")
        node = run["nodes"]["drive"]
        assert node.get("adopt_blocked_since") is None
        assert node["status"] in ("scheduled", "running")
        assert node.get("outcome") is None
    finally:
        board.close()


def _surface_ids(board: sqlite3.Connection, collect_card: str, ids: list[str]) -> None:
    """Make the collect node terminal, surfacing the given task ids in its output."""
    board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (collect_card,))
    board.execute(
        "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
        "VALUES (?, 'done', 'completed', ?, 1, 2)",
        (collect_card, "scope: drive " + " and ".join(ids) + " please"),
    )
    board.commit()


def test_adopt_sequential_drives_cards_one_at_a_time(tmp_path: Path) -> None:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        t1 = kb.create_task(board, title="one", created_by="op", triage=True)
        t2 = kb.create_task(board, title="two", created_by="op", triage=True)
        eng = _engine(tmp_path, board)
        spec = _spec(
            tmp_path,
            _adopt_spec("{{nodes.collect.output.task_ids}}", collect=True, sequential=True),
        )

        run = eng.run(spec, "r")
        _surface_ids(board, run["nodes"]["collect"]["hermes_task_id"], [t1, t2])

        # Sequential: only the FIRST card is promoted into dispatch; the second
        # stays in triage (not promoted) until the first is terminal.
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["driven_task_ids"] == [t1]
        assert _status(board, t1) == "ready"
        assert _status(board, t2) == "triage"

        # First card terminal -> the second is promoted now; the node stays active.
        _complete(board, t1)
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["status"] in ("scheduled", "running")
        assert run["nodes"]["drive"]["driven_task_ids"] == [t2]
        assert _status(board, t2) == "ready"

        # Second (last) card terminal -> the node settles success.
        _complete(board, t2)
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["status"] == "completed"
        assert run["nodes"]["drive"]["outcome"] == "success"
    finally:
        board.close()


def test_adopt_sequential_settles_failure_if_any_card_failed(tmp_path: Path) -> None:
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        t1 = kb.create_task(board, title="one", created_by="op", triage=True)
        t2 = kb.create_task(board, title="two", created_by="op", triage=True)
        eng = _engine(tmp_path, board)
        spec = _spec(
            tmp_path,
            _adopt_spec("{{nodes.collect.output.task_ids}}", collect=True, sequential=True),
        )

        run = eng.run(spec, "r")
        _surface_ids(board, run["nodes"]["collect"]["hermes_task_id"], [t1, t2])
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["driven_task_ids"] == [t1]

        # First card FAILS: the sequence still advances to the second card.
        _complete(board, t1, outcome="failed")
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["status"] in ("scheduled", "running")
        assert run["nodes"]["drive"]["driven_task_ids"] == [t2]

        # Second card succeeds, but the node settles failure because one failed.
        _complete(board, t2)
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["status"] == "completed"
        assert run["nodes"]["drive"]["outcome"] == "failure"
    finally:
        board.close()


def test_adopt_sequential_fails_closed_when_promoting_the_next_card_errors(tmp_path: Path) -> None:
    """If promoting the next sequential card errors (e.g. the card vanished), the
    node settles failure and aborts the run rather than wedging the tick by
    re-raising before the run is saved."""
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        t1 = kb.create_task(board, title="one", created_by="op", triage=True)
        t2 = kb.create_task(board, title="two", created_by="op", triage=True)
        eng = _engine(tmp_path, board)
        spec = _spec(
            tmp_path,
            _adopt_spec("{{nodes.collect.output.task_ids}}", collect=True, sequential=True),
        )

        run = eng.run(spec, "r")
        _surface_ids(board, run["nodes"]["collect"]["hermes_task_id"], [t1, t2])
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["driven_task_ids"] == [t1]

        # The first card is terminal, but the next card disappears before it can
        # be promoted: the adopt call will fail loud.
        _complete(board, t1)
        board.execute("DELETE FROM tasks WHERE id = ?", (t2,))
        board.commit()

        run = eng.advance(spec, "r")
        node = run["nodes"]["drive"]
        assert node["status"] == "completed"
        assert node["outcome"] == "failure"
        assert node.get("abort_run") is True
        assert run["status"] == "failed"
    finally:
        board.close()


def test_adopt_auto_sequences_a_dependency_linked_scope(tmp_path: Path) -> None:
    """When the driven scope has internal dependency links, the engine drives in
    dependency order (prerequisites first) WITHOUT an explicit `sequential` flag,
    so a dependent card is never claimed before its prerequisites are done. A
    parallel adopt would let a worker self-`kanban block` the dependent, and a
    worker block does not auto-clear - the run would then burn the time-box
    (t_a105aff2)."""
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        a = kb.create_task(board, title="prereq A", created_by="op", triage=True)
        b = kb.create_task(board, title="prereq B", created_by="op", triage=True)
        c = kb.create_task(board, title="dependent C", created_by="op", triage=True)
        kb.link_tasks(board, a, c)  # C depends on A
        kb.link_tasks(board, b, c)  # C depends on B
        eng = _engine(tmp_path, board)
        # No `sequential` flag: the default would be parallel, but the internal
        # links flip it to dependency-ordered driving.
        spec = _spec(tmp_path, _adopt_spec("{{nodes.collect.output.task_ids}}", collect=True))

        run = eng.run(spec, "r")
        # Surface ids with the dependent listed FIRST to prove the engine reorders.
        _surface_ids(board, run["nodes"]["collect"]["hermes_task_id"], [c, a, b])

        run = eng.advance(spec, "r")
        # A prerequisite is promoted first; the dependent stays unclaimed.
        assert run["nodes"]["drive"]["driven_task_ids"] == [a]
        assert _status(board, a) == "ready"
        assert _status(board, c) == "triage"

        _complete(board, a)
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["driven_task_ids"] == [b]
        assert _status(board, c) == "triage"

        _complete(board, b)
        run = eng.advance(spec, "r")
        # Both prerequisites done -> the dependent is driven now (no manual unblock).
        assert run["nodes"]["drive"]["driven_task_ids"] == [c]
        assert _status(board, c) == "ready"

        _complete(board, c)
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["status"] == "completed"
        assert run["nodes"]["drive"]["outcome"] == "success"
    finally:
        board.close()


def test_adopt_skips_an_umbrella_parent_and_drives_its_children(tmp_path: Path) -> None:
    """An umbrella/meta card with incomplete children has no leaf work of its own;
    adopting it just self-blocks and burns the time-box. The engine excludes it
    from the driven set and drives its executable children instead (t_4d434dc6)."""
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        epic = kb.create_task(board, title="(meta) portable workflows", created_by="op", triage=True)
        child = kb.create_task(board, title="real implementation", created_by="op", triage=True)
        kb.link_tasks(board, epic, child)  # child depends on the epic (board epic convention)
        eng = _engine(tmp_path, board)
        spec = _spec(tmp_path, _adopt_spec("{{nodes.collect.output.task_ids}}", collect=True))

        run = eng.run(spec, "r")
        _surface_ids(board, run["nodes"]["collect"]["hermes_task_id"], [epic, child])

        run = eng.advance(spec, "r")
        node = run["nodes"]["drive"]
        # The umbrella is skipped; only the executable child is driven.
        assert node["driven_task_ids"] == [child]
        assert _status(board, child) == "ready"
        assert _status(board, epic) == "triage"  # never promoted

        _complete(board, child)
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["status"] == "completed"
        assert run["nodes"]["drive"]["outcome"] == "success"
    finally:
        board.close()


def test_adopt_fails_fast_when_scope_is_only_an_umbrella(tmp_path: Path) -> None:
    """A scope that is ONLY an un-completable umbrella (its executable children are
    not in scope) has nothing to drive: fail the node fast with guidance instead
    of promoting the umbrella and waiting out the 6h time-box (t_4d434dc6)."""
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        epic = kb.create_task(board, title="(meta) umbrella only", created_by="op", triage=True)
        child = kb.create_task(board, title="work not in scope", created_by="op", triage=True)
        kb.link_tasks(board, epic, child)  # epic has an incomplete child -> un-completable leaf
        eng = _engine(tmp_path, board)
        spec = _spec(tmp_path, _adopt_spec(epic))  # adopt the umbrella alone

        run = eng.run(spec, "r")
        node = run["nodes"]["drive"]
        assert node["status"] == "completed"
        assert node["outcome"] == "failure"
        assert node.get("abort_run") is True
        assert "umbrella" in (node["output"] or "").lower()
        assert _status(board, epic) == "triage"  # never promoted
        assert run["status"] == "failed"
    finally:
        board.close()


def test_adopt_scope_features_work_through_the_composite_executor(tmp_path: Path) -> None:
    """In production the scope executor is wrapped in a CompositeExecutor (a
    `direct`/`script` backend is always wired). The umbrella-skip and dependency
    -ordering must reach the Kanban backend THROUGH that wrapper - the engine
    queries them by `getattr`, so the composite has to forward both. This guards
    the prod path the other adopt tests (bare KanbanExecutor) do not exercise."""
    from hermes_workflows.executor import DirectExecutor

    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        epic = kb.create_task(board, title="(meta) umbrella", created_by="op", triage=True)
        c1 = kb.create_task(board, title="prereq child", created_by="op", triage=True)
        c2 = kb.create_task(board, title="dependent child", created_by="op", triage=True)
        kb.link_tasks(board, epic, c1)  # children depend on the epic
        kb.link_tasks(board, epic, c2)
        kb.link_tasks(board, c1, c2)  # and c2 depends on c1
        # Wire a `direct` backend so _executor_for wraps the Kanban scope in a
        # CompositeExecutor, exactly as the real plugin does.
        eng = Engine(
            core_cli=CLI,
            db_path=str(tmp_path / "runs.db"),
            kanban=KanbanExecutor(board),
            direct=DirectExecutor(store_dir=str(tmp_path / "direct")),
        )
        spec = _spec(tmp_path, _adopt_spec("{{nodes.collect.output.task_ids}}", collect=True))

        run = eng.run(spec, "r")
        _surface_ids(board, run["nodes"]["collect"]["hermes_task_id"], [epic, c2, c1])

        run = eng.advance(spec, "r")
        # Umbrella excluded (is_umbrella forwarded) and the remaining children
        # driven in dependency order (scope_links forwarded): c1 before c2.
        assert run["nodes"]["drive"]["driven_task_ids"] == [c1]
        assert _status(board, epic) == "triage"
        assert _status(board, c2) == "triage"

        _complete(board, c1)
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["driven_task_ids"] == [c2]

        _complete(board, c2)
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["status"] == "completed"
        assert run["nodes"]["drive"]["outcome"] == "success"
    finally:
        board.close()


def test_extract_task_ids_block() -> None:
    from hermes_workflows.engine import _extract_task_ids_block

    fenced = "Locked it.\n```task_ids\nt_aaaa\nt_bbbb\n```\nstray t_cccc outside"
    assert _extract_task_ids_block(fenced) == ["t_aaaa", "t_bbbb"]
    assert _extract_task_ids_block("<task_ids>t_aaaa, t_bbbb</task_ids>") == ["t_aaaa", "t_bbbb"]
    # No block -> empty (so the caller falls back / fails closed, not a wrong scrape).
    assert _extract_task_ids_block("just prose with a stray t_cccc") == []
    assert _extract_task_ids_block(None) == []


def test_adopt_drives_ids_from_a_structured_output_block(tmp_path: Path) -> None:
    """The chosen ids come from a structured ```task_ids block in the resolving
    node's OUTPUT, isolated from any stray t_-shaped token elsewhere in its prose -
    so adopt drives exactly the chosen cards, never a leaked/wrong id (t_53be3a7b)."""
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        t1 = kb.create_task(board, title="one", created_by="op", triage=True)
        t2 = kb.create_task(board, title="two", created_by="op", triage=True)
        eng = _engine(tmp_path, board)
        spec = _spec(tmp_path, _adopt_spec("{{nodes.collect.output.task_ids}}", collect=True))

        run = eng.run(spec, "r")
        collect_card = run["nodes"]["collect"]["hermes_task_id"]
        # Output is prose (with a STRAY id that must be ignored) plus the chosen
        # ids in a fenced task_ids block.
        summary = (
            "Locked Scope 1 (CodeGraph quality); ignore the stray id t_99999999.\n"
            f"```task_ids\n{t1}\n{t2}\n```"
        )
        board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (collect_card,))
        board.execute(
            "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
            "VALUES (?, 'done', 'completed', ?, 1, 2)",
            (collect_card, summary),
        )
        board.commit()

        run = eng.advance(spec, "r")
        # Captured from the block - exactly the chosen ids, not the stray one.
        assert run["nodes"]["collect"]["task_ids"] == [t1, t2]
        assert run["nodes"]["drive"]["driven_task_ids"] == [t1, t2]
        assert _status(board, t1) == "ready"
        assert _status(board, t2) == "ready"
    finally:
        board.close()


def test_adopt_zero_ids_aborts_run_instead_of_routing_downstream(tmp_path: Path) -> None:
    """A failed adopt that resolved zero cards hard-stops the run (failed) and never
    falls through to the downstream finish/build node."""
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        eng = _engine(tmp_path, board)
        spec = _spec(tmp_path, _adopt_spec("{{nodes.collect.output.task_ids}}", collect=True))

        run = eng.run(spec, "r")
        # collect finishes with prose containing NO task ids and no typed channel.
        collect_card = run["nodes"]["collect"]["hermes_task_id"]
        board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (collect_card,))
        board.execute(
            "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
            "VALUES (?, 'done', 'completed', ?, 1, 2)",
            (collect_card, "I reviewed everything and it all looks good to me."),
        )
        board.commit()

        run = eng.advance(spec, "r")
        node = run["nodes"]["drive"]
        assert node["outcome"] == "failure"
        assert node.get("abort_run") is True
        # Fail closed: the run failed and the downstream finish node was NOT reached.
        assert run["status"] == "failed"
        assert run["nodes"].get("done", {}).get("status") != "completed"
    finally:
        board.close()

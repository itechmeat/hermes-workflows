"""Adopt mode: an agent_task drives EXISTING board cards (assign + promote into
dispatch, then poll to terminal) instead of creating new ones, including a typed
``{{nodes.<id>.output.task_ids}}`` reference that drives every id an upstream
node surfaced, gating completion on all of them.
"""

from __future__ import annotations

import json
import sqlite3
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

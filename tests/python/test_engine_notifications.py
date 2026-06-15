"""A4 - the engine fires a run-lifecycle notice once per transition into
completed / failed / waiting, delivering to the run's origin or the configured
default, and subscribes a Kanban-backed run's cards to their terminal events.
All effects are fail-open: a delivery error never changes a run outcome.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hermes_workflows.engine import Engine
from hermes_workflows.executor import DirectExecutor, ScriptExecutor

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "core" / "src" / "cli.ts"

DONE_SPEC = {
    "id": "notify-ok",
    "name": "Notify OK",
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
    "id": "notify-fail",
    "name": "Notify Fail",
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


class _Recorder:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    def __call__(self, target: str, message: str) -> None:
        self.sent.append((target, message))


def _spec(tmp_path: Path, obj: dict) -> str:
    path = tmp_path / f"{obj['id']}.workflow.json"
    path.write_text(json.dumps(obj))
    return str(path)


def _engine(tmp_path: Path, *, sender=None, default=None) -> Engine:
    return Engine(
        core_cli=["bun", "run", str(CLI)],
        db_path=str(tmp_path / "runs.db"),
        direct=DirectExecutor(store_dir=tmp_path / "direct"),
        script=ScriptExecutor(store_dir=tmp_path / "scripts", env_allowlist=["PATH"]),
        sender=sender,
        default_deliver=default,
    )


def test_completed_run_delivers_exactly_one_notice(tmp_path: Path) -> None:
    rec = _Recorder()
    eng = _engine(tmp_path, sender=rec, default="fallback:1")
    spec = _spec(tmp_path, DONE_SPEC)

    eng.run(spec, "c-1", origin="telegram:7:3")  # schedules the script
    run = eng.advance(spec, "c-1")  # poll -> complete -> finish
    assert run["status"] == "completed"
    completed = [m for _, m in rec.sent if "completed" in m]
    assert len(completed) == 1
    assert rec.sent[-1][0] == "telegram:7:3"  # delivered to the run origin

    # A second advance on the still-completed run delivers nothing new.
    before = len(rec.sent)
    eng.advance(spec, "c-1")
    assert len(rec.sent) == before


def test_no_origin_falls_back_to_default_target(tmp_path: Path) -> None:
    rec = _Recorder()
    eng = _engine(tmp_path, sender=rec, default="fallback:9")
    spec = _spec(tmp_path, DONE_SPEC)
    eng.run(spec, "c-2")
    eng.advance(spec, "c-2")
    assert any(target == "fallback:9" for target, _ in rec.sent)


def test_failed_run_notifies_failed(tmp_path: Path) -> None:
    rec = _Recorder()
    eng = _engine(tmp_path, sender=rec, default="fallback:1")
    spec = _spec(tmp_path, FAIL_SPEC)
    eng.run(spec, "f-1")
    run = eng.advance(spec, "f-1")
    assert run["status"] == "failed"
    assert any("failed" in m for _, m in rec.sent)


def test_delivery_error_does_not_change_outcome(tmp_path: Path) -> None:
    def boom(_target: str, _message: str) -> None:
        raise RuntimeError("delivery down")

    eng = _engine(tmp_path, sender=boom, default="fallback:1")
    spec = _spec(tmp_path, DONE_SPEC)
    eng.run(spec, "b-1")
    run = eng.advance(spec, "b-1")
    assert run["status"] == "completed"  # fail-open: the run still finished


def test_undelivered_notice_is_retried_not_falsely_marked(tmp_path: Path) -> None:
    # A sender that reports no live target (False, e.g. headless) must not mark
    # the notice done - it is retried on the next advance rather than lost.
    attempts: list[str] = []

    def headless(_target: str, message: str) -> bool:
        attempts.append(message)
        return False  # no live delivery target

    eng = _engine(tmp_path, sender=headless, default="fallback:1")
    spec = _spec(tmp_path, DONE_SPEC)
    eng.run(spec, "h-1")
    eng.advance(spec, "h-1")  # reaches completed; notice attempted, not marked
    first = sum(1 for m in attempts if "completed" in m)
    assert first >= 1
    eng.advance(spec, "h-1")  # retried because it was never marked delivered
    assert sum(1 for m in attempts if "completed" in m) > first


def test_no_sender_means_no_notices_and_no_error(tmp_path: Path) -> None:
    eng = _engine(tmp_path)  # sender=None
    spec = _spec(tmp_path, DONE_SPEC)
    eng.run(spec, "n-1")
    run = eng.advance(spec, "n-1")
    assert run["status"] == "completed"


# --- Kanban subscribe (needs hermes_cli) -----------------------------------

REVIEW_SPEC = {
    "id": "notify-review",
    "name": "Notify Review",
    "version": 1,
    "scope": {"type": "project"},
    "trigger": {"type": "manual"},
    "defaults": {"profile": "p"},
    "nodes": [
        {"id": "work", "type": "agent_task", "prompt": "do"},
        {"id": "review", "type": "human_review"},
        {"id": "done", "type": "finish", "outcome": "success"},
    ],
    "edges": [
        {"from": "work", "to": "review"},
        {"from": "review", "to": "done", "condition": {"type": "review_status", "equals": "approved"}},
    ],
}


def _complete(board, task_id: str, outcome: str = "completed") -> None:
    board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (task_id,))
    board.execute(
        "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
        "VALUES (?, 'done', ?, 'ok', 1, 2)",
        (task_id, outcome),
    )
    board.commit()


def test_waiting_run_notifies_and_subscribes_the_card(tmp_path: Path) -> None:
    # importorskip is scoped to this test so the no-Kanban tests above still run
    # where hermes_cli is absent (the core test venv).
    kb = pytest.importorskip("hermes_cli.kanban_db")
    from hermes_workflows.executor import KanbanExecutor

    rec = _Recorder()
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        eng = Engine(
            core_cli=["bun", "run", str(CLI)],
            db_path=str(tmp_path / "runs.db"),
            kanban=KanbanExecutor(board),
            sender=rec,
            default_deliver="fallback:1",
        )
        spec = _spec(tmp_path, REVIEW_SPEC)

        run = eng.run(spec, "r-1", origin="telegram:8:4")
        work_card = run["nodes"]["work"]["hermes_task_id"]
        # The agent card was subscribed to its terminal events for the run origin.
        subs = kb.list_notify_subs(board, work_card)
        assert len(subs) == 1
        assert subs[0]["platform"] == "telegram"

        _complete(board, work_card)
        run = eng.advance(spec, "r-1")
        assert run["status"] == "waiting"
        # The waiting transition delivers an actionable ACTION NEEDED notice to
        # the origin: it names the gate, how to resolve, and that chat replies do
        # not reach the run.
        review_notices = [(t, m) for t, m in rec.sent if "ACTION NEEDED" in m]
        assert len(review_notices) == 1
        assert review_notices[0][0] == "telegram:8:4"
        message = review_notices[0][1]
        assert "hermes-workflows review" in message
        assert "Reply in this chat" in message

        # Advancing again while still waiting delivers no duplicate.
        before = len(rec.sent)
        eng.advance(spec, "r-1")
        assert len(rec.sent) == before
    finally:
        board.close()


def test_subscribe_cards_opt_out_skips_per_card_subscription(tmp_path: Path) -> None:
    kb = pytest.importorskip("hermes_cli.kanban_db")
    from hermes_workflows.executor import KanbanExecutor

    rec = _Recorder()
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        eng = Engine(
            core_cli=["bun", "run", str(CLI)],
            db_path=str(tmp_path / "runs.db"),
            kanban=KanbanExecutor(board),
            sender=rec,
            default_deliver="fallback:1",
        )
        spec = _spec(tmp_path, {**REVIEW_SPEC, "notifications": {"subscribe_cards": False}})
        run = eng.run(spec, "r-1", origin="telegram:8:4")
        work_card = run["nodes"]["work"]["hermes_task_id"]
        # The opt-out means no per-card subscription is created, even though the
        # run has an origin (run-level lifecycle notices still use it).
        assert kb.list_notify_subs(board, work_card) == []
        assert run.get("origin") == "telegram:8:4"
    finally:
        board.close()


def test_per_node_notify_false_skips_subscription_despite_workflow_default(tmp_path: Path) -> None:
    kb = pytest.importorskip("hermes_cli.kanban_db")
    from hermes_workflows.executor import KanbanExecutor

    rec = _Recorder()
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        eng = Engine(
            core_cli=["bun", "run", str(CLI)],
            db_path=str(tmp_path / "runs.db"),
            kanban=KanbanExecutor(board),
            sender=rec,
            default_deliver="fallback:1",
        )
        # Workflow default is subscribe (unset), but the work node opts OUT.
        spec = _spec(
            tmp_path,
            {
                **REVIEW_SPEC,
                "nodes": [
                    {"id": "work", "type": "agent_task", "prompt": "do", "notify_completion": False},
                    {"id": "review", "type": "human_review"},
                    {"id": "done", "type": "finish", "outcome": "success"},
                ],
            },
        )
        run = eng.run(spec, "r-1", origin="telegram:8:4")
        work_card = run["nodes"]["work"]["hermes_task_id"]
        assert kb.list_notify_subs(board, work_card) == []
    finally:
        board.close()


def test_per_node_notify_true_subscribes_despite_workflow_opt_out(tmp_path: Path) -> None:
    kb = pytest.importorskip("hermes_cli.kanban_db")
    from hermes_workflows.executor import KanbanExecutor

    rec = _Recorder()
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        eng = Engine(
            core_cli=["bun", "run", str(CLI)],
            db_path=str(tmp_path / "runs.db"),
            kanban=KanbanExecutor(board),
            sender=rec,
            default_deliver="fallback:1",
        )
        # Workflow default is OFF, but the work node opts IN.
        spec = _spec(
            tmp_path,
            {
                **REVIEW_SPEC,
                "notifications": {"subscribe_cards": False},
                "nodes": [
                    {"id": "work", "type": "agent_task", "prompt": "do", "notify_completion": True},
                    {"id": "review", "type": "human_review"},
                    {"id": "done", "type": "finish", "outcome": "success"},
                ],
            },
        )
        run = eng.run(spec, "r-1", origin="telegram:8:4")
        work_card = run["nodes"]["work"]["hermes_task_id"]
        assert kb.list_notify_subs(board, work_card) != []
    finally:
        board.close()


def test_blocked_card_delivers_one_attention_notice(tmp_path: Path) -> None:
    kb = pytest.importorskip("hermes_cli.kanban_db")
    from hermes_workflows.executor import KanbanExecutor

    rec = _Recorder()
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        eng = Engine(
            core_cli=["bun", "run", str(CLI)],
            db_path=str(tmp_path / "runs.db"),
            kanban=KanbanExecutor(board),
            sender=rec,
            default_deliver="fallback:1",
        )
        spec = _spec(tmp_path, REVIEW_SPEC)
        run = eng.run(spec, "r-1", origin="telegram:8:4")
        work_card = run["nodes"]["work"]["hermes_task_id"]

        # The underlying card is blocked (e.g. a worker error ran `kanban block`).
        board.execute("UPDATE tasks SET status = 'blocked' WHERE id = ?", (work_card,))
        board.commit()

        run = eng.advance(spec, "r-1")
        # The run stays active (the node is still scheduled/running), not inert.
        assert run["status"] == "running"
        blocked = [m for _t, m in rec.sent if "ATTENTION" in m and "blocked" in m]
        assert len(blocked) == 1
        assert work_card in blocked[0]

        # A second tick while still blocked delivers no duplicate.
        before = len(rec.sent)
        eng.advance(spec, "r-1")
        assert len(rec.sent) == before
    finally:
        board.close()

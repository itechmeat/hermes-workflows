"""Native operator->run channel (t_64a30497): a chat reply that is exactly a
review decision resolves the run paused on that gate, via the pre_gateway_dispatch
hook. Deterministic and language-agnostic — only exact decision tokens count.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hermes_workflows import gate_reply

ROOT = Path(__file__).resolve().parents[2]
CLI = ["bun", "run", str(ROOT / "packages" / "core" / "src" / "cli.ts")]
ROOTS = [str(ROOT / "examples")]
ORIGIN = "telegram:8:4"


class StubEngine:
    def __init__(self, runs: list[dict]) -> None:
        self._runs = runs
        self.calls: list[tuple] = []

    def active_runs(self) -> list[dict]:
        return self._runs

    def decide_review(self, spec, run_id, node_id, decision, note=None):
        self.calls.append((spec, run_id, node_id, decision, note))
        return {}


def _waiting_run(run_id: str = "r1", origin: str = ORIGIN) -> dict:
    return {
        "run_id": run_id,
        "workflow_id": "feature-development",
        "origin": origin,
        "status": "waiting",
        "nodes": {
            "plan": {"status": "completed"},
            "review": {"status": "waiting_for_review"},
        },
    }


def _resolve(text: str, runs: list[dict]):
    engine = StubEngine(runs)
    result = gate_reply.resolve_gate_reply(ORIGIN, text, engine=engine, roots=ROOTS, core_cli=CLI)
    return result, engine


def test_decision_and_note_parsing() -> None:
    assert gate_reply._decision_and_note("approved") == ("approved", None)
    assert gate_reply._decision_and_note("needs_changes fix the lints") == (
        "needs_changes",
        "fix the lints",
    )
    assert gate_reply._decision_and_note("yes please") == (None, None)
    assert gate_reply._decision_and_note("  ") == (None, None)
    # A capitalized decision token is still a decision, not a bare pick: it must
    # not slip past the token check and get auto-approved by _interpret_reply.
    assert gate_reply._decision_and_note("Rejected fix this") == ("rejected", "fix this")
    assert gate_reply._interpret_reply("Rejected fix this") == ("rejected", "fix this")
    assert gate_reply._interpret_reply("NEEDS_CHANGES") == ("needs_changes", None)


def test_reply_resolves_the_single_waiting_gate() -> None:
    result, engine = _resolve("approved ship it", [_waiting_run()])
    assert result is not None and result["action"] == "skip"
    # The operator gets a confirmation back (not a silent resolve).
    assert "approved" in result["reply"] and "r1" in result["reply"]
    assert len(engine.calls) == 1
    spec, run_id, node_id, decision, note = engine.calls[0]
    assert spec.endswith("feature-development.workflow.yaml")
    assert (run_id, node_id, decision, note) == ("r1", "review", "approved", "ship it")


def test_decide_review_error_is_reported_back() -> None:
    class RaisingEngine(StubEngine):
        def decide_review(self, *args, **kwargs):
            super().decide_review(*args, **kwargs)
            raise ValueError("node moved")

    engine = RaisingEngine([_waiting_run()])
    result = gate_reply.resolve_gate_reply("telegram:8:4", "approved", engine=engine, roots=ROOTS, core_cli=CLI)
    assert result is not None and result["action"] == "skip"
    assert "Could not resolve" in result["reply"] and "node moved" in result["reply"]
    assert len(engine.calls) == 1  # the attempt was made


def test_bare_decision_has_no_note() -> None:
    result, engine = _resolve("rejected", [_waiting_run()])
    assert result is not None
    assert engine.calls[0][3:] == ("rejected", None)


def test_interpret_reply() -> None:
    assert gate_reply._interpret_reply("approved ship it") == ("approved", "ship it")
    assert gate_reply._interpret_reply("rejected") == ("rejected", None)
    assert gate_reply._interpret_reply("needs_changes fix lints") == ("needs_changes", "fix lints")
    # A bare pick (number, "scope N", or a name) is approved, text kept as note.
    assert gate_reply._interpret_reply("3") == ("approved", "3")
    assert gate_reply._interpret_reply("scope 3") == ("approved", "scope 3")
    assert gate_reply._interpret_reply("Native Obsidian views") == (
        "approved",
        "Native Obsidian views",
    )
    assert gate_reply._interpret_reply("   ") == (None, None)


def test_bare_pick_resolves_single_gate_as_approved() -> None:
    # The common scope-pick case: a non-decision reply against a uniquely waiting
    # gate resolves it as approved, with the full reply text as the note.
    result, engine = _resolve("3", [_waiting_run()])
    assert result is not None and result["action"] == "skip"
    assert len(engine.calls) == 1
    assert engine.calls[0][3:] == ("approved", "3")


def test_scope_pick_reply_resolves_scope_review_gate() -> None:
    # Acceptance (t_dc40e698): a run waiting on a gate in thread 952, operator
    # replies "3" -> the gate resolves approved with note "3" and the gateway
    # agent does not also process it (action: skip).
    run = _waiting_run(origin="telegram:-C:952")
    engine = StubEngine([run])
    result = gate_reply.resolve_gate_reply(
        "telegram:-C:952", "3", engine=engine, roots=ROOTS, core_cli=CLI
    )
    assert result is not None and result["action"] == "skip"
    assert engine.calls[0][3:] == ("approved", "3")


def test_reply_from_another_chat_is_ignored() -> None:
    result, engine = _resolve("approved", [_waiting_run(origin="telegram:999:1")])
    assert result is None
    assert engine.calls == []


def test_ambiguous_waiting_gates_fall_through() -> None:
    result, engine = _resolve("approved", [_waiting_run("r1"), _waiting_run("r2")])
    assert result is None  # two runs waiting in this chat — do not guess
    assert engine.calls == []


def test_no_waiting_gate_falls_through() -> None:
    running = _waiting_run()
    running["status"] = "running"
    running["nodes"]["review"] = {"status": "scheduled"}
    result, engine = _resolve("approved", [running])
    assert result is None
    assert engine.calls == []


def test_hook_does_not_build_engine_for_empty_or_commands(monkeypatch: pytest.MonkeyPatch) -> None:
    # Empty input and slash-commands never target a gate: a cheap guard skips them
    # before any engine is built. (A genuine reply DOES consult the run state.)
    calls: list[int] = []
    monkeypatch.setattr("hermes_workflows.cli.build_engine", lambda: calls.append(1) or object())

    for text in ("", "   ", "/workflow status"):

        class _Event:
            pass

        event = _Event()
        event.text = text
        event.source = object()
        assert gate_reply.route_chat_reply(event=event) is None
    assert calls == []


def test_hook_returns_none_without_a_source() -> None:
    class _Event:
        text = "approved"
        source = None

    assert gate_reply.route_chat_reply(event=_Event()) is None


def test_hook_sends_confirmation_then_skips(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[tuple] = []
    monkeypatch.setattr(gate_reply, "_send_confirmation", lambda origin, msg: sent.append((origin, msg)))
    monkeypatch.setattr(
        gate_reply,
        "resolve_gate_reply",
        lambda origin, text, **kw: {"action": "skip", "reason": "r", "reply": "Gate done."},
    )
    monkeypatch.setattr("hermes_workflows.cli.build_engine", lambda: object())
    monkeypatch.setattr("hermes_workflows.config.spec_roots", lambda: [])
    monkeypatch.setattr("hermes_workflows.config.core_cli", lambda: [])

    class _Platform:
        value = "telegram"

    class _Src:
        platform = _Platform()
        chat_id = "8"
        thread_id = "4"

    class _Event:
        text = "approved"
        source = _Src()

    result = gate_reply.route_chat_reply(event=_Event(), gateway=object())
    # The reply is sent to the origin, and the directive returned drops the reply key.
    assert result == {"action": "skip", "reason": "r"}
    assert sent == [("telegram:8:4", "Gate done.")]

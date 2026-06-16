"""Route an operator's chat reply to a workflow paused on a human_review gate.

A workflow that parks on a `human_review` gate notifies the run's origin chat
(see engine `_notice_text`). Without this, a reply in that chat is consumed by
the normal gateway agent in a fresh session and never reaches the paused run.

This is the native operator->run channel (t_64a30497, t_dc40e698): a
`pre_gateway_dispatch` hook inspects each inbound message and, when the chat has
exactly one run waiting on a gate, resolves that gate through the same
`decide_review` path the CLI/tool/dashboard use, then returns
``{"action": "skip"}`` so the gateway agent does not also process the reply.

Reply contract, anchored on a UNIQUELY waiting gate so the common scope-pick case
works without forcing the operator to learn a keyword:
  - an explicit decision token (`approved` / `rejected` / `needs_changes`) is
    honoured, with any trailing text kept as the operator note;
  - ANY other non-empty reply is taken as the operator's pick - approved, with
    the full reply text carried as the note (`{{nodes.<gate>.review_note}}`), so
    "3", "scope 3", or a scope name resolve the `scope-review` gate as the
    propose-scopes message instructs.
Ambiguity (no waiting gate, or more than one in the chat) falls through to normal
dispatch rather than guessing. Empty messages and slash-commands are cheap-skipped
(they never target a gate), so only a genuine reply consults the run state.
"""

from __future__ import annotations

from typing import Any, Optional, Tuple

from .engine import REVIEW_OPTIONS
from .origin_capture import build_origin


def _decision_and_note(text: str) -> Tuple[Optional[str], Optional[str]]:
    """Split a reply into an exact decision token and an optional trailing note.
    Returns ``(None, None)`` when the first token is not a review decision."""
    parts = (text or "").strip().split(None, 1)
    if not parts:
        return None, None
    token = parts[0].lower()
    if token not in REVIEW_OPTIONS:
        return None, None
    note = parts[1].strip() if len(parts) > 1 else None
    return token, (note or None)


def _interpret_reply(text: str) -> Tuple[Optional[str], Optional[str]]:
    """Interpret a reply that targets a UNIQUELY waiting gate. An explicit
    decision token is honoured with any trailing text as the note; any other
    non-empty reply is the operator's pick - approved, with the full reply text
    as the note (so "3" / "scope 3" / a scope name resolve a scope-review gate).
    Returns ``(None, None)`` only for empty text."""
    stripped = (text or "").strip()
    if not stripped:
        return None, None
    decision, note = _decision_and_note(stripped)
    if decision is not None:
        return decision, note
    return "approved", stripped


def _waiting_gate(run: dict) -> Optional[str]:
    """The id of the run's node awaiting a review decision, if any."""
    if run.get("status") != "waiting":
        return None
    for node_id, node in run.get("nodes", {}).items():
        if node.get("status") == "waiting_for_review" and node.get("review_decision") is None:
            return node_id
    return None


def resolve_gate_reply(
    origin: Optional[str],
    text: str,
    *,
    engine: Any,
    roots,
    core_cli,
) -> Optional[dict]:
    """Resolve a chat reply against a run waiting on a gate. Returns a
    ``pre_gateway_dispatch`` skip directive when it resolved one, else ``None``
    (not a decision, no origin, or an ambiguous/absent waiting gate)."""
    if not origin or not (text or "").strip():
        return None

    from . import tools

    candidates = [
        (run, gate)
        for run in engine.active_runs()
        if run.get("origin") == origin
        for gate in (_waiting_gate(run),)
        if gate is not None
    ]
    if len(candidates) != 1:
        return None  # nothing waiting here, or ambiguous — let normal dispatch run

    run, node_id = candidates[0]
    # A run is uniquely waiting in this chat: interpret the reply as a gate reply
    # (an explicit decision, or otherwise the operator's pick approved with the
    # reply text as the note).
    decision, note = _interpret_reply(text)
    if decision is None:
        return None
    run_id = run["run_id"]
    try:
        # Resolve inside the guard: a spec-lookup failure must surface as a gate
        # error reply (and still skip), not fall through to the gateway agent.
        spec_path = tools._resolve_spec_path(run["workflow_id"], roots, core_cli)
        engine.decide_review(spec_path, run_id, node_id, decision, note=note)
    except Exception as exc:  # noqa: BLE001 - report the failure to the operator
        # Still skip (the message was a gate reply, not chatter for the agent),
        # but tell the operator it did not take rather than resolving silently.
        return {
            "action": "skip",
            "reason": f"gate resolution failed for {run_id}",
            "reply": f"Could not resolve gate '{node_id}' of run {run_id}: {exc}",
        }
    return {
        "action": "skip",
        "reason": f"resolved gate {node_id} of {run_id} as {decision}",
        "reply": f"Gate '{node_id}' of run {run_id} resolved as {decision}.",
    }


def _send_confirmation(origin: str, message: str) -> None:
    """Deliver a confirmation/error line back to the operator's chat through the
    native delivery router (the same path run-lifecycle notices use). Fail-open:
    a delivery error never affects dispatch."""
    try:
        from .notify_sender import make_sender

        make_sender()(origin, message)
    except Exception:  # noqa: BLE001 - confirmation is best-effort
        pass


def route_chat_reply(
    event: Any = None, gateway: Any = None, session_store: Any = None, **_kwargs: Any
) -> Optional[dict]:
    """``pre_gateway_dispatch`` hook: forward an operator's reply to a paused run.
    Cheap-skips empty messages and slash-commands (they never target a gate); any
    other reply consults the run state and resolves only when exactly one gate is
    waiting in this chat. Never raises into dispatch."""
    try:
        text = getattr(event, "text", "") or ""
        stripped = text.strip()
        # Cheap guards: empty input and slash-commands are never a gate reply, so
        # they never build an engine. Everything else consults the run state.
        if not stripped or stripped.startswith("/"):
            return None
        origin = build_origin(getattr(event, "source", None))
        if origin is None:
            return None
        from . import config
        from .cli import build_engine

        result = resolve_gate_reply(
            origin,
            text,
            engine=build_engine(),
            roots=config.spec_roots(),
            core_cli=config.core_cli(),
        )
        if result is None:
            return None
        # Always confirm back so the operator knows the gate resolved (or why it
        # did not) — otherwise `skip` would swallow the reply with no feedback.
        reply = result.pop("reply", None)
        if reply:
            _send_confirmation(origin, reply)
        return result
    except Exception:  # noqa: BLE001 - a routing failure must never break dispatch
        return None

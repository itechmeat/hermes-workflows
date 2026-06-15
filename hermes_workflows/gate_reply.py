"""Route an operator's chat reply to a workflow paused on a human_review gate.

A workflow that parks on a `human_review` gate notifies the run's origin chat
(see engine `_notice_text`). Without this, a reply in that chat is consumed by
the normal gateway agent in a fresh session and never reaches the paused run.

This is the native operator->run channel (t_64a30497): a `pre_gateway_dispatch`
hook inspects each inbound message and, when it is exactly a review decision and
the chat has exactly one run waiting on a gate, resolves that gate through the
same `decide_review` path the CLI/tool/dashboard use, then returns
``{"action": "skip"}`` so the gateway agent does not also process the reply.

Deterministic and language-agnostic on purpose: only the exact decision enum
tokens (`approved` / `rejected` / `needs_changes`) are accepted — never NL
guesses like "yes" or "1" — with any trailing text kept as the operator note
(`{{nodes.<gate>.review_note}}`). Ambiguity (no waiting gate, or more than one in
the chat) falls through to normal dispatch rather than guessing.
"""

from __future__ import annotations

from typing import Any, Optional, Tuple

from .engine import REVIEW_OPTIONS
from .origin_capture import build_origin


def _decision_and_note(text: str) -> Tuple[Optional[str], Optional[str]]:
    """Split a reply into an exact decision token and an optional trailing note.
    Returns ``(None, None)`` when the first token is not a review decision."""
    parts = (text or "").strip().split(None, 1)
    if not parts or parts[0] not in REVIEW_OPTIONS:
        return None, None
    note = parts[1].strip() if len(parts) > 1 else None
    return parts[0], (note or None)


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
    if not origin:
        return None
    decision, note = _decision_and_note(text)
    if decision is None:
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
    spec_path = tools._resolve_spec_path(run["workflow_id"], roots, core_cli)
    engine.decide_review(spec_path, run["run_id"], node_id, decision, note=note)
    return {
        "action": "skip",
        "reason": f"resolved gate {node_id} of {run['run_id']} as {decision}",
    }


def route_chat_reply(
    event: Any = None, gateway: Any = None, session_store: Any = None, **_kwargs: Any
) -> Optional[dict]:
    """``pre_gateway_dispatch`` hook: forward an operator's decision reply to a
    paused run. Fast-paths out unless the message is exactly a decision token, so
    ordinary chatter never builds an engine. Never raises into dispatch."""
    try:
        text = getattr(event, "text", "") or ""
        if _decision_and_note(text)[0] is None:
            return None  # cheap guard: not a decision, do nothing
        origin = build_origin(getattr(event, "source", None))
        if origin is None:
            return None
        from . import config
        from .cli import build_engine

        return resolve_gate_reply(
            origin,
            text,
            engine=build_engine(),
            roots=config.spec_roots(),
            core_cli=config.core_cli(),
        )
    except Exception:  # noqa: BLE001 - a routing failure must never break dispatch
        return None

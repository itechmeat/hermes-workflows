"""Channel-agnostic notifications.

A workflow is one of many channels; nothing here names a platform. Two paths:

* Kanban-backed nodes (human_review, completion) subscribe the originating chat
  to the card's terminal-state events via the native notifier (``bridge/notify``).
* Run lifecycle events (completed / failed) deliver to the run's captured
  ``origin`` when present, else to a configured default target. The ``origin``
  and target are opaque strings shaped ``<platform>:<chat>[:<thread>]`` — Hermes'
  native delivery interprets them; we never branch on the platform.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Callable, Optional, Tuple

from .bridge import notify

# A function that hands (target, message) to Hermes' native delivery. It returns
# whether the message was dispatched to a live target: ``True`` delivered,
# ``False`` no live target (e.g. headless, no in-process gateway), ``None``
# unknown (a sender that does not report). The engine only records a notice as
# delivered when this is not ``False``, so a headless no-op is retried rather
# than falsely marked done.
Sender = Callable[[str, str], Optional[bool]]

# The Hermes ``[SILENT]`` convention: an agent/result output carrying this marker
# suppresses delivery (no notification spam). Case-sensitive, matching the host.
SILENT_MARKER = "[SILENT]"


@dataclass
class Notification:
    run_id: str
    event: str
    target: str
    text: str
    delivered: Optional[bool] = None


def is_silenced(text: Optional[str]) -> bool:
    """Whether a message carries the ``[SILENT]`` marker and must not be sent."""
    return SILENT_MARKER in (text or "")


def resolve_target(
    origin: Optional[str], default: Optional[str], deliver: Optional[str] = None
) -> Optional[str]:
    """The delivery target. A workflow-declared ``deliver`` other than the
    literal ``"origin"`` wins (the workflow says exactly where its result goes);
    ``"origin"`` or an unset ``deliver`` keeps the run's origin, else the
    configured default. ``None`` means there is nowhere to deliver (stay silent)."""
    if deliver and deliver != "origin":
        return deliver
    return origin or default


def parse_origin(origin: str) -> Optional[Tuple[str, str, Optional[str]]]:
    """Split an opaque ``<platform>:<chat>[:<thread>]`` origin. Returns ``None``
    when it lacks at least a platform and a chat."""
    parts = origin.split(":")
    if len(parts) < 2 or not parts[0] or not parts[1]:
        return None
    thread = parts[2] if len(parts) > 2 and parts[2] else None
    return parts[0], parts[1], thread


def subscribe_task(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    origin: Optional[str],
    notifier_profile: Optional[str] = None,
) -> bool:
    """Subscribe a Kanban-backed node's origin to its card terminal events.
    Returns False (no-op) when there is no parseable origin."""
    if not origin:
        return False
    parsed = parse_origin(origin)
    if parsed is None:
        return False
    platform, chat_id, thread_id = parsed
    notify.subscribe_completion(
        conn,
        task_id=task_id,
        platform=platform,
        chat_id=chat_id,
        thread_id=thread_id,
        notifier_profile=notifier_profile,
    )
    return True


def notify_run(
    *,
    run_id: str,
    event: str,
    send: Sender,
    origin: Optional[str] = None,
    default: Optional[str] = None,
    deliver: Optional[str] = None,
    text: Optional[str] = None,
) -> Optional[Notification]:
    """Deliver a run-lifecycle notice to the resolved target. Returns the
    Notification, or ``None`` when there is no target (delivered nowhere)."""
    target = resolve_target(origin, default, deliver)
    if target is None:
        return None
    note = Notification(
        run_id=run_id,
        event=event,
        target=target,
        text=text or f"Workflow run {run_id}: {event}",
    )
    note.delivered = send(note.target, note.text)
    return note

"""Observer hook callbacks for kanban worker processes.

The dispatcher spawns each card's worker with ``HERMES_KANBAN_TASK=<card id>``
in its environment; that card id equals ``NodeRunState.hermes_task_id`` and is
the node-correlation join. The ``task_id`` kwarg the host passes to tool/API
hooks is a per-conversation UUID on current hosts, so it is deliberately not
used for the join (it is opaque per the observer contract anyway).

Registration is gated on that env var, so gateway and interactive CLI sessions
register nothing and pay nothing — only hooks we consume are registered, in the
spirit of the host's ``has_hook()`` cheap-path rule. ``api_request_error`` is
part of the hermes.observer.v1 contract and does not fire on v0.15.x hosts;
registering it there logs one "unknown hook" warning and starts capturing
structured provider errors the moment the host upgrades.

Every callback accepts ``**kwargs`` (additive host fields stay compatible) and
delegates to the fail-open ``NodeTelemetryRecorder`` — a telemetry bug can
suppress telemetry, never break the worker.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional

from .telemetry import NodeTelemetryRecorder

_recorder: Optional[NodeTelemetryRecorder] = None


def _telemetry_root() -> Path:
    """Indirection point for tests; production resolves via config."""
    from . import config

    return config.telemetry_dir()


def register_observer_hooks(ctx: Any) -> None:
    """Register the consumed observer hooks — only inside a kanban worker
    process (the ``HERMES_KANBAN_TASK`` gate) and only when the host context
    exposes ``register_hook``. Fail-open: never raises."""
    global _recorder
    try:
        task_id = os.environ.get("HERMES_KANBAN_TASK")
        if not task_id:
            return
        register_hook = getattr(ctx, "register_hook", None)
        if not callable(register_hook):
            return
        _recorder = NodeTelemetryRecorder(_telemetry_root(), task_id)
        register_hook("post_api_request", _on_post_api_request)
        register_hook("api_request_error", _on_api_request_error)
        register_hook("post_tool_call", _on_post_tool_call)
        register_hook("subagent_stop", _on_subagent_stop)
        register_hook("pre_approval_request", _on_pre_approval_request)
        register_hook("post_approval_response", _on_post_approval_response)
    except Exception:
        _recorder = None


def _on_post_api_request(**kwargs: Any) -> None:
    if _recorder is not None:
        _recorder.record_api_request(
            usage=kwargs.get("usage"), api_duration=kwargs.get("api_duration")
        )


def _on_api_request_error(**kwargs: Any) -> None:
    if _recorder is not None:
        _recorder.record_api_error(error=kwargs.get("error"))


def _on_post_tool_call(**kwargs: Any) -> None:
    if _recorder is not None:
        _recorder.record_tool_call(
            status=kwargs.get("status"),
            error_type=kwargs.get("error_type"),
            error_message=kwargs.get("error_message"),
        )


def _on_subagent_stop(**kwargs: Any) -> None:
    if _recorder is not None:
        _recorder.record_subagent()


def _on_pre_approval_request(**kwargs: Any) -> None:
    """The worker is now blocked on a dangerous-command approval prompt; the
    run inspector shows the pending annotation while the node stays active."""
    if _recorder is not None:
        _recorder.record_approval_request(
            command=kwargs.get("command"),
            description=kwargs.get("description"),
            surface=kwargs.get("surface"),
            session_key=kwargs.get("session_key"),
        )


def _on_post_approval_response(**kwargs: Any) -> None:
    """The approval was answered or timed out; a deny/timeout choice persists
    so a subsequent node failure has context."""
    if _recorder is not None:
        _recorder.record_approval_response(choice=kwargs.get("choice"))

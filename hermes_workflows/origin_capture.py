"""Capture a run's chat origin from the ``pre_gateway_dispatch`` hook.

A model-started run learns its chat origin nowhere else: ``registry.dispatch``
hands tool handlers only ``task_id`` / ``user_task``, never the ``SessionSource``.
So the hook (which *does* receive the source) records it, keyed by the gateway
session key, and the ``workflow_run`` tool reads it back by ``task_id`` — which
is the session key on the gateway turn that issued the call. A miss (dashboard /
CLI / headless, or a key mismatch) yields no origin, and run-lifecycle delivery
falls back to the configured default target — a documented degradation, not a
leftover.

The hook also stashes the live gateway in ``runtime`` so the Sender can reach
its delivery router. It never alters dispatch (always returns ``None``).
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Any, Optional

from . import runtime

# session key -> opaque origin string (<platform>:<chat>[:<thread>]). Bounded so
# the long-lived gateway process never accumulates entries without limit; the
# oldest is evicted past the cap (a re-captured session simply re-inserts).
_MAX_ORIGINS = 2048
_origins: "OrderedDict[str, str]" = OrderedDict()


def reset() -> None:
    """Clear captured state (tests)."""
    _origins.clear()


def build_origin(source: Any) -> Optional[str]:
    """Shape a SessionSource into ``<platform>:<chat>[:<thread>]``; ``None`` when
    it lacks a platform or chat (nothing to deliver to)."""
    if source is None:
        return None
    platform = getattr(source, "platform", None)
    platform = getattr(platform, "value", platform)  # Platform enum -> its value
    chat = getattr(source, "chat_id", None)
    thread = getattr(source, "thread_id", None)
    if not platform or not chat:
        return None
    base = f"{platform}:{chat}"
    return f"{base}:{thread}" if thread else base


def _session_key(gateway: Any, session_store: Any, source: Any) -> Optional[str]:
    """Derive the gateway session key the same way the gateway does, so the
    tool's ``task_id`` correlates to what we stash."""
    for obj in (gateway, session_store):
        if obj is None:
            continue
        for method in ("_session_key_for_source", "_generate_session_key"):
            fn = getattr(obj, method, None)
            if fn is None:
                continue
            try:
                key = fn(source)
            except Exception:  # noqa: BLE001 - never let key derivation break dispatch
                continue
            if key:
                return str(key)
    return None


def origin_for(task_id: Optional[str]) -> Optional[str]:
    """The origin captured for this turn's session, or ``None``."""
    if not task_id:
        return None
    return _origins.get(task_id)


def capture_origin(
    event: Any = None, gateway: Any = None, session_store: Any = None, **_kwargs: Any
) -> None:
    """``pre_gateway_dispatch`` hook: record the session source and the live
    gateway, then return ``None`` so dispatch proceeds unchanged."""
    try:
        if gateway is not None:
            runtime.set_gateway(gateway)
        source = getattr(event, "source", None)
        origin = build_origin(source)
        if origin is None:
            return None
        key = _session_key(gateway, session_store, source)
        if key:
            _origins[key] = origin
            _origins.move_to_end(key)
            while len(_origins) > _MAX_ORIGINS:
                _origins.popitem(last=False)
    except Exception:  # noqa: BLE001 - a capture failure must never affect dispatch
        pass
    return None

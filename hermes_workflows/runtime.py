"""Process-local handle to the live Hermes gateway.

The ``pre_gateway_dispatch`` hook stashes the gateway here so the in-process
``Sender`` can reach ``gateway.delivery_router`` to deliver run-lifecycle
notices. It is ``None`` in headless contexts (notably the cron-tick subprocess,
which has no live gateway), where direct delivery degrades to a no-op and the
durable loop is closed instead by the native Kanban notifier.
"""

from __future__ import annotations

from typing import Any, Optional

_gateway: Optional[Any] = None


def set_gateway(gateway_obj: Any) -> None:
    """Record the live gateway (called by the pre_gateway_dispatch hook)."""
    global _gateway
    _gateway = gateway_obj


def gateway() -> Optional[Any]:
    """The live gateway, or ``None`` when not running in-process."""
    return _gateway

"""A ``Sender`` adapter over Hermes' native delivery (``gateway/delivery.py``).

The engine fires run-lifecycle notices through a ``Sender`` (``(target,
message) -> None``); this builds one that parses the target with
``DeliveryTarget`` and delivers via the gateway's ``DeliveryRouter``. We never
write a delivery path of our own.

Two reuse facts shape the design:
  * The router is reachable only in-process, as ``gateway.delivery_router`` on
    the live gateway the pre_gateway_dispatch hook stashed (``runtime``). In a
    headless context (the cron-tick subprocess) there is no gateway, so the
    Sender is a no-op there and the durable loop is closed by the native Kanban
    notifier instead.
  * ``DeliveryRouter.deliver`` is async; the Sender bridges it to the engine's
    synchronous advance loop and isolates every failure (a delivery error must
    never fail a run).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Optional

from .notifications import Sender

logger = logging.getLogger("hermes-workflows.notify_sender")

# Holds references to in-flight fire-and-forget delivery tasks so the event loop
# does not garbage-collect them mid-flight, and so their exceptions are observed
# (a bare create_task can be GC'd before completion and its error swallowed).
_INFLIGHT: set = set()


def _on_delivery_done(task: Any) -> None:
    _INFLIGHT.discard(task)
    try:
        exc = task.exception()
    except Exception:  # noqa: BLE001 - cancelled / already-consumed
        return
    if exc is not None:
        logger.warning("background delivery failed: %s", exc)


def _default_router_provider() -> Optional[Any]:
    """The live gateway's delivery router, or ``None`` when headless."""
    from . import runtime

    gateway_obj = runtime.gateway()
    return getattr(gateway_obj, "delivery_router", None) if gateway_obj is not None else None


def _run_coro(coro: Any) -> None:
    """Drive a delivery coroutine to completion from a sync caller. With a
    running loop (gateway thread) the coroutine is scheduled fire-and-forget;
    otherwise it runs to completion on a throwaway loop."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        task = loop.create_task(coro)
        _INFLIGHT.add(task)
        task.add_done_callback(_on_delivery_done)
    else:
        asyncio.run(coro)


def make_sender(
    *,
    router_provider: Callable[[], Optional[Any]] = _default_router_provider,
    coro_runner: Callable[[Any], None] = _run_coro,
) -> Sender:
    """Build a failure-isolated ``Sender``. ``router_provider`` and
    ``coro_runner`` are injectable for tests; production resolves the router
    from the in-process gateway and bridges the async delivery itself."""

    def send(target: str, message: str) -> bool:
        """Return True when the message was dispatched to a live target, False
        when there was no router (headless) or delivery raised - the engine uses
        this to retry rather than falsely mark an undelivered notice done."""
        try:
            router = router_provider()
            if router is None:
                logger.debug("no delivery router; skipping notice to %s", target)
                return False
            from gateway.delivery import DeliveryTarget

            coro_runner(router.deliver(message, [DeliveryTarget.parse(target)]))
            return True
        except Exception as exc:  # noqa: BLE001 - fail-open: a notice never fails a run
            logger.warning("delivery to %s failed: %s", target, exc)
            return False

    return send

"""A3 - a Sender over Hermes' native delivery: parse the target via
gateway.delivery.DeliveryTarget and deliver via a DeliveryRouter resolved from
the in-process gateway. Failure-isolated (never raises) and a no-op when no
router is available (headless). Skipped where gateway.delivery is absent.
"""

from __future__ import annotations

import pytest

pytest.importorskip("gateway.delivery")

from hermes_workflows import notify_sender


class _StubRouter:
    def __init__(self, raises: bool = False) -> None:
        self.calls: list[tuple[str, list]] = []
        self.raises = raises

    async def deliver(self, content, targets, **_kwargs):
        if self.raises:
            raise RuntimeError("delivery exploded")
        self.calls.append((content, targets))
        return {"ok": True}


def test_valid_target_delivers_through_the_router() -> None:
    router = _StubRouter()
    send = notify_sender.make_sender(router_provider=lambda: router)
    assert send("telegram:99:7", "run complete") is True  # reports delivery

    assert len(router.calls) == 1
    content, targets = router.calls[0]
    assert content == "run complete"
    # The target string was parsed into a DeliveryTarget for the platform/chat/thread.
    assert targets[0].chat_id == "99"
    assert targets[0].thread_id == "7"


def test_no_router_is_a_silent_noop() -> None:
    send = notify_sender.make_sender(router_provider=lambda: None)
    # Must not raise when delivery is unavailable (e.g. headless cron tick), and
    # reports False so the engine retries rather than marking the notice done.
    assert send("telegram:99:7", "run complete") is False


def test_router_error_is_swallowed() -> None:
    router = _StubRouter(raises=True)
    send = notify_sender.make_sender(router_provider=lambda: router)
    # A delivery error never propagates — a notice must never fail a run — and
    # reports False (not delivered).
    assert send("telegram:99:7", "run complete") is False


def test_target_parsing_covers_origin_local_and_platform_forms() -> None:
    from gateway.config import Platform
    from gateway.delivery import DeliveryTarget

    assert DeliveryTarget.parse("local").platform == Platform.LOCAL
    explicit = DeliveryTarget.parse("telegram:42:3")
    assert explicit.platform == Platform.TELEGRAM
    assert explicit.chat_id == "42"
    assert explicit.thread_id == "3"
    # "origin" with no source falls back to local (is_origin flagged).
    assert DeliveryTarget.parse("origin").is_origin is True

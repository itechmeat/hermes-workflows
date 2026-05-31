"""A2 - capture a run's chat origin from the pre_gateway_dispatch hook.

Tool handlers never receive the SessionSource (only task_id / user_task), so a
hook records the session's source, keyed by the gateway session key, and the
workflow_run tool reads it back by the task_id (= session key in the gateway).
The hook must never alter dispatch (always returns None).
"""

from __future__ import annotations

from hermes_workflows import origin_capture


class _Platform:
    def __init__(self, value: str) -> None:
        self.value = value


class _Source:
    def __init__(self, platform: str, chat_id, thread_id=None) -> None:
        self.platform = _Platform(platform)
        self.chat_id = chat_id
        self.thread_id = thread_id


class _Event:
    def __init__(self, source) -> None:
        self.source = source


class _Gateway:
    def __init__(self, key: str) -> None:
        self.key = key
        self.delivery_router = object()

    def _session_key_for_source(self, source):
        return self.key


def setup_function() -> None:
    origin_capture.reset()


def test_build_origin_shapes_platform_chat_thread() -> None:
    assert origin_capture.build_origin(_Source("telegram", "1", "2")) == "telegram:1:2"
    assert origin_capture.build_origin(_Source("telegram", "1")) == "telegram:1"
    # Missing chat or platform -> no origin (nothing to deliver to).
    assert origin_capture.build_origin(_Source("telegram", None)) is None
    assert origin_capture.build_origin(None) is None


def test_hook_captures_origin_keyed_by_session_and_returns_none() -> None:
    gateway = _Gateway("agent:main:telegram:supergroup:1:2")
    result = origin_capture.capture_origin(
        event=_Event(_Source("telegram", "1", "2")), gateway=gateway, session_store=None
    )
    # Never alters dispatch.
    assert result is None
    # The tool, given the same key as task_id, reads the captured origin.
    assert origin_capture.origin_for("agent:main:telegram:supergroup:1:2") == "telegram:1:2"


def test_unknown_key_and_no_source_yield_no_origin() -> None:
    assert origin_capture.origin_for("never-seen") is None
    # An event with no usable source captures nothing but still returns None.
    assert (
        origin_capture.capture_origin(event=_Event(_Source("telegram", None)), gateway=_Gateway("k"))
        is None
    )
    assert origin_capture.origin_for("k") is None


def test_hook_stashes_the_gateway_for_the_sender() -> None:
    from hermes_workflows import runtime

    gateway = _Gateway("k2")
    origin_capture.capture_origin(event=_Event(_Source("telegram", "9")), gateway=gateway)
    assert runtime.gateway() is gateway

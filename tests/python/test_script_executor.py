"""S4 — ScriptExecutor: run a script node's command locally (no LLM) in its
workdir with a restricted environment and a timeout, capturing + redacting
stdout/stderr, and persist the completion under an idempotent ``script:`` handle
(reusing the DirectExecutor file-backed store layout).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hermes_workflows.executor import Completion
from hermes_workflows.executor.script_executor import ScriptExecutor


def _executor(tmp_path: Path, *, allowlist=None, timeout: float = 10.0) -> ScriptExecutor:
    return ScriptExecutor(
        store_dir=tmp_path / "scripts",
        env_allowlist=list(allowlist or ["PATH"]),
        timeout_seconds=timeout,
    )


def _schedule(ex: ScriptExecutor, params: dict, **kw) -> str:
    return ex.schedule(run_id="run-1", node_id="lint", workflow_id="wf", params=params, **kw)


def test_passing_command_settles_success_with_stdout(tmp_path) -> None:
    ex = _executor(tmp_path)
    handle = _schedule(ex, {"command": "echo hello", "workdir": str(tmp_path)})
    completion = ex.poll(handle)
    assert isinstance(completion, Completion)
    assert completion.settled is True
    assert completion.outcome == "success"
    assert "hello" in (completion.output or "")


def test_failing_command_settles_failure_with_stderr(tmp_path) -> None:
    ex = _executor(tmp_path)
    handle = _schedule(ex, {"command": "echo boom >&2; exit 2", "workdir": str(tmp_path)})
    completion = ex.poll(handle)
    assert completion.settled is True
    assert completion.outcome == "failure"
    assert "boom" in (completion.output or "")


def test_hanging_command_times_out_to_failure(tmp_path) -> None:
    ex = _executor(tmp_path, timeout=0.3)
    handle = _schedule(ex, {"command": "sleep 5", "workdir": str(tmp_path)})
    completion = ex.poll(handle)
    assert completion.settled is True
    assert completion.outcome == "failure"


def test_per_node_timeout_overrides_the_default(tmp_path) -> None:
    ex = _executor(tmp_path, timeout=30.0)
    handle = _schedule(ex, {"command": "sleep 5", "workdir": str(tmp_path), "timeout_seconds": 0.3})
    completion = ex.poll(handle)
    assert completion.outcome == "failure"


def test_command_runs_in_its_workdir(tmp_path) -> None:
    work = tmp_path / "proj"
    work.mkdir()
    (work / "marker.txt").write_text("x")
    ex = _executor(tmp_path)
    handle = _schedule(ex, {"command": "ls", "workdir": str(work)})
    assert "marker.txt" in (ex.poll(handle).output or "")


def test_only_allowlisted_env_is_visible(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("WF_ALLOWED", "yes")
    monkeypatch.setenv("WF_SECRET", "nope")
    ex = _executor(tmp_path, allowlist=["WF_ALLOWED", "PATH"])
    # The node requests both, but only WF_ALLOWED is permitted by the settings
    # allowlist; WF_SECRET must not reach the command.
    handle = _schedule(
        ex,
        {
            "command": "echo A=${WF_ALLOWED:-_} S=${WF_SECRET:-_}",
            "workdir": str(tmp_path),
            "env": ["WF_ALLOWED", "WF_SECRET"],
        },
    )
    out = ex.poll(handle).output or ""
    assert "A=yes" in out
    assert "S=_" in out
    assert "nope" not in out


def test_home_is_always_provided_for_credential_clis(tmp_path, monkeypatch) -> None:
    # HOME-credential CLIs (claude, codex, gh, ...) need HOME to find ~/.config,
    # ~/.claude, etc. It is provided even when not in the allowlist.
    monkeypatch.setenv("HOME", "/home/login-user")
    ex = _executor(tmp_path, allowlist=["PATH"])  # HOME deliberately not listed
    handle = _schedule(ex, {"command": "echo HOME=$HOME", "workdir": str(tmp_path)})
    out = ex.poll(handle).output or ""
    assert "HOME=/home/login-user" in out


def test_secret_shaped_output_is_redacted(tmp_path) -> None:
    ex = _executor(tmp_path)
    token = "sk-ABCDEFGHIJKLMNOP0123456789"
    handle = _schedule(ex, {"command": f"echo {token}", "workdir": str(tmp_path)})
    out = ex.poll(handle).output or ""
    assert "[REDACTED]" in out
    assert token not in out


def test_handle_is_prefixed_and_round_trips(tmp_path) -> None:
    ex = _executor(tmp_path)
    handle = _schedule(ex, {"command": "echo ok", "workdir": str(tmp_path)})
    assert handle.startswith("script:")
    again = _schedule(ex, {"command": "echo ok", "workdir": str(tmp_path)})
    looped = _schedule(ex, {"command": "echo ok", "workdir": str(tmp_path)}, iteration=1)
    assert handle == again
    assert looped != handle
    assert ex.poll(handle).outcome == "success"


def test_poll_unknown_handle_is_not_settled(tmp_path) -> None:
    ex = _executor(tmp_path)
    completion = ex.poll("script:run-1:lint:0")
    assert completion.settled is False
    assert completion.outcome is None


def test_disabled_executor_settles_failure_without_running(tmp_path) -> None:
    # The execution-time gate: scripts disabled -> the command never runs, the
    # node settles failure. This covers every advance path (run, review, tick,
    # retry), not just the run entrypoint.
    marker = tmp_path / "ran"
    ex = ScriptExecutor(
        store_dir=tmp_path / "scripts",
        env_allowlist=["PATH"],
        enabled=lambda: False,
    )
    handle = _schedule(ex, {"command": f"touch {marker}", "workdir": str(tmp_path)})
    completion = ex.poll(handle)
    assert completion.settled is True
    assert completion.outcome == "failure"
    assert "scripts_enabled" in (completion.output or "")
    assert not marker.exists()  # the subprocess never ran


def test_settled_handle_is_not_re_executed(tmp_path) -> None:
    # Idempotent execution: scheduling the same (run, node, iteration) twice runs
    # the command once, so a tick retry after a crash never double-runs it.
    counter = tmp_path / "count"
    ex = _executor(tmp_path)
    params = {"command": f"echo x >> {counter}", "workdir": str(tmp_path)}
    first = _schedule(ex, params)
    again = _schedule(ex, params)
    assert first == again
    assert counter.read_text().count("x") == 1

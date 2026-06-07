"""P1.3 — DirectExecutor: run a global node by invoking the profile runner
(``<runner_dir>/<profile>``) with the prompt, capture stdout, persist the
completion under a results store keyed by an idempotent handle.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from hermes_workflows.executor import Completion
from hermes_workflows.executor.direct_executor import DirectExecutor, RunnerNotFound


def _runner(runner_dir: Path, profile: str, body: str) -> None:
    runner_dir.mkdir(parents=True, exist_ok=True)
    path = runner_dir / profile
    path.write_text("#!/usr/bin/env bash\n" + body + "\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IRWXU)


@pytest.fixture()
def dirs(tmp_path: Path):
    return tmp_path / "runners", tmp_path / "store"


def _executor(dirs, timeout: float = 10.0) -> DirectExecutor:
    runner_dir, store_dir = dirs
    return DirectExecutor(runner_dir=runner_dir, store_dir=store_dir, timeout_seconds=timeout)


def _wait_settled(ex: DirectExecutor, handle: str, deadline_s: float = 10.0) -> Completion:
    import time

    deadline = time.monotonic() + deadline_s
    while time.monotonic() < deadline:
        completion = ex.poll(handle)
        if completion.settled:
            return completion
        time.sleep(0.02)
    raise AssertionError(f"handle {handle} never settled")


def test_success_runner_settles_with_stdout(dirs) -> None:
    runner_dir, _ = dirs
    _runner(runner_dir, "researcher", 'echo "done: $1"')
    ex = _executor(dirs)
    handle = ex.schedule(
        run_id="run-1",
        node_id="research",
        workflow_id="wf",
        params={"assignee": "researcher", "prompt": "go"},
    )
    completion = _wait_settled(ex, handle)
    assert isinstance(completion, Completion)
    assert completion.settled is True
    assert completion.outcome == "success"
    assert completion.output == "done: go"


def test_nonzero_runner_settles_failure(dirs) -> None:
    runner_dir, _ = dirs
    _runner(runner_dir, "researcher", 'echo "boom" >&2; exit 3')
    ex = _executor(dirs)
    handle = ex.schedule(
        run_id="run-1", node_id="n", workflow_id="wf", params={"assignee": "researcher"}
    )
    completion = _wait_settled(ex, handle)
    assert completion.outcome == "failure"
    assert "boom" in (completion.output or "")


def test_missing_runner_raises_clear_error(dirs) -> None:
    ex = _executor(dirs)
    with pytest.raises(RunnerNotFound):
        ex.schedule(
            run_id="run-1", node_id="n", workflow_id="wf", params={"assignee": "ghost"}
        )


def test_runner_timeout_settles_failure(dirs) -> None:
    runner_dir, _ = dirs
    _runner(runner_dir, "slow", "sleep 5")
    ex = _executor(dirs, timeout=0.3)
    handle = ex.schedule(
        run_id="run-1", node_id="n", workflow_id="wf", params={"assignee": "slow"}
    )
    completion = _wait_settled(ex, handle)
    assert completion.outcome == "failure"


def test_poll_unknown_handle_is_not_settled(dirs) -> None:
    ex = _executor(dirs)
    completion = ex.poll("run-1:n:0")
    assert completion.settled is False
    assert completion.outcome is None


def test_handle_is_idempotent_per_iteration(dirs) -> None:
    runner_dir, _ = dirs
    _runner(runner_dir, "researcher", 'echo "ok"')
    ex = _executor(dirs)
    first = ex.schedule(
        run_id="run-1", node_id="n", workflow_id="wf", params={"assignee": "researcher"}
    )
    again = ex.schedule(
        run_id="run-1", node_id="n", workflow_id="wf", params={"assignee": "researcher"}
    )
    looped = ex.schedule(
        run_id="run-1",
        node_id="n",
        workflow_id="wf",
        params={"assignee": "researcher"},
        iteration=1,
    )
    assert first == again
    assert looped != first


def test_settled_handle_is_not_re_executed(dirs) -> None:
    runner_dir, store_dir = dirs
    counter = store_dir.parent / "count"
    _runner(runner_dir, "researcher", f'echo "x" >> {counter}')
    ex = _executor(dirs)
    params = {"assignee": "researcher"}
    first = ex.schedule(run_id="run-1", node_id="n", workflow_id="wf", params=params)
    _wait_settled(ex, first)
    again = ex.schedule(run_id="run-1", node_id="n", workflow_id="wf", params=params)
    assert first == again
    assert counter.read_text().count("x") == 1


def test_persisted_completion_survives_a_fresh_executor(dirs) -> None:
    runner_dir, _ = dirs
    _runner(runner_dir, "researcher", 'echo "persisted"')
    first = _executor(dirs)
    handle = first.schedule(
        run_id="run-1", node_id="n", workflow_id="wf", params={"assignee": "researcher"}
    )
    _wait_settled(first, handle)
    # A later tick is a fresh process / executor reading the same store dir.
    reopened = _executor(dirs).poll(handle)
    assert reopened.settled is True
    assert reopened.outcome == "success"
    assert reopened.output == "persisted"


def test_store_dir_is_created_on_demand(dirs) -> None:
    runner_dir, store_dir = dirs
    _runner(runner_dir, "researcher", 'echo "ok"')
    assert not os.path.exists(store_dir)
    _executor(dirs).schedule(
        run_id="run-1", node_id="n", workflow_id="wf", params={"assignee": "researcher"}
    )
    assert os.path.isdir(store_dir)


def test_schedule_returns_before_the_runner_finishes(dirs) -> None:
    """schedule() is non-blocking: the engine persists the scheduled state
    right after, so a long node is visible in the run state while it works
    (and a concurrent tick cannot double-start it)."""
    import time

    runner_dir, _ = dirs
    _runner(runner_dir, "slow", 'sleep 3; echo "done"')
    ex = _executor(dirs)
    t0 = time.monotonic()
    handle = ex.schedule(
        run_id="run-1", node_id="n", workflow_id="wf", params={"assignee": "slow"}
    )
    assert time.monotonic() - t0 < 1.0
    assert ex.poll(handle).settled is False
    completion = _wait_settled(ex, handle)
    assert completion.outcome == "success"
    assert completion.output == "done"


def test_inflight_handle_is_not_double_spawned(dirs) -> None:
    runner_dir, store_dir = dirs
    counter = store_dir.parent / "count"
    _runner(runner_dir, "slow", f'echo "x" >> {counter}; sleep 1')
    ex = _executor(dirs)
    params = {"assignee": "slow"}
    first = ex.schedule(run_id="run-1", node_id="n", workflow_id="wf", params=params)
    again = ex.schedule(run_id="run-1", node_id="n", workflow_id="wf", params=params)
    assert first == again
    _wait_settled(ex, first)
    assert counter.read_text().count("x") == 1

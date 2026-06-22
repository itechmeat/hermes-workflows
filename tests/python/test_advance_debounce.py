"""Event-driven advance — per-run debounce / single-flight.

Parallel-node cards on one run can complete within milliseconds of each other,
each firing the lifecycle observer in its own worker process. A per-run
filesystem debounce coalesces that burst into a single scoped advance; a
completion after the window opens a fresh spawn. (Correctness never rides on the
debounce — the advance cycle is idempotent — so this only guards against
pointless spawns.)
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from hermes_workflows import config, hooks


@pytest.fixture()
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    monkeypatch.setattr(config, "workflows_dir", lambda: tmp_path)
    monkeypatch.setattr(config, "event_debounce_seconds", lambda: 5.0)
    # Every card resolves to the same run, so the only thing gating a spawn is
    # the per-run debounce.
    monkeypatch.setattr(hooks, "_resolve_run_id", lambda _task_id: "run-1")
    captured: list[str] = []
    monkeypatch.setattr(hooks, "_spawn_advance_run", lambda run_id: captured.append(run_id))
    return captured


def test_burst_within_window_coalesces_to_one_spawn(env: list[str]) -> None:
    hooks._on_task_completed(task_id="t_a")
    hooks._on_task_completed(task_id="t_b")
    hooks._on_task_completed(task_id="t_c")
    assert env == ["run-1"]


def test_completion_after_window_spawns_again(env: list[str], tmp_path: Path) -> None:
    hooks._on_task_completed(task_id="t_a")
    assert env == ["run-1"]

    # Age the run's debounce marker past the window without a real sleep.
    marker = tmp_path / "advance-locks" / "run-1.lock"
    old = marker.stat().st_mtime - 3600
    os.utime(marker, (old, old))

    hooks._on_task_completed(task_id="t_b")
    assert env == ["run-1", "run-1"]

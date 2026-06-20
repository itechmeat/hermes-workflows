"""tools.start_workflow — the dashboard's non-blocking run start: create, arm
the tick, then drive the run in a background thread until it settles or parks.
"""

from __future__ import annotations

import time

import pytest

from hermes_workflows import tools


class FakeEngine:
    """Status sequence playback: each advance pops the next run status."""

    def __init__(self, statuses: list[str]) -> None:
        self.statuses = list(statuses)
        self.created: list[str] = []
        self.advances = 0

    def create(
        self, path: str, run_id: str, project_id=None, origin=None, input=None, params=None
    ) -> dict:
        self.created.append(run_id)
        return {"run_id": run_id, "status": "created", "workflow_id": "wf"}

    def advance(self, path: str, run_id: str) -> dict:
        self.advances += 1
        status = self.statuses.pop(0) if self.statuses else "completed"
        return {"run_id": run_id, "status": status}


@pytest.fixture()
def resolve_spec(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(tools, "_resolve_spec_path", lambda *_args: "/tmp/wf.yaml")


def _wait(predicate, deadline_s: float = 5.0) -> None:
    deadline = time.monotonic() + deadline_s
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("condition never became true")


def test_start_returns_created_and_drives_until_terminal(resolve_spec) -> None:
    engine = FakeEngine(["running", "running", "completed"])
    ticks: list[bool] = []

    result = tools.start_workflow(
        "wf",
        engine=engine,
        engine_factory=lambda: engine,
        roots=[],
        core_cli=[],
        run_id="wf-1",
        ensure_tick=lambda: ticks.append(True),
        drive_interval_seconds=0,
    )

    # The caller gets the created state immediately, before any advance.
    assert result == {"run_id": "wf-1", "status": "created"}
    assert ticks == [True]

    _wait(lambda: engine.advances >= 3)
    time.sleep(0.1)  # the loop must stop at the terminal status
    assert engine.advances == 3


def test_drive_stops_when_the_run_parks_for_review(resolve_spec) -> None:
    engine = FakeEngine(["running", "waiting"])

    tools.start_workflow(
        "wf",
        engine=engine,
        engine_factory=lambda: engine,
        roots=[],
        core_cli=[],
        run_id="wf-2",
        ensure_tick=None,
        drive_interval_seconds=0,
    )

    _wait(lambda: engine.advances >= 2)
    time.sleep(0.1)  # `waiting` needs a human; the loop must not spin on it
    assert engine.advances == 2


def test_drive_survives_an_advance_failure(resolve_spec, capsys) -> None:
    class ExplodingEngine(FakeEngine):
        def advance(self, path: str, run_id: str) -> dict:
            self.advances += 1
            raise RuntimeError("db locked")

    engine = ExplodingEngine([])
    tools.start_workflow(
        "wf",
        engine=engine,
        engine_factory=lambda: engine,
        roots=[],
        core_cli=[],
        run_id="wf-3",
        ensure_tick=None,
        drive_interval_seconds=0,
    )

    _wait(lambda: engine.advances >= 1)
    time.sleep(0.1)  # one failure ends the drive; the armed tick is the backstop
    assert engine.advances == 1

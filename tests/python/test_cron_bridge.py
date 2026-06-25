"""E3.4 — cron bridge: register a workflow trigger, manage the transient tick,
and pause/resume/remove schedules. The schedule string is passed through to
Hermes cron; here we use an interval so the test runs without croniter."""

from __future__ import annotations

from pathlib import Path

import pytest

cj = pytest.importorskip("cron.jobs")

from hermes_workflows.bridge import cron as cron_bridge


@pytest.fixture()
def cron_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    # The cron store is sandboxed to a tmp dir by the autouse _sandbox_cron_store
    # fixture in conftest; this fixture only adds the env + runner script.
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("HERMES_WORKFLOWS_BIN", str(tmp_path / "bin" / "hermes-workflows"))
    script = tmp_path / "runner.sh"
    script.write_text("#!/bin/bash\necho ok\n")
    return script


def test_register_trigger(cron_env: Path) -> None:
    job_id = cron_bridge.register_trigger(
        workflow_id="blog-daily-signals", schedule="every 2m", script=str(cron_env)
    )
    job = cj.get_job(job_id)
    assert job is not None
    assert job["name"] == "workflow:blog-daily-signals"
    assert job["script"] == str(cron_env)


def test_sync_tick_creates_and_removes(cron_env: Path) -> None:
    first = cron_bridge.sync_tick(active=True, script=str(cron_env))
    assert first is not None
    # idempotent: the singleton tick is reused, not duplicated
    again = cron_bridge.sync_tick(active=True, script=str(cron_env))
    assert again == first
    assert cron_bridge.find_by_name(cron_bridge.TICK_NAME) is not None

    # no active runs -> tick is torn down
    assert cron_bridge.sync_tick(active=False, script=str(cron_env)) is None
    assert cron_bridge.find_by_name(cron_bridge.TICK_NAME) is None


def test_workflow_trigger_uses_run_command(cron_env: Path) -> None:
    job_id = cron_bridge.register_workflow_trigger(
        workflow_id="blog-daily-signals", schedule="every 2m"
    )
    job = cj.get_job(job_id)
    assert job["name"] == "workflow:blog-daily-signals"

    shim = Path(job["script"])
    assert shim.name == "hermes-workflows-trigger-blog-daily-signals.sh"
    body = shim.read_text()
    assert "hermes-workflows" in body
    assert "run blog-daily-signals" in body


def test_workflow_tick_uses_advance_all_command(cron_env: Path) -> None:
    job_id = cron_bridge.sync_workflow_tick(active=True)
    job = cj.get_job(job_id)
    assert job["name"] == cron_bridge.TICK_NAME

    shim = Path(job["script"])
    assert shim.name == "hermes-workflows-tick.sh"
    assert "advance-all" in shim.read_text()

    # singleton: a second sync reuses the same job
    assert cron_bridge.sync_workflow_tick(active=True) == job_id
    # drained -> torn down
    assert cron_bridge.sync_workflow_tick(active=False) is None
    assert cron_bridge.find_by_name(cron_bridge.TICK_NAME) is None


def test_list_workflow_schedules(cron_env: Path) -> None:
    # Interval schedules keep the test croniter-free (see module docstring); the
    # bridge shapes them through the same row mapping as cron-expression jobs.
    cron_bridge.register_workflow_trigger(workflow_id="blog", schedule="every 30m")
    cron_bridge.register_workflow_trigger(workflow_id="nightly", schedule="every 1h")
    # a non-workflow job (the tick) must be excluded from the list
    cron_bridge.sync_workflow_tick(active=True)

    rows = cron_bridge.list_workflow_schedules()
    assert {r["workflow_id"] for r in rows} == {"blog", "nightly"}

    blog = next(r for r in rows if r["workflow_id"] == "blog")
    assert blog["cron_expression"] == "every 30m"  # interval display (no expr)
    assert blog["timezone"] == "UTC"
    assert blog["enabled"] is True
    assert blog["next_run"] is not None
    assert blog["hermes_cron_id"]


def test_find_workflow_job(cron_env: Path) -> None:
    job_id = cron_bridge.register_workflow_trigger(workflow_id="blog", schedule="every 30m")
    found = cron_bridge.find_workflow_job("blog")
    assert found is not None
    assert found["id"] == job_id
    assert cron_bridge.find_workflow_job("never-scheduled") is None


def test_next_run_by_workflow(cron_env: Path) -> None:
    cron_bridge.register_workflow_trigger(workflow_id="blog", schedule="every 30m")
    cron_bridge.register_workflow_trigger(workflow_id="nightly", schedule="every 1h")
    cron_bridge.sync_workflow_tick(active=True)  # excluded (not a workflow job)

    by_wf = cron_bridge.next_run_by_workflow()
    assert set(by_wf) == {"blog", "nightly"}
    assert by_wf["blog"] is not None


def test_run_now_triggers_or_reports_missing(cron_env: Path) -> None:
    job_id = cron_bridge.register_workflow_trigger(workflow_id="wf", schedule="every 2m")
    assert cron_bridge.run_now(job_id) is True
    assert cron_bridge.run_now("does-not-exist") is False


def test_edit_schedule_changes_schedule_and_rejects_bad(cron_env: Path) -> None:
    job_id = cron_bridge.register_workflow_trigger(workflow_id="wf", schedule="every 2m")
    cron_bridge.edit_schedule(job_id, "every 10m")
    assert cj.get_job(job_id)["schedule"]["minutes"] == 10

    with pytest.raises(ValueError):
        cron_bridge.edit_schedule(job_id, "totally not a schedule")

    assert cron_bridge.edit_schedule("does-not-exist", "every 10m") is None


def test_pause_resume_remove(cron_env: Path) -> None:
    job_id = cron_bridge.register_trigger(
        workflow_id="wf", schedule="every 1h", script=str(cron_env)
    )
    cron_bridge.pause(job_id)
    assert cj.get_job(job_id)["enabled"] is False
    cron_bridge.resume(job_id)
    assert cj.get_job(job_id)["enabled"] is True
    assert cron_bridge.remove(job_id) is True
    assert cj.get_job(job_id) is None

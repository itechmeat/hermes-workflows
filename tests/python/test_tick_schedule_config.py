"""Configurable advance-tick cadence (t_9cdf56de).

The residual ``hermes-workflows advance-all`` tick is no longer pinned to the
hardcoded ``every 2m``: its cadence is the ``plugins.workflows.tick_schedule``
setting (config ▸ env ▸ default), so an operator tunes it from the Settings page
without a code edit. With event-driven advance (t_c6a45c03) handling card
transitions, this tick is the coarse safety-net + ``wait``-node poll, so its
cadence is a knob, not the latency driver. The active/idle lifecycle
(``sync_workflow_tick``) is unchanged — still torn down at zero active runs.
"""

from __future__ import annotations

from pathlib import Path

import pytest

cj = pytest.importorskip("cron.jobs")
yaml = pytest.importorskip("yaml")
pytest.importorskip("hermes_cli.config")

from hermes_workflows import config  # noqa: E402
from hermes_workflows.bridge import cron as cron_bridge  # noqa: E402


@pytest.fixture()
def cron_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    # The cron store is sandboxed to a tmp dir by the autouse _sandbox_cron_store
    # fixture in conftest.
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("HERMES_WORKFLOWS_BIN", str(tmp_path / "bin" / "hermes-workflows"))
    return tmp_path / "home"


def _write_config(home: Path, data: dict) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(yaml.safe_dump(data))


def _job_schedule_expr(job: dict) -> str:
    """The schedule string as Hermes cron stored it (interval or cron expr)."""
    schedule = job.get("schedule") or {}
    return schedule.get("expr") or job.get("schedule_display") or ""


def test_tick_schedule_default_when_unset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    assert config.tick_schedule() == "every 2m"


def test_tick_schedule_reads_stored_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    _write_config(home, {"plugins": {"workflows": {"tick_schedule": "every 30s"}}})
    assert config.tick_schedule() == "every 30s"


def test_tick_schedule_in_schema_and_enforced(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    by_key = {f["key"]: f for g in config.settings_schema()["groups"] for f in g["fields"]}
    assert "tick_schedule" in by_key
    assert by_key["tick_schedule"]["default"] == "every 2m"
    assert by_key["tick_schedule"]["enforced"] is True


def test_tick_created_with_default_schedule(cron_env: Path) -> None:
    job_id = cron_bridge.sync_workflow_tick(active=True)
    job = cj.get_job(job_id)
    assert job["name"] == cron_bridge.TICK_NAME
    assert _job_schedule_expr(job) == "every 2m"


def test_tick_created_with_configured_schedule(cron_env: Path) -> None:
    _write_config(cron_env, {"plugins": {"workflows": {"tick_schedule": "every 1m"}}})
    job_id = cron_bridge.sync_workflow_tick(active=True)
    job = cj.get_job(job_id)
    assert _job_schedule_expr(job) == "every 1m"


def test_tick_lifecycle_teardown_preserved(cron_env: Path) -> None:
    _write_config(cron_env, {"plugins": {"workflows": {"tick_schedule": "every 1m"}}})
    # active -> the singleton tick exists with the configured cadence
    first = cron_bridge.sync_workflow_tick(active=True)
    assert first is not None
    assert cron_bridge.find_by_name(cron_bridge.TICK_NAME) is not None
    # idempotent: a second sync reuses the same job, no duplicate
    assert cron_bridge.sync_workflow_tick(active=True) == first
    # drained -> torn down (no busy-polling at zero active runs)
    assert cron_bridge.sync_workflow_tick(active=False) is None
    assert cron_bridge.find_by_name(cron_bridge.TICK_NAME) is None

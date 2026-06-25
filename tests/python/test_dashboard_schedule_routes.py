"""Schedules page routes: list workflow cron schedules and act on them
(pause / resume / run-now / edit / delete) over the Hermes cron bridge. Skipped
where fastapi or the Hermes cron module is unavailable."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
cj = pytest.importorskip("cron.jobs")
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_workflows.bridge import cron as cron_bridge

ROOT = Path(__file__).resolve().parents[2]
PLUGIN_API = ROOT / "dashboard" / "plugin_api.py"


def _load_router():
    spec = importlib.util.spec_from_file_location("hw_dashboard_api_sched", PLUGIN_API)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # The cron store is sandboxed to a tmp dir by the autouse _sandbox_cron_store
    # fixture in conftest.
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("HERMES_WORKFLOWS_BIN", str(tmp_path / "bin" / "hermes-workflows"))
    app = FastAPI()
    app.include_router(_load_router().router)
    return TestClient(app)


# Interval schedules keep these route tests croniter-free; the routes exercise
# the same bridge paths regardless of the schedule kind.
def _register(workflow_id: str = "blog", schedule: str = "every 30m") -> str:
    return cron_bridge.register_workflow_trigger(workflow_id=workflow_id, schedule=schedule)


def test_list_schedules(client: TestClient) -> None:
    job_id = _register()
    resp = client.get("/schedules")
    assert resp.status_code == 200
    rows = resp.json()["schedules"]
    row = next(r for r in rows if r["workflow_id"] == "blog")
    assert row["cron_expression"] == "every 30m"
    assert row["hermes_cron_id"] == job_id
    assert row["enabled"] is True


def test_pause_then_resume(client: TestClient) -> None:
    job_id = _register()
    assert client.post(f"/schedules/{job_id}/pause").status_code == 200
    assert cj.get_job(job_id)["enabled"] is False
    assert client.post(f"/schedules/{job_id}/resume").status_code == 200
    assert cj.get_job(job_id)["enabled"] is True


def test_pause_unknown_is_404(client: TestClient) -> None:
    assert client.post("/schedules/ghost/pause").status_code == 404


def test_run_now(client: TestClient) -> None:
    job_id = _register()
    assert client.post(f"/schedules/{job_id}/run").status_code == 200


def test_run_unknown_is_404(client: TestClient) -> None:
    assert client.post("/schedules/ghost/run").status_code == 404


def test_edit_cron(client: TestClient) -> None:
    job_id = _register()
    resp = client.put(f"/schedules/{job_id}", json={"cron": "every 10m"})
    assert resp.status_code == 200, resp.text
    assert cj.get_job(job_id)["schedule"]["minutes"] == 10


def test_edit_bad_cron_is_400(client: TestClient) -> None:
    job_id = _register()
    resp = client.put(f"/schedules/{job_id}", json={"cron": "totally not a schedule"})
    assert resp.status_code == 400


def test_edit_unknown_is_404(client: TestClient) -> None:
    assert client.put("/schedules/ghost", json={"cron": "0 9 * * *"}).status_code == 404


def test_delete_schedule(client: TestClient) -> None:
    job_id = _register()
    assert client.delete(f"/schedules/{job_id}").status_code == 200
    assert cj.get_job(job_id) is None


def test_delete_unknown_is_404(client: TestClient) -> None:
    assert client.delete("/schedules/ghost").status_code == 404

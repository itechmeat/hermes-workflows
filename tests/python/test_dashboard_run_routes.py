"""T7 — dashboard run routes: start a run, inspect it, cancel and retry, against
a temp Hermes home with a real runtime board. Skipped without fastapi/kanban."""

from __future__ import annotations

import importlib.util
import json
import shutil
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("hermes_cli.kanban_db")
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
PLUGIN_API = ROOT / "dashboard" / "plugin_api.py"
SPEC = ROOT / "examples" / "feature-development.workflow.yaml"


def _load_router():
    spec = importlib.util.spec_from_file_location("hw_dashboard_api_run", PLUGIN_API)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_SCRIPT_SPEC = {
    "id": "scripts-only",
    "name": "Scripts Only",
    "version": 1,
    "scope": {"type": "global"},
    "trigger": {"type": "manual"},
    "nodes": [
        {"id": "build", "type": "script", "command": "echo built"},
        {"id": "done", "type": "finish"},
    ],
    "edges": [{"from": "build", "to": "done"}],
}


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    home = tmp_path / "home"
    global_dir = home / "workflows" / "global"
    global_dir.mkdir(parents=True)
    shutil.copy(SPEC, global_dir / "feature-development.workflow.yaml")
    (global_dir / "scripts-only.workflow.json").write_text(json.dumps(_SCRIPT_SPEC))
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))

    app = FastAPI()
    app.include_router(_load_router().router)
    return TestClient(app)


def _start_run(client: TestClient) -> str:
    resp = client.post("/workflows/feature-development/run")
    assert resp.status_code == 200, resp.text
    return resp.json()["run_id"]


def test_run_then_inspect(client: TestClient) -> None:
    run_id = _start_run(client)
    resp = client.get(f"/runs/{run_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["run_id"] == run_id
    assert "plan" in body["nodes"]


def test_get_unknown_run_is_404(client: TestClient) -> None:
    assert client.get("/runs/ghost").status_code == 404


def _find_run(rows: list[dict], run_id: str) -> dict:
    match = [r for r in rows if r["run_id"] == run_id]
    assert match, f"{run_id} not in {[r['run_id'] for r in rows]}"
    return match[0]


def test_list_runs_default_active_has_page_fields(client: TestClient) -> None:
    run_id = _start_run(client)
    resp = client.get("/runs")
    assert resp.status_code == 200
    row = _find_run(resp.json()["runs"], run_id)
    # Every TZ column is present (values may be null for a fresh run).
    for key in (
        "run_id",
        "workflow_id",
        "project_id",
        "status",
        "current_node",
        "started_at",
        "finished_at",
        "duration",
    ):
        assert key in row, key
    assert row["workflow_id"] == "feature-development"


def test_list_runs_scope_all_includes_finished(client: TestClient) -> None:
    run_id = _start_run(client)
    client.post(f"/runs/{run_id}/cancel")  # settle it -> no longer active
    active_ids = [r["run_id"] for r in client.get("/runs").json()["runs"]]
    assert run_id not in active_ids
    all_ids = [r["run_id"] for r in client.get("/runs?scope=all").json()["runs"]]
    assert run_id in all_ids


def test_run_timing_is_recorded_end_to_end(client: TestClient) -> None:
    run_id = _start_run(client)
    # started_at is stamped at run-create; a still-running run has no finish/duration.
    row = _find_run(client.get("/runs?scope=all").json()["runs"], run_id)
    assert row["started_at"] is not None
    assert row["finished_at"] is None
    assert row["duration"] is None

    # Cancelling settles the run: finished_at is stamped and duration is derived.
    client.post(f"/runs/{run_id}/cancel")
    row = _find_run(client.get("/runs?scope=all").json()["runs"], run_id)
    assert row["finished_at"] is not None
    assert row["duration"] == row["finished_at"] - row["started_at"]
    assert row["duration"] >= 0

    # Retrying puts it back in flight: finished_at clears, started_at survives.
    client.post(f"/runs/{run_id}/retry")
    row = _find_run(client.get("/runs?scope=all").json()["runs"], run_id)
    assert row["started_at"] is not None
    assert row["finished_at"] is None


def test_export_run_returns_bundle(client: TestClient) -> None:
    run_id = _start_run(client)
    resp = client.get(f"/runs/{run_id}/export")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["run_id"] == run_id
    assert body["filename"] == f"{run_id}.run.json"
    # The downloadable payload is the full run-load bundle (per-node detail).
    assert body["json"]["run_id"] == run_id
    assert "nodes" in body["json"]


def test_export_unknown_run_is_404(client: TestClient) -> None:
    assert client.get("/runs/ghost/export").status_code == 404


def test_cancel_run(client: TestClient) -> None:
    run_id = _start_run(client)
    resp = client.post(f"/runs/{run_id}/cancel")
    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"


def test_cancel_unknown_run_is_404(client: TestClient) -> None:
    assert client.post("/runs/ghost/cancel").status_code == 404


def test_retry_run_resets_it(client: TestClient) -> None:
    run_id = _start_run(client)
    resp = client.post(f"/runs/{run_id}/retry")
    assert resp.status_code == 200
    assert resp.json()["status"] == "created"


def test_retry_unknown_run_is_404(client: TestClient) -> None:
    assert client.post("/runs/ghost/retry").status_code == 404


def test_retry_non_failed_node_is_400(client: TestClient) -> None:
    run_id = _start_run(client)
    # 'plan' is scheduled (the entry node), not failed -> RetryError -> 400.
    resp = client.post(f"/runs/{run_id}/retry", json={"node_id": "plan"})
    assert resp.status_code == 400


def test_script_workflow_is_409_when_scripts_disabled(client: TestClient) -> None:
    # scripts_enabled defaults to false -> a script workflow is refused.
    resp = client.post("/workflows/scripts-only/run")
    assert resp.status_code == 409, resp.text
    assert "scripts_enabled" in resp.json()["detail"]


def test_non_script_workflow_runs_when_scripts_disabled(client: TestClient) -> None:
    # The gate only affects workflows that contain script nodes.
    resp = client.post("/workflows/feature-development/run")
    assert resp.status_code == 200, resp.text


def test_script_workflow_runs_once_scripts_enabled(client: TestClient) -> None:
    from hermes_workflows import config

    config.save_settings({"scripts_enabled": True, "script_env_allowlist": "PATH"})
    resp = client.post("/workflows/scripts-only/run")
    assert resp.status_code == 200, resp.text
    assert resp.json()["run_id"].startswith("scripts-only-")

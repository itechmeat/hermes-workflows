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
# feature-development requires a feature_request param (no default).
_RUN_BODY = {"params": {"feature_request": "Add a dark mode toggle"}}


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


_RESUMABLE_SPEC = """\
id: resumable-dash
name: Resumable Dash
version: 1
scope:
  type: project
  projects: [demo]
trigger: { type: manual }
defaults: { profile: eng }
nodes:
  - id: a
    type: agent_task
    title: A
    prompt: "Do A."
  - id: b
    type: agent_task
    title: B
    prompt: "Do B ORIGINAL."
  - id: done
    type: finish
    outcome: success
edges:
  - { from: a, to: b }
  - { from: b, to: done }
"""


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    home = tmp_path / "home"
    global_dir = home / "workflows" / "global"
    global_dir.mkdir(parents=True)
    shutil.copy(SPEC, global_dir / "feature-development.workflow.yaml")
    (global_dir / "scripts-only.workflow.json").write_text(json.dumps(_SCRIPT_SPEC))
    (global_dir / "resumable-dash.workflow.yaml").write_text(_RESUMABLE_SPEC)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))

    app = FastAPI()
    app.include_router(_load_router().router)
    return TestClient(app)


def _resumable_spec_path() -> Path:
    import os

    return Path(os.environ["HERMES_HOME"]) / "workflows" / "global" / "resumable-dash.workflow.yaml"


def _fail_resumable_run(client: TestClient) -> str:
    """Create a resumable-dash run and craft a 'b failed' terminal state in the
    runs db, returning its run id. Created via the engine (not the HTTP run
    route) so no background drive races with the crafted state."""
    from hermes_workflows.cli import _spec_path_for_workflow, build_engine

    engine = build_engine()
    path = _spec_path_for_workflow(engine, "resumable-dash")
    run_id = "resumable-dash-failed"
    engine.create(path, run_id, project_id="demo")
    run = engine.status(run_id)
    run["nodes"]["a"]["status"] = "completed"
    run["nodes"]["a"]["outcome"] = "success"
    run["nodes"]["a"]["seq"] = 1
    run["nodes"]["a"]["output"] = "A DONE"
    run["nodes"]["b"]["status"] = "failed"
    run["nodes"]["b"]["outcome"] = "failure"
    run["nodes"]["b"]["seq"] = 2
    run["status"] = "failed"
    engine._save(run)
    return run_id


def _active_resumable_run(client: TestClient) -> str:
    """Create a resumable-dash run left ACTIVE (entry node scheduled, run
    running) directly in the runs db — no background drive thread."""
    from hermes_workflows.cli import _spec_path_for_workflow, build_engine

    engine = build_engine()
    path = _spec_path_for_workflow(engine, "resumable-dash")
    run_id = "resumable-dash-active"
    engine.create(path, run_id, project_id="demo")
    run = engine.status(run_id)
    run["nodes"]["a"]["status"] = "scheduled"
    run["nodes"]["a"]["hermes_task_id"] = "t_fake"
    run["status"] = "running"
    engine._save(run)
    return run_id


def _start_run(client: TestClient) -> str:
    """Start a run and wait for its background first advance, restoring the
    post-start invariant the assertions below rely on (entry node scheduled)."""
    import time

    resp = client.post("/workflows/feature-development/run", json=_RUN_BODY)
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["run_id"]
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        run = client.get(f"/runs/{run_id}").json()
        if run["status"] != "created":
            return run_id
        time.sleep(0.05)
    raise AssertionError(f"first advance never happened for {run_id}: {run['status']}")


def test_run_then_inspect(client: TestClient) -> None:
    run_id = _start_run(client)
    resp = client.get(f"/runs/{run_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["run_id"] == run_id
    assert "plan" in body["nodes"]


def test_run_with_non_object_params_is_400(client: TestClient) -> None:
    resp = client.post("/workflows/feature-development/run", json={"params": ["nope"]})
    assert resp.status_code == 400
    assert "params" in resp.json()["detail"]


def test_run_with_unknown_param_is_400(client: TestClient) -> None:
    # feature-development declares feature_request, so an unknown name is rejected
    # by the core at run-create and surfaced as a 400 (a caller error, not a 500).
    resp = client.post("/workflows/feature-development/run", json={"params": {"nope": "x"}})
    assert resp.status_code == 400
    assert "unknown param" in resp.json()["detail"]


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


def test_retry_run_restarts_a_terminal_run(client: TestClient) -> None:
    run_id = _fail_resumable_run(client)
    resp = client.post(f"/runs/{run_id}/retry")  # no node -> full restart
    assert resp.status_code == 200
    # Whole-graph reset, then advanced under the live spec: the entry node is
    # re-scheduled and the run is running again.
    body = resp.json()
    assert body["status"] == "running"
    assert body["nodes"]["a"]["status"] == "scheduled"


def test_retry_active_run_is_409(client: TestClient) -> None:
    """Resume refuses a still-active run (it already has a tick advancing it)."""
    run_id = _active_resumable_run(client)
    resp = client.post(f"/runs/{run_id}/retry")
    assert resp.status_code == 409, resp.text
    assert "resum" in resp.json()["detail"].lower()


def test_retry_unknown_run_is_404(client: TestClient) -> None:
    assert client.post("/runs/ghost/retry").status_code == 404


def test_resume_failed_node_reschedules_it(client: TestClient) -> None:
    """A failed run resumes: the failed node is reset and re-scheduled under the
    live spec (synchronous advance), keeping the completed prefix."""
    run_id = _fail_resumable_run(client)
    resp = client.post(f"/runs/{run_id}/retry", json={"node_id": "b"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "running"
    assert body["nodes"]["b"]["status"] == "scheduled"
    assert body["nodes"]["a"]["status"] == "completed"  # prefix kept
    assert body["nodes"]["a"]["output"] == "A DONE"


def test_resume_rejects_invalid_node_id_payload(client: TestClient) -> None:
    run_id = _fail_resumable_run(client)
    for payload in ({"node_id": ""}, {"node_id": "   "}, {"node_id": ["b"]}):
        resp = client.post(f"/runs/{run_id}/retry", json=payload)
        assert resp.status_code == 400, resp.text
        assert "node_id" in resp.json()["detail"]



def test_resume_refuses_structural_spec_drift_409(client: TestClient) -> None:
    run_id = _fail_resumable_run(client)
    # Add a node to the live spec since the run started -> node-set drift.
    drifted = _RESUMABLE_SPEC.replace(
        "  - id: done\n",
        "  - id: extra\n    type: agent_task\n    title: Extra\n    prompt: \"X.\"\n  - id: done\n",
    ).replace(
        "  - { from: b, to: done }\n",
        "  - { from: b, to: extra }\n  - { from: extra, to: done }\n",
    )
    _resumable_spec_path().write_text(drifted)

    resp = client.post(f"/runs/{run_id}/retry", json={"node_id": "b"})
    assert resp.status_code == 409, resp.text
    assert "drift" in resp.json()["detail"].lower()


def test_retry_non_failed_node_is_400(client: TestClient) -> None:
    run_id = _fail_resumable_run(client)
    # 'a' is completed, not failed -> RetryError -> 400.
    resp = client.post(f"/runs/{run_id}/retry", json={"node_id": "a"})
    assert resp.status_code == 400


def test_script_workflow_is_409_when_scripts_disabled(client: TestClient) -> None:
    # scripts_enabled defaults to false -> a script workflow is refused.
    resp = client.post("/workflows/scripts-only/run")
    assert resp.status_code == 409, resp.text
    assert "scripts_enabled" in resp.json()["detail"]


def test_non_script_workflow_runs_when_scripts_disabled(client: TestClient) -> None:
    # The gate only affects workflows that contain script nodes.
    resp = client.post("/workflows/feature-development/run", json=_RUN_BODY)
    assert resp.status_code == 200, resp.text


def test_script_workflow_runs_once_scripts_enabled(client: TestClient) -> None:
    from hermes_workflows import config

    config.save_settings({"scripts_enabled": True, "script_env_allowlist": "PATH"})
    resp = client.post("/workflows/scripts-only/run")
    assert resp.status_code == 200, resp.text
    assert resp.json()["run_id"].startswith("scripts-only-")


def test_second_start_is_409_naming_the_active_run(client: TestClient) -> None:
    """Single-flight: one workflow may have at most one active run. The refusal
    is explicit — 409 with the blocking run's id in the detail."""
    run_id = _start_run(client)
    resp = client.post("/workflows/feature-development/run", json=_RUN_BODY)
    assert resp.status_code == 409, resp.text
    assert run_id in resp.json()["detail"]


def test_start_is_allowed_again_after_the_active_run_settles(client: TestClient) -> None:
    run_id = _start_run(client)
    client.post(f"/runs/{run_id}/cancel")
    resp = client.post("/workflows/feature-development/run", json=_RUN_BODY)
    assert resp.status_code == 200, resp.text


def test_retry_is_409_while_a_sibling_run_is_active(client: TestClient) -> None:
    """Retry revives a run — it must not slip past the single-flight guard."""
    first = _start_run(client)
    client.post(f"/runs/{first}/cancel")
    second = _start_run(client)

    resp = client.post(f"/runs/{first}/retry")
    assert resp.status_code == 409, resp.text
    assert second in resp.json()["detail"]


def test_list_runs_filters_by_workflow_id(client: TestClient) -> None:
    """The editor-attach lookup: only the named workflow's runs come back."""
    run_id = _start_run(client)
    rows = client.get("/runs?scope=all&workflow_id=feature-development").json()["runs"]
    assert rows, "expected at least the run just started"
    assert all(r["workflow_id"] == "feature-development" for r in rows)
    assert run_id in [r["run_id"] for r in rows]
    assert client.get("/runs?scope=all&workflow_id=ghost").json()["runs"] == []


def test_get_run_overlays_live_telemetry(client: TestClient) -> None:
    """Active nodes show worker telemetry from the sidecar before the engine
    bakes it at settle time (the inspector polls this route every 2s)."""
    import os

    from hermes_workflows import telemetry

    run_id = _start_run(client)
    body = client.get(f"/runs/{run_id}").json()
    task_id = body["nodes"]["plan"]["hermes_task_id"]

    root = Path(os.environ["HERMES_HOME"]) / "workflows" / "telemetry"
    root.mkdir(parents=True, exist_ok=True)
    telemetry.sidecar_path(root, task_id).write_text(
        json.dumps({"api_calls": 2, "total_tokens": 50, "tool_calls": 1})
    )

    body = client.get(f"/runs/{run_id}").json()
    assert body["nodes"]["plan"]["telemetry"]["total_tokens"] == 50
    # A corrupt sidecar degrades to absent telemetry, never a 500.
    telemetry.sidecar_path(root, task_id).write_text("{broken")
    body = client.get(f"/runs/{run_id}").json()
    assert "telemetry" not in body["nodes"]["plan"]


def test_list_runs_row_carries_total_tokens(client: TestClient) -> None:
    run_id = _start_run(client)
    row = _find_run(client.get("/runs").json()["runs"], run_id)
    assert "total_tokens" in row  # null until telemetry lands
    assert row["total_tokens"] is None


def test_export_includes_trace_when_present(client: TestClient) -> None:
    """A traced run's export carries the JSONL timeline alongside the state
    bundle; the Runs page downloads it as a second file."""
    import os

    run_id = _start_run(client)
    traces = Path(os.environ["HERMES_HOME"]) / "workflows" / "traces"
    traces.mkdir(parents=True, exist_ok=True)
    line = json.dumps({"ts": 1.0, "run_id": run_id, "kind": "run_created"})
    (traces / f"{run_id}.jsonl").write_text(line + "\n")

    body = client.get(f"/runs/{run_id}/export").json()
    assert body["filename"] == f"{run_id}.run.json"  # unchanged primary bundle
    assert body["trace_filename"] == f"{run_id}.trace.jsonl"
    assert body["trace"] == line + "\n"


def test_export_without_trace_keeps_todays_envelope(client: TestClient) -> None:
    run_id = _start_run(client)
    body = client.get(f"/runs/{run_id}/export").json()
    assert set(body) == {"run_id", "filename", "json"}


def test_run_start_is_non_blocking_and_arms_the_tick(client: TestClient) -> None:
    """The start response carries the freshly-created state immediately (the
    first advance happens in the background) and the advance tick cron is armed
    so the run keeps progressing even if this process dies."""
    import time

    # The cron store is sandboxed to a tmp dir by the autouse _sandbox_cron_store
    # fixture in conftest; this only guards on cron.jobs being importable.
    pytest.importorskip("cron.jobs")

    resp = client.post("/workflows/feature-development/run", json=_RUN_BODY)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "created"

    from hermes_workflows.bridge import cron as cron_bridge

    assert cron_bridge.find_by_name(cron_bridge.TICK_NAME) is not None

    # The background advance schedules the entry node shortly after.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        run = client.get(f"/runs/{body['run_id']}").json()
        if run["nodes"]["plan"]["status"] == "scheduled":
            return
        time.sleep(0.1)
    raise AssertionError(f"entry node never scheduled: {run['nodes']['plan']}")

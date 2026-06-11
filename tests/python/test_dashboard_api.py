"""E6.1 / E6.3 — the dashboard plugin API exposes read-only workflow/run lists
and an O2B status badge. Skipped where FastAPI is unavailable (it ships with
the Hermes dashboard runtime)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
PLUGIN_API = ROOT / "dashboard" / "plugin_api.py"


def _load_router():
    spec = importlib.util.spec_from_file_location("hw_dashboard_api", PLUGIN_API)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    import hermes_workflows.tools as tools
    import hermes_workflows.cli_bridge as cli_bridge

    monkeypatch.setattr(
        tools, "list_workflows", lambda **_: {"workflows": [{"id": "wf", "name": "WF"}]}
    )
    monkeypatch.setattr(cli_bridge, "invoke", lambda *_a, **_k: [{"run_id": "r1", "workflow_id": "wf", "status": "running"}])

    module = _load_router()
    app = FastAPI()
    app.include_router(module.router)
    return TestClient(app)


def test_workflows_route(client: TestClient) -> None:
    resp = client.get("/workflows")
    assert resp.status_code == 200
    assert resp.json()["workflows"][0]["id"] == "wf"


def test_runs_route(client: TestClient) -> None:
    resp = client.get("/runs")
    assert resp.status_code == 200
    assert resp.json()["runs"][0]["run_id"] == "r1"


def test_o2b_status_route(client: TestClient) -> None:
    resp = client.get("/o2b-status")
    assert resp.status_code == 200
    payload = resp.json()
    assert isinstance(payload["connected"], bool)
    # `installed` drives the indicator's link target and is reported separately.
    assert isinstance(payload["installed"], bool)
    # connected implies installed (connected = installed AND configured).
    assert not payload["connected"] or payload["installed"]


def test_profiles_route(client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Profile names come from the roster YAML, sorted; missing roster -> []."""
    import hermes_workflows.config as wf_config

    roster_dir = tmp_path / "agent-roster"
    roster_dir.mkdir()
    (roster_dir / "agents.yaml").write_text(
        "agents:\n  writer: {}\n  coder: {}\n", encoding="utf-8"
    )
    monkeypatch.setattr(wf_config, "hermes_home", lambda: tmp_path)
    resp = client.get("/profiles")
    assert resp.status_code == 200
    assert resp.json()["profiles"] == ["coder", "writer"]


def test_profiles_route_missing_roster(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import hermes_workflows.config as wf_config

    monkeypatch.setattr(wf_config, "hermes_home", lambda: tmp_path)
    resp = client.get("/profiles")
    assert resp.status_code == 200
    assert resp.json()["profiles"] == []

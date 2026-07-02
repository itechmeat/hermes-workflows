"""Standalone dashboard-API sidecar — restores the Workflows dashboard backend
after upstream Hermes stopped auto-importing non-bundled plugin APIs
(GHSA-5qr3-c538-wm9j). The sidecar reuses the EXISTING ``dashboard/plugin_api.py``
router verbatim, mounted under ``/api/plugins/hermes-workflows``, plus a ``/healthz``
liveness route. Skipped where FastAPI is unavailable (it ships with the Hermes
dashboard runtime)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
PLUGIN_API = ROOT / "dashboard" / "plugin_api.py"
PREFIX = "/api/plugins/hermes-workflows"


def _imported_router_routes() -> list:
    """Routes declared by the existing plugin_api router, independent of the
    sidecar — the baseline the sidecar must mount and must not duplicate. A path
    may appear under more than one method, so this is a list of route objects,
    not a set of paths."""
    spec = importlib.util.spec_from_file_location("hw_plugin_api_baseline", PLUGIN_API)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return list(module.router.routes)


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    import hermes_workflows.tools as tools
    import hermes_workflows.cli_bridge as cli_bridge

    monkeypatch.setattr(
        tools, "list_workflows", lambda **_: {"workflows": [{"id": "wf", "name": "WF"}]}
    )
    monkeypatch.setattr(
        cli_bridge,
        "invoke",
        lambda *_a, **_k: [{"run_id": "r1", "workflow_id": "wf", "status": "running"}],
    )

    from hermes_workflows.dashboard_api import build_app

    return TestClient(build_app())


def test_healthz(client: TestClient) -> None:
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_plugin_route_mounted_under_prefix(client: TestClient) -> None:
    resp = client.get(f"{PREFIX}/workflows")
    assert resp.status_code == 200
    assert resp.json()["workflows"][0]["id"] == "wf"


def test_routes_not_mounted_at_root(client: TestClient) -> None:
    # Prefix must be exact: the same route at the bare path is NOT served, so the
    # sidecar can never shadow other dashboard routes.
    assert client.get("/workflows").status_code == 404


def test_no_route_duplication(client: TestClient) -> None:
    # Every plugin route appears exactly once, under the prefix — the sidecar
    # mounts the existing router, it does not re-declare routes.
    baseline = _imported_router_routes()
    app_paths = [r.path for r in client.app.routes]
    prefixed = [p for p in app_paths if p.startswith(PREFIX)]
    # Same set of paths, and exactly as many mounted route objects as the
    # baseline router — no route is dropped, none re-declared.
    assert set(prefixed) == {f"{PREFIX}{r.path}" for r in baseline}
    assert len(prefixed) == len(baseline)
    assert "/healthz" in app_paths

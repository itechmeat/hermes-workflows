"""T3 — Templates page routes: the enriched workflow list (enabled + run/next-run
columns), the enable/disable toggle, and the disabled-run gate. Runs against a
temp Hermes home with a real runtime board. Skipped without fastapi/kanban."""

from __future__ import annotations

import importlib.util
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
    spec = importlib.util.spec_from_file_location("hw_dashboard_api_tpl", PLUGIN_API)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    home = tmp_path / "home"
    (home / "workflows" / "global").mkdir(parents=True)
    shutil.copy(SPEC, home / "workflows" / "global" / "feature-development.workflow.yaml")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))

    app = FastAPI()
    app.include_router(_load_router().router)
    return TestClient(app)


def _row(client: TestClient, workflow_id: str = "feature-development") -> dict:
    rows = client.get("/workflows").json()["workflows"]
    return next(r for r in rows if r["id"] == workflow_id)


def test_list_carries_enabled_and_run_columns(client: TestClient) -> None:
    row = _row(client)
    # Every Templates-page column is present; a fresh workflow has no run yet.
    for key in ("enabled", "last_run_at", "last_status", "next_run_at"):
        assert key in row, key
    assert row["enabled"] is True  # absent in the spec -> enabled
    assert row["last_run_at"] is None
    assert row["next_run_at"] is None  # manual workflow -> no cron schedule


def test_last_run_columns_reflect_the_latest_run(client: TestClient) -> None:
    started = client.post("/workflows/feature-development/run", json=_RUN_BODY)
    assert started.status_code == 200, started.text
    row = _row(client)
    assert row["last_run_at"] is not None
    assert row["last_status"] is not None


def test_toggle_disables_then_re_enables(client: TestClient) -> None:
    off = client.put("/workflows/feature-development/enabled", json={"enabled": False})
    assert off.status_code == 200, off.text
    assert _row(client)["enabled"] is False

    on = client.put("/workflows/feature-development/enabled", json={"enabled": True})
    assert on.status_code == 200
    assert _row(client)["enabled"] is True


def test_disabled_workflow_run_is_409(client: TestClient) -> None:
    client.put("/workflows/feature-development/enabled", json={"enabled": False})
    blocked = client.post("/workflows/feature-development/run", json=_RUN_BODY)
    assert blocked.status_code == 409

    # re-enabling re-allows the run
    client.put("/workflows/feature-development/enabled", json={"enabled": True})
    allowed = client.post("/workflows/feature-development/run", json=_RUN_BODY)
    assert allowed.status_code == 200, allowed.text


def test_toggle_unknown_workflow_is_404(client: TestClient) -> None:
    resp = client.put("/workflows/ghost/enabled", json={"enabled": False})
    assert resp.status_code == 404


def test_export_template_returns_both_artifacts(client: TestClient) -> None:
    # No config.yaml in the temp home → no default model → deterministic
    # (fail-open) generation, so the route needs no live gateway.
    resp = client.get("/workflows/feature-development/export-template")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["yaml_filename"] == "feature-development.template.yaml"
    assert body["md_filename"] == "feature-development.template.md"
    assert "${PROFILE:" in body["yaml"]
    assert "product-tech-lead" not in body["yaml"]
    assert "Prerequisites" in body["md"]
    assert body["human_version"].startswith("fmt")
    # Second call is served from cache.
    again = client.get("/workflows/feature-development/export-template")
    assert again.json()["cached"] is True


def test_export_template_unknown_workflow_is_404(client: TestClient) -> None:
    resp = client.get("/workflows/ghost/export-template")
    assert resp.status_code == 404

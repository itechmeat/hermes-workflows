"""Settings page routes: read effective settings + schema, and persist edits to
the Hermes config `plugins.workflows` namespace. Skipped where fastapi or the
Hermes config module is unavailable."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("hermes_cli.config")
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
PLUGIN_API = ROOT / "dashboard" / "plugin_api.py"


def _load_router():
    spec = importlib.util.spec_from_file_location("hw_dashboard_api_settings", PLUGIN_API)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("HERMES_WORKFLOWS_BOARD", raising=False)
    app = FastAPI()
    app.include_router(_load_router().router)
    return TestClient(app)


def test_get_settings_returns_values_and_schema(client: TestClient) -> None:
    resp = client.get("/settings")
    assert resp.status_code == 200
    body = resp.json()
    assert body["values"]["default_mode"] == "durable"
    assert body["values"]["fail_open"] is True
    keys = {f["key"] for g in body["schema"]["groups"] for f in g["fields"]}
    assert "internal_board" in keys


def test_put_settings_persists_and_re_reads(client: TestClient) -> None:
    resp = client.put("/settings", json={"internal_board": "my-board", "fail_open": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["values"]["internal_board"] == "my-board"
    assert resp.json()["values"]["fail_open"] is False
    # persisted: a fresh GET reflects the change
    again = client.get("/settings").json()["values"]
    assert again["internal_board"] == "my-board"
    assert again["fail_open"] is False


def test_put_invalid_enum_is_400(client: TestClient) -> None:
    assert client.put("/settings", json={"default_mode": "sideways"}).status_code == 400


def test_put_unknown_key_is_400(client: TestClient) -> None:
    assert client.put("/settings", json={"totally_unknown": 1}).status_code == 400


def test_put_does_not_clobber_other_config(client: TestClient, tmp_path: Path) -> None:
    import yaml

    home = tmp_path / "home"
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(yaml.safe_dump({"model": {"default": "keep-me"}}))

    assert client.put("/settings", json={"internal_board": "b2"}).status_code == 200
    saved = yaml.safe_load((home / "config.yaml").read_text())
    assert saved["model"]["default"] == "keep-me"
    assert saved["plugins"]["workflows"]["internal_board"] == "b2"

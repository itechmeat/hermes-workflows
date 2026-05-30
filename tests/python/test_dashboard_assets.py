"""The dashboard ships the real-contract manifest plus the built frontend bundle
(from apps/dashboard) that registers the Workflows tab and talks to the API."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DASHBOARD = ROOT / "dashboard"


def test_manifest_matches_the_hermes_contract() -> None:
    manifest = json.loads((DASHBOARD / "manifest.json").read_text())
    assert manifest["name"] == "workflows"
    assert manifest["entry"] == "dist/index.js"
    assert manifest["css"] == "dist/index.css"
    assert manifest["api"] == "plugin_api.py"
    assert manifest["tab"]["path"] == "/workflows"


def test_bundle_registers_a_tab_and_reads_the_api() -> None:
    bundle = (DASHBOARD / "dist" / "index.js").read_text()
    assert "__HERMES_PLUGINS__" in bundle
    assert "register" in bundle
    assert "workflows" in bundle
    # The API client builds paths from this base; the o2b badge hits o2b-status.
    assert "/api/plugins/workflows" in bundle
    assert "o2b-status" in bundle


def test_stylesheet_is_present_for_the_manifest_css_entry() -> None:
    css = (DASHBOARD / "dist" / "index.css").read_text()
    assert len(css) > 0
    # @xyflow/react ships its canvas styles under the .react-flow namespace.
    assert ".react-flow" in css

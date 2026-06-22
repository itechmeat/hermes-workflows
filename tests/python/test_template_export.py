"""`export --as-template` orchestration: probe → (best-effort AI hints) → write,
with composite-key caching. Runs the real Bun core CLI against a temp Hermes
home; the model call is stubbed so the test never touches a live gateway."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from hermes_workflows import template_export

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "examples" / "feature-development.workflow.yaml"


@pytest.fixture()
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    h = tmp_path / "home"
    (h / "workflows" / "global").mkdir(parents=True)
    shutil.copy(SPEC, h / "workflows" / "global" / "feature-development.workflow.yaml")
    monkeypatch.setenv("HERMES_HOME", str(h))
    return h


def test_export_writes_both_files_with_placeholders_and_prereqs(
    home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"n": 0}

    def fake_hints(model, request, **kwargs):
        calls["n"] += 1
        return {
            "overview": "Ships a feature end to end.",
            "nodes": [{"nodeId": "plan", "role": "veteran planner", "capability": "deep reasoning"}],
        }

    monkeypatch.setattr(template_export, "generate_hints", fake_hints)
    monkeypatch.setattr(template_export, "default_model", lambda: "test-model@prov")

    bundle = template_export.export("feature-development")

    assert bundle["cached"] is False
    assert bundle["yaml_filename"] == "feature-development.template.yaml"
    assert bundle["md_filename"] == "feature-development.template.md"
    # De-bound: no concrete profile, placeholders present.
    assert "product-tech-lead" not in bundle["yaml"]
    assert "${PROFILE:" in bundle["yaml"]
    # Guide: prerequisites first + the AI hint surfaced.
    assert "Prerequisites" in bundle["md"]
    assert "REQUIRED" in bundle["md"]
    assert "veteran planner" in bundle["md"]
    assert calls["n"] == 1


def test_second_export_is_cached_without_a_model_call(
    home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"n": 0}

    def fake_hints(model, request, **kwargs):
        calls["n"] += 1
        return {"nodes": []}

    monkeypatch.setattr(template_export, "generate_hints", fake_hints)
    monkeypatch.setattr(template_export, "default_model", lambda: "test-model")

    first = template_export.export("feature-development")
    assert first["cached"] is False
    assert calls["n"] == 1

    second = template_export.export("feature-development")
    assert second["cached"] is True
    # The cache hit must NOT invoke the model again.
    assert calls["n"] == 1


def test_spec_edit_regenerates(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(template_export, "generate_hints", lambda *a, **k: None)
    monkeypatch.setattr(template_export, "default_model", lambda: None)

    template_export.export("feature-development")
    assert template_export.export("feature-development")["cached"] is True

    spec = home / "workflows" / "global" / "feature-development.workflow.yaml"
    spec.write_text(spec.read_text().replace("merged feature.", "merged feature, carefully."))
    assert template_export.export("feature-development")["cached"] is False


def test_fail_open_when_no_model(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # No default model and no hints — the export still produces a valid bundle.
    monkeypatch.setattr(template_export, "default_model", lambda: None)
    bundle = template_export.export("feature-development")
    assert bundle["cached"] is False
    assert "${PROFILE:" in bundle["yaml"]
    assert "Prerequisites" in bundle["md"]


def test_extract_json_handles_fenced_and_bare() -> None:
    assert template_export._extract_json('{"a": 1}') == {"a": 1}
    assert template_export._extract_json('```json\n{"a": 2}\n```') == {"a": 2}
    assert template_export._extract_json('noise {"a": 3} trailing') == {"a": 3}
    assert template_export._extract_json("not json at all") is None

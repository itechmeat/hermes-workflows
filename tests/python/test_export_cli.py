"""Operator CLI: `hermes-workflows export <id> --as-template` writes the bundle
and prints its envelope. The model call is stubbed (fail-open path)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from hermes_workflows import cli as wf_cli
from hermes_workflows import template_export

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "examples" / "feature-development.workflow.yaml"


@pytest.fixture()
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    h = tmp_path / "home"
    (h / "workflows" / "global").mkdir(parents=True)
    shutil.copy(SPEC, h / "workflows" / "global" / "feature-development.workflow.yaml")
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setattr(template_export, "default_model", lambda: None)
    return h


def test_export_as_template_writes_and_prints(
    home: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "bundle"
    rc = wf_cli.main(["export", "feature-development", "--as-template", "--out-dir", str(out)])
    assert rc == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["yaml_filename"] == "feature-development.template.yaml"
    assert (out / "feature-development.template.yaml").is_file()
    assert (out / "feature-development.template.md").is_file()


def test_export_without_flag_is_rejected(home: Path) -> None:
    with pytest.raises(SystemExit):
        wf_cli.main(["export", "feature-development"])

"""P4.1 — the ``hermes-workflows`` entrypoint: run / status / advance-all /
review delegate to the orchestrator and emit JSON, on a temp Hermes home.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")
cj = pytest.importorskip("cron.jobs")

from hermes_workflows import cli

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "examples" / "feature-development.workflow.yaml"


@pytest.fixture()
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    h = tmp_path / "home"
    (h / "workflows" / "global").mkdir(parents=True)
    shutil.copy(SPEC, h / "workflows" / "global" / "feature-development.workflow.yaml")
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    # Redirect cron writes so the tick (advance-all -> sync_workflow_tick) never
    # touches the real ~/.hermes/cron.
    cron_dir = tmp_path / "cron"
    cron_dir.mkdir()
    monkeypatch.setattr(cj, "CRON_DIR", cron_dir)
    monkeypatch.setattr(cj, "JOBS_FILE", cron_dir / "jobs.json")
    monkeypatch.setattr(cj, "OUTPUT_DIR", cron_dir / "output")
    return h


def _invoke(capsys, *argv: str):
    assert cli.main(list(argv)) == 0
    return json.loads(capsys.readouterr().out)


def test_run_status_and_advance_all(home: Path, capsys) -> None:
    run = _invoke(capsys, "run", "feature-development")
    run_id = run["run_id"]
    assert run_id.startswith("feature-development-")
    assert run["nodes"]["plan"]["status"] == "scheduled"

    status = _invoke(capsys, "status", run_id)
    assert status["run_id"] == run_id
    assert status["workflow_id"] == "feature-development"

    tick = _invoke(capsys, "advance-all")
    assert any(r["run_id"] == run_id for r in tick["advanced"])
    assert tick["active"] is True


def test_unknown_workflow_exits(home: Path) -> None:
    with pytest.raises(SystemExit):
        cli.main(["run", "no-such-workflow"])


def test_wrapper_script_is_executable() -> None:
    wrapper = ROOT / "bin" / "hermes-workflows"
    assert wrapper.is_file()
    assert os.access(wrapper, os.X_OK)
    assert "hermes_workflows.cli" in wrapper.read_text()


def test_run_arms_the_tick_for_an_active_run(home: Path, capsys) -> None:
    """A CLI-started run must leave the advance tick armed — without it a
    multi-node run stalls after the first step (nothing else calls advance)."""
    from hermes_workflows.bridge import cron as cron_bridge

    run = _invoke(capsys, "run", "feature-development")
    assert run["status"] == "running"
    assert cron_bridge.find_by_name(cron_bridge.TICK_NAME) is not None

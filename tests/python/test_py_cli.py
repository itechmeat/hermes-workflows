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


def test_run_threads_operator_input_into_run_state(home: Path, capsys) -> None:
    """`run --input` persists the operator's free-form input on the run, so the
    engine layers it above every agent_task prompt at highest priority. It
    survives a fresh status load (durable, not in-memory)."""
    run = _invoke(capsys, "run", "feature-development", "--input", "scope = only X; be terse")
    assert run["input"] == "scope = only X; be terse"

    status = _invoke(capsys, "status", run["run_id"])
    assert status["input"] == "scope = only X; be terse"


def test_run_without_input_has_no_run_input(home: Path, capsys) -> None:
    run = _invoke(capsys, "run", "feature-development")
    assert run.get("input") is None


def test_unknown_workflow_exits(home: Path) -> None:
    with pytest.raises(SystemExit):
        cli.main(["run", "no-such-workflow"])


def test_cancel_marks_the_run_and_active_nodes(home: Path, capsys) -> None:
    """`cancel <run_id>` stops a run from the shell: the run and its active
    nodes go cancelled, and a second cancel is an idempotent no-op."""
    run = _invoke(capsys, "run", "feature-development")
    run_id = run["run_id"]
    assert run["nodes"]["plan"]["status"] == "scheduled"

    cancelled = _invoke(capsys, "cancel", run_id)
    assert cancelled["status"] == "cancelled"
    assert cancelled["nodes"]["plan"]["status"] == "cancelled"

    # Idempotent: cancelling an already-terminal run leaves it cancelled.
    again = _invoke(capsys, "cancel", run_id)
    assert again["status"] == "cancelled"

    # The persisted run reflects the cancellation.
    assert _invoke(capsys, "status", run_id)["status"] == "cancelled"


def test_wrapper_script_is_executable() -> None:
    wrapper = ROOT / "bin" / "hermes-workflows"
    assert wrapper.is_file()
    assert os.access(wrapper, os.X_OK)
    assert "hermes_workflows.cli" in wrapper.read_text()


def test_run_refuses_a_second_active_run_cleanly(home: Path, capsys) -> None:
    """Single-flight: a second `run` of the same workflow exits with the core's
    message (a clean SystemExit naming the active run, not a traceback)."""
    first = _invoke(capsys, "run", "feature-development")

    with pytest.raises(SystemExit) as exc_info:
        cli.main(["run", "feature-development"])
    message = str(exc_info.value)
    assert first["run_id"] in message
    assert "active run" in message


def test_run_arms_the_tick_for_an_active_run(home: Path, capsys) -> None:
    """A CLI-started run must leave the advance tick armed — without it a
    multi-node run stalls after the first step (nothing else calls advance)."""
    from hermes_workflows.bridge import cron as cron_bridge

    run = _invoke(capsys, "run", "feature-development")
    assert run["status"] == "running"
    assert cron_bridge.find_by_name(cron_bridge.TICK_NAME) is not None

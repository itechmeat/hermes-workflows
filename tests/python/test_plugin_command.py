"""The `/workflow` in-chat slash command (registered via ctx.register_command,
available in CLI and gateway/messenger sessions): a thin front-end over the same
tools, parsing subcommands and returning a short human-readable line.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")
cj = pytest.importorskip("cron.jobs")

from hermes_workflows import plugin

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "examples" / "feature-development.workflow.yaml"


@pytest.fixture()
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    h = tmp_path / "home"
    (h / "workflows" / "global").mkdir(parents=True)
    shutil.copy(SPEC, h / "workflows" / "global" / "feature-development.workflow.yaml")
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    cron_dir = tmp_path / "cron"
    cron_dir.mkdir()
    monkeypatch.setattr(cj, "CRON_DIR", cron_dir)
    monkeypatch.setattr(cj, "JOBS_FILE", cron_dir / "jobs.json")
    monkeypatch.setattr(cj, "OUTPUT_DIR", cron_dir / "output")
    return h


def test_no_args_and_help_show_usage() -> None:
    assert plugin._handle_command("").startswith("Usage: /workflow")
    assert plugin._handle_command("help").startswith("Usage: /workflow")


def test_unknown_subcommand_shows_usage() -> None:
    assert plugin._handle_command("frobnicate").startswith("Usage: /workflow")


def test_list_names_the_workflow(home: Path) -> None:
    out = plugin._handle_command("list")
    assert "feature-development" in out


def test_run_then_status_then_cancel(home: Path) -> None:
    started = plugin._handle_command("run feature-development")
    assert started.startswith("Started run ")
    run_id = started.removeprefix("Started run ").split(" ")[0]

    status = plugin._handle_command(f"status {run_id}")
    assert run_id in status and "Run" in status

    cancelled = plugin._handle_command(f"cancel {run_id}")
    assert "Cancelled run" in cancelled and run_id in cancelled


def test_review_usage_when_underspecified() -> None:
    assert "Usage: /workflow review" in plugin._handle_command("review onlytwo args")


def test_failure_is_reported_as_text(home: Path) -> None:
    # An unknown run id surfaces as a text error, never an exception.
    out = plugin._handle_command("status no_such_run")
    assert "workflow command failed" in out

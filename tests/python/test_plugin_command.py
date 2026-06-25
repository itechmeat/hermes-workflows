"""The `/workflow` in-chat slash command (registered via ctx.register_command,
available in CLI and gateway/messenger sessions): a thin front-end over the same
tools, parsing subcommands and returning a short human-readable line.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")
pytest.importorskip("cron.jobs")

from hermes_workflows import plugin

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "examples" / "feature-development.workflow.yaml"


@pytest.fixture()
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    h = tmp_path / "home"
    (h / "workflows" / "global").mkdir(parents=True)
    shutil.copy(SPEC, h / "workflows" / "global" / "feature-development.workflow.yaml")
    # A second, parameter-free workflow for the NL-entry test: the free-text
    # path carries only operator input, so it cannot fill a required param.
    shutil.copy(
        ROOT / "examples" / "blog-daily-signals.workflow.yaml",
        h / "workflows" / "global" / "blog-daily-signals.workflow.yaml",
    )
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    return h


def test_no_args_and_help_show_usage() -> None:
    assert plugin._handle_command("").startswith("Usage: /workflow")
    assert plugin._handle_command("help").startswith("Usage: /workflow")


def test_unmatched_free_text_asks_which_workflow(home: Path) -> None:
    # Not an explicit subcommand and not a recognizable workflow: ask, never guess.
    out = plugin._handle_command("frobnicate the whatsit")
    assert "could not match" in out and "feature-development" in out


def test_nl_entry_resolves_target_and_operator_input(home: Path) -> None:
    # Free text whose leading run is a workflow id starts that workflow, carrying
    # the remainder as the operator input (t_77d752f7). Uses a parameter-free
    # workflow: the NL path carries only input, never template params.
    out = plugin._handle_command("blog-daily-signals take 2-3 minor related tasks")
    assert out.startswith("Started run ")
    assert 'input: "take 2-3 minor related tasks"' in out


def test_run_subcommand_parses_input_flag(home: Path) -> None:
    # The explicit `run` subcommand consumes everything after --input as the
    # operator prompt and starts the run (no project arg for a global workflow).
    out = plugin._handle_command(
        'run feature-development feature_request="add a dark mode toggle" '
        "--input scope only bugfixes"
    )
    assert out.startswith("Started run ")


def test_parse_run_args_splits_project_from_params() -> None:
    # The first bare token is the project; every name=value token is a param.
    project, params = plugin._parse_run_args(["acme", "region=eu", "tier=gold"])
    assert project == "acme"
    assert params == {"region": "eu", "tier": "gold"}


def test_parse_run_args_params_only_no_project() -> None:
    project, params = plugin._parse_run_args(["count=3"])
    assert project is None
    assert params == {"count": "3"}


def test_parse_run_args_rejects_a_stray_bare_token() -> None:
    # A second bare token (after the project) is ambiguous - a typo'd param
    # missing its `=`. Fail loud rather than silently dropping it.
    with pytest.raises(ValueError):
        plugin._parse_run_args(["acme", "oops", "region=eu"])


def test_parse_run_args_rejects_an_empty_param_name() -> None:
    with pytest.raises(ValueError):
        plugin._parse_run_args(["=value"])


def test_run_subcommand_reports_a_malformed_arg_as_text(home: Path) -> None:
    # The slash handler never raises to the gateway: a malformed run arg comes
    # back as a short failure line.
    out = plugin._handle_command("run feature-development oops extra")
    assert "failed" in out.lower()


def test_tokenize_keeps_quoted_param_value_as_one_token() -> None:
    # A text param value with spaces is quoted by the slash-command emitter and
    # must survive tokenisation as a single name=value token.
    tokens = plugin._tokenize('run wf region="two words"')
    assert tokens == ["run", "wf", "region=two words"]


def test_run_subcommand_rejects_unknown_param(home: Path) -> None:
    # `run <id> name=value` flows the param to the core, which validates it
    # against the workflow's declared params and fails loud on an unknown name
    # (feature-development declares feature_request, not scope). The slash
    # command reports it as text.
    out = plugin._handle_command("run feature-development scope=bugfixes")
    assert "unknown param" in out and "scope" in out


def test_list_names_the_workflow(home: Path) -> None:
    out = plugin._handle_command("list")
    assert "feature-development" in out


def test_run_then_status_then_cancel(home: Path) -> None:
    started = plugin._handle_command(
        'run feature-development feature_request="add a dark mode toggle"'
    )
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

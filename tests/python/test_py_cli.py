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
pytest.importorskip("cron.jobs")

from conftest import EXAMPLE_PARAMS
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
    # The cron store is redirected to a tmp dir by the autouse
    # _sandbox_cron_store fixture in conftest, so the tick never touches the
    # real ~/.hermes/cron.
    return h


def _invoke(capsys, *argv: str):
    assert cli.main(list(argv)) == 0
    return json.loads(capsys.readouterr().out)


def test_run_status_and_advance_all(home: Path, capsys) -> None:
    run = _invoke(capsys, "run", "feature-development", "--params", json.dumps(EXAMPLE_PARAMS))
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
    run = _invoke(capsys, "run", "feature-development", "--input", "scope = only X; be terse", "--params", json.dumps(EXAMPLE_PARAMS))
    assert run["input"] == "scope = only X; be terse"

    status = _invoke(capsys, "status", run["run_id"])
    assert status["input"] == "scope = only X; be terse"


def test_run_without_input_has_no_run_input(home: Path, capsys) -> None:
    run = _invoke(capsys, "run", "feature-development", "--params", json.dumps(EXAMPLE_PARAMS))
    assert run.get("input") is None


def test_run_missing_required_param_exits_cleanly(home: Path) -> None:
    """A run started without the required feature_request param fails closed with
    the core's message (a clean SystemExit, not a traceback)."""
    with pytest.raises(SystemExit) as exc_info:
        cli.main(["run", "feature-development"])
    assert "missing required value: feature_request (Feature request)" in str(exc_info.value)


def test_run_with_malformed_params_json_exits_cleanly(home: Path) -> None:
    with pytest.raises(SystemExit) as exc_info:
        cli.main(["run", "feature-development", "--params", "{not json"])
    assert "--params is not valid JSON" in str(exc_info.value)


def test_unknown_workflow_exits(home: Path) -> None:
    with pytest.raises(SystemExit):
        cli.main(["run", "no-such-workflow"])


def test_cancel_marks_the_run_and_active_nodes(home: Path, capsys) -> None:
    """`cancel <run_id>` stops a run from the shell: the run and its active
    nodes go cancelled, and a second cancel is an idempotent no-op."""
    run = _invoke(capsys, "run", "feature-development", "--params", json.dumps(EXAMPLE_PARAMS))
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
    first = _invoke(capsys, "run", "feature-development", "--params", json.dumps(EXAMPLE_PARAMS))

    with pytest.raises(SystemExit) as exc_info:
        cli.main(["run", "feature-development", "--params", json.dumps(EXAMPLE_PARAMS)])
    message = str(exc_info.value)
    assert first["run_id"] in message
    assert "active run" in message


def test_run_arms_the_tick_for_an_active_run(home: Path, capsys) -> None:
    """A CLI-started run must leave the advance tick armed — without it a
    multi-node run stalls after the first step (nothing else calls advance)."""
    from hermes_workflows.bridge import cron as cron_bridge

    run = _invoke(capsys, "run", "feature-development", "--params", json.dumps(EXAMPLE_PARAMS))
    assert run["status"] == "running"
    assert cron_bridge.find_by_name(cron_bridge.TICK_NAME) is not None


def _repo_local_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, seed_global: bool = False
) -> tuple[Path, Path]:
    """A temp Hermes home plus a separate project dir holding a repo-local spec.
    With ``seed_global`` the same workflow is also registered globally, so a run
    can fall back to it once the repo-local copy is gone."""
    h = tmp_path / "home"
    global_dir = h / "workflows" / "global"
    global_dir.mkdir(parents=True)
    if seed_global:
        shutil.copy(SPEC, global_dir / "feature-development.workflow.yaml")
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))

    project = tmp_path / "repo"
    local_dir = project / ".hermes" / "workflows"
    local_dir.mkdir(parents=True)
    shutil.copy(SPEC, local_dir / "feature-development.workflow.yaml")
    return project, local_dir


def test_run_discovers_repo_local_workflow_and_persists_its_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    project, local_dir = _repo_local_home(tmp_path, monkeypatch)
    local_spec = str(local_dir / "feature-development.workflow.yaml")

    monkeypatch.chdir(project)
    run = _invoke(
        capsys, "run", "feature-development", "--params", json.dumps(EXAMPLE_PARAMS)
    )
    assert run["workflow_path"] == local_spec

    # The persisted path keeps status/advance working from any other cwd.
    monkeypatch.chdir(tmp_path)
    status = _invoke(capsys, "status", run["run_id"])
    assert status["workflow_path"] == local_spec

    tick = _invoke(capsys, "advance-all")
    assert any(r["run_id"] == run["run_id"] for r in tick["advanced"])


def test_repo_local_spec_wins_over_a_global_id_collision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """When the same workflow id exists in BOTH a global root and the repo-local
    dir, resolution must favour the repo-local copy — not silently shadow it
    behind the global one. This is the v0.7.2 (#27) repo-local-discovery intent."""
    project, local_dir = _repo_local_home(tmp_path, monkeypatch, seed_global=True)
    local_spec = str(local_dir / "feature-development.workflow.yaml")

    monkeypatch.chdir(project)
    run = _invoke(
        capsys, "run", "feature-development", "--params", json.dumps(EXAMPLE_PARAMS)
    )
    assert run["workflow_path"] == local_spec


def test_advance_falls_back_to_global_when_stored_spec_is_gone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """If the repo-local spec the run was created from disappears (project moved
    or deleted), the run is still advanceable as long as the workflow resolves by
    id from a configured root — the stale stored path must not strand it."""
    project, local_dir = _repo_local_home(tmp_path, monkeypatch, seed_global=True)

    monkeypatch.chdir(project)
    run = _invoke(
        capsys, "run", "feature-development", "--params", json.dumps(EXAMPLE_PARAMS)
    )

    # The repo-local spec goes away; the global copy remains.
    shutil.rmtree(project)
    monkeypatch.chdir(tmp_path)

    tick = _invoke(capsys, "advance-all")
    assert any(r["run_id"] == run["run_id"] for r in tick["advanced"])

"""Operator-facing resume of a stalled/failed run: ``hermes-workflows resume``
resets the failed node (or the whole graph), keeps the completed prefix, and
advances under the CURRENT spec. Spec drift is refused; single-flight is kept.

Uses the real Bun core CLI on a temp Hermes home with a project board.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")
pytest.importorskip("cron.jobs")

from hermes_workflows import cli

ROOT = Path(__file__).resolve().parents[2]

_SPEC_ORIGINAL = """\
id: resumable
name: Resumable
version: 1
scope:
  type: project
  projects: [demo]
trigger: { type: manual }
defaults: { profile: eng }
nodes:
  - id: a
    type: agent_task
    title: A
    prompt: "Do A."
  - id: b
    type: agent_task
    title: B
    prompt: "Do B ORIGINAL."
  - id: done
    type: finish
    outcome: success
edges:
  - { from: a, to: b }
  - { from: b, to: done }
"""


@pytest.fixture()
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    h = tmp_path / "home"
    (h / "workflows" / "global").mkdir(parents=True)
    (h / "workflows" / "global" / "resumable.workflow.yaml").write_text(_SPEC_ORIGINAL)
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    return h


def _invoke(capsys, *argv: str):
    assert cli.main(list(argv)) == 0
    return json.loads(capsys.readouterr().out)


def _spec_path(home: Path) -> Path:
    return home / "workflows" / "global" / "resumable.workflow.yaml"


def _fail_after_a(run_id: str) -> dict:
    """Drive the persisted run into a 'b failed' terminal state: node ``a``
    completed (with output), node ``b`` failed, run failed."""
    engine = cli.build_engine()
    run = engine.status(run_id)
    run["nodes"]["a"]["status"] = "completed"
    run["nodes"]["a"]["outcome"] = "success"
    run["nodes"]["a"]["seq"] = 1
    run["nodes"]["a"]["output"] = "A DONE OK"
    run["nodes"]["b"]["status"] = "failed"
    run["nodes"]["b"]["outcome"] = "failure"
    run["nodes"]["b"]["seq"] = 2
    run["status"] = "failed"
    engine._save(run)
    return run


def _card_body(card_id: str) -> str:
    board = kb.connect(board="demo")
    try:
        row = board.execute("SELECT body FROM tasks WHERE id = ?", (card_id,)).fetchone()
        return row[0] if row else ""
    finally:
        board.close()


def test_resume_reruns_the_failed_node_keeping_the_completed_prefix(home: Path, capsys) -> None:
    run = _invoke(capsys, "run", "resumable")
    run_id = run["run_id"]
    _fail_after_a(run_id)

    resumed = _invoke(capsys, "resume", run_id)
    assert resumed["status"] == "running"
    # The failed node is reset and re-scheduled; the completed prefix is kept.
    assert resumed["nodes"]["b"]["status"] == "scheduled"
    assert resumed["nodes"]["b"]["hermes_task_id"]
    assert resumed["nodes"]["a"]["status"] == "completed"
    assert resumed["nodes"]["a"]["output"] == "A DONE OK"


def test_resume_reads_the_live_spec_for_the_failed_node(home: Path, capsys) -> None:
    """The headline value: a fix applied to the failed node's prompt takes
    effect on resume (advance reads the live spec), without redoing the prefix."""
    run = _invoke(capsys, "run", "resumable")
    run_id = run["run_id"]
    _fail_after_a(run_id)

    # Operator fixes node b's prompt in the spec, then resumes.
    _spec_path(home).write_text(_SPEC_ORIGINAL.replace("Do B ORIGINAL.", "Do B FIXED."))
    resumed = _invoke(capsys, "resume", run_id)

    card_id = resumed["nodes"]["b"]["hermes_task_id"]
    body = _card_body(card_id)
    assert "Do B FIXED." in body
    assert "Do B ORIGINAL." not in body


def test_resume_refuses_structural_spec_drift(home: Path, capsys) -> None:
    run = _invoke(capsys, "run", "resumable")
    run_id = run["run_id"]
    _fail_after_a(run_id)

    # A node added since the run started: the live node set no longer matches the
    # run's persisted nodes -> resume must refuse rather than advance.
    drifted = _SPEC_ORIGINAL.replace(
        "  - id: done\n",
        "  - id: extra\n    type: agent_task\n    title: Extra\n    prompt: \"X.\"\n  - id: done\n",
    ).replace("  - { from: b, to: done }\n", "  - { from: b, to: extra }\n  - { from: extra, to: done }\n")
    _spec_path(home).write_text(drifted)

    with pytest.raises(SystemExit) as exc:
        cli.main(["resume", run_id])
    msg = str(exc.value)
    assert "drift" in msg.lower()
    assert "extra" in msg


def test_resume_refuses_node_type_drift(home: Path, capsys) -> None:
    run = _invoke(capsys, "run", "resumable")
    run_id = run["run_id"]
    _fail_after_a(run_id)

    # Same id set, but node b changed kind: resuming into it would replay a
    # failed agent_task as a script under a run created for another graph shape.
    drifted = _SPEC_ORIGINAL.replace(
        "  - id: b\n    type: agent_task\n    title: B\n    prompt: \"Do B ORIGINAL.\"\n",
        "  - id: b\n    type: script\n    title: B\n    command: \"echo B\"\n",
    )
    _spec_path(home).write_text(drifted)

    with pytest.raises(SystemExit) as exc:
        cli.main(["resume", run_id])
    msg = str(exc.value)
    assert "drift" in msg.lower()
    assert "retyped" in msg
    assert "b" in msg



def test_resume_all_restarts_the_whole_graph(home: Path, capsys) -> None:
    run = _invoke(capsys, "run", "resumable")
    run_id = run["run_id"]
    _fail_after_a(run_id)

    resumed = _invoke(capsys, "resume", run_id, "--all")
    # Full restart: the entry node is scheduled again and the prefix is wiped.
    assert resumed["status"] == "running"
    assert resumed["nodes"]["a"]["status"] == "scheduled"
    assert resumed["nodes"]["a"].get("output") is None


def test_resume_node_targets_an_explicit_failed_node(home: Path, capsys) -> None:
    run = _invoke(capsys, "run", "resumable")
    run_id = run["run_id"]
    _fail_after_a(run_id)

    resumed = _invoke(capsys, "resume", run_id, "--node", "b")
    assert resumed["nodes"]["b"]["status"] == "scheduled"
    assert resumed["nodes"]["a"]["status"] == "completed"


def test_resume_refuses_a_non_failed_node(home: Path, capsys) -> None:
    run = _invoke(capsys, "run", "resumable")
    run_id = run["run_id"]
    _fail_after_a(run_id)

    # 'a' is completed, not failed -> RetryError surfaced as a clean SystemExit.
    with pytest.raises(SystemExit):
        cli.main(["resume", run_id, "--node", "a"])


def test_resume_refuses_an_active_run(home: Path, capsys) -> None:
    run = _invoke(capsys, "run", "resumable")
    run_id = run["run_id"]
    # The run is still active (entry node scheduled): resume is a refusal.
    with pytest.raises(SystemExit) as exc:
        cli.main(["resume", run_id])
    assert "resum" in str(exc.value).lower()


def test_resume_with_no_failed_node_refuses_and_hints_all(home: Path, capsys) -> None:
    run = _invoke(capsys, "run", "resumable")
    run_id = run["run_id"]
    # Cancel -> nodes go cancelled, not failed: bare resume has no failed node.
    _invoke(capsys, "cancel", run_id)

    with pytest.raises(SystemExit) as exc:
        cli.main(["resume", run_id])
    assert "--all" in str(exc.value)


def test_resume_node_and_all_are_mutually_exclusive(home: Path) -> None:
    with pytest.raises(SystemExit):
        cli.main(["resume", "whatever", "--node", "b", "--all"])


def test_resume_refused_while_a_sibling_run_is_active(home: Path, capsys) -> None:
    """Single-flight: reviving the failed run next to an active sibling of the
    same workflow is refused with the core's message (clean SystemExit)."""
    first = _invoke(capsys, "run", "resumable")
    first_id = first["run_id"]
    _fail_after_a(first_id)
    second = _invoke(capsys, "run", "resumable")  # allowed: first is terminal

    with pytest.raises(SystemExit) as exc:
        cli.main(["resume", first_id])
    assert second["run_id"] in str(exc.value)

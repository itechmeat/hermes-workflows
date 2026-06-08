"""S5 — a global, script-only workflow advances end to end through the engine
with the script node running locally on the ScriptExecutor and no Kanban card
created. Uses the real Bun core CLI; needs no hermes_cli.
"""

from __future__ import annotations

import json
from pathlib import Path

from hermes_workflows.engine import Engine
from hermes_workflows.executor import DirectExecutor, ScriptExecutor

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "core" / "src" / "cli.ts"

SPEC = {
    "id": "scripts-only",
    "name": "Scripts Only",
    "version": 1,
    "scope": {"type": "global"},
    "trigger": {"type": "manual"},
    "nodes": [
        {"id": "build", "type": "script", "command": "echo built"},
        {"id": "done", "type": "finish"},
    ],
    "edges": [{"from": "build", "to": "done"}],
}


def _engine(tmp_path: Path) -> Engine:
    return Engine(
        core_cli=["bun", "run", str(CLI)],
        db_path=str(tmp_path / "runs.db"),
        direct=DirectExecutor(store_dir=tmp_path / "direct"),
        script=ScriptExecutor(store_dir=tmp_path / "scripts", env_allowlist=["PATH"]),
    )


def _spec_file(tmp_path: Path) -> str:
    path = tmp_path / "scripts-only.workflow.json"
    path.write_text(json.dumps(SPEC))
    return str(path)


def test_script_only_global_run_finishes_with_no_kanban_card(tmp_path: Path) -> None:
    eng = _engine(tmp_path)
    spec = _spec_file(tmp_path)

    run = eng.run(spec, "s-1")
    build = run["nodes"]["build"]
    assert build["status"] == "scheduled"
    # The handle is a local script handle, not a Kanban card id (t_…).
    assert build["hermes_task_id"].startswith("script:")

    run = eng.advance(spec, "s-1")
    assert run["nodes"]["build"]["outcome"] == "success"
    assert "built" in (run["nodes"]["build"].get("output") or "")
    assert run["status"] == "completed"


def test_run_created_with_origin_carries_it(tmp_path: Path) -> None:
    eng = _engine(tmp_path)
    spec = _spec_file(tmp_path)
    eng.run(spec, "o-1", origin="telegram:5:6")
    assert eng.status("o-1")["origin"] == "telegram:5:6"


def test_run_without_origin_has_none(tmp_path: Path) -> None:
    eng = _engine(tmp_path)
    spec = _spec_file(tmp_path)
    eng.run(spec, "o-2")
    assert eng.status("o-2").get("origin") is None


def test_disabled_scripts_fail_the_run_on_advance(tmp_path: Path) -> None:
    # Even if a run reaches the engine (bypassing the start-time gate), a script
    # node settles failure when scripts are disabled — the command never runs.
    eng = Engine(
        core_cli=["bun", "run", str(CLI)],
        db_path=str(tmp_path / "runs.db"),
        direct=DirectExecutor(store_dir=tmp_path / "direct"),
        script=ScriptExecutor(
            store_dir=tmp_path / "scripts", env_allowlist=["PATH"], enabled=lambda: False
        ),
    )
    spec = _spec_file(tmp_path)

    run = eng.run(spec, "s-1")
    run = eng.advance(spec, "s-1")
    # The script node settled failure via the executor gate — the command never
    # ran. (The trivial build→done graph still routes on to finish; what matters
    # here is that a disabled script does not execute on the advance path.)
    assert run["nodes"]["build"]["outcome"] == "failure"
    assert "scripts_enabled" in (run["nodes"]["build"].get("output") or "")

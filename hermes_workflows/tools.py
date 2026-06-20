"""Model-visible tool implementations. Deliberately narrow: list, run, status,
and explain. The model never gets graph-editing access — editing is human-only
(CLI / dashboard). Handlers delegate to the core CLI and the orchestrator.
"""

from __future__ import annotations

import sys
import threading
import time
from typing import Any, Callable, Optional, Sequence

from . import cli_bridge


def _list_specs(roots: Sequence[str], core_cli: Sequence[str]) -> list[dict]:
    return cli_bridge.invoke([*core_cli, "list-specs", "--roots", ",".join(roots)]) or []


def _resolve_spec_path(workflow_id: str, roots: Sequence[str], core_cli: Sequence[str]) -> str:
    for spec in _list_specs(roots, core_cli):
        if spec["id"] == workflow_id:
            return spec["path"]
    raise ValueError(f"unknown workflow '{workflow_id}'")


def resolve_nl_command(text: str, workflows: Sequence[dict]) -> dict:
    """Resolve the free text after ``/workflow`` into a target and operator input,
    or a clarifying question. Matches the LONGEST leading run of the text against a
    known workflow id or name (case-insensitive); whatever follows is the operator
    instruction. Returns ``{"workflow_id", "input"}`` on a confident, unique match,
    otherwise ``{"question": "..."}`` so the caller asks rather than guesses (no
    recognizable target, or more than one workflow matched the same leading text).
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return {"question": "Which workflow should I run? Try `/workflow <id> <instruction>`."}
    lowered = cleaned.lower()
    best_len = 0
    matches: list[tuple[str, str]] = []  # (workflow_id, remaining operator input)
    for w in workflows:
        for target in (str(w.get("id", "")), str(w.get("name", ""))):
            t = target.strip().lower()
            if not t:
                continue
            # A target matches when it is the whole text or its leading run (so the
            # remainder is the operator instruction). Longest target wins.
            if lowered == t or lowered.startswith(t + " "):
                remainder = cleaned[len(t):].strip()
                if len(t) > best_len:
                    best_len, matches = len(t), [(str(w["id"]), remainder)]
                elif len(t) == best_len:
                    matches.append((str(w["id"]), remainder))
    if best_len == 0:
        available = ", ".join(sorted({str(w["id"]) for w in workflows})) or "(none configured)"
        return {
            "question": f"I could not match a workflow in {cleaned!r}. Which one did you "
            f"mean? Available: {available}. Try `/workflow <id> <instruction>`."
        }
    unique = {wid for wid, _ in matches}
    if len(unique) > 1:
        return {
            "question": f"That could be any of: {', '.join(sorted(unique))}. "
            f"Which workflow did you mean?"
        }
    workflow_id, remainder = matches[0]
    return {"workflow_id": workflow_id, "input": remainder or None}


def list_workflows(*, roots: Sequence[str], core_cli: Sequence[str]) -> dict:
    workflows = [
        {
            "id": spec["id"],
            "name": spec["name"],
            "scope": spec["scope"]["type"],
            "trigger": spec["trigger"],
            # Absent in the spec means enabled (see core isWorkflowEnabled).
            "enabled": spec.get("enabled", True),
        }
        for spec in _list_specs(roots, core_cli)
    ]
    return {"workflows": workflows}


def explain_workflow(workflow_id: str, *, roots: Sequence[str], core_cli: Sequence[str]) -> dict:
    path = _resolve_spec_path(workflow_id, roots, core_cli)
    return cli_bridge.invoke([*core_cli, "explain", path])


# The drive loop keeps advancing only these statuses. `waiting` is excluded on
# purpose: a parked review needs a human, and decide_review runs its own advance.
_DRIVEABLE_STATUSES = frozenset({"created", "running"})

# Pause between background advances: snappy enough that a settled node is
# ingested and the next node starts within seconds, gentle enough that a
# long kanban-backed run does not hammer the core CLI.
DRIVE_INTERVAL_SECONDS = 2.0


def start_workflow(
    workflow_id: str,
    *,
    engine: Any,
    engine_factory: Callable[[], Any],
    roots: Sequence[str],
    core_cli: Sequence[str],
    run_id: str,
    project_id: Optional[str] = None,
    origin: Optional[str] = None,
    input: Optional[str] = None,
    params: Optional[dict] = None,
    ensure_tick: Optional[Callable[[], Any]] = None,
    drive_interval_seconds: float = DRIVE_INTERVAL_SECONDS,
) -> dict:
    """Non-blocking start, for the dashboard run route: record the run, arm the
    advance tick (so the run survives this process dying), then drive the run
    in a background thread and return immediately.

    Blocking here is not hypothetical: through :func:`run_workflow` an HTTP
    caller waits for the first advance — minutes when the entry node is a
    global-scope ``agent_task``. The background drive loop advances the run
    every ``drive_interval_seconds`` until it settles or parks for review, so
    node transitions land in the run state seconds after they happen instead
    of waiting for the cron tick. One advance failure ends the drive (logged,
    not swallowed); the armed tick remains the durable backstop either way.

    ``engine_factory`` builds a fresh engine inside the background thread: the
    caller's engine holds SQLite connections bound to the calling thread
    (``check_same_thread``), so it must not cross into the drive thread."""
    path = _resolve_spec_path(workflow_id, roots, core_cli)
    created = engine.create(path, run_id, project_id, origin=origin, input=input, params=params)
    if ensure_tick is not None:
        ensure_tick()

    def _drive() -> None:
        try:
            background_engine = engine_factory()
            while True:
                run = background_engine.advance(path, run_id)
                if run.get("status") not in _DRIVEABLE_STATUSES:
                    return
                time.sleep(drive_interval_seconds)
        except Exception as exc:
            # Surfaced in the service log; the armed tick keeps advancing the
            # run, so it is delayed, not stranded.
            print(
                f"hermes-workflows: background drive failed for run {run_id}: {exc}",
                file=sys.stderr,
            )

    threading.Thread(target=_drive, name=f"hw-drive-{run_id}", daemon=True).start()
    return {"run_id": run_id, "status": created["status"]}


def run_workflow(
    workflow_id: str,
    *,
    engine: Any,
    roots: Sequence[str],
    core_cli: Sequence[str],
    run_id: str,
    project_id: Optional[str] = None,
    origin: Optional[str] = None,
    input: Optional[str] = None,
    params: Optional[dict] = None,
) -> dict:
    path = _resolve_spec_path(workflow_id, roots, core_cli)
    run = engine.run(path, run_id, project_id, origin=origin, input=input, params=params)
    return {"run_id": run_id, "status": run["status"]}


def review_workflow(
    run_id: str,
    node_id: str,
    decision: str,
    *,
    engine: Any,
    roots: Sequence[str],
    core_cli: Sequence[str],
    note: Optional[str] = None,
) -> dict:
    """Resolve a human_review node and advance the run. Channel-agnostic: the
    same resolution the CLI and dashboard use. An optional ``note`` is the
    operator's free-text payload, consumable downstream as
    ``{{nodes.<gate>.review_note}}``. Invalid decisions raise."""
    run = engine.status(run_id)
    path = _resolve_spec_path(run["workflow_id"], roots, core_cli)
    resolved = engine.decide_review(path, run_id, node_id, decision, note=note)
    return {"run_id": run_id, "status": resolved["status"], "decision": decision}


def workflow_status(run_id: str, *, engine: Any) -> dict:
    run = engine.status(run_id)
    current = next(
        (
            node_id
            for node_id, node in run["nodes"].items()
            if node.get("status") in ("scheduled", "running", "waiting_for_review")
        ),
        None,
    )
    return {"run_id": run_id, "status": run["status"], "current_node": current}

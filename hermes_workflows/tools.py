"""Model-visible tool implementations. Deliberately narrow: list, run, status,
and explain. The model never gets graph-editing access — editing is human-only
(CLI / dashboard). Handlers delegate to the core CLI and the orchestrator.
"""

from __future__ import annotations

from typing import Any, Optional, Sequence

from . import cli_bridge


def _list_specs(roots: Sequence[str], core_cli: Sequence[str]) -> list[dict]:
    return cli_bridge.invoke([*core_cli, "list-specs", "--roots", ",".join(roots)]) or []


def _resolve_spec_path(workflow_id: str, roots: Sequence[str], core_cli: Sequence[str]) -> str:
    for spec in _list_specs(roots, core_cli):
        if spec["id"] == workflow_id:
            return spec["path"]
    raise ValueError(f"unknown workflow '{workflow_id}'")


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


def run_workflow(
    workflow_id: str,
    *,
    engine: Any,
    roots: Sequence[str],
    core_cli: Sequence[str],
    run_id: str,
    project_id: Optional[str] = None,
    origin: Optional[str] = None,
) -> dict:
    path = _resolve_spec_path(workflow_id, roots, core_cli)
    run = engine.run(path, run_id, project_id, origin=origin)
    return {"run_id": run_id, "status": run["status"]}


def review_workflow(
    run_id: str,
    node_id: str,
    decision: str,
    *,
    engine: Any,
    roots: Sequence[str],
    core_cli: Sequence[str],
) -> dict:
    """Resolve a human_review node and advance the run. Channel-agnostic: the
    same resolution the CLI and dashboard use. Invalid decisions raise."""
    run = engine.status(run_id)
    path = _resolve_spec_path(run["workflow_id"], roots, core_cli)
    resolved = engine.decide_review(path, run_id, node_id, decision)
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

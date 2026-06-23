"""Pure helpers for resuming a stalled/failed run.

Resume re-runs from the failed node under the CURRENT spec (advance reads the
live ``spec_roots()``), so a just-applied fix to the node's prompt / timeout /
config takes effect. That is only safe when the live spec's NODE SET still
matches the run's persisted nodes: if a node was added / removed / renamed since
the run started, advancing would walk into a graph the run was never planned
against. :func:`structural_drift` is the guard for that — a structure-only
check (node-id set), kept separate from the template ``spec_sha`` primitive
(which also fingerprints edges/content for sharing, a different concern).
"""

from __future__ import annotations

from typing import Optional


def spec_node_ids(detail: Optional[dict]) -> set[str]:
    """The node-id set of a workflow, from a ``spec-get`` detail
    (``{"workflow": {"nodes": [{"id": ...}]}}``). An absent/garbled detail
    yields the empty set, which surfaces as drift against any non-empty run."""
    workflow = (detail or {}).get("workflow") or {}
    return {n["id"] for n in workflow.get("nodes", []) if isinstance(n, dict) and "id" in n}


def structural_drift(run: dict, detail: Optional[dict]) -> Optional[str]:
    """A clear, operator-facing message when the live spec's node set differs
    structurally from the run's persisted nodes (a node added / removed /
    renamed since the run started), else ``None``.

    Only the node-id set is compared: the run persists its nodes keyed by id but
    not the graph's edges, so an edge-only rewiring is not detectable here — and
    a same-node-set prompt / timeout / config edit is the safe, supported case
    that resume is built for, so it is deliberately NOT flagged."""
    spec_nodes = spec_node_ids(detail)
    run_nodes = set((run.get("nodes") or {}).keys())
    if spec_nodes == run_nodes:
        return None
    added = sorted(spec_nodes - run_nodes)
    removed = sorted(run_nodes - spec_nodes)
    parts: list[str] = []
    if added:
        parts.append(f"added {added}")
    if removed:
        parts.append(f"removed {removed}")
    return (
        f"spec drift: the live workflow's node set no longer matches run "
        f"'{run.get('run_id')}' ({'; '.join(parts)}). Resume re-runs under the "
        f"current spec and cannot safely advance into a changed graph. Revert the "
        f"structural change (node add/remove/rename) and resume, or start a fresh "
        f"run. A prompt/timeout/config edit that keeps the same node set is safe "
        f"to resume."
    )

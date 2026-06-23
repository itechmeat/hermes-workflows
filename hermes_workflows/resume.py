"""Pure helpers for resuming a stalled/failed run.

Resume re-runs from the failed node under the CURRENT spec (advance reads the
live ``spec_roots()``), so a just-applied fix to the node's prompt / timeout /
config takes effect. That is only safe when the live spec's structural node
signature still matches the run's persisted nodes: if a node was added, removed,
renamed, or changed to a different kind since the run started, advancing would
walk into a graph the run was never planned against. :func:`structural_drift` is
the guard for that — a structure-only check (node id + kind), kept separate from
the template ``spec_sha`` primitive (which also fingerprints edges/content for
sharing, a different concern).
"""

from __future__ import annotations

from typing import Optional


NodeSignature = tuple[str, str]


def spec_node_ids(detail: Optional[dict]) -> set[str]:
    """Backward-compatible node-id set helper for callers/tests that only need ids."""
    return {node_id for node_id, _kind in spec_node_signatures(detail)}


def spec_node_signatures(detail: Optional[dict]) -> set[NodeSignature]:
    """The ``(node_id, node_kind)`` set of a workflow, from a ``spec-get`` detail."""
    workflow = (detail or {}).get("workflow") or {}
    signatures: set[NodeSignature] = set()
    for node in workflow.get("nodes", []):
        if isinstance(node, dict) and isinstance(node.get("id"), str):
            signatures.add((node["id"], str(node.get("type") or "")))
    return signatures


def _run_node_signatures(run: dict) -> set[NodeSignature]:
    signatures: set[NodeSignature] = set()
    for node_id, state in (run.get("nodes") or {}).items():
        if isinstance(state, dict) and state.get("node_type") is not None:
            signatures.add((str(node_id), str(state.get("node_type"))))
        else:
            # Older persisted runs did not store node kinds; preserve their
            # historical id-only behavior rather than making them unresumable.
            signatures.add((str(node_id), ""))
    return signatures


def structural_drift(run: dict, detail: Optional[dict]) -> Optional[str]:
    """A clear, operator-facing message when the live spec's node structure differs
    from the run's persisted nodes (a node added / removed / renamed / retyped
    since the run started), else ``None``.

    Prompt / timeout / config edits that keep the same node id+kind signature are
    the safe, supported case and deliberately do NOT trip the guard."""
    spec_signatures = spec_node_signatures(detail)
    run_signatures = _run_node_signatures(run)
    spec_nodes = {node_id for node_id, _kind in spec_signatures}
    run_nodes = {node_id for node_id, _kind in run_signatures}
    if all(kind == "" for _node_id, kind in run_signatures):
        if spec_nodes == run_nodes:
            return None
    elif spec_signatures == run_signatures:
        return None

    added = sorted(spec_nodes - run_nodes)
    removed = sorted(run_nodes - spec_nodes)
    retyped = sorted(
        node_id
        for node_id in spec_nodes & run_nodes
        if {kind for nid, kind in spec_signatures if nid == node_id}
        != {kind for nid, kind in run_signatures if nid == node_id}
    )
    parts: list[str] = []
    if added:
        parts.append(f"added {added}")
    if removed:
        parts.append(f"removed {removed}")
    if retyped:
        parts.append(f"retyped {retyped}")
    return (
        f"spec drift: the live workflow's node structure no longer matches run "
        f"'{run.get('run_id')}' ({'; '.join(parts)}). Resume re-runs under the "
        f"current spec and cannot safely advance into a changed graph. Revert the "
        f"structural change (node add/remove/rename/type change) and resume, or "
        f"start a fresh run. A prompt/timeout/config edit that keeps the same node "
        f"id and type set is safe to resume."
    )

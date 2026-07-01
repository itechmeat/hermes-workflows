"""The node-execution seam. The advance engine decides *what* runs next; an
executor decides *how* a node runs. Two implementations exist: KanbanExecutor
(project-scoped, durable cards) and DirectExecutor (global, direct runner)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Protocol, runtime_checkable


@dataclass
class Completion:
    settled: bool
    outcome: Optional[str] = None  # "success" | "failure" | None (still running)
    output: Optional[str] = None
    # The work has visibly begun (worker spawned / runner invoked). Lets the
    # engine show a truthful "running" instead of a stale "scheduled" while a
    # long node executes. False on backends that cannot tell.
    started: bool = False
    # The backing card's live status, when the backend has one (Kanban:
    # triage/ready/running/blocked/done/...). Lets the tick detect a blocked
    # card and the `status` command report fresh state. None on backends with no
    # distinct card status (Direct, Script).
    status: Optional[str] = None
    # The native dispatcher's consecutive-failure counter for the backing card
    # (Kanban). Climbs when a worker repeatedly fails to spawn / exits non-zero.
    # Lets an adopt node bound its wait on a card it can never make progress on
    # instead of polling forever. 0 on backends with no such counter.
    consecutive_failures: int = 0
    # How many times this node's work was retried under the transient-error
    # policy (429 / overloaded / 5xx / connection reset) before this completion.
    # Surfaced so the engine can fold it into node telemetry - the dashboard
    # shows the ridden-out blip instead of a silent stall. 0 when none occurred.
    transient_retries: int = 0
    # The classifier's verdict for a settled completion: "success" | "transient"
    # | "deterministic". The engine keys its node-level retry on this: a
    # "transient" failure (a 429/overloaded blip the worker surfaced on a clean
    # exit) is re-scheduled with backoff before settling, where a "deterministic"
    # failure fails fast. Defaults "success" so a backend that cannot classify
    # (Direct - it retries internally, Script) never triggers an engine retry.
    kind: str = "success"


@runtime_checkable
class NodeExecutor(Protocol):
    def schedule(
        self,
        *,
        run_id: str,
        node_id: str,
        workflow_id: str,
        params: dict,
        iteration: int = 0,
    ) -> str:
        """Start the node's work; return an opaque handle persisted on the node run."""
        ...

    def poll(self, handle: str) -> Completion:
        """Read the current completion state of a previously scheduled node."""
        ...


_PROJECT_SCOPES = frozenset({"project", "projects"})


def select_executor(
    scope_type: str,
    *,
    kanban: NodeExecutor,
    direct: NodeExecutor,
) -> NodeExecutor:
    """Pick the executor for a workflow scope: project(s) -> Kanban, global -> Direct."""
    if scope_type in _PROJECT_SCOPES:
        return kanban
    if scope_type == "global":
        return direct
    raise ValueError(f"unknown scope type '{scope_type}'")

"""CompositeExecutor — wraps the scope executor (Kanban or Direct) and the
ScriptExecutor behind the single NodeExecutor seam the advance loop expects.

It routes ``schedule`` by the compiled step's ``kind`` (``"script"`` → the
script executor, everything else → the scope executor) and ``poll`` by the
handle's shape (a ``script:`` prefix → the script executor). That keeps the
engine's single-executor advance loop unchanged while letting script nodes run
locally in any workflow scope, alongside agent_task nodes on their backend.
"""

from __future__ import annotations

from .base import Completion, NodeExecutor
from .script_executor import _HANDLE_PREFIX


class CompositeExecutor:
    def __init__(self, *, scope: NodeExecutor, script: NodeExecutor) -> None:
        self.scope = scope
        self.script = script

    def schedule(
        self,
        *,
        run_id: str,
        node_id: str,
        workflow_id: str,
        params: dict,
        iteration: int = 0,
    ) -> str:
        target = self.script if params.get("kind") == "script" else self.scope
        return target.schedule(
            run_id=run_id,
            node_id=node_id,
            workflow_id=workflow_id,
            params=params,
            iteration=iteration,
        )

    def poll(self, handle: str) -> Completion:
        target = self.script if handle.startswith(_HANDLE_PREFIX) else self.scope
        return target.poll(handle)

    def adopt(self, task_id: str, *, assignee: str) -> str:
        """Drive an existing board card — a scope-backend (Kanban) capability;
        script nodes never adopt. Raises if the scope executor cannot adopt."""
        adopt = getattr(self.scope, "adopt", None)
        if adopt is None:
            raise ValueError("adopt requires a Kanban-backed (project) scope")
        return adopt(task_id, assignee=assignee)

    def send_to_review(self, task_id: str, *, reviewer: str) -> None:
        """Route a driven card through the native review stage via the scope
        backend. Raises if the scope executor has no review stage."""
        send = getattr(self.scope, "send_to_review", None)
        if send is None:
            raise ValueError("native review requires a Kanban-backed (project) scope")
        send(task_id, reviewer=reviewer)

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

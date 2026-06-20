"""CompositeExecutor — wraps the scope executor (Kanban or Direct), the
ScriptExecutor, and (for project scope) the off-board Direct runner behind the
single NodeExecutor seam the advance loop expects.

It routes ``schedule`` by the compiled step: a ``"script"`` kind goes to the
script executor; an ``off_board`` agent_task goes to the direct runner (no
Kanban card, so internal orchestration steps stay off the operator's board);
everything else goes to the scope executor. ``poll`` routes by the handle's
shape: a ``script:`` prefix → the script executor, a ``t_`` Kanban id → the
scope executor, any other handle → the direct runner. That keeps the engine's
single-executor advance loop unchanged while letting script nodes and off-board
nodes run locally in any workflow scope, alongside on-board agent_task cards.
"""

from __future__ import annotations

from typing import Optional

from .base import Completion, NodeExecutor
from .script_executor import _HANDLE_PREFIX

# Native Kanban card ids carry this prefix; direct-runner handles never do (they
# are ``run:node:iteration``). The prefix is what lets poll tell a board card
# from an off-board direct handle without threading per-node state through.
_KANBAN_ID_PREFIX = "t_"


class CompositeExecutor:
    def __init__(
        self,
        *,
        scope: NodeExecutor,
        script: NodeExecutor,
        direct: Optional[NodeExecutor] = None,
    ) -> None:
        self.scope = scope
        self.script = script
        # The off-board backend for `board: false` nodes. In global scope `scope`
        # is itself the direct runner, so this is only distinct in project scope.
        self.direct = direct

    def _off_board_target(self) -> NodeExecutor:
        if self.direct is not None:
            return self.direct
        # In global scope the scope executor already is the direct runner; only a
        # project run with no direct backend wired cannot honour off-board.
        if not hasattr(self.scope, "adopt"):
            return self.scope
        raise ValueError(
            "a node set board: false (off-board) but no direct runner is configured"
        )

    def schedule(
        self,
        *,
        run_id: str,
        node_id: str,
        workflow_id: str,
        params: dict,
        iteration: int = 0,
    ) -> str:
        if params.get("kind") == "script":
            target = self.script
        elif params.get("off_board"):
            target = self._off_board_target()
        else:
            target = self.scope
        return target.schedule(
            run_id=run_id,
            node_id=node_id,
            workflow_id=workflow_id,
            params=params,
            iteration=iteration,
        )

    def poll(self, handle: str) -> Completion:
        if handle.startswith(_HANDLE_PREFIX):
            target = self.script
        elif self.direct is not None and not handle.startswith(_KANBAN_ID_PREFIX):
            target = self.direct
        else:
            target = self.scope
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

    def scope_links(self, ids: list[str]) -> list[tuple[str, str]]:
        """Internal dependency links among an adopt scope, via the scope backend.
        Returns ``[]`` when the scope backend has no link view (e.g. a global /
        Direct scope), so adopt-ordering degrades to the parallel default rather
        than failing."""
        fn = getattr(self.scope, "scope_links", None)
        return fn(ids) if fn is not None else []

    def is_umbrella(self, task_id: str) -> bool:
        """Whether a card is an un-completable umbrella, via the scope backend.
        Returns ``False`` when the scope backend cannot tell (e.g. a global /
        Direct scope), so adopt drives the card as-is rather than excluding it."""
        fn = getattr(self.scope, "is_umbrella", None)
        return fn(task_id) if fn is not None else False

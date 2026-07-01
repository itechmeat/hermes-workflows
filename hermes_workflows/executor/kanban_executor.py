"""KanbanExecutor — the project-scoped backend. A node runs as a durable Kanban
card on the project's board; the worker pool (``hermes kanban dispatch``) drives
it. Scheduling is idempotent per (run, node, iteration) via the native
``idempotency_key``, so repeated advance ticks never duplicate a card.
"""

from __future__ import annotations

import sqlite3

from ..bridge import kanban
from .base import Completion


class KanbanExecutor:
    """Schedule nodes as Kanban cards and read their completion from ``task_runs``."""

    def __init__(self, board_conn: sqlite3.Connection) -> None:
        self.board_conn = board_conn

    def schedule(
        self,
        *,
        run_id: str,
        node_id: str,
        workflow_id: str,
        params: dict,
        iteration: int = 0,
    ) -> str:
        return kanban.create_node_task(
            self.board_conn,
            run_id=run_id,
            node_id=node_id,
            workflow_id=workflow_id,
            title=params.get("title") or node_id,
            prompt=params.get("prompt", ""),
            assignee=params.get("assignee") or "",
            model=params.get("model"),
            skills=params.get("skills"),
            max_retries=params.get("max_retries"),
            workspace=params.get("workspace") or "scratch",
            timeout_seconds=params.get("timeout_seconds"),
            iteration=iteration,
        )

    def adopt(self, task_id: str, *, assignee: str) -> str:
        """Drive an existing card on this board (assign + promote into dispatch),
        returning its id as the handle. See :func:`kanban.adopt_task`."""
        return kanban.adopt_task(self.board_conn, task_id, assignee=assignee)

    def scope_links(self, ids: list[str]) -> list[tuple[str, str]]:
        """Internal ``(parent, child)`` dependency links among the adopt scope.
        See :func:`kanban.scope_links`."""
        return kanban.scope_links(self.board_conn, ids)

    def is_umbrella(self, task_id: str) -> bool:
        """Whether a card is an un-completable umbrella/epic container.
        See :func:`kanban.is_umbrella_card`."""
        return kanban.is_umbrella_card(self.board_conn, task_id)

    def send_to_review(self, task_id: str, *, reviewer: str) -> None:
        """Route a completed driven card through the native review stage (assign
        reviewer, done -> review). See :func:`kanban.route_to_review`."""
        kanban.route_to_review(self.board_conn, task_id, reviewer=reviewer)

    def poll(self, handle: str) -> Completion:
        completion = kanban.read_completion(self.board_conn, handle)
        settled = completion.settled and completion.outcome is not None
        return Completion(
            settled=settled,
            outcome=completion.outcome,
            output=completion.output,
            status=completion.status,
            consecutive_failures=completion.consecutive_failures,
            # Carry the classifier's verdict so the engine can distinguish a
            # transient blip (re-schedule with backoff) from a deterministic
            # failure (fail fast). `read_completion` re-classifies the exit-0
            # `completed` case, so a 429 the worker surfaced on a clean exit
            # arrives here as kind="transient".
            kind=completion.kind,
        )

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
        )

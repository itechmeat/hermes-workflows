"""The run orchestrator: the only place that combines the pure TypeScript engine
(via the core CLI) with Kanban I/O (via the bridge).

Each advance tick:
  1. ingest completions for active agent_task cards from native task_runs,
  2. ask the engine for the next scheduling decision (pure),
  3. apply node status updates and create Kanban cards for newly scheduled nodes,
  4. persist the run.

The engine CLI is invoked out-of-process, so the orchestrator stays thin and
the spec is interpreted in exactly one place (TypeScript).
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable, Optional, Sequence

from . import cli_bridge, notifications
from .executor import CompositeExecutor, NodeExecutor

_ACTIVE_STATUSES = frozenset({"created", "running", "waiting"})
REVIEW_OPTIONS = frozenset({"approved", "rejected", "needs_changes"})

# Terminal run statuses that warrant a single run-lifecycle notice.
_TERMINAL_STATUSES = frozenset({"completed", "failed"})


class Engine:
    def __init__(
        self,
        *,
        core_cli: Sequence[str],
        db_path: str,
        kanban: Optional[NodeExecutor] = None,
        direct: Optional[NodeExecutor] = None,
        script: Optional[NodeExecutor] = None,
        kanban_factory: Optional[Callable[[str], NodeExecutor]] = None,
        sender: Optional[notifications.Sender] = None,
        default_deliver: Optional[str] = None,
        notifier_profile: Optional[str] = None,
    ) -> None:
        self.core_cli = list(core_cli)
        self.db_path = db_path
        # `kanban` is the fallback board executor for project runs with no bound
        # project; `kanban_factory(slug)` binds a project run to its own board.
        self.kanban = kanban
        self.direct = direct
        # The script executor runs `script` nodes locally in any scope; when set,
        # the scope executor is wrapped in a CompositeExecutor that routes by kind.
        self.script = script
        self.kanban_factory = kanban_factory
        # Run-lifecycle notifications: `sender` delivers to the run's origin or
        # `default_deliver`; None disables delivery (headless). Subscriptions of
        # Kanban cards to their terminal events use the native notifier.
        self.sender = sender
        self.default_deliver = default_deliver
        self.notifier_profile = notifier_profile

    # --- core CLI helpers -------------------------------------------------

    def _core(self, args: Sequence[str]) -> Any:
        return cli_bridge.invoke([*self.core_cli, *args])

    def _advance_decision(self, spec_path: str, run: dict) -> dict:
        with _temp_json(run) as run_file:
            return self._core(["advance", spec_path, "--run-file", run_file])

    def _save(self, run: dict) -> None:
        with _temp_json(run) as run_file:
            self._core(["run-save", "--db", self.db_path, "--run-file", run_file])

    def _load(self, run_id: str) -> Optional[dict]:
        return self._core(["run-load", "--db", self.db_path, "--id", run_id])

    # --- public API -------------------------------------------------------

    def run(
        self,
        spec_path: str,
        run_id: str,
        project_id: Optional[str] = None,
        origin: Optional[str] = None,
    ) -> dict:
        args = ["run-create", spec_path, "--db", self.db_path, "--id", run_id]
        if project_id:
            args += ["--project", project_id]
        if origin:
            args += ["--origin", origin]
        self._core(args)
        return self.advance(spec_path, run_id)

    def status(self, run_id: str) -> dict:
        run = self._load(run_id)
        if run is None:
            raise ValueError(f"unknown run {run_id}")
        return run

    def decide_review(self, spec_path: str, run_id: str, node_id: str, decision: str) -> dict:
        if decision not in REVIEW_OPTIONS:
            raise ValueError(
                f"invalid review decision '{decision}'; expected one of {sorted(REVIEW_OPTIONS)}"
            )
        run = self.status(run_id)
        node = run["nodes"].get(node_id)
        if node is None:
            raise ValueError(f"unknown node '{node_id}' in run '{run_id}'")
        if node.get("status") != "waiting_for_review":
            raise ValueError(f"node '{node_id}' is not awaiting review")
        node["review_decision"] = decision
        node["seq"] = _max_seq(run) + 1
        self._save(run)
        return self.advance(spec_path, run_id)

    def tick(
        self,
        spec_roots: Sequence[str],
        *,
        sync_tick: Callable[..., Any],
        tick_script: str,
        dispatch: Optional[Callable[[str], Any]] = None,
        resolve_board: Optional[Callable[[dict], Optional[str]]] = None,
    ) -> dict:
        """One self-terminating tick: advance every active run, then keep the
        singleton tick cron alive iff runs remain active.

        Worker spawning is normally the gateway's embedded dispatcher's job — it
        ticks every board on disk — so the tick only drives the workflow graph
        forward. For deployments that disable the gateway dispatcher
        (``kanban.dispatch_in_gateway=false``), pass ``dispatch`` + ``resolve_board``
        to run an explicit per-board dispatcher pass for boards with open cards."""
        advanced = self.advance_all(spec_roots)
        active = [run for run in advanced if run.get("status") in _ACTIVE_STATUSES]

        boards: list[str] = []
        if dispatch is not None and resolve_board is not None:
            for run in active:
                board = resolve_board(run)
                if board and board not in boards and _has_open_card(run):
                    boards.append(board)
            for board in boards:
                dispatch(board)

        sync_tick(active=bool(active), script=tick_script)
        return {"advanced": advanced, "dispatched": boards, "active": bool(active)}

    def advance_all(self, spec_roots: Sequence[str]) -> list[dict]:
        """Advance every active run in one pass, resolving each run's spec by
        workflow id across ``spec_roots``. Runs whose spec cannot be resolved are
        skipped; terminal runs are already excluded by the active-only listing."""
        specs = self._core(["list-specs", "--roots", ",".join(spec_roots)])
        path_by_id = {spec["id"]: spec["path"] for spec in specs}
        runs = self._core(["run-list", "--db", self.db_path, "--active"])

        advanced: list[dict] = []
        for run in runs:
            spec_path = path_by_id.get(run["workflow_id"])
            if spec_path is None:
                continue
            try:
                advanced.append(self.advance(spec_path, run["run_id"]))
            except Exception as exc:  # noqa: BLE001 - one bad run must not wedge the tick
                # Unattended: a single failing run (misconfigured backend, missing
                # runner, transient error) is isolated so every other active run
                # still advances. Surfaced on stderr, which lands in the tick log.
                print(
                    f"hermes-workflows: advance failed for run {run['run_id']}: {exc}",
                    file=sys.stderr,
                )
        return advanced

    def advance(self, spec_path: str, run_id: str) -> dict:
        run = self.status(run_id)
        plan = self._core(["compile-preview", spec_path])
        task_params = {task["node"]: task for task in plan["kanban_tasks"]}
        # Script steps share the per-node params map; the composite executor
        # routes them to the script backend by their `kind` tag.
        for step in plan.get("script_steps", []):
            task_params[step["node"]] = step
        executor = self._executor_for(plan["scope"], run)

        seq = _max_seq(run)
        for node in run["nodes"].values():
            if node.get("status") in ("scheduled", "running") and node.get("hermes_task_id"):
                completion = executor.poll(node["hermes_task_id"])
                if completion.settled and completion.outcome is not None:
                    seq += 1
                    node["status"] = "completed"
                    node["outcome"] = completion.outcome
                    node["seq"] = seq
                    if completion.output is not None:
                        node["output"] = completion.output

        decision = self._advance_decision(spec_path, run)
        for node_id, status in decision["node_updates"].items():
            run["nodes"][node_id]["status"] = status

        for node_id in decision["schedule"]:
            self._schedule_node(executor, run, run_id, node_id, task_params.get(node_id))

        run["status"] = decision["run_status"]
        self._emit_lifecycle(run, decision)
        self._save(run)
        return run

    # --- lifecycle effects (notifications) --------------------------------

    def _emit_lifecycle(self, run: dict, decision: dict) -> None:
        """Fire run-lifecycle notices once per transition into completed /
        failed / waiting, tracked by persisted markers so a run that stays in a
        state across ticks is never re-announced. Fail-open."""
        notified = list(run.get("notified") or [])
        seen = set(notified)

        def mark(key: str) -> None:
            if key not in seen:
                seen.add(key)
                notified.append(key)

        status = run.get("status")
        if status in _TERMINAL_STATUSES and status not in seen:
            self._notify(run, status)
            mark(status)
        for node_id in decision.get("waiting", []):
            key = f"waiting:{node_id}"
            if key not in seen:
                self._notify(run, "waiting", node_id=node_id)
                mark(key)

        if notified != (run.get("notified") or []):
            run["notified"] = notified

    def _notify(self, run: dict, event: str, node_id: Optional[str] = None) -> None:
        if self.sender is None:
            return
        try:
            notifications.notify_run(
                run_id=run["run_id"],
                event=event,
                send=self.sender,
                origin=run.get("origin"),
                default=self.default_deliver,
                text=_notice_text(run, event, node_id),
            )
        except Exception as exc:  # noqa: BLE001 - a notice must never fail a run
            print(
                f"hermes-workflows: notify failed for run {run.get('run_id')}: {exc}",
                file=sys.stderr,
            )

    def _subscribe_card(self, executor: NodeExecutor, run: dict, handle: str, params: Optional[dict]) -> None:
        """Subscribe the run's origin to a Kanban card's terminal events via the
        native notifier, so durable project runs close the loop out-of-process
        (where direct delivery cannot reach). No-op for local script handles and
        when there is no origin or board connection. Fail-open."""
        origin = run.get("origin")
        if not origin or (params and params.get("kind") == "script"):
            return
        if isinstance(handle, str) and handle.startswith("script:"):
            return
        conn = _board_conn(executor)
        if conn is None:
            return
        try:
            notifications.subscribe_task(
                conn, task_id=handle, origin=origin, notifier_profile=self.notifier_profile
            )
        except Exception as exc:  # noqa: BLE001 - subscription failure never fails a run
            print(
                f"hermes-workflows: subscribe failed for {handle}: {exc}",
                file=sys.stderr,
            )

    def _executor_for(self, scope: dict, run: dict) -> NodeExecutor:
        base = self._scope_executor(scope, run)
        # Script nodes run locally in any scope: wrap the scope executor so the
        # composite routes script steps to the script backend by kind, leaving
        # the single-executor advance loop otherwise unchanged.
        if self.script is not None:
            return CompositeExecutor(scope=base, script=self.script)
        return base

    def _scope_executor(self, scope: dict, run: dict) -> NodeExecutor:
        scope_type = scope.get("type", "")
        if scope_type == "global":
            return self._require(self.direct, scope_type)
        if scope_type in ("project", "projects"):
            slug = run.get("project_id") or _first(scope.get("projects"))
            if slug and self.kanban_factory is not None:
                return self.kanban_factory(slug)
            return self._require(self.kanban, scope_type)
        raise ValueError(f"unknown scope type '{scope_type}'")

    def _require(self, executor: Optional[NodeExecutor], scope_type: str) -> NodeExecutor:
        if executor is None:
            raise ValueError(f"no executor configured for scope '{scope_type}'")
        return executor

    def _schedule_node(
        self,
        executor: NodeExecutor,
        run: dict,
        run_id: str,
        node_id: str,
        params: Optional[dict],
    ) -> None:
        if params is None:
            return
        node = run["nodes"][node_id]
        handle = executor.schedule(
            run_id=run_id,
            node_id=node_id,
            workflow_id=run["workflow_id"],
            params=params,
            iteration=node.get("seq", 0),
        )
        node["hermes_task_id"] = handle
        node["status"] = "scheduled"
        self._subscribe_card(executor, run, handle, params)


def _board_conn(executor: NodeExecutor):
    """The Kanban DB connection behind an executor, when it has one. Reaches
    through a CompositeExecutor to its scope executor."""
    scope = getattr(executor, "scope", executor)
    return getattr(scope, "board_conn", None)


def _notice_text(run: dict, event: str, node_id: Optional[str]) -> str:
    workflow_id = run.get("workflow_id")
    run_id = run.get("run_id")
    if event == "waiting":
        return f"Workflow {workflow_id} run {run_id}: review needed ({node_id})."
    return f"Workflow {workflow_id} run {run_id}: {event}."


def _max_seq(run: dict) -> int:
    return max((node.get("seq") or 0 for node in run["nodes"].values()), default=0)


def _first(items: Optional[Sequence[str]]) -> Optional[str]:
    return items[0] if items else None


def _has_open_card(run: dict) -> bool:
    return any(
        node.get("status") in ("scheduled", "running") and node.get("hermes_task_id")
        for node in run["nodes"].values()
    )


class _temp_json:
    """Write a value to a temp JSON file for the duration of a `with` block."""

    def __init__(self, value: Any) -> None:
        self._value = value
        self._path: Optional[str] = None

    def __enter__(self) -> str:
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(self._value, handle)
        handle.close()
        self._path = handle.name
        return self._path

    def __exit__(self, *_exc: object) -> None:
        if self._path:
            Path(self._path).unlink(missing_ok=True)

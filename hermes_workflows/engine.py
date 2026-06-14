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

from . import cli_bridge, notifications, telemetry
from .executor import CompositeExecutor, NodeExecutor
from .resolve import UnresolvedInput, resolve_input_mapping

# Statuses that still need future advances — the tick's liveness condition,
# shared with the CLI/dashboard start paths that arm the tick.
ACTIVE_RUN_STATUSES = frozenset({"created", "running", "waiting"})
_ACTIVE_STATUSES = ACTIVE_RUN_STATUSES
REVIEW_OPTIONS = frozenset({"approved", "rejected", "needs_changes"})

# Terminal run statuses that warrant a single run-lifecycle notice.
_TERMINAL_STATUSES = frozenset({"completed", "failed"})

# Backstop for the inline drain: a cyclic script-only workflow could stay
# inline-eligible indefinitely, so cap the synchronous steps per call and let
# the durable tick carry on past the cap.
_MAX_INLINE_STEPS = 10_000


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
        memory: Optional[dict] = None,
        default_mode: str = "durable",
        telemetry_dir: Optional[Path] = None,
        trace: Optional[Any] = None,
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
        # Open Second Brain write policy (the enforced open_second_brain.* knobs):
        # {mode, write_run_summaries, write_node_failures, write_node_events}.
        # None or mode 'none' disables all memory writes.
        self.memory = memory or {}
        # Enforced execution.default_mode: 'durable' (one step per tick) or
        # 'direct' / 'auto' (drain inline-eligible script steps synchronously).
        self.default_mode = default_mode
        # Worker-side telemetry sidecars (per kanban card). None disables the
        # settle merge entirely (today's behaviour); the wired default is
        # config.telemetry_dir().
        self.telemetry_dir = telemetry_dir
        # Per-run JSONL trace writer (trace.TraceWriter). None — the default —
        # disables tracing entirely: no writer object, zero trace I/O on the
        # tick path (observability.trace_enabled gates the wiring).
        self.trace = trace

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

    def create(
        self,
        spec_path: str,
        run_id: str,
        project_id: Optional[str] = None,
        origin: Optional[str] = None,
    ) -> dict:
        """Record a new run without advancing it — the non-blocking half of
        :meth:`run`, for callers (the dashboard start route) that must return
        before the first node executes."""
        args = ["run-create", spec_path, "--db", self.db_path, "--id", run_id]
        if project_id:
            args += ["--project", project_id]
        if origin:
            args += ["--origin", origin]
        created = self._core(args)
        self._trace_emit(
            run_id,
            "run_created",
            workflow_id=(created or {}).get("workflow_id"),
            project_id=project_id,
        )
        return created

    def run(
        self,
        spec_path: str,
        run_id: str,
        project_id: Optional[str] = None,
        origin: Optional[str] = None,
    ) -> dict:
        self.create(spec_path, run_id, project_id, origin)
        return self.advance(spec_path, run_id)

    def status(self, run_id: str) -> dict:
        run = self._load(run_id)
        if run is None:
            raise ValueError(f"unknown run {run_id}")
        return run

    def cancel(self, run_id: str) -> dict:
        """Cancel a run from the shell: mark the run cancelled and cancel its
        still-active nodes, reusing the core ``run-cancel`` (``cancelRun``)
        semantics. Idempotent — an already-terminal run is returned unchanged."""
        return self._core(["run-cancel", "--db", self.db_path, "--id", run_id])

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
        # The decision is recorded before the advance step loads its snapshot,
        # so a prior-vs-post diff inside the tick cannot see it — emit here.
        self._trace_emit(run_id, "review_decided", node_id=node_id, decision=decision)
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
        """Advance a run one step, then - when inline mode is enabled and the
        step it just scheduled is inline-eligible (script-only, settled
        synchronously) - keep advancing in this same call until the run is
        terminal, waiting, or schedules a durable node. ``default_mode=durable``
        runs exactly one step per call (the unchanged durable behaviour)."""
        for _ in range(_MAX_INLINE_STEPS):
            run, decision = self._advance_step(spec_path, run_id)
            if not (self._inline_permitted() and decision.get("inline_eligible")):
                return run
        # Backstop: a pathological cyclic script-only workflow could stay
        # inline-eligible forever. Bail out of the synchronous drain and let the
        # tick continue it durably rather than hang the caller.
        print(
            f"hermes-workflows: inline drain hit the {_MAX_INLINE_STEPS}-step cap "
            f"for run {run_id}; continuing durably",
            file=sys.stderr,
        )
        return run

    def _inline_permitted(self) -> bool:
        """Whether the global mode allows the inline drain. ``durable`` never
        does; ``direct`` / ``auto`` do (eligibility is decided per-step by the
        core advance)."""
        return self.default_mode in ("direct", "auto")

    def _advance_step(self, spec_path: str, run_id: str) -> tuple[dict, dict]:
        run = self.status(run_id)
        # Trace snapshot: node statuses, run status, and emitted markers before
        # this step mutates anything; _emit_trace derives the timeline by diff.
        prior = _trace_snapshot(run) if self.trace is not None else None
        plan = self._core(["compile-preview", spec_path])
        task_params = {task["node"]: task for task in plan["kanban_tasks"]}
        # Script steps share the per-node params map; the composite executor
        # routes them to the script backend by their `kind` tag.
        for step in plan.get("script_steps", []):
            task_params[step["node"]] = step
        executor = self._executor_for(plan["scope"], run)

        seq = _max_seq(run)
        settled_cards: list[str] = []
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
                    self._merge_telemetry(node)
                    settled_cards.append(node["hermes_task_id"])
                elif completion.started and node["status"] == "scheduled":
                    # The executor reports the work has visibly begun (e.g. the
                    # Direct runner thread is live) — show a truthful "running"
                    # instead of a stale "scheduled" while the node executes.
                    node["status"] = "running"

        decision = self._advance_decision(spec_path, run)
        for node_id, status in decision["node_updates"].items():
            run["nodes"][node_id]["status"] = status

        for node_id in decision["schedule"]:
            self._schedule_node(executor, run, run_id, node_id, task_params.get(node_id))

        run["status"] = decision["run_status"]
        self._emit_lifecycle(run, decision, plan.get("deliver"))
        self._emit_memory(run, spec_path)
        if prior is not None:
            self._emit_trace(prior, run)
        self._save(run)
        # The aggregates are persisted on the nodes now; consume the sidecars
        # (corrupt ones included) so the telemetry dir does not grow without
        # bound. After the save, so an engine crash in between just re-merges
        # on the next tick (idempotent — last write wins).
        if self.telemetry_dir is not None:
            for task_id in settled_cards:
                telemetry.clear_node_telemetry(self.telemetry_dir, task_id)
        return run, decision

    def _merge_telemetry(self, node: dict) -> None:
        """Fold the worker's telemetry sidecar into a just-settled node.
        Fail-open: a missing or corrupt sidecar leaves telemetry absent."""
        if self.telemetry_dir is None:
            return
        data = telemetry.load_node_telemetry(self.telemetry_dir, node["hermes_task_id"])
        if data is not None:
            node["telemetry"] = data

    # --- lifecycle effects (trace) -----------------------------------------

    def _trace_emit(self, run_id: str, kind: str, **payload: Any) -> None:
        """Append one trace event when tracing is on. Fail-open beyond the
        writer's own guard, so even a broken injected writer cannot affect a
        run."""
        if self.trace is None:
            return
        try:
            self.trace.emit(run_id, kind, **payload)
        except Exception as exc:  # noqa: BLE001 - tracing never fails a run
            print(f"hermes-workflows: trace emit failed: {exc}", file=sys.stderr)

    def _emit_trace(self, prior: dict, run: dict) -> None:
        """Derive this step's timeline by diffing the pre-step snapshot against
        the post-decision run: settled work nodes (with outcome and seq), other
        node status transitions, scheduling, the run-status change, and any new
        lifecycle markers."""
        run_id = run["run_id"]
        for node_id, node in run["nodes"].items():
            before = prior["statuses"].get(node_id)
            after = node.get("status")
            if before == after:
                continue
            if after == "completed" and before in ("scheduled", "running"):
                self._trace_emit(
                    run_id,
                    "node_settled",
                    node_id=node_id,
                    outcome=node.get("outcome"),
                    seq=node.get("seq"),
                )
            elif after == "scheduled":
                self._trace_emit(
                    run_id,
                    "node_scheduled",
                    node_id=node_id,
                    handle=node.get("hermes_task_id"),
                )
            else:
                self._trace_emit(
                    run_id, "node_status", node_id=node_id, **{"from": before, "to": after}
                )
        if run.get("status") != prior["run_status"]:
            self._trace_emit(
                run_id, "run_status", **{"from": prior["run_status"], "to": run.get("status")}
            )
        for marker in run.get("notified") or []:
            if marker not in prior["notified"]:
                self._trace_emit(run_id, "marker", marker=marker)

    # --- lifecycle effects (notifications) --------------------------------

    def _emit_lifecycle(self, run: dict, decision: dict, deliver: Optional[str] = None) -> None:
        """Fire run-lifecycle notices once per transition into completed /
        failed / waiting, tracked by persisted markers so a run that stays in a
        state across ticks is never re-announced. ``deliver`` is the workflow's
        declared delivery target (compile-preview), routing the notice and, on a
        completed run, swapping the terse line for the run's result. Fail-open."""
        notified = list(run.get("notified") or [])
        seen = set(notified)

        def mark(key: str) -> None:
            if key not in seen:
                seen.add(key)
                notified.append(key)

        status = run.get("status")
        if status in _TERMINAL_STATUSES and status not in seen:
            if self._notify(run, status, deliver=deliver):
                mark(status)
        for node_id in decision.get("waiting", []):
            key = f"waiting:{node_id}"
            if key not in seen and self._notify(run, "waiting", node_id=node_id, deliver=deliver):
                mark(key)

        if notified != (run.get("notified") or []):
            run["notified"] = notified

    def _notify(
        self,
        run: dict,
        event: str,
        node_id: Optional[str] = None,
        deliver: Optional[str] = None,
    ) -> bool:
        """Deliver one notice; return whether it should be recorded as done. A
        headless no-op (no live target) returns False so the notice is retried on
        a later in-process advance rather than falsely marked. No configured
        sender, no target at all, or a ``[SILENT]`` result returns True (nothing
        to deliver, ever - don't keep retrying)."""
        if self.sender is None:
            return True
        text = self._notice_text_for(run, event, node_id, deliver)
        if notifications.is_silenced(text):
            return True  # [SILENT]: intentional suppression, never retry
        try:
            note = notifications.notify_run(
                run_id=run["run_id"],
                event=event,
                send=self.sender,
                origin=run.get("origin"),
                default=self.default_deliver,
                deliver=deliver,
                text=text,
            )
        except Exception as exc:  # noqa: BLE001 - a notice must never fail a run
            print(
                f"hermes-workflows: notify failed for run {run.get('run_id')}: {exc}",
                file=sys.stderr,
            )
            return False  # delivery errored - retry, don't mark
        if note is None:
            return True  # no origin and no default target: nowhere to deliver, ever
        return note.delivered is not False  # False == headless no-op -> retry

    def _notice_text_for(
        self, run: dict, event: str, node_id: Optional[str], deliver: Optional[str]
    ) -> str:
        """The text to deliver. When a delivery target is declared, a completed
        run delivers its RESULT (the final node output); every other case (and
        the no-deliver path) keeps the terse lifecycle line unchanged."""
        if deliver and event == "completed":
            result = _run_result_output(run)
            if result:
                return result
        return _notice_text(run, event, node_id)

    # --- lifecycle effects (memory writes) --------------------------------

    def _emit_memory(self, run: dict, spec_path: str) -> None:
        """Write Open Second Brain memory on lifecycle transitions, gated by the
        enforced open_second_brain.* settings and idempotent per (run, event)
        via the persisted markers. Fail-open (a memory error never fails a run).
        """
        mode = self.memory.get("mode")
        if mode in (None, "none"):
            return
        notified = list(run.get("notified") or [])
        seen = set(notified)

        def mark(key: str) -> None:
            if key not in seen:
                seen.add(key)
                notified.append(key)

        status = run.get("status")
        wf = run.get("workflow_id")
        run_id = run.get("run_id")

        # Granular per-run start event (quiet by default).
        if self.memory.get("write_node_events") and "mem:run_started" not in seen:
            self._memory_event(spec_path, "run_started", f"{wf} run {run_id} started", "")
            mark("mem:run_started")

        # One node_failed per newly failed node.
        if self.memory.get("write_node_failures", True):
            for node_id, node in run["nodes"].items():
                if node.get("outcome") != "failure":
                    continue
                key = f"mem:node_failed:{node_id}"
                if key not in seen:
                    body = node.get("error") or node.get("output") or ""
                    self._memory_event(spec_path, "node_failed", f"{wf} node {node_id} failed", body)
                    mark(key)

        # Run summary + retrospective on a terminal run.
        if self.memory.get("write_run_summaries", True):
            if status == "completed" and "mem:run_completed" not in seen:
                self._memory_event(spec_path, "run_completed", f"{wf} run {run_id} completed", "")
                mark("mem:run_completed")
            if status in _TERMINAL_STATUSES and "mem:retro" not in seen:
                self._memory_retro(spec_path, run)
                mark("mem:retro")

        if notified != (run.get("notified") or []):
            run["notified"] = notified

    def _memory_event(self, spec_path: str, kind: str, title: str, body: str) -> None:
        try:
            self._core(["memory-event", spec_path, "--kind", kind, "--title", title, "--body", body])
        except Exception as exc:  # noqa: BLE001 - fail-open
            print(f"hermes-workflows: memory-event failed: {exc}", file=sys.stderr)

    def _memory_retro(self, spec_path: str, run: dict) -> None:
        try:
            with _temp_json(run) as run_file:
                self._core(["memory-retro", spec_path, "--run-file", run_file])
        except Exception as exc:  # noqa: BLE001 - fail-open
            print(f"hermes-workflows: memory-retro failed: {exc}", file=sys.stderr)

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

    def _resolve_inputs(self, run: dict, params: dict) -> dict:
        """Substitute a node's input_mapping placeholders with upstream outputs
        from the run state. Returns a copy with the resolved prompt; the original
        params (the compiled task) are left untouched. A no-mapping node is
        returned unchanged. Raises UnresolvedInput when a reference cannot be
        satisfied (handled by the caller)."""
        mapping = params.get("input_mapping")
        if not mapping:
            return params
        outputs = {nid: node.get("output") for nid, node in run["nodes"].items()}
        resolved_prompt = resolve_input_mapping(params.get("prompt", ""), mapping, outputs)
        resolved = dict(params)
        resolved["prompt"] = resolved_prompt
        return resolved

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
        try:
            params = self._resolve_inputs(run, params)
        except UnresolvedInput as exc:
            # A declared input could not be satisfied on this run (e.g. an
            # unexecuted conditional source). Settle the node failure loudly
            # rather than schedule it with an unresolved placeholder; the next
            # advance routes the failure like any other settled node.
            node["status"] = "completed"
            node["outcome"] = "failure"
            node["output"] = f"input resolution failed: {exc}"
            node["seq"] = _max_seq(run) + 1
            return
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


def _run_result_output(run: dict) -> Optional[str]:
    """The run's result: the output of the most recently completed node that
    produced one (highest ``seq``; terminal ``finish`` nodes carry none). None
    when no node produced output."""
    best: Optional[str] = None
    best_seq: Optional[int] = None
    for node in (run.get("nodes") or {}).values():
        if node.get("status") != "completed" or not node.get("output"):
            continue
        seq = node.get("seq") or 0
        if best_seq is None or seq >= best_seq:
            best, best_seq = node["output"], seq
    return best


def _trace_snapshot(run: dict) -> dict:
    """What _emit_trace diffs against: per-node statuses, the run status, and
    the already-emitted lifecycle markers."""
    return {
        "statuses": {node_id: node.get("status") for node_id, node in run["nodes"].items()},
        "run_status": run.get("status"),
        "notified": set(run.get("notified") or []),
    }


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

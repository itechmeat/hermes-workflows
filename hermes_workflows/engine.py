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
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Optional, Sequence

from . import cli_bridge, notifications, telemetry, wait
from .executor import CompositeExecutor, NodeExecutor
from .resolve import UnresolvedInput, resolve_input_mapping, resolve_ref

# Statuses that still need future advances — the tick's liveness condition,
# shared with the CLI/dashboard start paths that arm the tick.
ACTIVE_RUN_STATUSES = frozenset({"created", "running", "waiting"})
_ACTIVE_STATUSES = ACTIVE_RUN_STATUSES
REVIEW_OPTIONS = frozenset({"approved", "rejected", "needs_changes"})

# Terminal run statuses that warrant a single run-lifecycle notice.
_TERMINAL_STATUSES = frozenset({"completed", "failed"})

# Card statuses where a climbing consecutive-failure counter means the card is
# parked awaiting dispatch (not actively being worked): the dispatcher keeps
# failing to make progress on it. `running` is excluded (a worker is on it).
_STUCK_CARD_STATUSES = frozenset({"ready", "triage", "todo", "review"})
# How many consecutive dispatch failures on a parked driven card before an adopt
# node settles failure rather than polling it forever.
_ADOPT_STUCK_FAILURES = 3

# Backstop for the inline drain: a cyclic script-only workflow could stay
# inline-eligible indefinitely, so cap the synchronous steps per call and let
# the durable tick carry on past the cap.
_MAX_INLINE_STEPS = 10_000

# task_ref resolution: a literal board id, or a typed reference to the task ids
# an upstream node surfaced in its output (extracted by the board id shape, so a
# free-text agent output still yields a typed id list, failing loud on none).
_TASK_IDS_REF = re.compile(r"^\{\{nodes\.([A-Za-z0-9_-]+)\.output\.task_ids\}\}$")
_TASK_ID_TOKEN = re.compile(r"\bt_[0-9a-z]+\b")


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
        input: Optional[str] = None,
    ) -> dict:
        """Record a new run without advancing it — the non-blocking half of
        :meth:`run`, for callers (the dashboard start route) that must return
        before the first node executes. ``input`` is the operator's free-form
        run input, layered above every agent_task prompt at highest priority."""
        args = ["run-create", spec_path, "--db", self.db_path, "--id", run_id]
        if project_id:
            args += ["--project", project_id]
        if origin:
            args += ["--origin", origin]
        if input:
            args += ["--input", input]
        created = self._core(args)
        self._trace_emit(
            run_id,
            "run_created",
            workflow_id=(created or {}).get("workflow_id"),
            project_id=project_id,
            input=input,
        )
        return created

    def run(
        self,
        spec_path: str,
        run_id: str,
        project_id: Optional[str] = None,
        origin: Optional[str] = None,
        input: Optional[str] = None,
    ) -> dict:
        self.create(spec_path, run_id, project_id, origin, input)
        return self.advance(spec_path, run_id)

    def status(self, run_id: str) -> dict:
        run = self._load(run_id)
        if run is None:
            raise ValueError(f"unknown run {run_id}")
        return run

    def active_runs(self) -> list[dict]:
        """Every run still needing advances (created / running / waiting). Used by
        the chat-reply gate router to find a run awaiting a decision."""
        return self._core(["run-list", "--db", self.db_path, "--active"])

    def status_live(self, spec_path: str, run_id: str) -> dict:
        """Like :meth:`status`, but annotate each active node with a read-only
        live poll of its backing card, so a manual status read reflects reality
        between ticks instead of the last persisted tick (the source of repeated
        "it looks stuck" confusion). Never mutates persisted state; a poll error
        leaves a node un-annotated. ``run['live']`` lists nodes whose card has
        already settled but the run has not yet folded in (pending completions).
        """
        run = self.status(run_id)
        try:
            plan = self._core(["compile-preview", spec_path])
            executor = self._executor_for(plan["scope"], run)
        except Exception as exc:  # noqa: BLE001 - status must never fail on a live read
            run["live"] = {"error": str(exc)}
            return run

        pending: list[str] = []
        for node_id, node in run["nodes"].items():
            handles = _node_handles(node)
            if node.get("status") not in ("scheduled", "running") or not handles:
                continue
            # An adopt node drives several cards; poll them all so live status
            # never reports the node healthy while another driven card is stuck.
            cards: list[dict] = []
            settled_all = True
            blocked_any = False
            for handle in handles:
                try:
                    completion = executor.poll(handle)
                except Exception:  # noqa: BLE001 - one bad poll never fails status
                    settled_all = False
                    continue
                card_settled = bool(completion.settled and completion.outcome is not None)
                settled_all = settled_all and card_settled
                blocked_any = blocked_any or completion.status == "blocked"
                card: dict = {"handle": handle, "card_status": completion.status, "settled": card_settled}
                if completion.outcome is not None:
                    card["outcome"] = completion.outcome
                cards.append(card)
            node["live"] = {"settled": settled_all and bool(cards), "cards": cards}
            if (settled_all and cards) or blocked_any:
                pending.append(node_id)
        run["live"] = {"as_of": "live-poll", "pending_completions": pending}
        return run

    def cancel(self, run_id: str) -> dict:
        """Cancel a run from the shell: mark the run cancelled and cancel its
        still-active nodes, reusing the core ``run-cancel`` (``cancelRun``)
        semantics. Idempotent — an already-terminal run is returned unchanged."""
        return self._core(["run-cancel", "--db", self.db_path, "--id", run_id])

    def decide_review(
        self,
        spec_path: str,
        run_id: str,
        node_id: str,
        decision: str,
        note: Optional[str] = None,
    ) -> dict:
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
        # Optional operator payload, consumable downstream as
        # {{nodes.<gate>.review_note}}. Blank/whitespace is treated as no note.
        if note is not None and note.strip() != "":
            node["review_note"] = note
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
        # wait nodes are polled worker-free in this tick (no executor); keep them
        # in their own map so the schedule/poll paths never treat them as cards.
        wait_params = {step["node"]: step for step in plan.get("wait_steps", [])}
        executor = self._executor_for(plan["scope"], run)

        seq = _max_seq(run)
        settled_cards: list[str] = []
        blocked_nodes: list[str] = []
        stuck_nodes: list[str] = []
        for node_id, node in run["nodes"].items():
            if node.get("status") not in ("scheduled", "running"):
                continue
            # An adopt node drives a LIST of existing cards; every other node has
            # one backing handle. The node settles only when ALL of its cards are
            # terminal, and fails if any of them did.
            handles = _node_handles(node)
            if not handles:
                continue
            review_profile = (task_params.get(node_id) or {}).get("review_profile")
            completions = [executor.poll(handle) for handle in handles]
            terminal = [
                self._card_terminal(executor, node, handle, completion, review_profile)
                for handle, completion in zip(handles, completions)
            ]
            # Bound the wait: a driven card the dispatcher cannot make progress on
            # (consecutive_failures climbing while it sits un-run) would otherwise
            # be polled forever - the silent-hang this guards against. Settle the
            # node failure loudly and surface it. Excludes a card that is actively
            # running (a worker is on it) and terminal cards (handled below). This
            # also catches an unspawnable review worker: a card parked in `review`
            # with a climbing counter (e.g. a reviewer profile with an unknown
            # skill) fails the node instead of bouncing silently.
            stuck = [
                (h, c)
                for h, c in zip(handles, completions)
                if not c.settled
                and c.status in _STUCK_CARD_STATUSES
                and (c.consecutive_failures or 0) >= _ADOPT_STUCK_FAILURES
            ]
            if stuck and not all(terminal):
                handle, comp = stuck[0]
                seq += 1
                node["status"] = "completed"
                node["outcome"] = "failure"
                node["seq"] = seq
                node["output"] = (
                    f"adopt stuck: card {handle} could not be dispatched after "
                    f"{comp.consecutive_failures} consecutive worker failures "
                    f"(status {comp.status}); settling the node failure instead of "
                    f"polling forever. Check the card's profile/reviewer skills."
                )
                self._merge_telemetry(node)
                settled_cards.extend(handles)
                stuck_nodes.append(node_id)
                continue
            if all(terminal):
                batch_failed = any(c.outcome == "failure" for c in completions)
                batch_outputs = [c.output for c in completions if c.output is not None]
                seq_state = node.get("adopt_seq")
                if seq_state and seq_state.get("pending"):
                    # Sequential adopt: this card is terminal but more remain.
                    # Stash its result, promote the next card on the shared branch,
                    # and keep the node active rather than settling.
                    seq_state.setdefault("outputs", []).extend(batch_outputs)
                    seq_state["failed"] = bool(seq_state.get("failed")) or batch_failed
                    next_id = seq_state["pending"].pop(0)
                    adopt = getattr(executor, "adopt", None)
                    handle = adopt(next_id, assignee=seq_state.get("assignee") or "")
                    node["driven_task_ids"] = [handle]
                    node["hermes_task_id"] = handle
                    node["status"] = "scheduled"
                    self._subscribe_card(
                        executor, run, handle, task_params.get(node_id) or {},
                        plan.get("subscribe_cards", True),
                    )
                else:
                    seq += 1
                    node["status"] = "completed"
                    failed = batch_failed or bool(seq_state and seq_state.get("failed"))
                    node["outcome"] = "failure" if failed else "success"
                    node["seq"] = seq
                    prior_outputs = list(seq_state.get("outputs") or []) if seq_state else []
                    outputs = prior_outputs + batch_outputs
                    if outputs:
                        node["output"] = "\n\n".join(outputs)
                    self._merge_telemetry(node)
                    settled_cards.extend(handles)
            elif any(c.status == "blocked" for c in completions):
                # An underlying card was blocked (e.g. a worker error ran
                # `kanban block`). The node stays active so the tick keeps polling
                # and auto-recovers when it is unblocked, but we must not leave the
                # run silently inert: surface it for an operator notice (once, via
                # the notified markers).
                blocked_nodes.append(node_id)
            elif any(c.started for c in completions) and node["status"] == "scheduled":
                # The executor reports the work has visibly begun (e.g. the Direct
                # runner thread is live) — show a truthful "running" instead of a
                # stale "scheduled" while the node executes.
                node["status"] = "running"

        # Worker-free wait nodes: poll each active one's predicate in this tick.
        if wait_params:
            channels = {
                nid: {"output": n.get("output"), "review_note": n.get("review_note")}
                for nid, n in run["nodes"].items()
            }
            for node_id, node in run["nodes"].items():
                step = wait_params.get(node_id)
                if step is None or node.get("status") != "running":
                    continue
                outcome = self._evaluate_wait(node, step, channels)
                if outcome is not None:
                    seq += 1
                    node["status"] = "completed"
                    node["outcome"] = outcome
                    node["seq"] = seq

        decision = self._advance_decision(spec_path, run)
        for node_id, status in decision["node_updates"].items():
            node = run["nodes"][node_id]
            # Loop re-entry resets a settled wait node back to pending/running;
            # clear its attempt-scoped state so the new attempt records a fresh
            # timeout clock and outcome (otherwise _evaluate_wait sees a stale
            # wait_started_at and miscomputes elapsed time).
            if node_id in wait_params and status in ("pending", "running"):
                node.pop("wait_started_at", None)
                node.pop("outcome", None)
                node.pop("output", None)
            node["status"] = status

        subscribe_cards = plan.get("subscribe_cards", True)
        for node_id in decision["schedule"]:
            self._schedule_node(
                executor, run, run_id, node_id, task_params.get(node_id), subscribe_cards
            )

        # An adopt node can settle failure SYNCHRONOUSLY during scheduling (it
        # resolved zero cards to drive) and flag the run to abort. Re-decide so
        # the run fails closed this tick instead of leaking a 'running' status -
        # and never advances toward a downstream build/PR - until the next tick.
        if any(run["nodes"][nid].get("abort_run") for nid in decision["schedule"]):
            decision = self._advance_decision(spec_path, run)
            for node_id, status in decision["node_updates"].items():
                run["nodes"][node_id]["status"] = status

        run["status"] = decision["run_status"]
        self._emit_lifecycle(run, decision, plan.get("deliver"), blocked_nodes, stuck_nodes)
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

    def _emit_lifecycle(
        self,
        run: dict,
        decision: dict,
        deliver: Optional[str] = None,
        blocked: Optional[Sequence[str]] = None,
        stuck: Optional[Sequence[str]] = None,
    ) -> None:
        """Fire run-lifecycle notices once per transition into completed /
        failed / waiting, once per underlying card that goes blocked, and once
        per adopt node settled failed because its driven card was un-dispatchable,
        tracked by persisted markers so a run that stays in a state across ticks
        is never re-announced. ``deliver`` is the workflow's declared delivery
        target (compile-preview), routing the notice and, on a completed run,
        swapping the terse line for the run's result. Fail-open."""
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
        # One attention notice per blocked underlying card. The run stays active
        # (the node is still scheduled/running), so it is not re-announced across
        # ticks and clears naturally once the card is unblocked and completes.
        for node_id in blocked or []:
            key = f"blocked:{node_id}"
            if key not in seen and self._notify(run, "blocked", node_id=node_id, deliver=deliver):
                mark(key)
        # One attention notice per adopt node settled failed because its driven
        # card could not be dispatched (the bounded-wait escape from a silent
        # hang). The node is terminal, so this fires exactly once.
        for node_id in stuck or []:
            key = f"stuck:{node_id}"
            if key not in seen and self._notify(run, "stuck", node_id=node_id, deliver=deliver):
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

    def _subscribe_card(
        self,
        executor: NodeExecutor,
        run: dict,
        handle: str,
        params: Optional[dict],
        subscribe_cards: bool = True,
    ) -> None:
        """Subscribe the run's origin to a Kanban card's terminal events via the
        native notifier, so durable project runs close the loop out-of-process
        (where direct delivery cannot reach). No-op for local script handles and
        when there is no origin or board connection, and when the spec opted out
        (`notifications.subscribe_cards: false`) to silence per-card pings while
        keeping run-level lifecycle notices. A per-node `notify_completion`
        overrides that workflow-level default for this card only. Fail-open."""
        node_pref = params.get("notify_completion") if params else None
        effective = node_pref if node_pref is not None else subscribe_cards
        if not effective:
            return
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
        base = params.get("prompt", "")
        prompt = base
        mapping = params.get("input_mapping")
        if mapping:
            channels = {
                nid: {"output": node.get("output"), "review_note": node.get("review_note")}
                for nid, node in run["nodes"].items()
            }
            prompt = resolve_input_mapping(prompt, mapping, channels)
        # The run-level operator input (if any) is layered ABOVE every agent_task
        # node's prompt as the highest-priority block: it overrides conflicting
        # node instructions and otherwise binds as an additional constraint.
        operator_input = run.get("input")
        if operator_input:
            prompt = _layer_operator_input(prompt, operator_input)
        if prompt == base:
            return params  # nothing layered or substituted: byte-identical
        resolved = dict(params)
        resolved["prompt"] = prompt
        return resolved

    def _input_task_ids(self, run: dict, params: dict) -> list[str]:
        """Board task ids carried into a node by its input_mapping, captured as a
        typed channel. Reads the resolved mapping VALUES only (upstream outputs /
        gate notes) - never the operator-input block layered on top - so a generic
        operator instruction that happens to name an id cannot pollute the set."""
        mapping = params.get("input_mapping")
        if not mapping:
            return []
        channels = {
            nid: {"output": n.get("output"), "review_note": n.get("review_note")}
            for nid, n in run["nodes"].items()
        }
        ids: list[str] = []
        for ref in mapping.values():
            try:
                value = resolve_ref(str(ref), channels)
            except UnresolvedInput:
                continue
            for token in _TASK_ID_TOKEN.findall(value or ""):
                if token not in ids:
                    ids.append(token)
        return ids

    def _resolve_task_ref(self, run: dict, task_ref: str) -> list[str]:
        """The card id(s) an adopt node should drive. A literal id resolves to
        itself; a ``{{nodes.<id>.output.task_ids}}`` reference extracts the board
        task ids an upstream node surfaced in its output (by their id shape, so a
        free-text output still yields a typed list). Fails loud on an empty or
        unproduced source — never drives zero cards silently."""
        ref = task_ref.strip()
        match = _TASK_IDS_REF.match(ref)
        if not match:
            return [ref]  # literal board task id
        source = match.group(1)
        node = run["nodes"].get(source)
        # Prefer the typed list captured from the source node's resolved input
        # (the ids that flowed in via input_mapping / a gate note): driving real
        # board cards must not depend on the worker re-emitting machine-parseable
        # ids in free text. Fall back to scraping the output by id shape only when
        # no structured list is present.
        typed = node.get("task_ids") if node else None
        if typed:
            structured = [tid for tid in dict.fromkeys(typed) if tid]
            if structured:
                return structured
        output = node.get("output") if node else None
        if output:
            scraped: list[str] = []
            for token in _TASK_ID_TOKEN.findall(output):
                if token not in scraped:
                    scraped.append(token)
            if scraped:
                return scraped
        raise UnresolvedInput(
            f"task_ref node {source!r} surfaced no task ids to drive "
            f"(neither a typed task_ids channel nor an id in its output)"
        )

    def _adopt_cards(
        self, executor: NodeExecutor, run: dict, node_id: str, params: dict, subscribe_cards: bool = True
    ) -> None:
        """Drive the existing board card(s) named by an adopt node's task_ref:
        resolve the id(s), adopt each (assign + promote), and record them on the
        node. Gating on their completion happens in the poll loop. A resolution
        or adopt error settles the node failure loudly rather than scheduling it
        in a broken state — the same contract as input_mapping resolution."""
        node = run["nodes"][node_id]
        sequential = bool(params.get("sequential"))
        try:
            ids = self._resolve_task_ref(run, params.get("task_ref") or "")
            adopt = getattr(executor, "adopt", None)
            if adopt is None:
                raise ValueError("adopt requires a Kanban-backed (project) scope")
            assignee = params.get("assignee") or ""
            # Sequential is only meaningful for more than one card: promote the
            # first now and queue the rest; the poll loop promotes N+1 once N is
            # terminal, so workers build on prior committed work on one branch.
            sequential = sequential and len(ids) > 1
            if sequential:
                driven = [adopt(ids[0], assignee=assignee)]
            else:
                driven = [adopt(task_id, assignee=assignee) for task_id in ids]
        except (UnresolvedInput, ValueError) as exc:
            node["status"] = "completed"
            node["outcome"] = "failure"
            node["output"] = f"adopt failed: {exc}"
            node["seq"] = _max_seq(run) + 1
            # An adopt that drove ZERO cards did none of the real work; fail the
            # run closed so it cannot fall through to a downstream build/PR with
            # an empty branch. The advance engine honours this and does not route
            # this node's outgoing edges.
            node["abort_run"] = True
            return
        node["driven_task_ids"] = driven
        node["hermes_task_id"] = driven[0]
        node["status"] = "scheduled"
        if sequential:
            node["adopt_seq"] = {
                "pending": ids[1:],
                "assignee": assignee,
                "outputs": [],
                "failed": False,
            }
        # Subscribe every driven card to its terminal events for the origin (a
        # multi-card adopt drives more than one).
        for handle in driven:
            self._subscribe_card(executor, run, handle, params, subscribe_cards)

    def _card_terminal(
        self,
        executor: NodeExecutor,
        node: dict,
        handle: str,
        completion: Any,
        review_profile: Optional[str],
    ) -> bool:
        """Whether a driven/backing card counts as terminal for node settlement.

        Without a review_profile (or for a failed card), a settled card is
        terminal. With a review_profile, the FIRST successful completion is routed
        once through the native review stage (done -> review) and is NOT terminal
        yet; it becomes terminal only when it settles again after review (tracked
        by reviewed_task_ids so the transition fires exactly once)."""
        if not (completion.settled and completion.outcome is not None):
            return False
        if not review_profile or completion.outcome == "failure":
            return True
        if handle in (node.get("reviewed_task_ids") or []):
            return True
        send = getattr(executor, "send_to_review", None)
        if send is None:
            return True  # backend has no review stage; accept the completion as-is
        try:
            send(handle, reviewer=review_profile)
        except Exception as exc:  # noqa: BLE001 - never let a review-routing error wedge the run
            # Leave the card unmarked so the next tick retries the transition,
            # and keep the node active rather than crashing _advance_step.
            print(
                f"hermes-workflows: send_to_review failed for {handle}: {exc}",
                file=sys.stderr,
            )
            return False
        node.setdefault("reviewed_task_ids", []).append(handle)
        return False

    def _evaluate_wait(self, node: dict, step: dict, channels: dict) -> Optional[str]:
        """Poll a wait node's predicate once. Returns ``"success"`` / ``"failure"``
        to settle it, or ``None`` to keep waiting. Records the first-poll time for
        the optional timeout, resolves a ``{{nodes.X.output}}`` ref, fails loud on
        an unresolvable ref or unknown condition, and fails on timeout."""
        if node.get("wait_started_at") is None:
            node["wait_started_at"] = int(time.time())
        wait_for = dict(step.get("wait_for") or {})
        try:
            if "github_pr_merged" in wait_for:
                wait_for["github_pr_merged"] = resolve_ref(wait_for["github_pr_merged"], channels)
            outcome = wait.evaluate(wait_for)
        except UnresolvedInput as exc:
            node["output"] = f"wait input resolution failed: {exc}"
            return "failure"
        except ValueError as exc:
            node["output"] = f"wait misconfigured: {exc}"
            return "failure"
        if outcome is None:
            timeout = step.get("timeout_seconds")
            if timeout is not None and int(time.time()) - int(node["wait_started_at"]) >= int(timeout):
                node["output"] = f"wait timed out after {timeout}s"
                return "failure"
        return outcome

    def _schedule_node(
        self,
        executor: NodeExecutor,
        run: dict,
        run_id: str,
        node_id: str,
        params: Optional[dict],
        subscribe_cards: bool = True,
    ) -> None:
        if params is None:
            return
        node = run["nodes"][node_id]
        if params.get("adopt"):
            # Drive existing card(s) instead of creating one; no prompt/input_mapping
            # resolution (the work is the card's own).
            self._adopt_cards(executor, run, node_id, params, subscribe_cards)
            return
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
        # Capture the board task ids carried in via input_mapping as a typed
        # channel, so a downstream adopt can drive them structurally even if this
        # node's worker later emits a prose summary with no literal ids.
        captured = self._input_task_ids(run, params)
        if captured:
            node["task_ids"] = captured
        handle = executor.schedule(
            run_id=run_id,
            node_id=node_id,
            workflow_id=run["workflow_id"],
            params=params,
            iteration=node.get("seq", 0),
        )
        node["hermes_task_id"] = handle
        node["status"] = "scheduled"
        self._subscribe_card(executor, run, handle, params, subscribe_cards)


def _board_conn(executor: NodeExecutor):
    """The Kanban DB connection behind an executor, when it has one. Reaches
    through a CompositeExecutor to its scope executor."""
    scope = getattr(executor, "scope", executor)
    return getattr(scope, "board_conn", None)


def _notice_text(run: dict, event: str, node_id: Optional[str]) -> str:
    workflow_id = run.get("workflow_id")
    run_id = run.get("run_id")
    if event == "waiting":
        # Actionable gate notice: what is needed, the allowed decisions, and how
        # to resolve it. The operator can reply right here in this chat with a
        # decision (the gate_reply hook routes it to this run), or use the
        # dashboard / CLI.
        return (
            f"ACTION NEEDED - workflow {workflow_id} run {run_id}: review gate "
            f"'{node_id}' is waiting for your decision. Reply in this chat with "
            f"'approved', 'rejected', or 'needs_changes' (optionally followed by a "
            f"note) - or, if the gate offered choices, just reply with your pick "
            f"(e.g. a number or a name), which is taken as approval with your reply "
            f"as the note. You can also resolve it from the dashboard or with: "
            f"hermes-workflows review {run_id} {node_id} <decision> [--note \"...\"]."
        )
    if event == "blocked":
        card = (run.get("nodes") or {}).get(node_id, {}).get("hermes_task_id")
        card_hint = f" (card {card})" if card else ""
        return (
            f"ATTENTION - workflow {workflow_id} run {run_id}: the card for node "
            f"'{node_id}'{card_hint} is blocked and the run cannot make progress "
            f"until it is unblocked. Inspect and unblock it on its board, then the "
            f"next tick resumes the run automatically."
        )
    if event == "stuck":
        node = (run.get("nodes") or {}).get(node_id, {})
        card = node.get("hermes_task_id")
        card_hint = f" (card {card})" if card else ""
        return (
            f"ATTENTION - workflow {workflow_id} run {run_id}: node '{node_id}'"
            f"{card_hint} was settled FAILED because its driven card could not be "
            f"dispatched (repeated worker spawn/exec failures); the run stopped "
            f"polling it instead of hanging. Check the card's profile/reviewer "
            f"skills on its board."
        )
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


def _layer_operator_input(prompt: str, operator_input: str) -> str:
    """Layer the run's operator input above a node's prompt as the highest-
    priority block: it overrides conflicting node instructions and otherwise
    binds as an additional constraint. Nothing is dropped - the full node prompt
    follows."""
    return (
        "OPERATOR INSTRUCTION - HIGHEST PRIORITY for this run. Where it conflicts "
        "with the node instructions below, follow this; otherwise treat it as an "
        "additional binding constraint.\n\n"
        f"{operator_input}\n\n"
        "--- node instructions ---\n\n"
        f"{prompt}"
    )


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


def _node_handles(node: dict) -> list[str]:
    """Backing card handles to poll for a node: an adopt node's full driven list,
    else its single hermes_task_id (empty when it has neither)."""
    driven = node.get("driven_task_ids")
    if driven:
        return list(driven)
    handle = node.get("hermes_task_id")
    return [handle] if handle else []


def _has_open_card(run: dict) -> bool:
    return any(
        node.get("status") in ("scheduled", "running") and _node_handles(node)
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

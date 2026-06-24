"""The ``hermes-workflows`` command — a thin entrypoint over the orchestrator.

Subcommands:
  run <workflow_id> [--project P]   start a run and advance it once
  advance-all                        advance every active run (the tick body)
  advance-run <run_id>               advance one run (the event-driven path)
  status <run_id>                    print a run's current state
  cancel <run_id>                    cancel a run and its still-active nodes
  resume <run_id> [--node|--all]     resume a stalled/failed run under the live spec
  review <run_id> <node_id> <dec>    resolve a human_review node
  export <workflow_id> --as-template share a workflow as an installation-
                                     agnostic template (+ adaptation guide)

Each prints a JSON document to stdout. The installed wrapper (``bin/hermes-
workflows``) execs this module; cron jobs invoke the same command.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path
from typing import Any, Optional, Sequence

from . import cli_bridge, config
from .engine import ACTIVE_RUN_STATUSES, Engine


def build_engine() -> Engine:
    """Wire the orchestrator to the live Hermes runtime: project runs land on
    their own project board (``kanban_factory``), falling back to the runtime
    board when unbound; global runs use the Direct profile-runner backend."""
    from hermes_cli import kanban_db as kb

    from .bridge import boards
    from .executor import DirectExecutor, KanbanExecutor, ScriptExecutor
    from .notify_sender import make_sender

    cache: dict[str, KanbanExecutor] = {}

    def kanban_factory(slug: str) -> KanbanExecutor:
        if slug not in cache:
            boards.ensure_board(slug)
            cache[slug] = KanbanExecutor(kb.connect(board=slug))
        return cache[slug]

    return Engine(
        core_cli=config.core_cli(),
        db_path=str(config.runs_db_path()),
        kanban=KanbanExecutor(kb.connect(board=config.runtime_board())),
        direct=DirectExecutor(store_dir=config.direct_store_dir()),
        # The script executor runs script nodes locally in any scope. The enable
        # gate is enforced at the executor (consulted at schedule time, so every
        # advance path is covered) as well as fail-fast at the run entrypoint;
        # the executor only ever exposes the settings env allowlist.
        script=ScriptExecutor(
            store_dir=config.script_store_dir(),
            env_allowlist=config.script_env_allowlist(),
            enabled=config.scripts_enabled,
        ),
        kanban_factory=kanban_factory,
        # Run-lifecycle notices: deliver through the in-process gateway's
        # delivery router (no-op when headless), to the run origin or the
        # configured default target.
        sender=make_sender(),
        default_deliver=config.default_deliver(),
        # Open Second Brain write policy from the enforced settings.
        memory=config.memory_settings(),
        # Enforced execution mode: durable (one step per tick) vs direct/auto
        # (drain inline-eligible script steps synchronously).
        default_mode=str(config.settings()["default_mode"]),
        # Worker-side telemetry sidecars, folded into nodes at settle time.
        telemetry_dir=config.telemetry_dir(),
        # Per-run JSONL trace, opt-in: no writer object at all when disabled.
        trace=_build_trace_writer(),
    )


def _build_trace_writer():
    if not config.trace_enabled():
        return None
    from .trace import TraceWriter

    return TraceWriter(config.traces_dir())


def workflow_has_scripts(engine: Engine, spec_path: str) -> bool:
    """Whether the compiled workflow contains any script node."""
    return bool(engine._core(["compile-preview", spec_path]).get("script_steps"))


class ScriptsDisabledError(Exception):
    """A workflow with script nodes was started while scripts are disabled."""


def guard_scripts_enabled(engine: Engine, spec_path: str) -> None:
    """Refuse to run a workflow with script nodes unless scripts are enabled
    in settings (TZ §25.2). Raises ScriptsDisabledError when blocked."""
    if workflow_has_scripts(engine, spec_path) and not config.scripts_enabled():
        raise ScriptsDisabledError(
            "workflow contains script nodes but execution.scripts_enabled is false"
        )


def _spec_path_for_workflow(engine: Engine, workflow_id: str) -> str:
    specs = engine._core(["list-specs", "--roots", ",".join(config.cli_spec_roots())])
    for spec in specs:
        if spec["id"] == workflow_id:
            return spec["path"]
    raise SystemExit(f"unknown workflow '{workflow_id}'")


def _spec_path_for_run(engine: Engine, run_id: str) -> str:
    run = engine.status(run_id)
    stored = engine._stored_spec_path(run)
    if stored is not None:
        return stored
    return _spec_path_for_workflow(engine, run["workflow_id"])


def _default_project(engine: Engine, spec_path: str, given: Optional[str]) -> Optional[str]:
    """Bind a project run to its project: explicit --project wins, else the
    workflow scope's first declared project; global stays unbound."""
    if given:
        return given
    scope = engine._core(["compile-preview", spec_path]).get("scope", {})
    if scope.get("type") in ("project", "projects"):
        projects = scope.get("projects") or []
        return projects[0] if projects else None
    return None


def _advance_all(engine: Engine) -> dict:
    """The tick body the cron shim runs: advance every active run and keep the
    singleton tick cron alive while runs remain active. Worker spawning is the
    gateway's embedded dispatcher (it ticks every board), so no dispatch here."""
    from .bridge import cron

    return engine.tick(
        config.cli_spec_roots(),
        sync_tick=lambda *, active, script: cron.sync_workflow_tick(active=active),
        tick_script="advance-all",
    )


def _advance_run(engine: Engine, run_id: str) -> dict:
    """The scoped advance the event-driven path spawns: advance exactly one run.
    The engine's ``ValueError`` (unknown run / unresolvable spec) is surfaced as
    a clean ``SystemExit`` (non-zero with a message), never a traceback."""
    try:
        return engine.advance_run(config.cli_spec_roots(), run_id)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc


def _dispatch(args: argparse.Namespace, engine: Engine) -> Any:
    if args.command == "run":
        spec = _spec_path_for_workflow(engine, args.workflow_id)
        try:
            guard_scripts_enabled(engine, spec)
        except ScriptsDisabledError as exc:
            raise SystemExit(str(exc)) from exc
        project_id = _default_project(engine, spec, args.project)
        run_id = f"{args.workflow_id}-{uuid.uuid4().hex[:8]}"
        try:
            params = json.loads(args.params) if args.params else None
        except json.JSONDecodeError as exc:
            raise SystemExit(f"--params is not valid JSON: {exc}") from exc
        if params is not None and not isinstance(params, dict):
            raise SystemExit("--params must be a JSON object")
        try:
            run = engine.run(
                spec,
                run_id,
                project_id=project_id,
                origin=args.origin,
                input=args.input,
                params=params,
            )
        except cli_bridge.CoreBridgeError as exc:
            # Single-flight refusal and a param-validation failure are both
            # expected operator-facing outcomes: exit with the core's message,
            # not a traceback.
            if exc.kind in ("ActiveRunExistsError", "ParamFillError"):
                raise SystemExit(exc.detail) from exc
            raise
        # A run that survived its first advance still needs future advances;
        # arm the singleton tick or a multi-node run stalls right here (the
        # tick keeps itself alive afterwards and tears down once idle). Never
        # tear down from this side: other active runs may still need it.
        if run.get("status") in ACTIVE_RUN_STATUSES:
            from .bridge import cron

            cron.ensure_workflow_tick()
        return run
    if args.command == "advance-all":
        return _advance_all(engine)
    if args.command == "advance-run":
        return _advance_run(engine, args.run_id)
    if args.command == "status":
        # Opportunistic live read: annotate active nodes with their card's live
        # state so status does not lag the tick. Falls back to the persisted run
        # if the spec cannot be resolved (e.g. the workflow file was removed).
        try:
            spec = _spec_path_for_run(engine, args.run_id)
        except SystemExit:
            return engine.status(args.run_id)
        return engine.status_live(spec, args.run_id)
    if args.command == "cancel":
        return engine.cancel(args.run_id)
    if args.command == "resume":
        try:
            # Use the CLI spec roots (global + templates + the repo-local
            # `<cwd>/.hermes/workflows`), same as run/status/advance, so a run
            # started from a repo-local spec is still resolvable on resume.
            run = engine.resume(
                config.cli_spec_roots(),
                args.run_id,
                node=args.node,
                reset_all=args.all,
            )
        except ValueError as exc:
            # ResumeError (active run / spec drift / no-or-many failed nodes) and
            # unknown-run/unresolvable-spec: a clean, traceback-free message.
            raise SystemExit(str(exc)) from exc
        except cli_bridge.CoreBridgeError as exc:
            # The core's own refusals: single-flight (reviving next to an active
            # sibling) and a non-failed --node target.
            if exc.kind in ("ActiveRunExistsError", "RetryError", "NotFoundError"):
                raise SystemExit(exc.detail) from exc
            raise
        # Like `run`: a resumed run that is still active needs future advances,
        # so arm the singleton tick (it tears itself down once idle).
        if run.get("status") in ACTIVE_RUN_STATUSES:
            from .bridge import cron

            cron.ensure_workflow_tick()
        return run
    if args.command == "review":
        spec = _spec_path_for_run(engine, args.run_id)
        return engine.decide_review(spec, args.run_id, args.node_id, args.decision, note=args.note)
    if args.command == "export":
        if not args.as_template:
            raise SystemExit("export currently supports only --as-template")
        from . import template_export

        out_dir = Path(args.out_dir) if args.out_dir else None
        try:
            return template_export.export(args.workflow_id, out_dir=out_dir)
        except cli_bridge.CoreBridgeError as exc:
            if exc.kind == "NotFoundError":
                raise SystemExit(exc.detail) from exc
            raise
    raise SystemExit(f"unknown command '{args.command}'")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="hermes-workflows")
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run", help="start a run and advance it once")
    p_run.add_argument("workflow_id")
    p_run.add_argument("--project", default=None)
    # Chat origin (<platform>:<chat>[:<thread>]) for run-lifecycle notices; the
    # cron trigger shim carries the schedule's delivery target here.
    p_run.add_argument("--origin", default=None)
    # Free-form operator input, layered above every agent_task prompt at highest
    # priority (overrides conflicting node instructions, augments the rest).
    p_run.add_argument("--input", default=None)
    # Template parameter values as a JSON object ({"name": value, ...}). The core
    # validates them against the workflow's declared params (rejecting unknown or
    # missing-required values) and substitutes each as {{params.<name>}}. Omit
    # for a workflow with no params, or one whose params are all optional.
    p_run.add_argument("--params", default=None)

    sub.add_parser("advance-all", help="advance every active run")

    p_advance_run = sub.add_parser("advance-run", help="advance a single run by id")
    p_advance_run.add_argument("run_id")

    p_status = sub.add_parser("status", help="print a run's state")
    p_status.add_argument("run_id")

    p_cancel = sub.add_parser("cancel", help="cancel a run (and its active nodes)")
    p_cancel.add_argument("run_id")

    p_resume = sub.add_parser(
        "resume", help="resume a stalled/failed run from its failed node (or --all)"
    )
    p_resume.add_argument("run_id")
    # --node (an explicit failed node) and --all (full restart) are mutually
    # exclusive; the bare default resumes THE single failed node.
    resume_target = p_resume.add_mutually_exclusive_group()
    resume_target.add_argument(
        "--node", default=None, help="resume a specific failed node (must be failed)"
    )
    resume_target.add_argument(
        "--all",
        action="store_true",
        help="full restart: reset the whole graph and re-run from the entry node",
    )

    p_review = sub.add_parser("review", help="resolve a human_review node")
    p_review.add_argument("run_id")
    p_review.add_argument("node_id")
    p_review.add_argument("decision")
    # Optional operator payload, consumable downstream as {{nodes.<gate>.review_note}}.
    p_review.add_argument("--note", default=None)

    p_export = sub.add_parser("export", help="export a workflow as a shareable template")
    p_export.add_argument("workflow_id")
    p_export.add_argument(
        "--as-template",
        action="store_true",
        help="decouple installation bindings into placeholders + an adaptation guide",
    )
    p_export.add_argument(
        "--out-dir", default=None, help="where to write the bundle (default: the export cache dir)"
    )

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parser().parse_args(argv)
    result = _dispatch(args, build_engine())
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())

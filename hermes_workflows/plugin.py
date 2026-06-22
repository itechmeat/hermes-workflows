"""Hermes plugin entrypoint. Stays thin: it registers the four model tools with
lazy handlers so Hermes startup does not import the engine, and does no O2B
detection at load time (so an O2B problem can never break startup)."""

from __future__ import annotations

import json
from typing import Any, Optional

PLUGIN_NAME = "hermes-workflows"
TOOLSET = "workflows"

_LIST_SCHEMA = {"type": "object", "properties": {}, "additionalProperties": False}
_RUN_SCHEMA = {
    "type": "object",
    "properties": {
        "workflow_id": {"type": "string"},
        "project_id": {"type": "string"},
    },
    "required": ["workflow_id"],
    "additionalProperties": False,
}
_STATUS_SCHEMA = {
    "type": "object",
    "properties": {"run_id": {"type": "string"}},
    "required": ["run_id"],
    "additionalProperties": False,
}
_EXPLAIN_SCHEMA = {
    "type": "object",
    "properties": {"workflow_id": {"type": "string"}},
    "required": ["workflow_id"],
    "additionalProperties": False,
}
_REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "run_id": {"type": "string"},
        "node_id": {"type": "string"},
        "decision": {"type": "string", "enum": ["approved", "rejected", "needs_changes"]},
        "note": {
            "type": "string",
            "description": "Optional operator payload (e.g. the picked option or instructions), "
            "consumable downstream as {{nodes.<gate>.review_note}}.",
        },
    },
    "required": ["run_id", "node_id", "decision"],
    "additionalProperties": False,
}


def register(ctx: Any) -> None:
    log = getattr(ctx, "log", None)
    if log is not None and hasattr(log, "info"):
        try:
            log.info("hermes-workflows plugin loaded")
        except Exception:
            pass

    # Capture each turn's chat origin before dispatch so a model-started
    # workflow_run can carry it (tool handlers never see the SessionSource), and
    # route an operator's decision reply to a run paused on a human_review gate
    # (the native operator->run channel). Both are pre_gateway_dispatch hooks.
    register_hook = getattr(ctx, "register_hook", None)
    if callable(register_hook):
        try:
            from .origin_capture import capture_origin

            register_hook("pre_gateway_dispatch", capture_origin)
        except Exception:
            pass
        try:
            from .gate_reply import route_chat_reply

            register_hook("pre_gateway_dispatch", route_chat_reply)
        except Exception:
            pass

    # Per-node telemetry observers — active only inside kanban worker
    # processes (gated on HERMES_KANBAN_TASK inside); fail-open.
    try:
        from .observer import register_observer_hooks

        register_observer_hooks(ctx)
    except Exception:
        pass

    # Event-driven advance: worker-side kanban lifecycle observers that spawn a
    # scoped `advance-run` the moment a workflow card completes/blocks, so a run
    # advances in seconds instead of waiting for the residual ~2-minute tick.
    # Registered unconditionally (the observers self-no-op for non-workflow
    # cards); the detached advance is the real runtime and logs truthfully.
    # Lazy import keeps registration cheap — the engine is never imported here.
    try:
        from .hooks import register as register_lifecycle_hooks

        register_lifecycle_hooks(ctx)
    except Exception:
        pass

    ctx.register_tool(
        name="workflow_list",
        toolset=TOOLSET,
        schema=_LIST_SCHEMA,
        handler=_handle_list,
        description="List available workflows.",
    )
    ctx.register_tool(
        name="workflow_run",
        toolset=TOOLSET,
        schema=_RUN_SCHEMA,
        handler=_handle_run,
        description="Run a workflow by id.",
    )
    ctx.register_tool(
        name="workflow_status",
        toolset=TOOLSET,
        schema=_STATUS_SCHEMA,
        handler=_handle_status,
        description="Get the status of a workflow run.",
    )
    ctx.register_tool(
        name="workflow_explain",
        toolset=TOOLSET,
        schema=_EXPLAIN_SCHEMA,
        handler=_handle_explain,
        description="Explain what a workflow does without running it.",
    )
    ctx.register_tool(
        name="workflow_review",
        toolset=TOOLSET,
        schema=_REVIEW_SCHEMA,
        handler=_handle_review,
        description="Resolve a human_review node (approved/rejected/needs_changes) and advance the run.",
    )

    # In-session slash command, available in CLI AND gateway (messenger)
    # sessions. Guarded: a host without register_command simply skips it and the
    # model tools above still work. `args_hint` lets gateway adapters (e.g.
    # Discord's native picker) surface an argument field.
    register_command = getattr(ctx, "register_command", None)
    if callable(register_command):
        register_command(
            "workflow",
            _handle_command,
            description="Run and manage Workflows (list / run / status / review / cancel / explain).",
            args_hint="run <id> [project] [name=value ...] | status <run> | review <run> <node> <decision> | cancel <run> | list",
        )


_COMMAND_USAGE = (
    "Usage: /workflow list | "
    "run <id> [project] [name=value ...] [--input <operator prompt>] | "
    "status <run_id> | "
    "review <run_id> <node_id> <approved|rejected|needs_changes> [note] | "
    "cancel <run_id> | explain <id>"
)


def _tokenize(raw_args: str) -> list[str]:
    """Split the command line, respecting quotes so a ``name="two words"`` param
    value survives as one token (the slash-command emitter quotes text values).
    Falls back to a plain whitespace split on an unbalanced quote."""
    import shlex

    try:
        return shlex.split(raw_args or "")
    except ValueError:
        return (raw_args or "").strip().split()


def _parse_run_args(tail: list[str]) -> tuple[Optional[str], dict[str, str]]:
    """From the tokens after ``run <id>`` (with any ``--input`` already removed),
    split a positional project id from ``name=value`` template params. The first
    bare token (no ``=``) is the project; every ``name=value`` token is a param.
    Core ``fillParams`` validates/coerces the values at run-create."""
    project_id: Optional[str] = None
    params: dict[str, str] = {}
    for token in tail:
        if "=" in token:
            name, value = token.split("=", 1)
            if not name:
                raise ValueError(f"invalid param {token!r}: expected name=value")
            params[name] = value
        elif project_id is None:
            project_id = token
        else:
            # A second bare token is ambiguous (a typo'd param missing its `=`,
            # or a stray arg). Fail loud rather than silently dropping it and
            # starting a run with unintended arguments.
            raise ValueError(f"unexpected argument {token!r}: use name=value for params")
    return project_id, params


def _handle_command(raw_args: str = "", **_kwargs: Any) -> str:
    """The `/workflow` slash command: a thin chat front-end over the same tools
    the model uses. Returns a short human-readable line (handlers never raise to
    the gateway — a failure is reported as text)."""
    import uuid

    from . import config, tools

    parts = _tokenize(raw_args)
    if not parts or parts[0] in ("help", "-h", "--help"):
        return _COMMAND_USAGE
    sub, rest = parts[0], parts[1:]
    roots, core_cli = config.spec_roots(), config.core_cli()
    try:
        if sub == "list":
            workflows = tools.list_workflows(roots=roots, core_cli=core_cli)["workflows"]
            if not workflows:
                return "No workflows found."

            def _trigger(value: Any) -> str:
                return value.get("type", "?") if isinstance(value, dict) else str(value)

            return "Workflows:\n" + "\n".join(
                f"- {w['id']} ({w['scope']}, {_trigger(w['trigger'])}"
                f"{'' if w['enabled'] else ', disabled'})"
                for w in workflows
            )
        if sub == "run":
            if not rest:
                return (
                    "Usage: /workflow run <workflow_id> [project] [name=value ...] "
                    "[--input <operator prompt>]"
                )
            workflow_id = rest[0]
            tail = rest[1:]
            # Everything after `--input` is the operator's free-form run input,
            # layered above every agent_task prompt at highest priority.
            operator_input = None
            if "--input" in tail:
                i = tail.index("--input")
                operator_input = " ".join(tail[i + 1 :]).strip() or None
                tail = tail[:i]
            # The remaining tokens are a positional project and name=value
            # template params (validated/coerced by the core at run-create).
            project_id, params = _parse_run_args(tail)
            run_id = f"run_{uuid.uuid4().hex[:12]}"
            result = tools.run_workflow(
                workflow_id,
                engine=_build_engine(),
                roots=roots,
                core_cli=core_cli,
                run_id=run_id,
                project_id=project_id,
                input=operator_input,
                params=params or None,
            )
            return f"Started run {result['run_id']} ({result['status']})."
        if sub == "status":
            if not rest:
                return "Usage: /workflow status <run_id>"
            status = tools.workflow_status(rest[0], engine=_build_engine())
            current = status.get("current_node")
            tail = f", current node {current}" if current else ""
            return f"Run {status['run_id']}: {status['status']}{tail}."
        if sub == "review":
            if len(rest) < 3:
                return "Usage: /workflow review <run_id> <node_id> <decision> [note]"
            note = " ".join(rest[3:]) or None
            result = tools.review_workflow(
                rest[0], rest[1], rest[2], engine=_build_engine(), roots=roots, core_cli=core_cli, note=note
            )
            return f"Resolved gate {rest[1]} as {result['decision']} (run {result['status']})."
        if sub == "cancel":
            if not rest:
                return "Usage: /workflow cancel <run_id>"
            result = _build_engine().cancel(rest[0])
            return f"Cancelled run {rest[0]} ({result.get('status')})."
        if sub == "explain":
            if not rest:
                return "Usage: /workflow explain <workflow_id>"
            explained = tools.explain_workflow(rest[0], roots=roots, core_cli=core_cli)
            summary = explained.get("summary") or explained.get("name") or rest[0]
            return f"{rest[0]}: {summary}"
        # Not an explicit subcommand: treat the whole argument string as natural
        # language - resolve the target workflow + operator input, or ask.
        return _handle_nl_command(raw_args, roots, core_cli)
    except Exception as exc:  # noqa: BLE001 - a slash command never crashes the session
        return f"workflow command failed: {exc}"


def _handle_nl_command(raw_args: str, roots: Any, core_cli: Any) -> str:
    """Free-text entry: `/workflow <anything>` that is not an explicit subcommand.
    Resolve it to a workflow id + operator input and start the run, or return a
    clarifying question when the target/intent is ambiguous or unknown."""
    import uuid

    from . import tools

    workflows = tools.list_workflows(roots=roots, core_cli=core_cli)["workflows"]
    resolved = tools.resolve_nl_command(raw_args, workflows)
    question = resolved.get("question")
    if question:
        return question
    workflow_id = resolved["workflow_id"]
    operator_input = resolved.get("input")
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    result = tools.run_workflow(
        workflow_id,
        engine=_build_engine(),
        roots=roots,
        core_cli=core_cli,
        run_id=run_id,
        input=operator_input,
    )
    suffix = f' with input: "{operator_input}"' if operator_input else ""
    return f"Started run {result['run_id']} ({result['status']}) of {workflow_id}{suffix}."


def _handle_list(args: Any = None, **_kwargs: Any) -> str:
    from . import config, tools

    return json.dumps(tools.list_workflows(roots=config.spec_roots(), core_cli=config.core_cli()))


def _handle_explain(args: dict, **_kwargs: Any) -> str:
    from . import config, tools

    return json.dumps(
        tools.explain_workflow(args["workflow_id"], roots=config.spec_roots(), core_cli=config.core_cli())
    )


def _handle_run(args: dict, task_id: Any = None, **_kwargs: Any) -> str:
    import uuid

    from . import config, origin_capture, tools

    run_id = f"run_{uuid.uuid4().hex[:12]}"
    # The pre_gateway_dispatch hook stashed this turn's origin under the session
    # key; the gateway passes that key as task_id. A miss -> no origin -> the
    # configured default delivery target.
    origin = origin_capture.origin_for(task_id if isinstance(task_id, str) else None)
    return json.dumps(
        tools.run_workflow(
            args["workflow_id"],
            engine=_build_engine(),
            roots=config.spec_roots(),
            core_cli=config.core_cli(),
            run_id=run_id,
            project_id=args.get("project_id"),
            origin=origin,
        )
    )


def _handle_status(args: dict, **_kwargs: Any) -> str:
    from . import tools

    return json.dumps(tools.workflow_status(args["run_id"], engine=_build_engine()))


def _handle_review(args: dict, **_kwargs: Any) -> str:
    from . import config, tools

    return json.dumps(
        tools.review_workflow(
            args["run_id"],
            args["node_id"],
            args["decision"],
            engine=_build_engine(),
            roots=config.spec_roots(),
            core_cli=config.core_cli(),
            note=args.get("note"),
        )
    )


def _build_engine() -> Any:
    from .cli import build_engine

    return build_engine()

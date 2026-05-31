"""Hermes plugin entrypoint. Stays thin: it registers the four model tools with
lazy handlers so Hermes startup does not import the engine, and does no O2B
detection at load time (so an O2B problem can never break startup)."""

from __future__ import annotations

import json
from typing import Any

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
    # workflow_run can carry it (tool handlers never see the SessionSource).
    register_hook = getattr(ctx, "register_hook", None)
    if callable(register_hook):
        try:
            from .origin_capture import capture_origin

            register_hook("pre_gateway_dispatch", capture_origin)
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
        )
    )


def _build_engine() -> Any:
    from .cli import build_engine

    return build_engine()

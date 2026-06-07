"""Dashboard plugin backend. Mounted at /api/plugins/workflows/ by the Hermes
dashboard runtime. Lists workflows and active runs, reports O2B availability,
and exposes the single human-in-the-loop write: resolving a human_review node.
Graph editing remains human-only via CLI (the visual editor is a later phase)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from fastapi import APIRouter, Body, HTTPException

router = APIRouter()


@contextmanager
def _spec_tempfile(workflow: dict, ui: object) -> Iterator[str]:
    """Write a ``{workflow + ui?}`` spec to a temp JSON file for the core CLI's
    ``--spec-file`` flag, removing it afterwards. Shared by the create and save
    routes so the temp-file plumbing lives in exactly one place."""
    spec = dict(workflow)
    if ui is not None:
        spec["ui"] = ui
    fd, tmp = tempfile.mkstemp(suffix=".json")
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(spec, handle)
        yield tmp
    finally:
        os.unlink(tmp)


def _save_spec(workflow: dict, ui: object) -> dict:
    """Validate-and-persist a ``{workflow, ui?}`` through the core ``spec-save``.
    A bad graph or id maps to ``400``; other failures to ``500``. Shared by the
    save and enable/disable routes so the spec-save plumbing lives in one place."""
    from hermes_workflows import cli_bridge, config

    with _spec_tempfile(workflow, ui) as tmp:
        try:
            return cli_bridge.invoke(
                [
                    *config.core_cli(),
                    "spec-save",
                    "--roots",
                    ",".join(config.spec_roots()),
                    "--global-root",
                    str(config.global_workflows_dir()),
                    "--templates-root",
                    str(config.templates_dir()),
                    "--spec-file",
                    tmp,
                ]
            )
        except cli_bridge.CoreBridgeError as exc:
            if exc.kind in ("SpecValidationError", "WorkflowParseError"):
                raise HTTPException(status_code=400, detail=exc.detail) from exc
            raise HTTPException(status_code=500, detail="failed to save workflow") from exc


def _workflow_detail(workflow_id: str) -> dict | None:
    from hermes_workflows import cli_bridge, config

    return cli_bridge.invoke(
        [*config.core_cli(), "spec-get", "--roots", ",".join(config.spec_roots()), "--id", workflow_id]
    )


def _run_state(run_id: str) -> dict | None:
    from hermes_workflows import cli_bridge, config

    run = cli_bridge.invoke(
        [*config.core_cli(), "run-load", "--db", str(config.runs_db_path()), "--id", run_id]
    )
    return None if run is None else _overlay_live_telemetry(run)


def _overlay_live_telemetry(run: dict) -> dict:
    """Attach worker telemetry sidecars to nodes the engine has not baked yet,
    so the inspector's poll shows live counts (and pending approvals) while a
    node is still running. Best-effort: any failure leaves the run untouched —
    telemetry is an overlay, never a reason for a 500."""
    try:
        from hermes_workflows import config, telemetry

        root = config.telemetry_dir()
        for node in run.get("nodes", {}).values():
            task_id = node.get("hermes_task_id")
            if not task_id or node.get("telemetry") is not None:
                continue
            data = telemetry.load_node_telemetry(root, task_id)
            if data is not None:
                node["telemetry"] = data
    except Exception:
        pass
    return run


@router.get("/workflows")
async def list_workflows() -> dict:
    """List workflows for the Templates page. Each row carries ``enabled`` plus
    the run/schedule columns: ``last_run_at`` / ``last_status`` (the workflow's
    most recent run) and ``next_run_at`` (its cron schedule, ``null`` when it has
    none). The columns are best-effort overlays — listing never fails if the run
    store is empty or the cron module is unavailable."""
    from hermes_workflows import config, tools

    result = tools.list_workflows(roots=config.spec_roots(), core_cli=config.core_cli())
    latest = _latest_runs()
    next_runs = _next_run_by_workflow()
    for wf in result["workflows"]:
        run = latest.get(wf["id"]) or {}
        wf["last_run_at"] = run.get("started_at")
        wf["last_status"] = run.get("status")
        wf["next_run_at"] = next_runs.get(wf["id"])
    return result


def _latest_runs() -> dict:
    """Map each workflow id to its most recent run (core ``run-latest``). A
    best-effort overlay: a non-mapping result or any failure (e.g. a locked or
    missing run store) yields no enrichment rather than failing the list."""
    from hermes_workflows import cli_bridge, config

    try:
        result = cli_bridge.invoke(
            [*config.core_cli(), "run-latest", "--db", str(config.runs_db_path())]
        )
    except Exception:
        return {}
    return result if isinstance(result, dict) else {}


def _next_run_by_workflow() -> dict:
    """Map each scheduled workflow id to its next-run timestamp. Returns ``{}``
    when the Hermes cron module is unavailable (it is optional at runtime) or the
    lookup fails — the columns are an overlay, never a hard dependency."""
    try:
        from hermes_workflows.bridge import cron as cron_bridge

        return cron_bridge.next_run_by_workflow()
    except Exception:
        return {}


@router.put("/workflows/{workflow_id}/enabled")
async def set_workflow_enabled(workflow_id: str, enabled: bool = Body(..., embed=True)) -> dict:
    """Enable or disable a workflow. Writes ``enabled`` into the spec (the single
    source of truth) and, when the workflow has a cron schedule, pauses it on
    disable / resumes it on enable so the schedule follows the flag. ``404`` if
    the workflow does not exist."""
    detail = _workflow_detail(workflow_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="workflow not found")

    workflow = dict(detail["workflow"])
    workflow["enabled"] = enabled
    saved = _save_spec(workflow, detail.get("ui"))
    _sync_schedule_enabled(workflow_id, enabled)
    return saved


def _sync_schedule_enabled(workflow_id: str, enabled: bool) -> None:
    """Pause/resume the workflow's cron job to match the spec flag. No-op when
    the workflow has no schedule or the cron module is unavailable."""
    try:
        from hermes_workflows.bridge import cron as cron_bridge
    except Exception:
        return
    job = cron_bridge.find_workflow_job(workflow_id)
    if job is None:
        return
    (cron_bridge.resume if enabled else cron_bridge.pause)(job["id"])


@router.post("/workflows")
async def create_workflow(payload: dict = Body(...)) -> dict:
    """Create a brand-new workflow on disk. Body is ``{workflow, ui?}``. Refuses
    to overwrite an existing id (``409``); an invalid graph or bad id is ``400``.
    The created ``{workflow, ui?, path}`` is returned so the client can open it
    in the editor via the existing load-by-id path."""
    from hermes_workflows import cli_bridge, config

    workflow = payload.get("workflow")
    if not isinstance(workflow, dict):
        raise HTTPException(status_code=400, detail="body must contain a 'workflow' object")

    with _spec_tempfile(workflow, payload.get("ui")) as tmp:
        try:
            return cli_bridge.invoke(
                [
                    *config.core_cli(),
                    "spec-create",
                    "--roots",
                    ",".join(config.spec_roots()),
                    "--global-root",
                    str(config.global_workflows_dir()),
                    "--templates-root",
                    str(config.templates_dir()),
                    "--spec-file",
                    tmp,
                ]
            )
        except cli_bridge.CoreBridgeError as exc:
            if exc.kind == "SpecExistsError":
                raise HTTPException(status_code=409, detail=exc.detail) from exc
            if exc.kind in ("SpecValidationError", "WorkflowParseError"):
                raise HTTPException(status_code=400, detail=exc.detail) from exc
            raise HTTPException(status_code=500, detail="failed to create workflow") from exc


@router.delete("/workflows/{workflow_id}")
async def delete_workflow(workflow_id: str) -> dict:
    """Delete a workflow's on-disk spec. ``404`` if no spec matched the id."""
    from hermes_workflows import cli_bridge, config

    result = cli_bridge.invoke(
        [*config.core_cli(), "spec-delete", "--roots", ",".join(config.spec_roots()), "--id", workflow_id]
    )
    if not result or not result.get("deleted"):
        raise HTTPException(status_code=404, detail="workflow not found")
    return result


@router.get("/workflows/{workflow_id}/export")
async def export_workflow(workflow_id: str) -> dict:
    """Return a workflow's canonical on-disk YAML for download, wrapped in a JSON
    envelope (``{id, filename, yaml}``) so it travels over the host's JSON-only
    ``fetchJSON`` channel. The stored file is the authority (written by
    ``serializeWorkflow``); the route reads it verbatim and adds no second
    serializer. ``404`` if absent."""
    path = _spec_path_or_404(workflow_id)
    with open(path, encoding="utf-8") as handle:
        body = handle.read()
    return {"id": workflow_id, "filename": f"{workflow_id}.workflow.yaml", "yaml": body}


@router.get("/runs")
async def list_runs(scope: str = "active") -> dict:
    """List runs for the Runs page. ``scope=active`` (default) keeps the
    historical behaviour — only in-flight runs; ``scope=all`` adds finished
    runs. Each row carries the TZ columns, shaped from the core run summary
    (``run-list-summary``); ``duration`` is derived from the timing meta."""
    from hermes_workflows import cli_bridge, config

    argv = [*config.core_cli(), "run-list-summary", "--db", str(config.runs_db_path())]
    if scope != "all":
        argv.append("--active")
    runs = cli_bridge.invoke(argv) or []
    return {"runs": [_run_row(r) for r in runs]}


def _run_row(summary: dict) -> dict:
    """Shape one core run summary into the Runs-page row, adding the derived
    ``duration`` (``finished_at - started_at`` when both are known)."""
    started = summary.get("started_at")
    finished = summary.get("finished_at")
    duration = finished - started if started is not None and finished is not None else None
    return {
        "run_id": summary["run_id"],
        "workflow_id": summary.get("workflow_id"),
        "project_id": summary.get("project_id"),
        "status": summary.get("status"),
        "current_node": summary.get("current_node"),
        "started_at": started,
        "finished_at": finished,
        "duration": duration,
        # Sum of per-node telemetry tokens (core RunSummary); null until any
        # node has baked telemetry.
        "total_tokens": summary.get("total_tokens"),
    }


@router.post("/runs/{run_id}/review")
async def review_run(
    run_id: str, node_id: str = Body(...), decision: str = Body(...)
) -> dict:
    """Resolve a human_review node and advance the run. Same channel-agnostic
    resolution the model tool and CLI use; an invalid decision is a 400."""
    from hermes_workflows import config, tools
    from hermes_workflows.cli import build_engine

    try:
        return tools.review_workflow(
            run_id,
            node_id,
            decision,
            engine=build_engine(),
            roots=config.spec_roots(),
            core_cli=config.core_cli(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/workflows/{workflow_id}")
async def get_workflow(workflow_id: str) -> dict:
    """Full graph (workflow + ui + path) for the editor to load."""
    detail = _workflow_detail(workflow_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="workflow not found")
    return detail


@router.put("/workflows/{workflow_id}")
async def save_workflow(workflow_id: str, payload: dict = Body(...)) -> dict:
    """Persist an edited graph. Body is ``{workflow, ui?}``; the body id must
    match the URL. An invalid graph is rejected by the core (400)."""
    workflow = payload.get("workflow")
    if not isinstance(workflow, dict):
        raise HTTPException(status_code=400, detail="body must contain a 'workflow' object")
    if workflow.get("id") != workflow_id:
        raise HTTPException(status_code=400, detail="workflow id in body does not match the URL")

    return _save_spec(workflow, payload.get("ui"))


def _workflow_enabled(workflow_id: str) -> bool:
    """Whether the workflow's spec permits runs. Absent ``enabled`` means on;
    an unknown workflow is treated as enabled (the run path 404s separately)."""
    detail = _workflow_detail(workflow_id)
    if detail is None:
        return True
    return detail["workflow"].get("enabled", True) is not False


def _spec_path_or_404(workflow_id: str) -> str:
    detail = _workflow_detail(workflow_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="workflow not found")
    return detail["path"]


@router.post("/workflows/{workflow_id}/validate")
async def validate_workflow(workflow_id: str) -> dict:
    from hermes_workflows import cli_bridge, config

    return cli_bridge.invoke([*config.core_cli(), "validate", _spec_path_or_404(workflow_id)])


@router.post("/workflows/{workflow_id}/compile-preview")
async def compile_preview(workflow_id: str) -> dict:
    from hermes_workflows import cli_bridge, config

    return cli_bridge.invoke([*config.core_cli(), "compile-preview", _spec_path_or_404(workflow_id)])


@router.post("/workflows/{workflow_id}/run")
async def run_workflow(workflow_id: str, payload: dict = Body(default={})) -> dict:
    """Start a run from the dashboard. Non-blocking by design: a global-scope
    ``agent_task`` executes synchronously inside the first advance (Direct
    executor), so the blocking CLI path would hold this request open for the
    whole node. The route records the run, arms the advance tick, kicks the
    first advance in the background, and returns the created state — the UI
    polls ``GET /runs/{id}`` for progress."""
    import uuid

    from hermes_workflows import config, tools
    from hermes_workflows.bridge import cron
    from hermes_workflows.cli import (
        ScriptsDisabledError,
        build_engine,
        guard_scripts_enabled,
        _default_project,
        _spec_path_for_workflow,
    )

    engine = build_engine()
    try:
        spec = _spec_path_for_workflow(engine, workflow_id)
    except SystemExit as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not _workflow_enabled(workflow_id):
        raise HTTPException(status_code=409, detail="workflow is disabled")
    try:
        guard_scripts_enabled(engine, spec)
    except ScriptsDisabledError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    project_id = _default_project(engine, spec, payload.get("project_id"))
    run_id = f"{workflow_id}-{uuid.uuid4().hex[:8]}"
    return tools.start_workflow(
        workflow_id,
        engine=engine,
        # Fresh engine per advance thread: this engine's SQLite connections are
        # bound to the request thread and must not cross thread boundaries.
        engine_factory=build_engine,
        roots=config.spec_roots(),
        core_cli=config.core_cli(),
        run_id=run_id,
        project_id=project_id,
        ensure_tick=cron.ensure_workflow_tick,
    )


@router.get("/runs/{run_id}")
async def get_run(run_id: str) -> dict:
    """Full run state (per-node detail) for the run inspector."""
    run = _run_state(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    return run


@router.get("/runs/{run_id}/export")
async def export_run(run_id: str) -> dict:
    """Return a run's full state bundle (per-node detail, incl. Hermes task ids)
    for download, wrapped in a JSON envelope (``{run_id, filename, json}``) so it
    travels over the host's JSON-only ``fetchJSON`` channel. Reuses the same
    ``run-load`` shape the inspector reads — no second serializer. ``404`` if
    the run is absent."""
    run = _run_state(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    envelope = {"run_id": run_id, "filename": f"{run_id}.run.json", "json": run}
    trace = _run_trace(run_id)
    if trace is not None:
        # A traced run additionally carries its JSONL timeline; the Runs page
        # saves it as a second file next to the state bundle.
        envelope["trace"] = trace
        envelope["trace_filename"] = f"{run_id}.trace.jsonl"
    return envelope


def _run_trace(run_id: str) -> str | None:
    """The run's JSONL trace when tracing produced one. Best-effort overlay:
    any failure means no trace in the envelope, never a failed export."""
    try:
        from hermes_workflows import config
        from hermes_workflows import trace as trace_mod

        return trace_mod.read_trace(config.traces_dir(), run_id)
    except Exception:
        return None


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str) -> dict:
    from hermes_workflows import cli_bridge, config

    try:
        return cli_bridge.invoke(
            [*config.core_cli(), "run-cancel", "--db", str(config.runs_db_path()), "--id", run_id]
        )
    except cli_bridge.CoreBridgeError as exc:
        if exc.kind == "NotFoundError":
            raise HTTPException(status_code=404, detail=exc.detail) from exc
        raise HTTPException(status_code=500, detail="failed to cancel run") from exc


@router.post("/runs/{run_id}/retry")
async def retry_run(run_id: str, payload: dict = Body(default={})) -> dict:
    from hermes_workflows import cli_bridge, config

    argv = [*config.core_cli(), "run-retry", "--db", str(config.runs_db_path()), "--id", run_id]
    node = payload.get("node_id")
    if node:
        argv += ["--node", node]
    try:
        return cli_bridge.invoke(argv)
    except cli_bridge.CoreBridgeError as exc:
        if exc.kind == "NotFoundError":
            raise HTTPException(status_code=404, detail=exc.detail) from exc
        if exc.kind == "RetryError":
            raise HTTPException(status_code=400, detail=exc.detail) from exc
        raise HTTPException(status_code=500, detail="failed to retry run") from exc


@router.get("/schedules")
async def list_schedules() -> dict:
    """List every workflow cron schedule (native Hermes cron jobs). Read-only
    projection of the cron bridge — Hermes cron owns the schedules."""
    from hermes_workflows.bridge import cron as cron_bridge

    return {"schedules": cron_bridge.list_workflow_schedules()}


@router.post("/schedules/{job_id}/pause")
async def pause_schedule(job_id: str) -> dict:
    from hermes_workflows.bridge import cron as cron_bridge

    if not cron_bridge.pause(job_id):
        raise HTTPException(status_code=404, detail="schedule not found")
    return {"ok": True}


@router.post("/schedules/{job_id}/resume")
async def resume_schedule(job_id: str) -> dict:
    from hermes_workflows.bridge import cron as cron_bridge

    if not cron_bridge.resume(job_id):
        raise HTTPException(status_code=404, detail="schedule not found")
    return {"ok": True}


@router.post("/schedules/{job_id}/run")
async def run_schedule_now(job_id: str) -> dict:
    """Trigger a schedule's workflow on the next scheduler tick."""
    from hermes_workflows.bridge import cron as cron_bridge

    if not cron_bridge.run_now(job_id):
        raise HTTPException(status_code=404, detail="schedule not found")
    return {"ok": True}


@router.put("/schedules/{job_id}")
async def edit_schedule(job_id: str, cron: str = Body(..., embed=True)) -> dict:
    """Change a schedule's cron expression. A bad expression is ``400``; an
    unknown job is ``404``. Edits the live cron job, not the on-disk spec."""
    from hermes_workflows.bridge import cron as cron_bridge

    try:
        updated = cron_bridge.edit_schedule(job_id, cron)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if updated is None:
        raise HTTPException(status_code=404, detail="schedule not found")
    return {"ok": True, "cron_expression": cron}


@router.delete("/schedules/{job_id}")
async def delete_schedule(job_id: str) -> dict:
    from hermes_workflows.bridge import cron as cron_bridge

    if not cron_bridge.remove(job_id):
        raise HTTPException(status_code=404, detail="schedule not found")
    return {"deleted": True}


@router.get("/settings")
async def get_settings() -> dict:
    """Effective plugin settings plus the field schema for rendering. Values
    resolve config ▸ env ▸ default over the Hermes config `plugins.workflows`."""
    from hermes_workflows import config

    return {"values": config.settings(), "schema": config.settings_schema()}


@router.put("/settings")
async def put_settings(payload: dict = Body(...)) -> dict:
    """Persist a settings patch to the Hermes config `plugins.workflows`
    namespace (merging, not clobbering other config) and return the new
    effective values. An unknown key or invalid value is ``400``."""
    from hermes_workflows import config

    try:
        values = config.save_settings(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"values": values, "schema": config.settings_schema()}


def _home_dir() -> Path:
    """The invoking user's home, resolved from the password database by uid
    rather than ``$HOME``/``expanduser``. The gateway service mutates its
    process environment, so ``$HOME`` is unreliable inside a request handler;
    the passwd entry is stable."""
    try:
        import pwd

        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    except Exception:
        return Path(os.path.expanduser("~"))


def _o2b_installed(home: Path) -> bool:
    """Whether the OpenSecondBrain CLI is present — on PATH or at the
    conventional user-local install dir (the gateway env may not carry
    ``~/.local/bin``)."""
    return shutil.which("o2b") is not None or (home / ".local/bin/o2b").exists()


@router.get("/o2b-status")
async def o2b_status() -> dict:
    """Best-effort OpenSecondBrain availability for the connection badge: the
    CLI is installed and a config file exists. Resolved from the filesystem
    (paths derived from the passwd home, not ``$HOME``) rather than a
    ``o2b status`` subprocess, whose exit code was an unreliable signal under
    the gateway's mutated service environment — the probe reported
    "not connected" even when O2B was configured. Never raises — O2B is
    optional."""
    home = _home_dir()
    config = home / ".config/open-second-brain/config.yaml"
    return {"connected": _o2b_installed(home) and config.is_file()}


def _read_yaml(path: Path) -> dict:
    """Parse a YAML mapping file, returning {} on any error (missing file, parse
    failure, non-mapping root)."""
    try:
        import yaml

        with path.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


@router.get("/profiles")
async def list_profiles() -> dict:
    """Agent-task profile names from the user's Hermes roster
    (``<hermes_home>/agent-roster/agents.yaml``). Best-effort: [] if unreadable."""
    from hermes_workflows import config as wf_config

    roster = _read_yaml(wf_config.hermes_home() / "agent-roster" / "agents.yaml")
    agents = roster.get("agents")
    names = sorted(agents.keys()) if isinstance(agents, dict) else []
    return {"profiles": names}


# Model options are served by the host gateway (`/api/model/options`), which
# enumerates every authenticated provider and its models. The dashboard calls
# that endpoint directly, so the plugin does not duplicate a `/models` route.

"""Cron bridge: compile a workflow's cron trigger into a native Hermes Cron job,
and manage the transient advance tick. We never write our own cron engine — the
gateway runs the jobs. Trigger and tick jobs are deterministic no-agent script
jobs (the script invokes the workflow run / advance).

The tick is a single, named singleton: created when active runs exist, removed
when none remain, so tick jobs never accumulate.
"""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Optional

from cron import jobs as cj

from .. import config

TICK_NAME = "hermes-workflows-tick"
# Fallback cadence when the configurable `plugins.workflows.tick_schedule`
# cannot be resolved (e.g. `hermes_cli` absent). The effective default is read
# from config via `_tick_schedule()`; this constant only guards that path.
DEFAULT_TICK_SCHEDULE = "every 2m"


def _tick_schedule() -> str:
    """Effective tick cadence: the configurable ``plugins.workflows.tick_schedule``
    (config ▸ env ▸ default), falling back to ``DEFAULT_TICK_SCHEDULE`` if the
    config layer is unavailable."""
    try:
        return config.tick_schedule()
    except Exception:
        return DEFAULT_TICK_SCHEDULE

# Workflow cron triggers are registered with this job-name prefix (see
# ``register_trigger``); the dashboard Schedules page lists exactly these jobs.
WORKFLOW_JOB_PREFIX = "workflow:"


def write_shim(name: str, *command_args: str, command: Optional[Path] = None) -> Path:
    """Write an executable shim under ``HERMES_HOME/scripts`` that execs the
    ``hermes-workflows`` entrypoint with ``command_args``. Hermes cron only runs
    scripts that live in that directory and invokes them with no arguments, so a
    per-purpose shim is how a trigger/tick carries its subcommand."""
    binary = command or config.command_path()
    scripts = config.scripts_dir()
    scripts.mkdir(parents=True, exist_ok=True)
    args = " ".join(shlex.quote(str(arg)) for arg in command_args)
    path = scripts / f"{name}.sh"
    path.write_text(f"#!/usr/bin/env bash\nexec {shlex.quote(str(binary))} {args}\n")
    path.chmod(0o755)
    return path


def register_workflow_trigger(
    *,
    workflow_id: str,
    schedule: str,
    deliver: Optional[str] = None,
    command: Optional[Path] = None,
) -> str:
    """Compile a workflow's cron trigger into a native Cron job that runs
    ``hermes-workflows run <id>`` on schedule. When the schedule has a delivery
    target it is also threaded onto the run as its origin, so a cron-started run
    notifies the same place its output is delivered."""
    origin_args = ["--origin", deliver] if deliver else []
    shim = write_shim(
        f"hermes-workflows-trigger-{workflow_id}",
        "run",
        workflow_id,
        *origin_args,
        command=command,
    )
    return register_trigger(
        workflow_id=workflow_id, schedule=schedule, script=str(shim), deliver=deliver
    )


def ensure_workflow_tick(
    *, schedule: Optional[str] = None, command: Optional[Path] = None
) -> str:
    """Ensure the singleton tick job exists, running ``hermes-workflows
    advance-all`` on schedule. ``schedule`` defaults to the configurable
    ``plugins.workflows.tick_schedule`` (config ▸ env ▸ ``every 2m``), resolved
    at call time so a Settings-page change takes effect on the next tick
    (re)creation without a code edit."""
    shim = write_shim("hermes-workflows-tick", "advance-all", command=command)
    return ensure_tick(script=str(shim), schedule=schedule)


def sync_workflow_tick(*, active: bool, command: Optional[Path] = None) -> Optional[str]:
    """Tick lifecycle keyed on whether any runs remain active, using the
    advance-all shim as the job script."""
    if active:
        return ensure_workflow_tick(command=command)
    teardown_tick()
    return None


def register_trigger(
    *,
    workflow_id: str,
    schedule: str,
    script: str,
    deliver: Optional[str] = None,
) -> str:
    """Create a cron job that runs `script` on `schedule` to start the workflow.
    Returns the Hermes cron job id (persist the mapping in runs.db)."""
    job = cj.create_job(
        prompt=None,
        schedule=schedule,
        name=f"workflow:{workflow_id}",
        script=script,
        no_agent=True,
        deliver=deliver,
    )
    return job["id"]


def find_by_name(name: str) -> Optional[dict]:
    for job in cj.list_jobs(include_disabled=True):
        if job.get("name") == name:
            return job
    return None


def ensure_tick(*, script: str, schedule: Optional[str] = None) -> str:
    existing = find_by_name(TICK_NAME)
    if existing is not None:
        return existing["id"]
    job = cj.create_job(
        prompt=None,
        schedule=schedule or _tick_schedule(),
        name=TICK_NAME,
        script=script,
        no_agent=True,
    )
    return job["id"]


def teardown_tick() -> bool:
    existing = find_by_name(TICK_NAME)
    if existing is None:
        return False
    return cj.remove_job(existing["id"])


def sync_tick(*, active: bool, script: str) -> Optional[str]:
    """Ensure the tick exists while runs are active and is gone when none are."""
    if active:
        return ensure_tick(script=script)
    teardown_tick()
    return None


def _is_workflow_job(job: dict) -> bool:
    return str(job.get("name") or "").startswith(WORKFLOW_JOB_PREFIX)


def _schedule_row(job: dict) -> dict:
    """Map a native Cron job into the Schedules-page row. Cron schedules are
    interpreted in UTC by Hermes cron, so the timezone column is fixed to UTC."""
    schedule = job.get("schedule") or {}
    name = str(job.get("name") or "")
    next_run = job.get("next_run_at") or cj.compute_next_run(schedule, job.get("last_run_at"))
    return {
        "workflow_id": name[len(WORKFLOW_JOB_PREFIX) :],
        "cron_expression": schedule.get("expr") or job.get("schedule_display"),
        "timezone": "UTC",
        "enabled": bool(job.get("enabled", True)),
        "last_run": job.get("last_run_at"),
        "next_run": next_run,
        "hermes_cron_id": job.get("id"),
    }


def list_workflow_schedules() -> list[dict]:
    """List every workflow cron schedule (the ``workflow:<id>`` jobs), disabled
    ones included, shaped into the Schedules-page rows."""
    return [_schedule_row(job) for job in cj.list_jobs(include_disabled=True) if _is_workflow_job(job)]


def find_workflow_job(workflow_id: str) -> Optional[dict]:
    """The native Cron job backing a workflow's cron trigger, or ``None`` when
    the workflow has no schedule (e.g. a manual-only workflow)."""
    return find_by_name(f"{WORKFLOW_JOB_PREFIX}{workflow_id}")


def next_run_by_workflow() -> dict[str, object]:
    """Map each scheduled workflow id to its next-run timestamp, for the
    Templates page. Workflows without a cron schedule are simply absent."""
    return {row["workflow_id"]: row["next_run"] for row in list_workflow_schedules()}


def run_now(job_id: str) -> bool:
    """Trigger a schedule's workflow on the next scheduler tick."""
    return cj.trigger_job(job_id) is not None


def edit_schedule(job_id: str, cron_expression: str) -> Optional[dict]:
    """Change a schedule's cron expression. Raises ``ValueError`` on an invalid
    expression (via ``parse_schedule``); returns ``None`` for an unknown job."""
    return cj.update_job(job_id, {"schedule": cron_expression})


def pause(job_id: str) -> bool:
    return cj.pause_job(job_id) is not None


def resume(job_id: str) -> bool:
    return cj.resume_job(job_id) is not None


def remove(job_id: str) -> bool:
    return cj.remove_job(job_id)

# Schedules Page — Design

Status: draft (brainstorm complete, Variant 1 chosen) — implementation NOT started
Author: orchestrator (via feature-release-playbook)
Audience: implementation

## Problem statement

Cron-triggered workflows are scheduled as native Hermes Cron jobs, but the
dashboard has no view of them — you cannot see, pause, resume, run, edit, or
delete a workflow's schedule (TZ §20.9). This epic adds a Schedules page over the
**existing Hermes cron** machinery.

## Hermes / existing reuse (audited first) — and a duplicate to remove

- **Scheduling is already Hermes cron.** `hermes_workflows/bridge/cron.py`
  registers a workflow's cron trigger as a native Cron job
  (`hermes-workflows-trigger-<id>`) via `cron.jobs` and already wraps
  `pause` / `resume` / `remove` / `find_by_name`. Hermes `cron.jobs` provides
  `list_jobs`, `get_job`, `update_job`, `trigger_job`, `pause_job`,
  `resume_job`, `remove_job`, `compute_next_run`, `mark_job_run`. The page is a
  thin read/act layer over these — **no scheduler, no schedule store of our own.**
- **Duplicate to remove.** The core `RunRepository` carries a `workflow_schedules`
  table plus `WorkflowSchedule` / `ScheduleRow` types and
  `saveSchedule` / `getSchedule` / `listSchedules` / `setScheduleEnabled` /
  `deleteSchedule`. A full-repo grep shows these are referenced **only by
  `db.test.ts`** — nothing in the engine, CLI, or bridge reads or writes them.
  It is a dead parallel implementation of what Hermes cron owns. This epic
  removes it (task B0) so there is one source of truth: Hermes cron.

## Scope (TZ §20.9)

- A **Schedules page** listing each workflow cron schedule with `Workflow`,
  `Cron expression`, `Timezone`, `Enabled`, `Last run`, `Next run`,
  `Hermes Cron ID`.
- Row actions: **Pause**, **Resume**, **Run now**, **Edit schedule** (change the
  cron expression), **Delete schedule**.
- Backend routes over the cron bridge; **B0** removes the dead core store.

## Out of scope

- Creating a schedule from this page (a schedule is created by deploying a
  cron-triggered workflow; this page manages existing ones). Listed as roadmap.
- Editing the workflow's stored `trigger.schedule` spec field from here (the
  editor owns the spec; this page edits the live cron job). If the two should be
  kept in lockstep, that reconciliation is a follow-up.
- Per-run history beyond last/next run (the Runs page covers run history).

## Chosen approach (Variant 1 — thin layer over Hermes cron; remove the dead store)

- **B0 — remove the duplicate store.** Delete the `workflow_schedules` table from
  `schema.ts` `SCHEMA_SQL`, the `WorkflowSchedule` / `ScheduleRow` types,
  `toSchedule`, and the five schedule methods on `RunRepository`; drop the
  schedule coverage from `db.test.ts` and the `WorkflowSchedule` export from the
  core barrel. Verify nothing else references them.
- **Bridge.** Extend `bridge/cron.py`: `list_workflow_schedules()` returns the
  workflow trigger jobs (filter `cj.list_jobs(include_disabled=True)` by the
  `hermes-workflows-trigger-` name prefix), each mapped to the TZ fields
  (`workflow_id` from the name, `cron_expression` + `timezone` from the job,
  `enabled`, `last_run` from `mark_job_run` history, `next_run` via
  `compute_next_run`, `hermes_cron_id` = job id). Add `run_now` (`trigger_job`)
  and `edit_schedule` (`update_job` the cron expression). Pause/resume/delete are
  already wrapped.
- **Backend routes.** `GET /schedules`, `POST /schedules/{id}/pause|resume|run`,
  `PUT /schedules/{id}` (new cron expression), `DELETE /schedules/{id}`. Each is a
  thin shell over the bridge; an unknown job id is `404`, a bad cron is `400`.
- **Frontend.** A `SchedulesPage` (host DS table + `hw-` styles) with the fields
  and the five actions; a Schedules nav entry. Edit opens a small inline/modal
  cron field reusing the existing form styling.

## Design decisions

- **One source of truth: Hermes cron.** No second schedule store; the dead core
  table is removed rather than wired up.
- **`workflow_id` derived from the job name** (`hermes-workflows-trigger-<id>`),
  matching how the bridge creates triggers.
- **Edit edits the live cron job**, not the on-disk spec (the editor owns the
  spec). The boundary is documented to avoid drift; reconciliation is a follow-up.
- **English in the repo;** operator chat in Russian.

## Component / route map (target)

```
packages/core/  - REMOVE workflow_schedules table, WorkflowSchedule/ScheduleRow,
                  toSchedule, RunRepository schedule methods, db.test schedule case,
                  core barrel export.
hermes_workflows/bridge/cron.py
  + list_workflow_schedules(), run_now(), edit_schedule()  (pause/resume/remove exist)
dashboard/plugin_api.py
  + GET /schedules
  + POST /schedules/{id}/pause | resume | run
  + PUT  /schedules/{id}            (edit cron expression; 400 on bad cron)
  + DELETE /schedules/{id}          (404 if absent)
apps/dashboard/src/
  api/client.ts  + listSchedules / pause / resume / runNow / editSchedule / deleteSchedule
  pages/SchedulesPage.tsx + Schedules nav entry in App.tsx
```

## Risks and open questions

- **Last run** source: confirm Hermes cron records last-run timestamp/outcome per
  job (`mark_job_run`); if unavailable, link via the run store by workflow id.
- **Timezone**: Hermes cron interprets schedules in UTC; the workflow cron trigger
  carries an optional timezone. Surface the job's timezone; clarify UTC semantics
  in the column header.
- **Removing the store** must be confirmed safe by the grep (only `db.test.ts`);
  re-verify at implementation time before deleting.

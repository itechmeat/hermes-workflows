# Templates Page Enhancements — Design

Status: draft (brainstorm complete, Variant 1 chosen) — implementation NOT started
Author: orchestrator (via feature-release-playbook)
Audience: implementation

## Problem statement

The Templates page lists workflows and supports create / open / run / duplicate /
export / delete, but two TZ §20.2 items remain: a workflow cannot be
**enabled/disabled**, and the rows do not show **Last run**, **Last status**, or
**Next run**. This epic adds both.

## Hermes / existing reuse (audited first)

- **No `enabled` field exists** on the workflow spec today, and no run path checks
  one. Enable/Disable is new behaviour — see the chosen approach.
- **Cron owns the auto-trigger.** A cron-triggered workflow is a native Hermes
  cron job; the plugin already bridges `pause`/`resume` and exposes `next_run_at`
  (Schedules epic). The **Next run** column and the cron side of "disabled" reuse
  that bridge directly.
- **Run history** lives in `runs.db`; `RunRepository.listRunSummaries` exists.
  **Last run / Last status** are the latest run per workflow — a small core
  aggregation over the existing store, no new Hermes primitive.
- Host DS components + the `hw-` tokens render the new control and columns.

## Scope (TZ §20.2)

- A per-workflow **Enable / Disable** control on the Templates page.
- Three per-row columns: **Last run** (timestamp), **Last status** (the run's
  status), **Next run** (cron `next_run_at`, blank for manual workflows).

## Out of scope (roadmap)

- Bulk enable/disable; scheduling a workflow from this page (Schedules epic
  covers cron management; a workflow becomes cron-scheduled by its trigger).
- Run history beyond the single latest run (the Runs page covers full history).

## Chosen approach (Variant 1 — spec-level `enabled` field)

- **Core.** Add `enabled?: boolean` (default `true`) to the workflow schema,
  round-tripping through `parseWorkflow`/`serializeWorkflow` like any other field;
  validation rejects a non-boolean. Add a run-store aggregation
  `latestRunByWorkflow()` returning, per workflow id, the most recent run's
  `{ run_id, status, started_at, finished_at }`, surfaced as a `run-latest` CLI
  command.
- **Run gate + cron sync.** `POST /workflows/{id}/run` refuses a disabled
  workflow with `409`. A toggle route (`PUT /workflows/{id}/enabled` with
  `{ enabled }`) writes `enabled` into the spec via the existing spec-save path
  and, when the workflow has a cron job, pauses/resumes it through the cron bridge
  so the auto-trigger follows the flag.
- **Templates list.** `GET /workflows` rows gain `enabled`, `last_run_at`,
  `last_status`, `next_run_at` — `enabled` from the spec, last-run fields from the
  run aggregation, `next_run_at` from the cron bridge (null when no cron job).
- **Frontend.** The Templates table gains a Last run / Last status / Next run
  column trio and an Enable/Disable control per row; toggling calls the new route
  and refreshes the list. A disabled row is visually marked and its Run action is
  disabled.

## Design decisions

- **`enabled` is a spec property, not a trigger property** — one source of truth
  that covers both manual and cron workflows; no parallel state store (the
  pattern we just removed with `workflow_schedules`).
- **Reuse cron pause/resume** for the auto-trigger side of disabling, and cron
  `next_run_at` for the Next run column — no second scheduler.
- **Last run/status reuse the run store**, aggregated in the core (run logic stays
  in TS), exposed via one CLI command and shaped by the thin Python route.
- **English in the repo;** operator chat in Russian.

## Component / route map (target)

```
packages/core/
  schema/nodes? no — schema/workflow.ts: + enabled?: boolean (default true)
  schema/load.ts + serialize/serializeWorkflow.ts: round-trip enabled
  validation/validateWorkflow.ts: enabled must be boolean
  runtime/db/runRepository.ts: + latestRunByWorkflow()
  cli: + run-latest  (workflow_id -> latest run summary)
hermes_workflows / dashboard/plugin_api.py
  ~ GET /workflows  -> rows gain enabled, last_run_at, last_status, next_run_at
  + PUT /workflows/{id}/enabled  -> write spec.enabled; pause/resume cron job
  ~ POST /workflows/{id}/run     -> 409 when disabled
apps/dashboard/src/
  api/client.ts  + setWorkflowEnabled(id, enabled); WorkflowListItem gains the 4 fields
  pages/TemplatesPage.tsx  + Enable/Disable control + Last run/Last status/Next run columns
```

## Risks and open questions

- **Disabling a manual workflow mid-run**: the gate blocks new runs; in-flight
  runs are unaffected (intended). Document this.
- **Cron sync ordering**: the toggle writes the spec first, then pauses/resumes
  the cron job; if the cron call fails, surface it without leaving the spec and
  cron out of sync (resolve in the toggle task — write spec last, or report
  partial failure).
- **Workflows with no run yet**: last-run columns render blank ("—"); manual
  workflows always render a blank Next run.

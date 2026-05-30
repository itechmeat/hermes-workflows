# Schedules Page — Implementation Plan

NOT started — planning only; awaits operator go-ahead to implement.

TDD throughout. Core uses `bun test`; backend uses pytest
(`importorskip("fastapi")`); frontend uses Vitest + jsdom + RTL with the client
injected. After each task the relevant `validate` stays green. Each task is one
atomic conventional commit on `feat/schedules-page`.

## Task B0: Remove the dead `workflow_schedules` core store
- Re-verify (grep) that `saveSchedule`/`getSchedule`/`listSchedules`/
  `setScheduleEnabled`/`deleteSchedule`/`workflow_schedules`/`WorkflowSchedule`
  are referenced only by `db.test.ts`. Then remove: the table from `schema.ts`
  `SCHEMA_SQL`, the `WorkflowSchedule`/`ScheduleRow` types + `toSchedule`, the five
  `RunRepository` methods, the schedule case in `db.test.ts`, and the
  `WorkflowSchedule` export from the core barrel.
- **Acceptance**: `bun test packages/core` green with the schedule store gone; a
  grep shows zero remaining references; the DB schema test no longer expects the
  table.
- **Depends on**: none.

## Task B1: Cron bridge — list / run-now / edit
- `bridge/cron.py`: `list_workflow_schedules()` (filter
  `cj.list_jobs(include_disabled=True)` by the `hermes-workflows-trigger-` prefix
  → TZ fields incl. `next_run` via `compute_next_run`, `hermes_cron_id` = job id),
  `run_now(job_id)` (`trigger_job`), `edit_schedule(job_id, cron)` (`update_job`).
  Pause/resume/remove already exist.
- **Acceptance**: pytest against a temp Hermes cron store — a registered workflow
  trigger appears in the list with all fields; run-now triggers; edit changes the
  cron; pause/resume flip enabled; delete removes.
- **Depends on**: none (independent of B0).

## Task B2: Backend routes
- `dashboard/plugin_api.py`: `GET /schedules`,
  `POST /schedules/{id}/pause|resume|run`, `PUT /schedules/{id}` (cron, `400` on
  invalid), `DELETE /schedules/{id}` (`404` if absent).
- **Acceptance**: pytest — list returns registered schedules; pause/resume/run
  act; edit with a bad cron → `400`; delete-missing → `404`.
- **Depends on**: B1.

## Task B3: API client + types
- `api/client.ts`: `listSchedules`, `pauseSchedule`, `resumeSchedule`,
  `runScheduleNow`, `editSchedule(id, cron)`, `deleteSchedule`. `api/types.ts`:
  `ScheduleListItem` with the TZ fields.
- **Acceptance**: client builds the right URLs/verbs/bodies against a mocked fetch.
- **Depends on**: B2.

## Task B4: SchedulesPage UI + shell wiring
- `pages/SchedulesPage.tsx`: table (host DS + `hw-` styles) with the fields and
  Pause / Resume / Run now / Edit (cron field) / Delete. `App.tsx`: a Schedules
  nav entry/view; list refreshes after each action.
- **Acceptance**: Vitest — renders a row per schedule; each action calls the right
  client method; Edit submits a new cron; list refreshes (against mocked client).
- **Depends on**: B3.

## Task B5: Build wiring, docs, CHANGELOG
- Rebuild + commit `dashboard/dist`; update README + `docs/dashboard.md`; add a
  CHANGELOG entry under the existing version header (no bump); note the removal of
  the dead schedule store.
- **Acceptance**: `bun run validate` green incl. the committed-bundle guard.
- **Depends on**: B0–B4.

## Verification (phase 4 QA)
- Core green after B0 (store removed, no dangling refs).
- Backend pytest green (list/pause/resume/run/edit/delete + error codes).
- Frontend typecheck, lint, vitest, build green; committed bundle matches.

## Notes
- Operator gate: implementation begins only on explicit go-ahead.
- Version stays 0.1.0 until the operator bumps it. No auto-merge armed.

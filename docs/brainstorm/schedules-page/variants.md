# Brainstorm — Schedules page (TZ §20.9)

Phase 0 of the feature-release-playbook. CLI consultants were not run this round
(same harness constraints); an in-process orchestrator pass produced the
variants. The orchestrator decides.

## Hermes / existing reuse audit (and a duplicate found)

- Workflow cron triggers are already native Hermes Cron jobs via
  `bridge/cron.py` + `cron.jobs` (`list_jobs`, `update_job`, `trigger_job`,
  `pause_job`, `resume_job`, `remove_job`, `compute_next_run`). The page is a
  thin layer over these — no scheduler, no store of our own.
- **Duplicate:** the core `workflow_schedules` table + `WorkflowSchedule` types +
  five `RunRepository` schedule methods are referenced only by `db.test.ts`;
  nothing wires them in. They duplicate what Hermes cron owns and are removed
  (task B0).

## Variants

- **Variant 1 — Thin layer over Hermes cron; remove the dead core store.**
  List/pause/resume/run/edit/delete go through `bridge/cron.py` over `cron.jobs`;
  the unused `workflow_schedules` store is deleted so Hermes cron is the single
  source of truth. Complexity: medium (incl. the removal). Risk: low.
- **Variant 2 — Wire up the existing core `workflow_schedules` store as the
  schedule model, syncing it to Hermes cron.** Keep the table, populate it on
  trigger registration, and read the page from it. Con: two stores to keep in
  sync (table + cron jobs.json), reintroducing drift; contradicts "Hermes owns
  cron". Complexity: large. Risk: high.
- **Variant 3 — Read schedules straight from Hermes cron, keep the dead store
  untouched.** Build the page on `cron.jobs` but leave `workflow_schedules` in
  place. Con: leaves dead, misleading code that looks like the schedule model.
  Complexity: small. Risk: medium (future confusion / accidental use).

## Recommended: Variant 1

Hermes cron already is the scheduler and exposes every action the page needs, so
the page is a thin read/act layer over it. The core `workflow_schedules` store is
dead and duplicates that ownership, so the correct move is to remove it (V1)
rather than wire it up (V2, two-store drift) or leave it as a trap (V3). One
source of truth, smallest correct surface.

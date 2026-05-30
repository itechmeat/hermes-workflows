You are a frontend+backend architecture consultant brainstorming ARCHITECTURAL VARIANTS for one epic. Do NOT write code, do NOT write a final design. Output exactly 3 variants and one recommendation.

# Task (Schedules page in the Hermes Workflows dashboard, TZ §20.9)

Add a Schedules page showing cron-triggered workflows with fields Workflow / Cron expression / Timezone / Enabled / Last run / Next run / Hermes Cron ID, and row actions Pause / Resume / Run now / Edit schedule / Delete schedule.

Already exists (reuse): workflow cron triggers are registered as native Hermes Cron jobs (`hermes-workflows-trigger-<id>`) by `hermes_workflows/bridge/cron.py`, which wraps `cron.jobs` (`list_jobs`, `get_job`, `update_job`, `trigger_job`, `pause_job`, `resume_job`, `remove_job`, `compute_next_run`, `mark_job_run`) and already exposes pause/resume/remove/find_by_name. The host design-system components and the project's `hw-` theme tokens are available.

Known duplicate: the TypeScript core `RunRepository` has a `workflow_schedules` table + `WorkflowSchedule` type + saveSchedule/getSchedule/listSchedules/setScheduleEnabled/deleteSchedule, but a full-repo grep shows these are referenced ONLY by `db.test.ts` — nothing in the engine, CLI, or bridge uses them. Hermes cron is the real scheduler.

# Constraints
- Hermes owns cron; do not write a scheduler or a second schedule store. Pure TS core owns spec logic; Python is a thin shell over the core CLI / Hermes modules.
- Frontend builds to one Vite bundle; the API client is injected for tests; oxlint zero warnings.
- Operator chats in Russian; repo artifacts stay English.
- Out of scope: creating schedules from this page (a schedule is created by deploying a cron workflow); editing the on-disk spec trigger from here; run history beyond last/next.

# Required output format
Exactly 3 variants, each with Approach (2-3 sentences), Trade-offs (pros/cons), Complexity (small|medium|large), Risk (low|medium|high). Differ on what to do with the dead core `workflow_schedules` store: (a) remove it and layer the page purely over Hermes cron; (b) wire it up as the schedule model and sync it to cron; (c) ignore it and read from cron, leaving it in place. Then exactly one "Recommended: Variant N" with a 2-3 sentence rationale. Output nothing outside these sections.

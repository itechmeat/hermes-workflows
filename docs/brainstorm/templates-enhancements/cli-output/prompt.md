You are a frontend+backend architecture consultant brainstorming ARCHITECTURAL VARIANTS for one epic. Do NOT write code, do NOT write a final design. Output exactly 3 variants and one recommendation.

# Task (Templates page enhancements in the Hermes Workflows dashboard, TZ §20.2)

The Templates page lists workflows and supports create / open / run / duplicate / export / delete. Two pieces remain from TZ §20.2:
1. Enable / Disable a workflow.
2. Per-row columns: Last run, Last status, Next run.

Already exists (audited):
- The workflow schema has NO `enabled`/`disabled` field today; nothing gates a run on enabled state.
- Cron-triggered workflows are native Hermes cron jobs; the plugin already bridges pause/resume and exposes `next_run_at` (Schedules page). So the cron side of "disabled" and the "Next run" value are already available via the cron bridge.
- Run history lives in the run store (`runs.db`); the plugin has `listRunSummaries` over all runs. "Last run / Last status" require the latest run per workflow (no aggregation helper exists yet).
- `GET /workflows` returns id/name/scope/trigger. The host DS components and the `hw-` theme tokens are available.

# Constraints
- Reuse Hermes facilities (cron enabled flag, next_run) and the existing run store; do NOT build a parallel state store (a dead schedule store was just removed — do not reintroduce that pattern). Pure TS core owns spec/run logic; Python is a thin shell over the core CLI / Hermes modules.
- Manual (non-cron) workflows have no cron job, so any "Next run" / cron-based disable only applies to cron workflows; the design must say what Enable/Disable means for a manual workflow.
- Frontend builds to one Vite bundle; the API client is injected for tests; oxlint zero warnings; the committed bundle must match a fresh build.
- Operator chats in Russian; repo artifacts stay English.

# Required output format
Exactly 3 variants, each with Approach (2-3 sentences), Trade-offs (pros/cons), Complexity (small|medium|large), Risk (low|medium|high). Differ on WHERE the enabled state lives: (a) a spec-level `enabled` field in the core schema (gates manual runs + syncs the cron job); (b) cron-only — Enable/Disable just toggles the Hermes cron job, manual workflows have no toggle; (c) a plugin-owned sidecar store of disabled ids checked at run time. Then exactly one "Recommended: Variant N" with a 2-3 sentence rationale. Output nothing outside these sections.

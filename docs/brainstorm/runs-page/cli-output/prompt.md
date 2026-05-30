You are a frontend+backend architecture consultant brainstorming ARCHITECTURAL VARIANTS for one epic. Do NOT write code, do NOT write a final design. Output exactly 3 variants and one recommendation.

# Task (Runs page in the Hermes Workflows dashboard, TZ §20.7)

The dashboard can start a run and open the run inspector, but only right after starting one — there is no list of runs. Add a Runs page listing every run with fields Run ID / Workflow / Project / Status / Current node / Started / Finished / Duration, and row actions Open / Cancel / Retry failed node / Retry whole run / Export logs.

Already exists (reuse): the `run-list` core CLI (returns all runs without `--active`); `RunMeta` (started/finished/error) persisted; `GET /runs` (active-only today), `GET /runs/{id}`, `POST /runs/{id}/cancel`, `POST /runs/{id}/retry` (whole run or one node); the run inspector UI; the host design-system components and the project's `hw-` theme tokens; a `downloadTextFile` helper.

# Constraints
- Pure TS core owns spec/run logic via the JSON CLI; the Python layer is a thin shell. No new serializer in the browser.
- Frontend builds to one Vite bundle; the API client is injected for tests; oxlint zero warnings.
- Operator chats in Russian; repo artifacts stay English.
- Out of scope: server-side pagination/search, live list auto-refresh, script-node stdout/stderr.

# Required output format
Exactly 3 variants, each with Approach (2-3 sentences), Trade-offs (pros/cons), Complexity (small|medium|large), Risk (low|medium|high). Differ on: (a) extend `GET /runs` with a flag vs a separate all-runs route; (b) export logs as a backend route vs assembled client-side; (c) runs sourced from the run store vs the Kanban board. Then exactly one "Recommended: Variant N" with a 2-3 sentence rationale. Output nothing outside these sections.

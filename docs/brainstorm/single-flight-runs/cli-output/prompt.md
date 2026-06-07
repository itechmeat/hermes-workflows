You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Single-flight workflow runs + editor attach to the active run.

Today one workflow can be started in parallel any number of times: leaving the editor page and returning "forgets" the active run — the Play button is enabled again and `POST /workflows/{id}/run` happily creates a second concurrent run of the same workflow. Live example: a run sat in `running` for hours while newer runs of the same workflow were started over it.

Required behaviour:

1. **Single-flight at the platform level**: one workflow may have at most ONE active run (status `created` / `running` / `waiting`) at any time. Starting a second one must be an explicit error (HTTP 409 for the dashboard) that names the active run id. The guard must cover EVERY entry point that creates or revives a run: dashboard `POST /workflows/{id}/run`, the Python CLI `run` command, cron-scheduled runs, and `POST /runs/{id}/retry` (retry revives a finished run — it must not produce a second active run of the same workflow either).
2. **Editor attach**: opening a workflow's editor page must check whether that workflow has an active run; if it does, the editor immediately enters the existing read-only playback mode (live per-node statuses, editing locked, Play button reflecting the actual state) attached to that run, and performs the standard hand-off to the run inspector when the run settles.
3. Errors are surfaced explicitly to the operator; silent fallbacks and stubs are forbidden.

# Project context

hermes-workflows — a Hermes dashboard plugin: TypeScript core (Bun, `packages/core`) owns spec + run persistence (SQLite `runs.db`) and is invoked as a CLI by a Python orchestrator (`hermes_workflows/`), which a FastAPI router (`dashboard/plugin_api.py`) wraps for the dashboard SPA (React 19, `apps/dashboard`, built bundle committed to `dashboard/dist`).

Recent commits:
4e5a5f5 feat(editor): Play button — run the edited workflow with live node progress (#15)
4ae4dcc feat: run observability — per-node telemetry, approval surfacing, JSONL trace (#14)
b06cf6a feat(dashboard): UI overhaul — plugin header, hash routing, shared component kit (#13)
7a4b3cb refactor: clean up workflow runtime backends (#12)
706261c fix(memory): write Open Second Brain notes via the real o2b CLI contract (#11)

Related files:
- packages/core/src/cli/commands.ts — `cmdRunCreate` (validates spec, `repository(dbPath).saveRun(run, timingMeta(run, true))`), `cmdRunRetry`, `NotFoundError` (error class name travels to Python as `kind`)
- packages/core/src/runtime/db/runRepository.ts — `RunRepository.saveRun` (single upsert used for create AND ticks), `listRunSummaries(activeOnly)`, `latestRunByWorkflow()`
- packages/core/src/runtime/status.ts — `ACTIVE_RUN_STATUSES = ["created","running","waiting"]`
- packages/core/src/runtime/runMutations.ts — `RetryError`, retry/cancel mutations
- hermes_workflows/cli_bridge.py — subprocess seam; structured stderr `{error:{name,message}}` becomes `CoreBridgeError(kind, detail)`
- hermes_workflows/engine.py — `Engine.create()` calls core `run-create`; `Engine.run()` = create + advance; used by dashboard route, Python CLI `run`, and cron tick
- dashboard/plugin_api.py — `POST /workflows/{id}/run` (non-blocking start via `tools.start_workflow`), `GET /runs?scope=active|all` (run-list-summary), `POST /runs/{id}/retry`; existing 409 mapping pattern: `exc.kind == "SpecExistsError"`
- apps/dashboard/src/editor/useRunPlayback.ts — Play state machine: `phase idle|starting|playing`, polls via `useRunPolling`, hand-off via `shouldHandOff(status)`
- apps/dashboard/src/editor/FlowEditor.tsx — Play button, run-status overlay (`overlayRunStatus`), editing locked while playing
- apps/dashboard/src/api/client.ts — typed `WorkflowsApi` wrapper over the host `fetchJSON`

Conventions:
- The TS core is the single writer/owner of `runs.db`; Python never touches SQLite directly, it shells out to the core CLI.
- Core error class names map to HTTP statuses in the FastAPI routes via `CoreBridgeError.kind` (NotFoundError→404, SpecExistsError→409, SpecValidationError→400, RetryError→400).
- The dashboard SPA polls `GET /runs/{id}` every 2s while a run is active; the editor's playback mode reuses the run-view pipeline.
- TDD; Vitest (jsdom+RTL) for the SPA, `bun test` for core, pytest for Python.
- SOLID/KISS/DRY; no do-nothing fallbacks, no stubs; errors must surface explicitly.

Constraints:
- Do not change existing public API shapes more than needed (additive changes preferred).
- The guard must be race-safe across processes: dashboard route, CLI and cron tick can run concurrently (SQLite is the shared store; per-process in-memory locks are not sufficient).
- A stale/zombie active run must not be silently auto-cancelled by the guard; blocking with an explicit 409 (operator cancels via existing UI) is the desired behaviour.
- The editor-attach check must not add heavy per-mount cost: one cheap query on mount is fine.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.

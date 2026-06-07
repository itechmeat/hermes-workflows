# Single-flight workflow runs — at most one active run per workflow, editor attaches to it

**Status:** accepted
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

One workflow can currently be started in parallel any number of times: leaving
the editor page and returning "forgets" the active run — Play is enabled again
and `POST /workflows/{id}/run` creates a second concurrent run of the same
workflow. Concurrent runs of one workflow contend for the same agents and side
effects and were never a supported mode. The operator requires: at most one
active run per workflow, and an editor that, on mount, attaches to the active
run instead of pretending the workflow is idle.

## Scope

- **Core guard (single source of truth).** `run-create` refuses to insert a run
  when the workflow already has a run in an active status
  (`created` / `running` / `waiting`), atomically (check + insert inside one
  immediate SQLite transaction). New error class `ActiveRunExistsError` whose
  message names the workflow, the active run id, and its status; the name
  travels to Python as `CoreBridgeError.kind` (existing structured-stderr
  channel). Because the TS core is the only writer of `runs.db`, this one guard
  covers every entry point: dashboard route, Python CLI `run`, cron-scheduled
  runs, and MCP tools.
- **Retry is also a revival.** `run-retry` (whole-run and single-node) re-checks
  the same invariant, excluding the run being retried itself: reviving run X of
  workflow W while another run of W is active raises `ActiveRunExistsError`.
- **Run-list filter.** `run-list-summary` gains `--workflow <id>`;
  `GET /runs` gains an optional `workflow_id` query param (additive). The
  editor's attach check is one cheap query: active runs of this workflow.
- **HTTP mapping.** `POST /workflows/{id}/run` and `POST /runs/{id}/retry` map
  `kind == "ActiveRunExistsError"` to `409` with the core's message as detail
  (same pattern as `SpecExistsError`). The Python CLI `run` command surfaces the
  same error as a clean `SystemExit` message instead of a traceback.
- **Editor attach.** On mount, the editor queries active runs of its workflow;
  if one exists, playback enters `playing` attached to that run: live node
  statuses, editing locked, Play shows `Running…`, and the standard hand-off to
  the run inspector fires when the run settles (or parks in `waiting`). After a
  failed Play start, the same attach check runs once more: if a concurrent
  active run is the reason, the editor both shows the explicit start error and
  attaches to the real state.

## Out of scope

- Auto-cancelling stale/zombie active runs. A zombie blocks new starts **by
  design** — the 409 names it and the operator cancels it via the existing
  Runs/inspector UI.
- A per-workflow concurrency limit > 1 or queueing of pending starts.
- A dedicated active-run pointer table or DB schema migration (variants 2/3 —
  see `variants.md`).
- Cross-workflow concurrency limits.

## Chosen approach

Variant 1 of the brainstorm (consultant-recommended, accepted): a transactional
check-and-insert in the TS core. `RunRepository` gains
`findActiveRun(workflowId, excludeRunId?)` and a `createRun(run, meta)` method
that wraps "no active sibling? insert" in one `BEGIN IMMEDIATE` transaction
(bun:sqlite `transaction().immediate()`), so two concurrent creators serialize
at the database and the loser gets `ActiveRunExistsError`. `saveRun` keeps its
current upsert semantics for tick updates — only creation and revival are
guarded. The editor attach reuses the run-list-summary read path with a new
workflow filter rather than adding a bespoke endpoint.

## Design decisions

- **Guard in the repository, not the route.** Routes/CLI/cron all funnel into
  core `run-create` / `run-retry`; enforcing there is the only place that is
  simultaneously race-safe (single writer, one transaction) and DRY.
- **`BEGIN IMMEDIATE`, not a plain deferred transaction.** The check-then-insert
  must take the write lock before reading, or two deferred readers could both
  see "no active run" and then both insert.
- **Retry excludes itself.** Whole-run retry resets the run to `created` —
  that run *becoming* active again is fine; a *different* active run of the same
  workflow is not. Node retry behaves identically (it revives the run to
  `running`).
- **Error carries the active run id in the message.** The structured stderr
  channel transports `{name, message}` only; the id is embedded in the message
  for the operator. The dashboard does not parse it — the attach check supplies
  the machine-readable run id.
- **Attach picks the most recently started active run.** The guard makes >1
  active run impossible going forward, but pre-existing databases may hold
  several; the attach must behave deterministically on such data (newest
  `started_at`, ties broken on higher `run_id` — same convention as
  `latestRunByWorkflow`).
- **Attach errors are visible.** A failed mount query surfaces in the editor's
  existing alert slot — no silent "assume idle" fallback. While the attach
  check is in flight, Play is disabled (a window where a second start could
  slip through otherwise; the server guard would catch it, but the UI should
  not invite it).
- **Post-start-failure re-attach is status-agnostic.** The host `fetchJSON`
  error shape does not expose HTTP status codes, so after any failed start the
  editor re-runs the attach query once: if an active run exists, it attaches
  (and still shows the start error). No status-code parsing, no behavioural
  guess.

## File changes

Core (TypeScript):
- `packages/core/src/runtime/db/runRepository.ts` — `ActiveRunExistsError`,
  `findActiveRun`, `createRun` (immediate transaction).
- `packages/core/src/cli/commands.ts` — `cmdRunCreate` uses `createRun`;
  `cmdRunRetry` re-checks the invariant; `cmdRunListSummary` gains the
  workflow filter.
- `packages/core/src/cli.ts` — `run-list-summary --workflow`, `run-create`
  unchanged wiring.
- Tests: `packages/core/tests` (repository guard incl. concurrency semantics,
  retry guard, summary filter).

Python:
- `dashboard/plugin_api.py` — 409 mapping in run + retry routes; `workflow_id`
  param on `GET /runs`.
- `hermes_workflows/cli.py` — clean `SystemExit` for `ActiveRunExistsError`.
- Tests: `tests/python/test_dashboard_run_routes.py`, `tests/python/test_py_cli.py`.

Frontend:
- `apps/dashboard/src/api/client.ts` (+`types.ts` if needed) —
  `listRuns(scope?, workflowId?)`.
- `apps/dashboard/src/editor/useRunPlayback.ts` — attach-on-mount, post-failure
  re-attach, `attaching` state that disables Play until the check lands.
- `apps/dashboard/src/editor/FlowEditor.tsx` — Play disabled while attach check
  is pending (existing `disabled` expression).
- Tests: `apps/dashboard/tests/editor-playback.test.tsx`, client tests.

Docs:
- `docs/dashboard.md` — run route 409, `GET /runs` filter, editor attach.
- `README.md` — one line on single-flight semantics if the feature list
  mentions runs.

## Risks and open questions

- **bun:sqlite immediate transactions** — `transaction().immediate()` is the
  documented better-sqlite3-compatible API; verified in the repository test
  with two connections to the same file.
- **Pre-existing duplicate active runs** — the guard only constrains new
  creations; old duplicates stay listed until cancelled. Attach handles them
  deterministically (newest wins). No data migration needed.
- **Editor auto-hand-off on mount when the run is `waiting`** — attaching to a
  run that is already parked for review immediately hands off to the inspector
  (same rule as live playback: only the inspector can answer a review). This is
  deliberate, not a bug.
- **Templates-page Run button** — it calls the same start route and already
  shows request errors; it now receives a 409 with a clear message. No bespoke
  UI work in this scope.

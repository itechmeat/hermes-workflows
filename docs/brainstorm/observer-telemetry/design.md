# Per-node observer telemetry — worker sidecars merged into run state

**Status:** accepted
**Author:** Sol Aitken (via feature-release-playbook)
**Audience:** implementation

## Problem statement

`NodeRunState` carries only `status` / `outcome` / `output` / `error`. A workflow
run gives no visibility into what the agent actually did inside an `agent_task`
node — no duration, no token usage, no API or tool call counts, no structured
error type. The run inspector shows a status pill and the final output text.

## Scope

- Observer hook callbacks registered from `hermes_workflows/plugin.py`, active
  only inside kanban worker processes (gated on the `HERMES_KANBAN_TASK` env
  var the dispatcher injects).
- A per-task telemetry sidecar: one small JSON file per kanban card under
  `<hermes_home>/workflows/telemetry/`, written atomically (tmp + `os.replace`,
  the `executor/store.py` idiom) on every observed event.
- Engine merge: `Engine._advance_step` folds the sidecar into
  `NodeRunState.telemetry` when the node settles, and removes the sidecar after
  the run is saved.
- Live overlay: the dashboard `GET /runs/{run_id}` route attaches sidecar data
  to active nodes so the inspector's 2s poll shows telemetry before settle.
- Additive `telemetry` field on `NodeRunState` (TS schema), persisted via a new
  `telemetry_json` column on `workflow_node_runs` (idempotent `migrate()` ALTER).
- Run inspector node detail renders the telemetry block; the Runs view summary
  gains a per-run `total_tokens`.

## Out of scope

- Raw event journaling / replay (the sidecar holds aggregates only).
- Telemetry for DirectExecutor (global scope) and script nodes — by design they
  have no worker env join; runs complete with telemetry absent.
- Cost estimation, per-model breakdowns, latency histograms.

## Chosen approach

Variant 1 of the consultant round (see `variants.md`): worker-side aggregate
sidecars, engine merges at tick. Observer callbacks run inside the kanban
worker process, accumulate counters in process memory keyed by the card id from
`HERMES_KANBAN_TASK`, and atomically rewrite one aggregate JSON per card on each
event. The orchestrator reads the sidecar when the node settles and persists the
aggregate on the node; the dashboard route overlays the same file for live
display until then.

## Design decisions

- **Join key is the worker env var, not `kwargs["task_id"]`.** Verified against
  the installed host (hermes-agent 0.15.1): the `task_id` kwarg in tool/API
  hooks is a per-conversation UUID; the kanban card id reaches the worker only
  as the `HERMES_KANBAN_TASK` env var. The env var equals
  `NodeRunState.hermes_task_id`, giving an exact join with no parsing of opaque
  IDs (contract rule).
- **Zero overhead outside workers.** `register(ctx)` registers the observer
  hooks only when `HERMES_KANBAN_TASK` is present in the environment, so
  gateway and interactive CLI sessions register nothing and pay nothing.
- **Callbacks accept `**kwargs` and read fields via `.get`.** The v0.15.1 host
  lacks `status` / `error_type` on `post_tool_call` and has no
  `api_request_error` hook firing; the v1 contract adds them. Reading
  defensively means the same consumer works on both, and richer fields appear
  automatically after a host upgrade.
- **`api_request_error` is registered up front.** Unknown hook names produce a
  warning and are still stored (verified in `hermes_cli/plugins.py`), so
  registering the v1 error hook now costs one log line on old hosts and starts
  capturing structured errors the moment the host upgrades.
- **Aggregates, not events.** The sidecar holds the final shape
  (`NodeTelemetry`); no second aggregation pass exists anywhere. The engine and
  the dashboard route share one reader in `hermes_workflows/telemetry.py` (DRY).
- **Only the orchestrator writes runs.db.** Workers never open the database;
  the TS core remains its sole owner. The sidecar crosses the process boundary.
- **Settle-then-clean.** The engine merges the sidecar into the node at the
  same point it ingests the executor completion, and unlinks the file after a
  successful save — telemetry directories do not grow without bound.
- **Fail-open everywhere.** A telemetry write/read/parse failure is swallowed
  (host `invoke_hook` already wraps callbacks; our reader returns `None` on any
  error). A failure can suppress telemetry, never a run.
- **Duration is the observed activity window**: `last_event_ts - first_event_ts`
  inside the worker. It is the agent-activity duration, not the card queue time
  (queue time is visible in the trace task's timeline instead).

## File changes

New:
- `hermes_workflows/telemetry.py` — sidecar path resolution, `NodeTelemetryRecorder`
  (in-memory aggregate + atomic write-through), `load_node_telemetry(task_id)`,
  `clear_node_telemetry(task_id)`.
- `hermes_workflows/observer.py` — hook callbacks (`post_api_request`,
  `post_tool_call`, `api_request_error`, `subagent_stop`) over a module-level
  recorder; `register_observer_hooks(ctx)` with the env gate.
- `tests/python/test_telemetry.py`, `tests/python/test_observer.py`,
  `tests/python/test_engine_telemetry.py`.

Modified:
- `hermes_workflows/plugin.py` — call `register_observer_hooks(ctx)` (fail-open).
- `hermes_workflows/config.py` — `telemetry_dir()`.
- `hermes_workflows/engine.py` — merge sidecar into `node["telemetry"]` at
  settle; clear sidecars after save.
- `packages/core/src/schema/run.ts` — `NodeTelemetry` + `telemetry?` field.
- `packages/core/src/runtime/db/schema.ts` — `telemetry_json` column.
- `packages/core/src/runtime/db/connection.ts` — extend `migrate()` to
  `workflow_node_runs`.
- `packages/core/src/runtime/db/runRepository.ts` — round-trip `telemetry`,
  `total_tokens` on `RunSummary`.
- `dashboard/plugin_api.py` — live sidecar overlay in `GET /runs/{run_id}`;
  `_run_row` passes `total_tokens` through to the Runs-page row (the list
  route whitelists summary fields, so the new one must be named there).
- `apps/dashboard/src/api/types.ts` — re-export `NodeTelemetry`.
- `apps/dashboard/src/run/RunInspector.tsx` — telemetry block in node detail.
- `apps/dashboard/src/pages/RunsPage.tsx` — tokens column (when present).
- Core tests (`packages/core/tests`) + dashboard tests for the new surface.

## Risks and open questions

- **Worker plugin loading**: the consumer assumes kanban workers load plugins
  (they do — workers are `hermes -p <profile> chat -q` subprocesses and plugin
  discovery runs for chat sessions). If a deployment disables plugins for
  workers, telemetry is absent — which is the designed degradation.
- **Host upgrade drift**: when the host starts emitting v1 fields the consumer
  picks them up automatically; nothing breaks on either version (callbacks are
  `**kwargs`-tolerant in both directions).
- **Sidecar left behind on engine crash** between settle and save: the file is
  re-read on the next tick (merge is idempotent — last write wins) and cleaned
  after the next successful save.

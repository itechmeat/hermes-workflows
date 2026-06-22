# Event-driven workflow advance — replace the 2-minute cron tick with near-instant run progression

**Status:** accepted
**Author:** product-tech-lead (Phase 0 brainstorm)
**Audience:** implementation (fullstack-engineer)
**Branch:** `feat/event-driven-advance`
**Scope cards:** `t_c6a45c03` (preferred — native lifecycle hooks), `t_9cdf56de` (the
sub-minute / event-driven advancer it supersedes — adopt reconciles the supersession).

## Problem

A multi-node workflow run waits **up to ~2 minutes per node transition** because run
advancement is polled by a singleton cron tick (`hermes-workflows-tick`, schedule
`DEFAULT_TICK_SCHEDULE = "every 2m"`). The shim runs `hermes-workflows advance-all`.
A 3–4 node run therefore takes ~10–12 min wall-clock even though each node's compute is
seconds. Operators perceive the engine as slow.

Sub-minute cadence (~10s) is **not** reachable through the current mechanism: the
schedule is a hardcoded constant in plugin code, and Hermes cron is minute-granular
(the gateway evaluates cron ~once a minute; cron syntax cannot express seconds). This
is a plugin change, not a per-workflow YAML or cron-schedule edit.

### Enabler (newly available)

Hermes #50349 (merged, in installed `main`) fires kanban lifecycle plugin hooks
**after** the state-transition write txn commits — observers only, return values
ignored, exceptions swallowed:

- `kanban_task_completed` — fired in the **WORKER process** when it calls
  `kanban_complete`. Kwargs: `task_id`, `board`, `assignee`, `run_id`, `summary`,
  `profile_name`.
- `kanban_task_blocked` — fired in the **WORKER process** (worker-initiated block).
  Kwargs add `reason`.
- `kanban_task_claimed` — fired by the **DISPATCHER process** before the worker spawns.

Two process-boundary facts shape the design: (1) the completion/block hooks fire in
the short-lived worker subprocess, **not** the gateway; (2) the hook payload carries
`task_id` but **not** the workflow columns (`workflow_template_id`,
`current_step_key`) — those live on the `tasks` row and must be read with a lookup to
decide whether a card belongs to a workflow run.

## Scope

- **Event-driven advance (primary).** Register a `kanban_task_completed` /
  `kanban_task_blocked` observer in the plugin (loads in the worker session). The
  observer does one cheap task lookup; if the card belongs to a workflow run, it spawns
  a **detached, reparented** scoped advance for that run and returns immediately. The
  advance cycle (ingest → pure `advance` → schedule → persist) runs in a fresh
  gateway-side process that outlives the worker, via the **existing** idempotent
  `Engine.advance(spec_path, run_id)` path. This removes per-transition latency for the
  common case (card-driven `agent_task` nodes) entirely.
- **New scoped CLI surface.** Today the cron shim runs `advance-all`; the event path
  needs a per-run advance so a single card completion does not re-walk every active
  run. Add `hermes-workflows advance-run <run_id>` (a thin wrapper around
  `Engine.advance`) and the matching detached shim, mirroring the existing
  `write_shim` / cron-tick pattern.
- **Configurable cadence.** Replace the hardcoded `DEFAULT_TICK_SCHEDULE = "every 2m"`
  with a configurable default. The knob lives in the plugin's settings model
  (`plugins.workflows.tick_schedule`, exposed via `SETTINGS_SCHEMA` in
  `config.py`, default `"every 2m"`) — NOT a bare `workflows.tick_schedule`
  key in `config.yaml`. Every existing setting in this plugin resolves
  config ▸ env ▸ default through a `SETTINGS_SCHEMA` field, and the dashboard
  Settings page renders from that schema; a key not declared in the schema is
  invisible to the resolvers and the UI. With the event path handling card
  transitions, this residual tick is now a coarse safety-net + the poll for
  `wait` nodes, not the latency driver — so the operator-stated
  "configurable interval" ask is satisfied by exposing this one knob.
- **Tick lifecycle preserved.** Keep `sync_workflow_tick(active=…)` exactly: the tick
  exists while runs are active and is torn down when none remain. This is both the
  `wait`-node poll and the crash-safety net (see Risks).

## Out of scope

- Per-workflow advance intervals (`defaults.advance_interval`). A reviewer note on
  `t_9cdf56de` already concludes this becomes moot once event-driven advance lands;
  the global configurable `tick_schedule` is enough for now.
- A long-lived gateway-resident listener / daemon (outbox drain, inotify/socket wake).
  That would be a second runtime to supervise, against KISS and the project's "no
  second engine" stance.
- In-process advance inside the worker hook (running the full cycle before the worker
  exits). Rejected as too fragile against worker reaping (see variants.md).
- Anything about worker spawning — that stays the gateway's embedded dispatcher.
- `wait`-node event coverage. `wait` is worker-free by design and polled by the tick;
  it stays tick-driven. The residual tick still polls it.

## Chosen approach

**Variant 1** of the brainstorm (consultant-recommended, accepted): event-triggered
**detached** advance that reuses the cron shim pattern, fired by the worker-side hook.

Flow on a card completion:

1. Worker calls `kanban_complete` → the board txn commits → Hermes fires
   `kanban_task_completed(task_id, board, …)` inside the worker process.
2. The plugin observer looks up the task row on `board`; if
   `workflow_template_id`/`current_step_key` are set (it is a workflow card), it
   resolves `current_step_key` (node id) to the owning run via a `runs.db` read of
   `hermes_task_id` / `driven_task_ids` / `task_ids_json` (single cheap query).
3. The observer spawns a **detached, reparented** process running the new
   `hermes-workflows advance-run <run_id>` shim (same `write_shim` machinery as the
   tick), then returns. The worker is free to exit immediately.
4. The detached process calls `Engine.advance(spec_path, run_id)` — the **same**
   idempotent cycle the cron tick uses, scoped to one run. It ingests the completion,
   asks the pure `advance` core, schedules the next node's card through the normal
   executor, and persists to `runs.db`.
5. The singleton tick continues to run on its (now configurable) schedule as the
   `wait`-node poll and the safety net, and tears down when no runs are active.

## Design decisions

- **Detached spawn, not in-process.** The worker does a trivial lookup + fork and
  returns; the real work runs gateway-side and survives the worker. This is the only
  option that both gets near-instant latency and never puts a mid-flight advance on
  the worker-exit critical path (where idempotency cannot save a truncated
  persist-before-schedule). Same conclusion as the consultant; reaffirmed against the
  project's "no dirty hooks / log the actual runtime" rule: the detached process IS
  the real `advance` runtime, logging truthfully.
- **New `advance-run <run_id>` CLI subcommand, not `advance-all` on every event.** A
  per-card event should advance only the owning run; re-walking every active run per
  completion is wasteful and races more on `runs.db`. `Engine.advance` already takes a
  single `(spec_path, run_id)`; the new subcommand is a thin dispatcher around it,
  parallel to `_advance_all`.
- **Cheap card→run resolution, failure-tolerant.** The hook contract treats observers
  as fire-and-forget; the observer must never throw into the completion path. Unknown
  board, non-workflow card, missing run mapping, or any lookup error → the observer
  logs and returns; the residual tick still advances the run. No card transition is
  ever lost to an observer failure.
- **Single-flight per run + debounce.** Near-simultaneous completions of parallel-node
  cards (or completion + block) can spawn a burst. Guard with a per-run debounce: if a
  scoped advance for `<run_id>` was spawned within a short window (configurable, small
  default ~2s) or is still in flight, coalesce (skip the spawn). Idempotent `advance`
  + WAL `busy_timeout` already cover concurrent writers, so this is about avoiding
  pointless spawns, not correctness.
- **Tick becomes safety-net + wait-poll, not the latency driver.** The tick schedule
  is exposed as `tick_schedule` in the `plugins.workflows` settings model (field in
  `SETTINGS_SCHEMA`, default `"every 2m"`). It no longer needs to be fast; it exists
  to (a) poll `wait` nodes and (b) recover any event the detached spawn missed
  (worker crashed before spawn, lookup failed). Keeping it preserves the "no
  busy-polling at zero runs" acceptance point verbatim — `sync_workflow_tick`
  teardown is unchanged.
- **Crash-safe by construction.** The hook fires only after the completion/block txn
  commits, so the transition is durable before any spawn. A worker that dies before
  spawning the detached advance leaves a committed completion that the next tick
  ingests normally. No lost events.
- **No second runtime.** The detached process is the same `hermes-workflows`
  entrypoint the cron shim calls. Nothing new is supervised; teardown semantics are
  unchanged. This is the explicit reason Variant 2 (gateway-resident listener) was
  rejected.

## File changes

TypeScript core:
- `packages/core/src/cli/commands.ts` / `packages/core/src/cli.ts` — only if a pure
  per-run advance surface is needed at the core level; in most cases the Python
  `Engine.advance` already covers it and no core change is required. (Confirm during
  implementation; the core `advance(workflow, run)` is already per-run.)

Python bridge:
- `hermes_workflows/cli.py` — new `advance-run <run_id>` subcommand
  (`_advance_run(engine, run_id)`) wrapping `Engine.advance`; keep `advance-all`
  unchanged. Add `--tick-schedule` / config plumbing only if the knob is read here.
- `hermes_workflows/engine.py` — `Engine.advance(spec_path, run_id)` already exists;
  add a `advance_run(run_id)` helper that resolves the spec path from the persisted run
  and calls it, so the CLI subcommand has a clean entrypoint.
- `hermes_workflows/bridge/cron.py` — read `DEFAULT_TICK_SCHEDULE` default from config
  (`config.tick_schedule()` with fallback `"every 2m"`); keep
  `ensure_workflow_tick` / `sync_workflow_tick` / `teardown_tick` behavior identical.
- `hermes_workflows/__init__.py` — no change needed (hook registration already
  flows through `plugin.py:register()`; see next item).
- `hermes_workflows/plugin.py` — in `register()`, alongside the existing
  `pre_gateway_dispatch` and `register_observer_hooks(ctx)` calls, register the
  `kanban_task_completed` / `kanban_task_blocked` hooks that delegate to the new
  module. Use the same `getattr(ctx, "register_hook", None)` + `try/except`
  fail-open shape the existing hook registrations use. (`provides_hooks: []` in
  `plugin.yaml` may optionally be updated for discoverability, but host
  discovery of lifecycle hooks is driven by `ctx.register_hook(...)` calls at
  plugin load, not by `provides_hooks`, so it is cosmetic.)
- `hermes_workflows/hooks.py` (new) — `_on_task_event(task_id, board, **fields)`:
  lookup the task row on `board`; if it carries `workflow_template_id`/`current_step_key`,
  resolve the owning `run_id` from `runs.db`, check the per-run debounce window, and
  spawn the detached `advance-run` shim. All best-effort, never raises. NOTE: the
  existing `observer.py` already registers in-worker hooks behind the
  `HERMES_KANBAN_TASK` gate (proving lifecycle hooks fire in the worker) — but
  `kanban_task_completed`/`_blocked` fire during `kanban_complete`/`kanban_block`
  at the end of the worker's run, not gated on that env var, so register them
  unconditionally in `register()` like the `pre_gateway_dispatch` hooks do
  (they self-no-op for non-workflow cards).
- `hermes_workflows/config.py` — (see Config/docs block below for the full
  treatment; `tick_schedule()` and `event_debounce_seconds()` readers).

Config / docs:
- `hermes_workflows/config.py` — add `tick_schedule` and `event_debounce_seconds`
  as FIELDS in `SETTINGS_SCHEMA` (e.g. in the `execution` group) so they flow
  through the existing config ▸ env ▸ default resolver and render on the
  dashboard Settings page. Add the `tick_schedule()` and
  `event_debounce_seconds()` readers via `_setting_value(...)`. The
  `plugins.workflows` namespace is where the host config stores these — NOT a
  top-level `workflows.*` key.
- `docs/architecture.md` — "Execution model" section: add the event-driven advance
  path alongside the tick; note the tick is now safety-net + wait-poll.
- `README.md` — "Why" bullet on self-advancing runs updated to mention event-driven
  advancement (it already says "advances on a self-terminating cron tick").
- `CHANGELOG.md` — new `### Added` / `### Changed` entries under the next version.
- `docs/brainstorm/event-driven-advance/{design,plan,variants}.md` — this work.

Tests (TDD):
- `tests/python/test_advance_run_cli.py` — `advance-run <run_id>` advances exactly one
  run and is idempotent; non-existent run errors cleanly.
- `tests/python/test_lifecycle_hooks.py` — the `kanban_task_completed` observer:
  non-workflow card → no spawn; workflow card → spawns scoped advance (mock the spawn);
  lookup error → no throw, no spawn. `kanban_task_blocked` same shape.
- `tests/python/test_tick_schedule_config.py` — `tick_schedule()` default + override;
  `sync_workflow_tick` teardown still idles at zero active runs.
- Debounce / single-flight unit test (parallel-node completion burst → one spawn).
- Existing `advance-all` / tick-lifecycle tests stay green.

## Risks and open questions

- **Worker does not load the plugin / hook not registered in worker profile.
  RESOLVED in Phase 1 review.** Verified in installed `main`: the worker is
  spawned as `hermes -p <profile> --accept-hooks chat -q "work kanban task <id>"`
  (`_default_spawn` in `hermes_cli/kanban_db.py`), and `chat` is an
  `_AGENT_COMMAND`, so `_maybe_discover_plugins` runs `discover_plugins()` at
  worker startup — the plugin manager (process-local `_hooks` dict) is populated
  before the worker's first `kanban_complete`/`kanban_block` fires the hook.
  Corroborated by the existing `observer.py`, which already registers
  in-worker hooks behind the `HERMES_KANBAN_TASK` gate and has run in
  production without the hooks being absent. The Phase 1 smoke test can be a
  simple `has_hook("kanban_task_completed")` check after discovery in a worker
  profile; no design change rides on it.
- **Detached-spawn cost (Bun cold start).** ~hundreds of ms, trivial against the
  2-minute floor. The debounce window prevents a spawn storm on parallel-node bursts.
- **`runs.db` write contention between a detached advance and the tick.** WAL plus
  `PRAGMA busy_timeout = 30000` (verified already set in
  `packages/core/src/runtime/db/connection.ts`) cover concurrent writers; the
  per-run debounce reduces overlap.
- **`advance-run` must resolve the spec path from the persisted run** (a global run
  has no project board). `Engine.advance(spec_path, run_id)` takes the spec path
  explicitly; the new CLI subcommand reads it from the persisted run record (the same
  way `advance-all` enumerates `(spec_path, run_id)` pairs).
- **Identifying the owning run from `task_id` when an `adopt` node drives several
  cards.** A driven card's `current_step_key` is the adopt node id; the run is found
  via that node's row. Multiple driven cards map to one node/run, so the debounce is
  per-run, not per-card — correct.

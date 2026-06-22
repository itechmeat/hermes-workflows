# Architecture

Hermes Workflows compiles a workflow graph onto native Hermes primitives. It is
a thin orchestration layer, not a separate engine.

```text
@xyflow editor (later)   model tools (workflow_list/run/status/explain/review)
        |                                   |
   workflow specs (YAML/JSON)               |
        |                                   v
   TypeScript core (Bun)  <----- cli_bridge -----  Python orchestrator
   schema · validation · compiler · advance · run-state persistence
        |                                   |
        |                          Kanban · Cron · Profiles bridges
        v                                   v
   runs.db (SQLite)                 native Hermes primitives
                                    + optional OpenSecondBrain memory
```

## Topology

- **TypeScript core (`packages/core`)** owns everything that interprets a spec:
  schema and loader, validation, the compiler (graph to Hermes plan), the pure
  `advance` decision, and run-state persistence (`runs.db`). It is exposed as a
  JSON-in/JSON-out CLI (`cli.ts`).
- **Python orchestrator (`hermes_workflows`)** is the only place that touches
  Hermes. It drives the core CLI via `cli_bridge` for pure decisions and
  persistence, and performs Kanban/Cron/Profiles I/O through the bridges. The
  spec is therefore interpreted in exactly one place (TypeScript).
- **Plugin shell (`__init__.py`, `plugin.yaml`)** registers five model tools
  (`workflow_list/run/status/explain/review`) with lazy handlers; the engine is
  not imported at startup, and no O2B detection runs at load.
- **Dashboard (`dashboard/`)** is the Workflows tab (manifest + `plugin_api.py`
  + a build-free bundle): read-only listing plus the one human-in-the-loop
  write, `POST /runs/{id}/review`.
- **Execution backends (`hermes_workflows/executor`)** sit behind a `schedule`/
  `poll` seam: project runs schedule durable Kanban cards on their project
  board; global runs invoke the profile runner directly with no card. See
  [execution.md](execution.md).

## Execution model

A run advances durably. Each tick:

1. ingest completions for active nodes through the run's execution backend,
2. ask the core for the next scheduling decision (`advance`, pure),
3. schedule newly ready nodes through that backend,
4. persist the run to `runs.db`.

The backend is chosen by workflow scope: a project run uses the Kanban backend
(durable cards on the project's board); a global run uses the Direct backend
(profile runner, no card). Worker spawning is **not** the plugin's job — the
Hermes gateway hosts an embedded dispatcher that ticks every board on disk and
spawns workers for ready cards, governed by `kanban.max_in_progress[_per_profile]`.

Advancement is primarily **event-driven**. A worker that completes (or blocks) a
workflow card fires the native `kanban_task_completed` / `kanban_task_blocked`
lifecycle hooks (Hermes #50349), which the plugin observes and turns into a
detached, scoped `hermes-workflows advance-run <run_id>` — the same idempotent
advance cycle, scoped to the owning run. A multi-node run therefore advances
node-to-node in **seconds**, not on the next poll.

Behind that, a transient Cron tick (`hermes-workflows advance-all`) remains as
the coarse **safety-net + `wait`-node poll**: a single named job created while
runs are active and removed when none remain, so tick jobs never accumulate and
nothing busy-polls at zero active runs. Its cadence is the configurable
`plugins.workflows.tick_schedule` setting (config ▸ env ▸ default `every 2m`),
tunable from the Settings page without a code edit; Hermes cron is
minute-granular, so a sub-minute value is bounded by the scheduler — sub-minute
latency comes from the event path, not the tick. `advance` is idempotent: a
repeated tick or a redundant event spawn never duplicates work (native
`idempotency_key`), and loop edges (fix to validate) re-run a node on a fresh
card keyed by iteration. See [execution.md](execution.md) for backend details
and limits.

## Native Hermes mapping

| Workflow concept | Native primitive |
| --- | --- |
| `agent_task` node | Kanban task assigned to a profile, stamped with `workflow_template_id` / `current_step_key` |
| node outcome | `task_runs.outcome` (`completed` to success, else failure; worker may override via metadata) |
| sequential edge | `task_links` parent/child |
| human_review / completion notice | `kanban_notify_subs` + the gateway kanban-notifier |
| cron trigger | a Hermes Cron job running the workflow |
| retries / workspace / model / skills | native `max_retries` / `workspace_kind` / `model_override` / `skills` columns |

If a future Hermes version routes on these columns itself, the plugin already
speaks the same vocabulary and can defer to it.

## Storage

- `runs.db` (SQLite, WAL): `workflow_runs`, `workflow_node_runs` (one row per
  node, current state, including observer-derived `telemetry_json`),
  `workflow_schedules`. Source of truth for run state.
- Specs: `~/.hermes/workflows/{global,templates}` and
  `<project>/.hermes/workflows`.
- Artifacts: `~/.hermes/workflows/runs/<run_id>/...`.
- Telemetry sidecars: `~/.hermes/workflows/telemetry/<card_id>.json` — written
  by worker-side observers, folded into the node at settle time and removed.
- Traces: `~/.hermes/workflows/traces/<run_id>.jsonl` — opt-in per-run
  timeline (`observability.trace_enabled`).
- OpenSecondBrain is never runtime storage — only optional long-term memory.

# Execution

A workflow runs autonomously: no human in the loop except an explicit
`human_review` node. How a node runs depends on the workflow's **scope**, which
selects one of two execution backends behind a single `schedule` / `poll` seam
(`hermes_workflows/executor`).

## Backends

| Scope | Backend | How a node runs | Durability |
| --- | --- | --- | --- |
| `project` / `projects` | `KanbanExecutor` | a Kanban card on the project's board, dispatched by the gateway to the assigned profile | the board DB |
| `global` | `DirectExecutor` | the profile runner (`~/.hermes/bin/agents/<profile>`) invoked directly with the node prompt | a file-backed completion store |

A `script` node is orthogonal to scope: it always runs locally on the
`ScriptExecutor` (a subprocess in its `workdir`), regardless of the workflow's
backend. The engine wraps the scope executor in a `CompositeExecutor` that
routes a node by its compiled `kind` on `schedule` and by handle prefix
(`script:`) on `poll`, so agent_task nodes keep using the scope backend while
script nodes run in the plugin. Hermes has no no-agent Kanban task mode, so a
script step never becomes a card.

Both implement the same contract:

- `schedule(...) -> handle` starts the node's work and returns an opaque handle
  persisted on the node (`hermes_task_id`). Scheduling is idempotent per
  `(run, node, iteration)`, so a repeated tick never double-starts a node and a
  loop edge re-runs a node on a fresh handle keyed by iteration.
- `poll(handle) -> Completion` reports whether the node has settled and, once
  settled, its `success` / `failure` outcome and captured output.

## Boards (project scope)

A project run's cards live on the **project's own board** — the board slug is
the project slug, matching the platform project name convention. The run's bound
project (`project_id`, defaulted from the workflow scope's first declared
project) wins over the scope list. Boards are auto-ensured on first use
(idempotent), so a first run never parks waiting for a board to exist. A project
run with no bound project falls back to the shared runtime board
(`hermes-workflows`).

## Dispatch

The plugin does **not** spawn workers. The Hermes gateway hosts an embedded
dispatcher that ticks every board on disk each interval and spawns workers for
ready cards, throttled by `kanban.max_in_progress` and
`kanban.max_in_progress_per_profile`. The workflow tick only advances the graph
(progressing runs as cards complete) and manages its own singleton cron.

For installs that disable the gateway dispatcher
(`kanban.dispatch_in_gateway=false`), the tick can run an explicit per-board
dispatcher pass — pass `dispatch` + `resolve_board` to `Engine.tick`. This is
off by default.

## The tick

`hermes-workflows advance-all` is the tick body the cron job runs. It advances
every active run in one pass and keeps the singleton tick cron alive only while
runs remain active, tearing it down once everything drains — so tick jobs never
accumulate.

## Script nodes (security gate)

A `script` node runs an operator-authored shell command, so its mitigations
(TZ §25.2) are enforced, not advisory:

- **Explicit enable.** A workflow containing script nodes runs only when
  `execution.scripts_enabled` is on (default off). Otherwise the run is refused
  — the dashboard run route returns `409`, the CLI exits non-zero — before
  anything is scheduled. Agent-only workflows are unaffected.
- **Env allowlist.** A script sees only the env vars named in
  `execution.script_env_allowlist` (comma-separated), intersected with the
  node's own `env` list — never the full process env.
- **Workdir-only cwd and a timeout.** The command runs in its `workdir` and is
  killed on `timeout_seconds` (settling `failure`).
- **Redacted, capped output.** Captured stdout/stderr is secret-redacted and
  clipped to 100,000 characters before it is persisted.

The compiled command is shown in the dashboard compile preview before a run.

## human_review

A `human_review` node is the one place a human is required. Resolution is
channel-agnostic and reachable three ways, all funneling through the same engine
validation (`approved` / `rejected` / `needs_changes`, and only while the node
is actually awaiting review):

- the `workflow_review` model tool,
- the CLI: `hermes-workflows review <run_id> <node_id> <decision>`,
- the dashboard: `POST /api/plugins/workflows/runs/{run_id}/review`.

## Notifications

The notification contract is channel-agnostic: a target is the run's captured
**origin** when present, else a configured default (`HERMES_WORKFLOWS_DELIVER`),
else nothing (stay silent). Origins and targets are opaque
`<platform>:<chat>[:<thread>]` strings that Hermes' native delivery interprets —
nothing branches on the platform. The resolution and the Kanban-notifier
subscription (`subscribe_task`) are implemented and unit-tested in
`notifications.py`.

> **Status: contract only, not yet wired into the live run path.** Runs do not
> yet capture an `origin`, and run-lifecycle delivery (a notice on
> completed/failed/review-needed) is not hooked into `advance`. So today a run
> does not actively send a notice on its own. Wiring it requires origin capture
> on the run plus a run-lifecycle send; that is a deliberate next step, tracked
> separately — the module is built so the wiring is a small, isolated change.

## Limits

- **DirectExecutor timeout.** A global node's runner is killed after
  `timeout_seconds` (default 1800s); a timeout settles the node as `failure`.
  Configure per call when constructing the executor.
- **DirectExecutor output cap.** Captured stdout/stderr is clipped to 100,000
  characters before it is persisted, so a runaway worker cannot bloat the run
  store.
- **A global node blocks the tick for its duration.** `DirectExecutor.schedule`
  runs the profile runner synchronously, and `advance_all` processes runs
  serially, so a single slow global node holds up the advancement of every other
  active run (and the cron tick itself) until it returns or hits its timeout.
  This is acceptable for the current global workloads (short, periodic jobs); if
  global nodes grow long-running, switch the Direct backend to a detached spawn
  whose `poll` reads the result later. Project (Kanban) runs are unaffected —
  their workers are spawned out-of-band by the gateway dispatcher.
- **`kind: hermes` profiles under the Direct backend.** The Direct backend
  invokes a profile *runner* executable and captures its stdout. Profiles whose
  runner is a long-lived `hermes`-kind agent (rather than a one-shot runner that
  prints a final message and exits) are not supported as global nodes; bind such
  work to a project so it runs as a Kanban card instead.

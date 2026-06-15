# Phase 2 — Autonomous Execution Design

Status: approved (brainstorm), ready for implementation
Builds on: the MVP (`docs/specs/2026-05-29-hermes-workflows-mvp-design.md`)

## 1. Goal

Make workflows execute **autonomously in production**, with **two execution
backends**:

- **project-scoped** workflows execute durably as Kanban cards on the bound
  project's board (dispatched to profile workers);
- **global / unbound** workflows execute **without Kanban cards**, by invoking
  the assigned profile's runner directly (lightweight).

Autonomy is the point: workflows run without a human. `human_review` is a rare
exception node, resolved through a simple, channel-agnostic path (not coupled to
any one chat platform).

## 2. Execution backends behind one seam

The advance engine must not know *how* a node runs. A single seam isolates it:

```text
interface NodeExecutor {
  schedule(node, runCtx): Handle           // start the work, return a handle
  poll(handle): { settled, outcome, output }  // read completion
}

KanbanExecutor  (scope = project)  -> creates a Kanban card on the project board
                                      (the existing kanban bridge), dispatched to
                                      a profile worker; poll reads task_runs.
DirectExecutor  (scope = global)   -> invokes the profile runner script
                                      (~/.hermes/bin/agents/<profile>, prompt ->
                                      stdout) as a subprocess; poll reads the
                                      captured result.
```

The orchestrator selects the executor from the workflow `scope`. The handle is
persisted on the node run (`hermes_task_id` for Kanban; a direct-run id / output
path for Direct), so polling survives a tick restart.

### DirectExecutor approach (the one real fork)

Reuse the **profile runner contract**: roster profiles expose a runner
(`~/.hermes/bin/agents/<profile>`) that takes a prompt and emits the agent's
final message on stdout. DirectExecutor resolves the profile's runner and runs
it with the node prompt, capturing stdout as the node output, with a timeout.

`kind: hermes` profiles (gateway-LLM, no runner script) are flagged by the
validator as unsupported for **global** workflows in this phase (every roster
runner on this server is a codex/claude/custom script, so coverage is complete).
Rejected alternative: reuse the Kanban dispatcher's worker spawn — it is hard
bound to a Kanban task id, so it would mean duplicating per-kind spawn logic.

## 3. Tick = advance + dispatch

`hermes-workflows advance-all` loads active runs and, per run: advances the
graph (pure decision), schedules next nodes through the executor (creates Kanban
cards for project runs, starts runners for global runs), then, for project runs,
runs a `hermes kanban dispatch` pass on the project board so ready cards spawn
workers. This closes the loop with no persistent daemon.

The tick is one self-rescheduling singleton Cron job (`once in N min`): while any
run is active it reschedules itself; when none remain it stops. Tick jobs never
accumulate.

## 4. `hermes-workflows` command

A stable in-repo entrypoint (`bin/hermes-workflows`, optionally symlinked at
`~/.hermes/bin/hermes-workflows`) wrapping the Bun
core CLI and the Python orchestrator. Cron triggers and the tick invoke it
(via `config.command_path()`, which falls back to the in-repo wrapper);
`run`, `advance`, `advance-all`, `status`, and `review` are its subcommands.
Manual runs already work through the `workflow_run` model tool.

## 5. Board model

- **project** scope: resolve the bound project's Kanban board (project slug via
  the platform registry / scope), auto-ensure it exists (`kanban boards create`),
  and create cards there. Removes the MVP collision with the dev board.
- **global** scope: no board, no cards — DirectExecutor runs the node inline.

## 6. Notifications (channel-agnostic)

No hardcoded Telegram. Project (Kanban-backed) nodes use the native
`kanban_notify_subs` so the gateway notifier delivers on the origin platform.
Run-lifecycle notices use Hermes' native delivery keyed by `origin` (the
platform+chat the run was triggered from); a default `deliver` target in plugin
config is used when there is no origin. This works for any of the gateway's
platforms.

## 7. human_review resolution (simple, channel-agnostic)

A core `resolveReview(run, node, decision)` mutates run state in `runs.db`. It is
exposed through three thin wrappers so resolution is not tied to any one channel:

- CLI: `hermes-workflows review <run> <node> <approved|rejected|needs_changes>`
- model tool: `workflow_review` (an agent, or a chat command on any platform,
  can resolve it)
- optional dashboard button (a single write route)

## 8. Security and limits

- DirectExecutor runs the profile runner with a bounded timeout and a redacted,
  size-capped prompt/output; the existing secret redactor applies to any output
  written to logs / O2B.
- The tick `dispatch` pass honours the native `--max` spawn cap.
- No new secrets handling beyond the MVP redactor.

## 9. Testing (TDD)

- Executor unit tests: `KanbanExecutor` against a temp board; `DirectExecutor`
  with a fake runner script that echoes stdout.
- Orchestrator: advance routes agent_task to the correct executor by scope.
- End-to-end: a project-durable run (Kanban) and a global-direct run (runner
  stub) each driven to `finish`.
- Tick: `advance-all` advances + dispatches and self-terminates when no runs are
  active.

## 10. Epics (become Kanban cards)

- **P1** Executor seam — `NodeExecutor` + `KanbanExecutor` + `DirectExecutor`.
- **P2** Orchestrator — scope-based executor routing; per-backend completion ingest.
- **P3** Tick = advance + dispatch — `advance-all`, dispatch pass, self-terminating tick.
- **P4** `hermes-workflows` command + cron wiring.
- **P5** Board model — per-project board resolve/auto-ensure; global = no board.
- **P6** Notifications — channel-agnostic native delivery (origin) + notify subs.
- **P7** human_review resolution — `resolveReview` + CLI + tool + optional dashboard button.
- **P8** Live verification, docs, limits.

## 11. Out of scope (later phases)

Visual `@xyflow` editor (E7); richer nodes/triggers/conditions (script, parallel,
subworkflow, webhook, expression conditions, O2B MCP provider); `kind: hermes`
direct execution for global workflows.

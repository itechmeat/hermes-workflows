# Hermes Workflows

Visual workflow orchestration for [Hermes Agent](https://github.com/NousResearch/hermes-agent).
Describe a workflow as a graph, then run it on top of Hermes' own primitives.

```
Workflow graph -> Hermes-native execution (Kanban, Cron, Profiles)
```

Hermes Workflows is a thin orchestration layer, not a separate engine. Workflows compile to
native Hermes Kanban tasks, Cron jobs, and Profile assignments. It does not replace any of them.
OpenSecondBrain is an optional long-term memory layer.

## Status

The engine is headless-first and runs autonomously. A workflow advances on a self-terminating
Cron tick with no human in the loop except an explicit `human_review` node. The dashboard tab
manages the full authoring lifecycle: create a workflow from a modal (seeded with a minimal valid
graph and opened in the editor), enable/disable, duplicate, export YAML, or delete it, with each
template showing its last run and next scheduled run. Author the graph in a
visual `@xyflow/react` editor — edit the full node field set (including agent_task workdir,
workspace, retries, timeout, and input mapping), duplicate or auto-layout nodes, validate, preview
the compiled Hermes plan, and save (layout included) — alongside a live run inspector with per-node
status, cancel, and retry. It also has a **Runs** view (every run, with open / cancel / retry /
export-logs), a **Schedules** view over Hermes cron (pause / resume / run-now / edit / delete), and
a **Settings** view backed by the Hermes config. See [docs/dashboard.md](docs/dashboard.md).

## Node types

- `trigger` — `manual` or `cron`
- `agent_task` — run a text prompt as work assigned to a profile
- `condition` — branch on a structured condition (node status or review decision)
- `human_review` — pause for a human decision (channel-agnostic resolution)
- `finish` — terminate the run

## Execution

The workflow scope picks the execution backend: a **project** run schedules durable Kanban cards
on the project's own board; a **global** run invokes the profile runner directly with no card.
Worker spawning is the Hermes gateway's job; the tick only advances the graph and self-terminates
when no runs remain active. See [docs/execution.md](docs/execution.md).

```bash
hermes-workflows run <workflow_id>          # start a run and advance it once
hermes-workflows advance-all                # the tick body: advance every active run
hermes-workflows status <run_id>
hermes-workflows review <run_id> <node_id> <approved|rejected|needs_changes>
```

## Layout

- `packages/core` — TypeScript engine (schema, validation, compiler, runtime, memory) on Bun
- `apps/dashboard` — frontend source for the dashboard plugin (Vite + React 19 + `@xyflow/react`), built to `dashboard/dist`
- `hermes_workflows/` — Python orchestrator: execution backends + Hermes bridges (kanban, cron, profiles, boards, notify, o2b)
- `dashboard/` — Hermes dashboard plugin: the built bundle, manifest, and the authoring + run-control API
- `docs/` — [architecture](docs/architecture.md), [execution](docs/execution.md), [workflow schema](docs/workflow-schema.md), [dashboard](docs/dashboard.md); specs and plans under `docs/specs`, `docs/plans`

## Development

```bash
bun install
bun run validate          # core typecheck + lint + tests (Bun + pytest), then the
                          # frontend typecheck + tests + a fresh build, and a guard
                          # that the committed dashboard/dist matches that build
bun run dashboard:build   # rebuild just the dashboard bundle into dashboard/dist
```

## License

MIT

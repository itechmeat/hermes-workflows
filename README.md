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
graph and opened in the editor), enable/disable, duplicate, export as YAML or JSON, import a
workflow from a JSON export (validated server-side; an id clash is an explicit error), or delete
it, with each template showing its last run and next scheduled run. Author the graph in a
visual `@xyflow/react` editor — edit the full node field set (including agent_task workdir,
workspace, retries, timeout, and input mapping), duplicate or auto-layout nodes, validate, preview
the compiled Hermes plan, save (layout included), and press Play to run the workflow in place:
the canvas shows live per-node progress while editing is locked, then hands off to the run
inspector once the run settles — alongside that live run inspector with per-node
status, cancel, and retry. Runs are single-flight: a workflow can have at most one active run
(a second start is refused with the blocking run named), and re-opening the editor while a run
is in flight attaches to it instead of pretending the workflow is idle. It also has a **Runs** view (every run, with open / cancel / retry /
export-logs), a **Schedules** view over Hermes cron (pause / resume / run-now / edit / delete), and
a **Settings** view backed by the Hermes config. See [docs/dashboard.md](docs/dashboard.md).

Runs are observable through the Hermes observer-hook contract: each `agent_task` node executed by
a kanban worker reports per-node telemetry (duration, token usage, API and tool calls, subagents,
structured errors) live in the run inspector and persisted with the run; a node whose worker is
blocked on a dangerous-command approval shows a waiting annotation with the command text; and an
opt-in per-run JSONL trace (`observability.trace_enabled`) records the full timeline of every run
for export from the Runs view. See the Observability section in
[docs/execution.md](docs/execution.md).

## Node types

- `trigger` — `manual` or `cron`
- `agent_task` — run a text prompt as work assigned to a profile
- `script` — run a deterministic shell command with no LLM (lint, tests, build), gated by an enable flag and an env allowlist
- `condition` — branch on a structured condition (node status or review decision)
- `human_review` — pause for a human decision (channel-agnostic resolution)
- `finish` — terminate the run

## Passing data between nodes

An `agent_task` can consume a prior node's output instead of a shared file. Declare the
inputs it needs and reference them by placeholder in the prompt:

```yaml
- id: analyze
  type: agent_task
  prompt: "Design scopes from this inventory:\n{{inventory}}"
  input_mapping:
    inventory: "{{nodes.collect.output}}"
```

At schedule time the engine substitutes each `{{placeholder}}` with the referenced node's
captured output. References are validated when the workflow is authored: the source must be a
prior (ancestor) node, every declared placeholder must appear in the prompt, and an output that
never materialised fails the node loudly rather than substituting empty text. Because the data
flows through the run state, the workflow stays fully exportable and editable — no host path is
baked into the graph.

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
- `apps/dashboard` — frontend source for the dashboard plugin (Vite + React 19 + `@xyflow/react` + `@base-ui/react`), built to `dashboard/dist`. UI-control conventions: [DESIGN.md](DESIGN.md)
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

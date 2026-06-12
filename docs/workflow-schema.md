# Workflow schema

A workflow is a portable YAML (or JSON) spec. It is valid and executable without
the optional `ui` layout block — layout is strictly separated from execution.

## Top level

```yaml
id: feature-development        # stable identifier
name: Feature Development
version: 1                     # integer
scope:
  type: project                # global | project | projects
  projects: [open-second-brain] # optional
trigger:
  type: manual                 # manual | cron | webhook | github | api
deliver: origin                # optional; DeliveryTarget syntax or "origin"
defaults:
  profile: fullstack-engineer  # fallback assignee
  max_retries: 1
  memory: { provider: auto, fail_open: true }
params: [ ... ]                # optional; typed slots when used as a template
nodes: [ ... ]
edges: [ ... ]
ui: { xyflow: { ... } }        # optional, ignored by execution
```

## UI layout (optional)

The `ui` block carries the editor's visual layout and is strictly separated from
execution — a spec without it still loads and runs. It is parsed into a typed,
lenient shape (malformed entries are dropped, never raised):

```yaml
ui:
  xyflow:
    nodes:                       # canvas position per workflow node id
      - { id: plan, x: 100, y: 80 }
      - { id: done, x: 400, y: 80 }
    viewport: { x: 0, y: 0, zoom: 1 }
```

The serializer round-trips `ui` losslessly, so saving from the editor preserves
layout. Validation ignores `ui` entirely.

## Triggers

- `manual` — started via the `workflow_run` tool, the CLI, or the dashboard.
- `cron` — `{ type: cron, schedule: "0 9 * * *", timezone: "Europe/Belgrade" }`;
  compiled to a native Hermes Cron job.
- **Event triggers** — `webhook`, `github`, and `api`, mirroring Hermes's three
  automation sources. Each carries an `events` filter and an optional
  `event_mapping` of `{event.<path>}` references threaded into the entry node's
  prompt (a namespace distinct from `{{nodes.<id>.output}}`):
  ```yaml
  trigger:
    type: github
    events: [pull_request, issues]
    event_mapping: { title: "{event.pull_request.title}" }
  ```
  Support boundary: event triggers are **declarable, validated, and shown in the
  compile preview**, but *firing* is deferred to an upstream Hermes change — the
  host webhook system dispatches an event only to an agent prompt or direct
  delivery (no event→workflow-run wiring; `cron.jobs.create_job` is time-only).
  No local stub pretends to fire them.

## Delivery

A workflow may declare where its result is delivered:

```yaml
deliver: telegram:-1001234567890:42   # DeliveryTarget syntax, or the literal "origin"
```

When `deliver` is set, a completed run delivers its result (the final node
output) to that target through the host's native delivery router instead of the
terse lifecycle line. An explicit target other than `origin` overrides the run's
captured chat origin; `origin` (or unset) keeps it. A result containing
`[SILENT]` (the Hermes output-marker convention) suppresses delivery, so a
nothing-to-report run stays quiet. Any non-empty string is accepted — the
gateway validates the platform downstream. Left unset, run-lifecycle notices
behave exactly as before.

## Template parameters

A workflow used as a template can declare typed parameters (mirroring Hermes
blueprint slots) as the single source of truth for every surface:

```yaml
params:
  - { name: topic, type: text, label: "Topic", default: "AI" }
  - { name: tone,  type: enum, label: "Tone",  options: [formal, casual], default: formal }
```

Param `type` is `text | enum | int | bool`; an `enum` may set `strict: false` to
accept any value (validated downstream). From this one schema the core emits a
form, a ready-to-paste `/workflow <key> name=val` command, a `hermes://` deep
link, and an agent-seed prompt (`packages/core/src/templates/params.ts`); the
compile preview surfaces them as a `catalog`. The working chat slash command and
deep-link resolution are host surfaces pending upstream Hermes support.

## Node types (MVP)

- **agent_task** — the primary node, a text prompt run as a Kanban task:
  ```yaml
  - id: implement
    type: agent_task
    title: Implement feature
    profile: fullstack-engineer   # -> assignee (or defaults.profile)
    model: some-model             # -> model_override
    skills: [coding]              # -> skills
    workspace: { type: worktree } # scratch | worktree
    prompt: |
      Implement the feature according to the plan.
    max_retries: 1
    timeout_seconds: 3600
  ```
- **script** — a deterministic shell command run with no LLM (lint, tests, a
  build step). It settles `success`/`failure` by exit code, so it branches on
  `node_status` like any work node. It runs locally in the plugin in any scope.
  ```yaml
  - id: lint
    type: script
    command: bun run lint        # required
    workdir: /srv/projects/foo   # where the command runs
    timeout_seconds: 120         # failure on expiry
    env: [PATH, CI]              # env var names the command may see (allowlist)
  ```
  Running a workflow with script nodes requires `execution.scripts_enabled` and
  exposes only `execution.script_env_allowlist` vars — see `execution.md`.
- **condition** — a routing-only node; its outgoing edges carry the conditions.
- **human_review** — pauses the run; `options: [approved, rejected, needs_changes]`.
- **finish** — terminal; `outcome: success | failure`.

The entry node is the one with no incoming edge (exactly one is required).

## Edges and conditions

```yaml
edges:
  - from: validate
    to: review
    condition: { type: node_status, node: validate, equals: success }
  - from: validate
    to: fix
    condition: { type: node_status, node: validate, equals: failure }
  - from: review
    to: publish
    condition: { type: review_status, equals: approved }
  - from: fix
    to: validate            # a loop edge re-runs validate
```

Conditions are structured only (no expression or LLM routing):

- `node_status` — branch on a node's success/failure. A branch on `node_status`
  must cover both outcomes or declare a `fallback: true` edge.
- `review_status` — branch on a human_review decision. Partial handling is
  allowed; an unhandled decision stops the run.

A node's success/failure comes from the backing Kanban task's outcome; a worker
may override it by writing `{ "node_outcome": "success" | "failure" }` into its
completion metadata (useful for a QA gate that "completes" but reports failure).

See `examples/` for two complete specs.

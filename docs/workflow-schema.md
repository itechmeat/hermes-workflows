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

## Notifications

```yaml
notifications:
  subscribe_cards: false   # optional; default true
```

Each Kanban-backed node card subscribes the run's origin to its native terminal
event (the `✔ Kanban … done` ping per card). On a long autonomous workflow that
floods the chat. `notifications.subscribe_cards: false` silences the per-card
pings while keeping run-level lifecycle notices (run failed / completed) and any
explicit `hermes send` calls in node prompts. Absent means `true` (unchanged).

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
compile preview surfaces them as a `catalog`.

A node prompt interpolates a param as `{{params.<name>}}`; a reference to an
undeclared param is rejected at author time (`unknown_param_ref`). Supply values
when starting a run and the core validates them against the declared params
(unknown name, missing required, bad enum/int/bool all fail loud), then
substitutes each placeholder at schedule time. Three surfaces instantiate off
the same schema:

- the dashboard Run button opens a form (one field per param) when the workflow
  declares any;
- `/workflow run <id> [project] name=value …` in chat (quote a value with
  spaces);
- the run API `POST /workflows/{id}/run` with a `params` object.

The `hermes://` deep-link resolution and a fully conversational agent-seed fill
remain host surfaces pending upstream Hermes support; the emitters and catalog
already produce what those surfaces consume.

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
    board: true                   # default; set false to run off the board
  ```
  By default a project-scope agent_task creates a Kanban card the worker pool
  drives. Set `board: false` to run the node **off the board** through the direct
  profile runner: no card is created, so internal orchestration steps do not
  clutter the operator's board - reserve real cards for the actual work (an
  `adopt` node driving an existing card, or an epic card the run itself opens).
  An off-board node runs without a project worktree, so it is for
  reasoning/orchestration steps, not for nodes that must commit to the repo. In
  `global` scope it is a no-op (every node already runs through the direct
  runner).
  An agent_task can instead **drive an existing board card** rather than create
  one — the native Kanban flow where the work is the card:
  ```yaml
  - id: drive
    type: agent_task
    profile: fullstack-engineer
    adopt: true
    task_ref: "{{nodes.lock-scope.output.task_ids}}"  # or a literal id, e.g. t_abc123
    review_profile: qa-engineer   # optional native review stage after each card is done
    stack: true                   # drive the scope STACKED on a shared release branch
    branch: feat/my-release        # the shared branch (optional; default: workdir's branch)
    workdir: /srv/projects/foo     # the release working tree (optional; default: board default_workdir)
    prompt: ""                    # unused when adopting (the card carries its own)
  ```
  `task_ref` resolves to the card id(s) to drive; the node settles only when all
  of them are terminal. With `stack: true` the cards are driven ONE AT A TIME on
  a shared feature branch: each card runs in a linked worktree based on that
  branch's current tip (so card N builds on cards 1..N-1), and the engine
  fast-forwards the branch to include a card's commits before the next card
  starts. Stacked cards are also told not to self-bump version/CHANGELOG — a
  single docs-version step owns that once for the whole release. See
  `execution.md` ("Driving existing cards").

  **Dispatcher worktree/cwd contract (Hermes #49855 + #50348).** Stacking builds
  on, and is validated against, the host dispatcher's per-task model:
  - Each driven `worktree` card is materialized as a real linked git worktree at
    `<repo>/.worktrees/<task-id>`, anchored on the board's `default_workdir` (or
    the node's `workdir`) — a persistent project checkout — and NEVER under the
    dispatcher's incidental CWD (e.g. the Hermes code checkout the gateway
    launched from). The engine stamps each card with `workspace_kind=worktree` +
    `workspace_path=<repo>` so the host resolves that target on the shared
    branch's tip; `assert_anchor_conformance` refuses an anchor inside the Hermes
    checkout at drive time.
  - The worker's `TERMINAL_CWD` is pinned to that resolved worktree, so its file
    tools and AGENTS.md/context-file loader resolve inside the project repo, not
    the dispatching gateway's directory.
  `tests/python/test_dispatch_worktree_conformance.py` pins this contract so an
  upstream pull that changes worktree anchoring or `TERMINAL_CWD` pinning fails
  loudly.
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
- **prompt** — a block of authored text with one input and one output, and no
  work of its own. Its text becomes the operator directive for every agent_task
  reachable DOWNSTREAM of it (a transitive walk over the edges), so a Prompt node
  governs the whole sub-flow from its insertion point, not just its immediate
  successor. The directive holds the highest authority over each step's decisions
  (what to select, the scope, the version, whether to release) but is carried out
  only through that step's own role - a read-only step stays read-only and no
  step takes over another's work - the same layering the run `--input` applies
  (see `execution.md`), packaged as a graph node. Routing-only: it resolves
  instantly and follows its edge, creating no Kanban card and running no worker.
  The text is optional; several Prompt nodes feeding one task join in
  node-declaration order.
  ```yaml
  - id: brief
    type: prompt
    prompt: "Ship the urgent fix first; keep the change minimal."
  ```
  When a downstream agent_task's own prompt is empty the Prompt node text becomes
  the whole instruction; a run `--input`, when set, still sits above it.
- **condition** — a routing-only node; its outgoing edges carry the conditions.
- **human_review** — pauses the run; `options: [approved, rejected, needs_changes]`.
  The resolution may carry an optional operator note, consumable downstream as
  `{{nodes.<gate>.review_note}}` (see `execution.md`).
- **wait** — a worker-free wait for an external signal, polled in the engine
  tick (no Kanban card, no LLM worker). It settles `success`/`failure` and
  branches on `node_status` like any work node.
  ```yaml
  - id: merge
    type: wait
    wait_for:
      github_pr_merged: "{{nodes.open_pr.output}}"  # PR url/number, or a node ref
    timeout_seconds: 86400        # optional; failure on expiry
  ```
  Today one condition exists: `github_pr_merged` (success on MERGED, failure on
  CLOSED-not-merged, keep waiting on OPEN). See `execution.md`.
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

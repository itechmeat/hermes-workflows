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

## Inter-node inputs

An `agent_task` consumes a prior node's output through its `input_mapping`: each
entry maps a placeholder to a `{{nodes.<id>.output}}` reference, and the prompt
uses `{{placeholder}}`. The engine resolves these at the single scheduling seam
(`_schedule_node`, just before the executor runs), substituting each placeholder
with the referenced node's captured output from the run state in one pass — so
both backends behave identically and an injected output is never re-scanned for
another placeholder. A reference that cannot be satisfied on this run (an
upstream node that produced no output, e.g. an unexecuted conditional branch)
settles the node `failure` with a clear message rather than scheduling it with an
unresolved placeholder. Static checks (the source is an ancestor, the placeholder
is used) run at author time in `validateWorkflow`; this runtime path only guards
the per-run gap. Data therefore flows through the run, not a host file, keeping a
workflow exportable.

Two further per-node channels ride the same `{{nodes.<id>.…}}` grammar:
`{{nodes.<gate>.review_note}}` (a human_review gate's operator note — see the
human_review section) and `{{nodes.<id>.output.task_ids}}` (the board task ids an
upstream node surfaced in its output, extracted by their id shape) for an adopt
node's `task_ref`.

## Driving existing cards (adopt)

An `agent_task` with `adopt: true` drives EXISTING board card(s) instead of
creating one — the native Kanban flow where the work *is* the card. `task_ref`
names them: a literal id, or `{{nodes.<id>.output.task_ids}}` resolved at the
scheduling seam to the ids an upstream node chose. The executor assigns the
node's `profile` and promotes each card into the dispatch lane (assign before
promote, since assigning a `ready` card drops it to `todo`; a `triage` card takes
the native `triage -> todo` step first), then polls every driven card; the node
settles only when ALL are terminal (failure if any failed). Adopting a card that
is already running / in review or terminal is a no-op (idempotent). A resolution
or adopt error settles the node `failure` loudly, never a half-adopt.

With `review_profile`, a driven card that reaches `done` is routed once through
Hermes' native `review` status (assigned to the reviewer, claimed via
`claim_review_task`); the node then settles on the post-review outcome. The work
is the real board card throughout — no parallel workflow-owned card.

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

## Transient-error retry

A momentary provider fault (HTTP 429, "temporarily overloaded", a 5xx, a usage
limit, a connection reset) on a single `agent_task` must not abort a whole run.
Two things make this subtle on the Kanban path: the agent CLI exhausts its own
HTTP retries and then exits **0**, printing `API call failed after N retries:
HTTP 429 ...` as its final message — so the native dispatcher records the card
`done` and its own `max_retries` never fires — and the failure is only visible
once the completion is re-classified from that output, not from the exit code.

So the engine retries at the graph level. When a single-card node settles a
`transient` failure (the classifier's verdict, distinct from a `deterministic`
one) and has attempts left, the tick re-schedules it on a fresh card after an
exponential-backoff window instead of routing the failure onward. The per-node
attempt cap is the node's `max_retries` (retries, so `+1` total attempts); the
retry count and the backoff deadline persist on the node so both accumulate
across ticks. A deterministic failure — a real worker error, or an agent that
declared `node_outcome: failure` — is never retried and fails fast. Adopt nodes
(driving several cards) keep their existing stuck/blocked handling and are not
covered by this single-card retry.

A `script` node runs an operator-authored shell command, so its mitigations
(TZ §25.2) are enforced, not advisory:

- **Explicit enable.** A workflow containing script nodes runs only when
  `execution.scripts_enabled` is on (default off). Otherwise the run is refused
  — the dashboard run route returns `409`, the CLI exits non-zero — before
  anything is scheduled. Agent-only workflows are unaffected.
- **Env allowlist.** A script sees only the env vars named in
  `execution.script_env_allowlist` (comma-separated), intersected with the
  node's own `env` list — never the full process env. The allowlist is empty by
  default, so a command runs with no inherited environment: add `PATH` (and any
  of `LANG` / `CI` it needs) to the allowlist, or commands that resolve a binary
  by `PATH` will fail to find it.
- **HOME is always provided.** `HOME` (the orchestrator's own home directory) is
  passed to every script command regardless of the allowlist, because
  HOME-credential CLIs (`claude`, `codex`, `gh`, `rclone`, …) resolve their
  config and credentials from it (`~/.claude`, `~/.config`, …) — without it such
  a command fails (e.g. `claude -p` returns "Not logged in"). HOME is the home
  directory, not a secret, so this does not widen secret exposure.

> **Agent bash-tool HOME caveat.** The HOME guarantee above covers `script`
> nodes. An `agent_task` node's worker shells out through the *Hermes agent's*
> bash tool, whose environment (including `HOME`) is owned by the host, not by
> this plugin. A hermes-kind agent's bash tool may run with a non-login `HOME`
> (e.g. a per-session sandbox), so a HOME-credential CLI invoked from inside an
> agent prompt can fail to resolve credentials even though the same CLI works for
> the login user. That is a host-side contract: ensure the agent runtime exposes
> the intended `HOME`, or have the node call a wrapper that sets it. This plugin
> does not (and cannot) override the host agent's bash-tool environment.
- **Workdir and a timeout.** The command runs in its `workdir` and is killed on
  `timeout_seconds` (settling `failure`). Set a `workdir` to contain the command
  to a known directory — with none, it runs in the orchestrator's working
  directory, which is not a deterministic location.
- **Redacted, capped output.** Captured stdout/stderr is secret-redacted and
  clipped to 100,000 characters before it is persisted.

The compiled command is shown in the dashboard compile preview before a run.

## human_review

A `human_review` node is the one place a human is required. Resolution is
channel-agnostic and reachable three ways, all funneling through the same engine
validation (`approved` / `rejected` / `needs_changes`, and only while the node
is actually awaiting review):

- the `workflow_review` model tool,
- a plain chat reply in the run's origin chat — see the operator->run channel below,
- the `/workflow review <run> <node> <decision> [note]` chat slash command (CLI
  and gateway/messenger sessions),
- the CLI: `hermes-workflows review <run_id> <node_id> <decision> [--note "…"]`,
- the dashboard: `POST /api/plugins/workflows/runs/{run_id}/review`.

Each surface accepts an optional **note** — a free-text operator payload that
lands on the gate node as `review_note` and is consumable by a downstream
`agent_task` via `input_mapping: {x: "{{nodes.<gate>.review_note}}"}` (a channel
distinct from a work node's `.output`). This is how a gate feeds the operator's
choice or instructions into the rest of the run.

On entering the gate the run delivers one **ACTION NEEDED** notice to its origin
naming the gate, the allowed decisions, and how to resolve it.

### Operator→run channel (chat reply)

A run paused on a gate notifies its origin chat. The operator can resolve it by
**replying in that chat with a decision** — `approved`, `rejected`, or
`needs_changes`, optionally followed by a note that becomes
`{{nodes.<gate>.review_note}}`. A `pre_gateway_dispatch` hook
(`hermes_workflows/gate_reply.py`) intercepts the reply, routes it to the run's
gate through the same `decide_review` path, and stops the gateway agent from also
consuming it. Without this the reply would be swallowed by the normal gateway
agent in a fresh session and never reach the paused run.

The match is deterministic and language-agnostic: only the exact decision enum
tokens count (never NL guesses like "yes" or "1"), and the reply is routed only
when the origin chat has exactly one run waiting on a gate. Zero or more than one
waiting gate in the chat falls through to normal dispatch rather than guessing;
disambiguate with `/workflow review <run> <node> <decision>` or the dashboard.
Telegram inline-keyboard buttons whose callback resolves the gate are a possible
future enhancement on top of this channel (they need host support for plugin
button callbacks); the tagged-reply route here needs none.

## Wait nodes (worker-free external waits)

A `wait` node blocks the run on an external signal without spending a worker. It
parks active and the engine evaluates its `wait_for` predicate inside the
periodic tick — no Kanban card, no LLM worker — settling the node `success` /
`failure` (then it branches on `node_status` like any work node). The one
condition today is `github_pr_merged`: the tick runs `gh pr view <ref> --json
state` and settles `success` on MERGED, `failure` on CLOSED-not-merged, and
keeps waiting on OPEN; a transient `gh` error just retries next tick. The `<ref>`
is a literal PR url/number or a `{{nodes.<id>.output}}` reference resolved at
poll time. `gh` resolves its credentials from the tick process's own HOME (it
runs as the login user). An optional `timeout_seconds` settles the node `failure`
if the signal has not arrived in time.

This replaces the agent_task poll-loop stopgap (a worker per poll window) with a
zero-worker wait, so "merge the PR → release publishes" runs at no polling cost
and with no chat. A GitHub webhook that resolves the node instantly (no polling)
is the optimal form but needs an upstream Hermes event→run binding that does not
exist yet (the same wiring the chat-reply channel would use), so it is not
stubbed; the tick-poll above works today.

## Inline mode (`execution.default_mode`)

A run advances one node per tick (durable mode) unless inline mode is enabled.
`execution.default_mode` selects the behaviour: `durable` (the default) disables
the inline drain; `direct` and `auto` both enable it (they are equivalent here -
eligibility is decided per-step by the core advance, so neither forces inline on
a step that is not script-only). When enabled, the engine drains
**inline-eligible** steps synchronously within a single `run` / tick call:

- A step is inline-eligible when every node it just scheduled is a `script`
  (`condition` / `finish` already resolve in-call). The `ScriptExecutor` settles
  synchronously at schedule time, so the engine can immediately advance again.
- The drain stops when the run is terminal, enters `waiting` (review), or
  schedules a durable node (an `agent_task` / `human_review`). A
  `script → agent_task` run therefore runs the script inline, then parks the
  agent_task as a Kanban card for the durable path.
- `execution.default_mode = durable` (the default) keeps the unchanged
  one-step-per-tick behaviour.

The core advance reports inline-eligibility; the engine decides whether to act on
it from the enforced `default_mode`. A script-only run thus reaches `finish` with
no tick round-trip.

## Notifications

Notifications are channel-agnostic: a target is the run's captured **origin**
when present, else a configured default (`HERMES_WORKFLOWS_DELIVER`), else
nothing (stay silent). Origins and targets are opaque
`<platform>:<chat>[:<thread>]` strings that Hermes' native delivery interprets —
nothing branches on the platform.

**Origin capture.** A tool handler never receives the chat source (Hermes hands
it only `task_id` / `user_task`), so a `pre_gateway_dispatch` hook
(`origin_capture`) records each turn's source keyed by the gateway session key,
and `workflow_run` reads it back by `task_id` (the session key on that turn),
threading it into `run-create --origin`. A miss — dashboard, CLI, or a key
mismatch — leaves the run with no origin and delivery falls back to the default
target. A cron-started run carries the schedule's delivery target as its origin
(the trigger shim passes `--origin`). The hook also stashes the live gateway so
the Sender can reach its delivery router; it never alters dispatch.

**Two complementary delivery paths**, so the loop closes in every context:

- **Run-lifecycle notice (direct).** After each advance the engine delivers a
  single notice on the transition into `completed` / `failed` / `waiting`
  (review-needed), through a `Sender` over Hermes' `gateway/delivery.py`
  (`DeliveryTarget` + `DeliveryRouter`), to the run's origin or the default. The
  router is reachable only in-process, so this covers runs that advance under a
  live gateway (a tool-driven `workflow_run` / `workflow_review`, including
  inline runs that finish in one call). In the headless cron-tick subprocess
  there is no gateway, so the direct notice degrades to a no-op there.
- **Kanban card subscription (native notifier).** When the engine schedules an
  agent_task card on a Kanban backend it subscribes the run's origin to that
  card's terminal events via `bridge/notify` (`subscribe_task`). The gateway's
  native notifier then delivers each card's `completed` / `blocked` notice — so
  durable project runs that finish on a later cron tick (out-of-process) still
  reach the chat.

Both paths are **idempotent** — a run-lifecycle notice is recorded done at most
once per event, tracked by per-run `notified` markers persisted in `runs.db`, so
a run that stays terminal across ticks is never re-announced — and **fail-open**:
a delivery or subscription error is logged and never changes a run outcome. A
notice is marked done only when it was actually dispatched to a live target; a
headless no-op (no in-process gateway) is left unmarked so it is retried on a
later in-process advance rather than silently lost.

> A `human_review` node has no Kanban card, so the only notice for it is the
> direct run-lifecycle one. A run that parks on review purely on a headless cron
> tick therefore relies on the review surfacing on the dashboard (and the notice
> delivering on the next in-process advance); the direct notice fires
> immediately for tool-driven and inline runs.

## Observability

Three layers, all fail-open (an observability bug can suppress data, never
affect a run) and all built on the host's observer-hook contract
(`hermes.observer.v1`; the consumer also runs on earlier hosts, which simply
emit fewer fields).

**Per-node telemetry.** The plugin's `register(ctx)` registers observer
callbacks (`post_api_request`, `api_request_error`, `post_tool_call`,
`subagent_stop`, and the approval pair below) — but only inside kanban worker
processes: the dispatcher injects `HERMES_KANBAN_TASK=<card id>` into each
worker's environment, and that env var both gates registration (gateway and
interactive CLI sessions register nothing) and provides the node join — it
equals `NodeRunState.hermes_task_id`. The `task_id` kwarg the host passes to
hooks is a per-conversation UUID and is treated as opaque. The callbacks
aggregate counts (API attempts, tokens from `usage`, tool calls and errors,
subagents, the most recent structured error) into one atomic JSON sidecar per
card under `<hermes_home>/workflows/telemetry/`. The engine folds the sidecar
into `node["telemetry"]` when the node settles and consumes the file after the
save; the dashboard overlays the same file onto active nodes so the inspector's
poll shows live counts. Nodes executed without a kanban worker (DirectExecutor,
script nodes) have no join and simply carry no telemetry.

**Approval surfacing.** `pre_approval_request` marks the card's sidecar with a
pending approval (command, description, surface); `post_approval_response`
resolves it with the user's choice. The inspector shows a waiting badge and the
command text only while the node is active; a `deny` / `timeout` choice stays
in the baked telemetry so a subsequent node failure is explainable.
Observer-only by contract — the approval flow itself is untouched.

**Per-run JSONL trace.** Opt-in via `observability.trace_enabled` (default
off; `HERMES_WORKFLOWS_TRACE` env override). When on, the engine appends one
self-describing line per event (`{ts, run_id, kind, node_id?, …}`) to
`<hermes_home>/workflows/traces/<run_id>.jsonl`: `run_created`,
`node_scheduled` (with the executor handle), `node_settled` (with outcome and
`seq`), other node status transitions, `review_decided`, `run_status`, and
lifecycle `marker` events. When off there is no writer object at all — zero
trace I/O on the tick path. The Runs-view export returns the trace as a second
`<run_id>.trace.jsonl` download when present.

## Open Second Brain writes

On lifecycle transitions the engine writes long-term memory through the core
memory provider (the same `WorkflowMemoryProvider` the spec's `defaults.memory`
selects), via the `memory-event` / `memory-retro` core CLI commands — so the
retrospective markdown and the provider rules live in one place, not duplicated
in the orchestrator. See [o2b-integration.md](./o2b-integration.md) for what is
written and which settings gate it.

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

# Close the Autonomous Loop — Design

Status: implemented (PR #10) — Variant 2 as designed
Author: orchestrator (via feature-release-playbook)
Audience: implementation

## Problem statement

Three pieces of the original spec are built but not wired into the live run
path, so a run cannot fully close its loop on its own:

1. **Notifications** (TZ §, `docs/execution.md`) — `notifications.py` and the
   Kanban-notifier bridge exist, but runs never capture an `origin`, never
   subscribe a chat to a Kanban-backed node's terminal events, and never deliver
   a run-lifecycle notice (completed / failed / review-needed).
2. **Open Second Brain writes** (TZ §22.6) — the core `WorkflowMemoryProvider`
   seam and its providers (`O2BCLIProvider`, `FailOpenMemoryProvider`,
   `NoopMemoryProvider`) exist, but the orchestrator never calls them, so no
   run event or retrospective is ever written.
3. **Lightweight inline mode** (TZ §18.2) — only durable mode exists; a
   script-only run still round-trips through the tick cron instead of running
   synchronously to `finish`.

This epic wires all three to completion in one PR. The `execution.default_mode`
and `open_second_brain.*` settings — today persisted but labelled
not-yet-enforced — become enforced.

## Hermes / existing reuse (audited first)

- **Model-visible tools (§21) are already complete — out of scope.** `plugin.py`
  registers `workflow_list` / `workflow_run` / `workflow_status` /
  `workflow_explain` / `workflow_review`, delegating to `tools.py`. The earlier
  roadmap note ("model tools partial") was wrong (a grep matched only the
  `workflow_status`-named function); no work is needed here.
- **Native delivery — reuse `gateway/delivery.py`.** `DeliveryTarget.parse(target, origin)`
  parses `origin` / `local` / `<platform>[:<chat>[:<thread>]]`; `DeliveryRouter.deliver(content, targets, …)`
  performs the send. We build a thin `Sender` adapter over it, not a new delivery
  path. Origin shape is `<platform>:<chat>[:<thread>]`, exactly what
  `notifications.parse_origin` already produces.
- **Inbound origin — `gateway/session.py:SessionSource`** (`platform`, `chat_id`,
  `thread_id`, …). It reaches a plugin's `pre_gateway_dispatch` hook as
  `event.source`. **It does NOT reach tool handlers:** `registry.dispatch` calls
  `handler(args, task_id=…, user_task=…)` only (`model_tools.py`), so the
  `workflow_run` tool cannot read the chat origin directly — origin capture needs
  a `pre_gateway_dispatch` hook that records the session's source, correlated to
  the run started in that turn.
- **Kanban terminal-state notifier — reuse `bridge/notify.subscribe_completion`**
  (`kb.add_notify_sub`). The gateway's native kanban-notifier then delivers
  `completed` / `blocked` notices for a subscribed card. `notifications.subscribe_task`
  already wraps it; wire it at schedule time for human_review / terminal nodes.
- **Memory provider lives in core (TypeScript)**, invoked by shelling to the O2B
  CLI. The orchestrator is Python and drives runs via the core CLI, so memory
  writes route through a new core CLI command (`memory-event` / `memory-retro`)
  rather than a second Python O2B client — no duplicate rule set, provider stays
  in one place.
- **Cron programmatic API — `cron/jobs.py`** (`create_job(origin=…, deliver=…)`,
  `compute_next_run`). Relevant only for carrying an origin onto a scheduled run;
  the schedules page already uses the cron bridge.

## Scope

- **Notifications, fully wired.** Capture `origin` on a run (new core field +
  `run-create --origin`), populated from a `pre_gateway_dispatch` hook for
  model-started runs and from the schedule for cron-started runs. Subscribe the
  origin to Kanban-backed human_review / terminal nodes via the native notifier.
  Deliver a run-lifecycle notice on `completed` / `failed` / `waiting`
  (review-needed) through a `Sender` over `gateway/delivery.py`, to the run's
  origin or the configured default. Delivery is idempotent (once per event) and
  failure-isolated (a delivery error never wedges a run).
- **Open Second Brain writes, fully wired.** On lifecycle transitions the
  orchestrator emits `workflow_run_started` (optional), `workflow_node_failed`
  (per newly failed node), `workflow_run_completed`, and a
  `workflow_retrospective` (§22.6 markdown) via the resolved provider. The
  `open_second_brain.{mode,write_run_summaries,write_node_failures,write_node_events}`
  settings are enforced; writes are fail-open and idempotent.
- **Lightweight inline mode (§18.2), fully implemented.** A run whose next work
  is inline-eligible (only `script` / `condition` / `finish`) advances
  synchronously to `finish` in one call, with no tick round-trip; a run that
  reaches an `agent_task` / `human_review` node falls back to durable mode at
  that node. Governed by the now-enforced `execution.default_mode`
  (`durable` forces durable; `direct` / auto enables inline for eligible runs).

## Out of scope (roadmap)

- **O2B context *reads* before a run / node (§22.7)** — pulling project
  preferences, prior retrospectives, known failures. This epic does *writes*
  only; reads are a separate enhancement (the `readContext` seam already exists
  but stays unused here). Stated explicitly so it is a deliberate boundary, not
  a leftover.
- Post-MVP node types (§14) and post-MVP triggers (§13.1).
- A general run-event store / subscriber bus (Variant 3, rejected below).

## Chosen approach (Variant 2 — lifecycle effects orchestrated in the engine)

The Python engine already detects run transitions (it sets terminal status after
each `advance`) and already owns the executor seam. It is the natural place for
the I/O side-effects (delivery, memory writes) and for the inline loop, while the
TypeScript core keeps owning graph interpretation. Core gains only what it must
own: the `origin` field on the run, the inline-eligibility signal in the advance
result, and the `memory-event` / `memory-retro` CLI (because the provider is
TypeScript). Everything else is engine wiring over already-built modules.

- **Notifications.** Core: `origin?: string` on `RunState`, persisted in
  `runs.db` (new column + forward-compatible read), set by `run-create --origin`.
  Plugin: a `pre_gateway_dispatch` hook records the session source as an
  `<platform>:<chat>:<thread>` string keyed by the turn so the `workflow_run`
  tool can pass `--origin`; a `Sender` adapts `gateway/delivery.py`; the engine
  fires `notify_run` once per `completed` / `failed` / `waiting` transition
  (tracked by persisted per-run notification markers) and `subscribe_task` when a
  Kanban-backed human_review / terminal node is scheduled.
- **O2B writes.** Core: `memory-event --kind … --title … --body …` and
  `memory-retro --markdown-file …` resolve the provider from the workflow's
  `defaults.memory` (auto / open_second_brain / none) and write fail-open.
  Plugin: the engine calls them on transitions, gated by the enforced
  `open_second_brain.*` settings, idempotent per event.
- **Inline mode.** Core: the advance result reports whether the just-scheduled
  set is inline-eligible (all `script` / `condition` / `finish`). Plugin: when
  `default_mode` permits and the set is eligible, the engine keeps advancing in
  the same call (the script executor settles synchronously) until the run is
  terminal, `waiting`, or hits a durable node — then it returns and the tick
  takes over.

## Design decisions

- **Effects in the engine, not the core (Variant 2 over 1).** Delivery and memory
  writes are I/O; the engine already does all run I/O and transition detection.
  Core stays pure graph logic plus the memory provider it already owns. Pushing
  effect *payloads* through the core (Variant 1) would make core model delivery
  and memory orchestration it has no other reason to know about.
- **No run-event store / bus (Variant 3 rejected).** A subscriber bus is
  over-built for three wiring tasks and drifts toward the n8n-clone §27 forbids.
- **Origin capture via `pre_gateway_dispatch`, not the tool handler.** Tool
  handlers receive only `task_id` / `user_task`, so the hook is the only place a
  model-started run can learn its chat origin. Interactive runs capture it;
  dashboard / CLI runs have none and fall back to the configured default;
  cron-started runs carry the origin stored on the schedule.
- **Memory writes through the core CLI.** The provider is TypeScript and shells
  to O2B; routing engine writes through a core command keeps one implementation
  and one rule set, mirroring how the engine already calls the core for every
  other interpretation step.
- **Enforce, don't add, the mode / O2B settings.** `execution.default_mode` and
  `open_second_brain.*` already exist as not-yet-enforced knobs; this epic makes
  them real (no silent no-ops) and flips their `enforced` flag, which the
  Settings page reflects automatically.
- **Idempotent, fail-open effects.** A notice or memory write happens at most
  once per (run, event); a delivery / write error is swallowed (logged) so a
  side-effect never fails a run. This matches the executor's existing
  failure-isolation discipline.
- **English in the repo; operator chat in Russian.**

## Component / route map (target)

```text
packages/core/src/
  schema/run.ts                 + origin? on RunState
  runtime/db/{schema,runRepository}.ts  + origin column, persist/read
  runtime/advance.ts            + inline-eligibility of the scheduled set
  cli/commands.ts, cli.ts       + run-create --origin; memory-event; memory-retro
  memory/MemoryProvider + providers  (reused: O2B / FailOpen / Noop)
  memory/resolveProvider.ts (new)    + provider selection from defaults.memory
  memory/RedactingMemoryProvider.ts (new)  + unconditional redaction
  memory/retrospective.ts (new)      + §22.6 markdown builder (in core, not Python)

hermes_workflows/
  plugin.py                     + pre_gateway_dispatch hook (capture origin)
  origin_capture.py (new)       + session-keyed origin store + hook
  runtime.py (new)              + live-gateway handle for the Sender
  notify_sender.py (new)        + Sender over gateway/delivery.py
  engine.py                     + lifecycle effects: notify + subscribe + memory;
                                  inline advance loop honoring default_mode
  config.py                     enforce default_mode + open_second_brain.* (flags)
  notifications.py              (reused: resolve_target / parse_origin /
                                  subscribe_task / notify_run)
```

## Risks and open questions

- **Origin↔run correlation in the hook.** The `pre_gateway_dispatch` hook sees a
  session source but the run is created later inside the `workflow_run` tool
  call. Correlate by the turn / session identity available to both (the hook can
  stash the latest source per session; the tool reads it via `task_id` /
  session). If correlation is unavailable, fall back to the default target — no
  leftover, just a documented degradation. Resolve in A2.
- **Notification idempotency store.** Per-run "already notified for event X"
  markers must persist across ticks (a column or a small JSON alongside the run)
  so a run that stays terminal across ticks is not re-announced. Decide the
  storage in A1/A4.
- **Inline mode and loops.** A `script → condition → script` loop must still
  terminate inline; reuse the durable advance's loop semantics (iteration seq) so
  inline and durable agree. Covered by tests.
- **Delivery adapter construction.** `DeliveryRouter` needs the gateway config +
  platform adapters; the plugin must obtain them at runtime (in-process) and
  degrade to "no delivery" when unavailable (e.g. headless cron without a live
  gateway). The `Sender` isolates this.
- **`run_started` write timing.** Optional per §22.6; gate it so the default is
  quiet (retrospective is the high-value write).

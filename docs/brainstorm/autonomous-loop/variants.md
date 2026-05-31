# Brainstorm — Close the autonomous loop

Phase 0 of the feature-release-playbook. CLI consultants were not run this round
(same harness constraints as prior rounds); an in-process orchestrator pass
produced the variants. The orchestrator decides.

## Hermes / existing reuse audit

- **Model tools (§21) already complete** — `plugin.py` registers
  `workflow_list` / `workflow_run` / `workflow_status` / `workflow_explain` /
  `workflow_review`. Dropped from this epic; the roadmap note was a grep
  artifact (the functions are `list_workflows` etc., not `workflow_list`).
- **Delivery: `gateway/delivery.py`** — `DeliveryTarget.parse(target, origin)`
  (`origin` / `local` / `<platform>[:<chat>[:<thread>]]`) + `DeliveryRouter.deliver`.
  Reuse via a thin `Sender`; do not write a delivery path.
- **Origin: `gateway/session.py:SessionSource`**, reaching a plugin only through
  the `pre_gateway_dispatch` hook (`event.source`). Tool handlers get
  `task_id` / `user_task` only — NOT the source — so origin capture needs the
  hook, not the tool.
- **Kanban notices: `bridge/notify.subscribe_completion`** over the native
  kanban-notifier; `notifications.subscribe_task` already wraps it.
- **Memory: core `WorkflowMemoryProvider`** + `O2BCLIProvider` /
  `FailOpenMemoryProvider` / `NoopMemoryProvider` exist; the provider is
  TypeScript and shells to O2B, so the Python engine writes through a core CLI.
- **Cron: `cron/jobs.py`** (`create_job(origin=…)`, `compute_next_run`) — only
  relevant for carrying an origin onto a scheduled run.
- **`notifications.py`** (`resolve_target` / `parse_origin` / `subscribe_task` /
  `notify_run`) and the `open_second_brain.*` + `execution.default_mode`
  settings already exist; this epic wires and enforces them.

The real architectural choice is **where run-lifecycle effects (notifications,
memory writes) are produced and where the inline loop lives** — core vs the
Python engine. The node-schema, settings, delivery target parsing, and
retrospective markdown are mechanical.

## Variants (lifecycle-effect placement)

- **Variant 1 — Effects emitted by the core advance, executed by the thin Python
  layer.** `advance` returns lifecycle effects (notify targets, memory event /
  retrospective payloads) and a continue-inline signal; the engine executes them
  (delivery, memory CLI, inline re-advance). Pro: core stays the single
  interpreter of *when* to notify / write / continue. Con: core must model
  delivery + memory payloads it otherwise has no reason to know; the memory
  provider is already core but invoked from Python via CLI, so a round-trip
  either way. Complexity: medium. Risk: medium.
- **Variant 2 — Effects orchestrated in the Python engine.** The engine inspects
  transitions after each `advance` and calls `notifications` + the memory CLI +
  the inline loop; core gains only the `origin` field, an inline-eligibility
  signal, and the memory CLI. Pro: smallest, most direct change — the engine
  already detects transitions and owns the executor seam and all run I/O; reuses
  `notifications.py`, the notifier bridge, and the memory provider as-is. Con:
  lifecycle policy (when to notify / write) lives in Python, lightly splitting
  interpretation. Complexity: medium. Risk: low.
- **Variant 3 — Event-sourced lifecycle: a run-event log + subscribers.** Persist
  lifecycle events to a table; notification and memory writers are subscribers
  draining it; inline mode is a synchronous drain. Pro: decoupled, auditable,
  extensible. Con: a new event store + subscriber machinery is disproportionate
  for three wiring tasks and drifts toward the n8n clone §27 forbids; more
  surface, more failure modes. Complexity: large. Risk: medium.

## Recommended: Variant 2

Variant 2 is the proportionate choice: the engine already detects run
transitions and owns every run-side I/O concern, so delivery and memory writes
(both I/O side-effects) belong there, while the TypeScript core keeps owning
graph interpretation and the memory provider it already implements. Core changes
stay minimal and necessary — the `origin` field, the inline-eligibility signal,
and the `memory-event` / `memory-retro` CLI (the provider is TypeScript). The
inline loop is the engine advancing synchronously while the next work is
inline-eligible, reusing the existing advance + script executor. Variant 1's gain
(core owns effect timing) does not justify teaching core about delivery and
memory orchestration; Variant 3's event bus is over-engineered for this scope.

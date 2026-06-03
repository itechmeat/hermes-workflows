# Pending command-approval surfacing — variants (audit trail)

Primary consultant: Claude Code (claude -p), run 2026-06-03. Raw output: cli-output/claude.md (verbatim below). Fallback consultant not invoked (primary returned 3 parseable variants).

### Variant 1: Telemetry event-stream reuse
- **Approach**: Register the two observers in `plugin.py` and have them append new event kinds (`approval_pending`, `approval_resolved`) to the same per-task JSONL channel the sibling telemetry task establishes, keyed by `HERMES_KANBAN_TASK`. The dashboard's existing live-overlay reducer computes "currently pending" by folding the stream (a `pending` with no matching `resolved`); at node settle, the engine's telemetry aggregation bakes the terminal `choice` (deny/timeout) into `NodeRunState.telemetry` for after-the-fact context.
- **Trade-offs**:
  - Pro: no new cross-process plumbing — rides the file channel, the 2s live overlay, and the settle-time aggregation that already exist.
  - Pro: one mechanism satisfies both requirements — transient pending via live overlay, durable deny/timeout via settle aggregation.
  - Pro: fail-open and stdlib fall out of the inherited design; node join is the same `hermes_task_id` the telemetry task already correlates.
  - Con: hard-depends on the sibling task's reducer/overlay landing exactly as described; tightly coupled to its event-kind extensibility.
  - Con: pending presence is derived (fold over events) rather than explicit state — a dropped/garbled `resolved` event leaves a phantom pending until settle.
- **Complexity**: small
- **Risk**: low

### Variant 2: Dedicated presence-file marker
- **Approach**: The `pre_approval_request` observer writes a per-task marker file (e.g. `approvals/<task>.json` with command/description/surface); `post_approval_response` deletes it and appends a terminal record to the telemetry channel for persistence. The dashboard route checks marker existence to render the live "waiting for approval" annotation, independent of the telemetry settle cadence.
- **Trade-offs**:
  - Pro: pending presence is explicit and self-clearing via file lifecycle — no event-fold ambiguity.
  - Pro: decoupled from the telemetry reducer; the live annotation works even if telemetry aggregation timing shifts.
  - Con: two persistence paths (marker for pending, telemetry for terminal) — more surface, more to keep consistent.
  - Con: crash leaves a stale marker (worker dies mid-prompt) → dashboard must reconcile marker against run/node liveness to avoid a permanent phantom annotation.
  - Con: new directory + read path in the dashboard process not shared with the sibling task.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Centralized orchestrator approval index + notifications
- **Approach**: Workers emit only raw approval events; a new orchestrator-side component maintains a live approval index (`hermes_task_id` → node → pending/terminal state) that drives both the inspector annotation and threshold-based pinging through `Engine._notify` with the existing idempotency markers. Correlation, clearing, and notification logic all live in one orchestrator authority.
- **Trade-offs**:
  - Pro: single source of truth for approval state; cleanest home for the optional threshold-notification scope.
  - Pro: centralized reconciliation can detect stale/abandoned approvals against run state in one place.
  - Con: introduces new long-lived in-orchestrator state and a polling/ingest loop — largest footprint, most that can drift from worker reality.
  - Con: pulls in the optional notification scope as structural rather than additive, enlarging the core change.
  - Con: more failure modes to keep fail-open; heavier to test across the three-process boundary.
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 1
**Rationale**: The proposal already gates this work on the sibling telemetry task landing first, so reusing its event channel, live overlay, and settle-time aggregation gives transient-pending plus durable deny/timeout with essentially no new cross-process machinery — directly matching the stdlib-only, fail-open, observer-only constraints. Variant 2's separate marker path adds stale-file reconciliation for a problem the live overlay already solves, and Variant 3's centralized index is disproportionate to surfacing an annotation, better deferred until the optional threshold-notification scope is actually prioritized.

## Orchestrator decision

Variant 1 accepted, agreeing with the consultant, with one adjustment driven by the sibling task's settled design: the telemetry channel is an aggregate sidecar (not an event journal), so the approval state is a struct field updated in place — pre_approval_request sets state=pending, post_approval_response flips it to resolved. This removes the consultant's own con about deriving pending-ness from an event fold (a dropped resolve leaving a phantom pending): last write wins, and the UI additionally renders pending only for nodes still active. Variant 3's threshold notifications stay deferred as optional scope, exactly as the consultant suggested.

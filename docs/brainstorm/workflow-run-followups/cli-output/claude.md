### Q1 Variant 1: Additive `adopt` flag with free-text id parsing
- **Approach**: Add `adopt: true` plus a `task_ref` field (single id or list) to the existing agent_task node; the executor branches in `schedule` to assign-then-promote an existing card instead of calling `create_task`. Lists sourced from upstream flow through the existing `{{nodes.X.output}}` token, with ids parsed out of the free-text output.
- **Trade-offs**:
  - Pro: smallest possible schema delta; agent_task stays one node type, so `profile` routing and the poll path are reused unchanged (DRY).
  - Pro: no resolver changes; rides the existing single-pass regex.
  - Con: parsing ids from free text is brittle and violates "fail loud / no misleading fallbacks" — a reworded upstream output silently yields zero ids.
  - Con: no typed contract means the failure mode is a partial adopt, not a clear error.
- **Complexity**: small
- **Risk**: high

### Q1 Variant 2: Additive `adopt` flag with a typed `.output.task_ids` channel
- **Approach**: Same `adopt: true` + `task_ref` schema on agent_task, but extend the resolver with a second, typed channel `{{nodes.X.output.task_ids}}` that carries a structured id list emitted by upstream nodes alongside the untouched free-text `.output`. The executor adopts each resolved id (assign before promote), returns the existing id(s) as the handle, and gates completion on all driven cards reaching a terminal status.
- **Trade-offs**:
  - Pro: typed flow fails loud on a missing/empty `task_ids` channel, matching the resolver's existing fail-on-missing behavior.
  - Pro: one node type, shared poll path; the new channel is the same mechanism reused for Q2.
  - Pro: `.output` contract is untouched (additive sub-channel).
  - Con: requires upstream nodes to populate the typed channel, so it is not purely transparent.
  - Con: resolver gains a second code path to maintain.
- **Complexity**: medium
- **Risk**: low

### Q1 Variant 3: Dedicated adopt node type with an explicit structured-output contract
- **Approach**: Introduce a distinct compiled node (e.g. `adopt_task`) and a formal inter-node output contract: producing nodes declare a typed `task_ids` artifact, consuming adopt nodes bind to it by reference. The compiler validates the contract at compile time so an unsatisfiable adopt fails before any run.
- **Trade-offs**:
  - Pro: cleanest separation of create vs drive; strong compile-time guarantees.
  - Pro: contract is reusable for any future typed handoff.
  - Con: largest surface — new node type duplicates assignee routing and poll wiring unless carefully shared, risking DRY violations.
  - Con: contract layer is over-engineered for the single id-list case (KISS pushback).
  - Con: more schema and compiler churn for a one-PR batch.
- **Complexity**: large
- **Risk**: medium

### Q1 Recommended: Variant 2
**Rationale**: It satisfies the loud-failure and native-reuse constraints without the brittleness of free-text parsing or the weight of a second node type, keeping `profile` routing and the poll path shared. The typed `.output.task_ids` sub-channel is additive to the existing resolver and is the same extension Q2 needs, so the batch gets one consistent channel mechanism.

### Q2 Variant 1: Dedicated `review_note` field and single new token
- **Approach**: Store an optional free-text note on node state next to `review_decision`; `decide_review`/CLI/dashboard accept it as an optional argument. Expose it downstream via one new token `{{nodes.<gate>.review_note}}`, leaving `.output` entirely untouched.
- **Trade-offs**:
  - Pro: KISS and fully additive; zero risk to the single-channel `.output` contract.
  - Pro: minimal CLI/dashboard surface change.
  - Con: free text only — no structured "chosen option" channel the question contemplates.
  - Con: a one-off token rather than a reusable channel pattern.
- **Complexity**: small
- **Risk**: low

### Q2 Variant 2: Structured review payload with note + option sub-channels
- **Approach**: Store an additive `review_payload` object (operator note plus an optional chosen-option key) on node state, populated by `decide_review`/CLI/dashboard. Expose it via `{{nodes.<gate>.review_note}}` and `{{nodes.<gate>.review_option}}`, both new named tokens that never touch `.output`.
- **Trade-offs**:
  - Pro: covers both stated needs (free-text note and structured choice) in one additive field.
  - Pro: review_decision semantics are unchanged; payload is purely additive.
  - Con: two new tokens to document and test.
  - Con: option key shape needs a small convention to stay loud on typos.
- **Complexity**: medium
- **Risk**: low

### Q2 Variant 3: Generic named-channel resolver registry
- **Approach**: Generalize the resolver so each node publishes named output channels, with `.output` remaining the default channel for backward compatibility; review nodes register a `note` (and optional `option`) channel. Q1's `task_ids` becomes another registered channel, unifying both questions under one mechanism.
- **Trade-offs**:
  - Pro: maximally DRY across Q1 and Q2; one extension point for all future channels.
  - Pro: consistent token grammar.
  - Con: touches the core resolver contract more deeply, raising the chance of regressing the existing `.output` path.
  - Con: more design upfront than the concrete need justifies in a single PR.
- **Complexity**: medium
- **Risk**: medium

### Q2 Recommended: Variant 2
**Rationale**: It delivers exactly what the question asks — both an operator note and a structured chosen option — as a purely additive payload that never alters the existing `.output` contract or `review_decision` meaning. It reuses the same per-node named-token style introduced for Q1 without committing the batch to a full channel-registry refactor.

### Q3 Variant 1: Pretty serializer (block scalars + comment round-trip)
- **Approach**: Replace the canonical emitter so multiline strings serialize as `prompt: |` block scalars and authored comments survive a round-trip via a comment-preserving YAML representation. The on-disk file stays the rewrite target but becomes human-friendly.
- **Trade-offs**:
  - Pro: keeps the single on-disk source of truth; no storage model change.
  - Pro: directly improves hand-editability.
  - Con: comment round-tripping in YAML is notoriously fragile and lossy; high chance of subtle reordering or drop.
  - Con: still mutates the author's file on every run start.
- **Complexity**: medium
- **Risk**: medium

### Q3 Variant 2: Authored spec read-only, canonical form internal/DB
- **Approach**: Treat the on-disk YAML as read-only source of truth; parse it on run start and hold the canonical normalized form in the run's persisted state/DB only, never writing back to the author's file. The dashboard, as the primary authoring surface, edits through this internal form.
- **Trade-offs**:
  - Pro: eliminates the destructive rewrite entirely — the most correct fix.
  - Pro: clean separation: file = source, DB = working form; aligns with the editor-foundation goal.
  - Pro: avoids fragile comment/block-scalar serialization work.
  - Con: requires a guarantee that no code path writes the file; needs an audit.
  - Con: file and dashboard can drift if both are edited (needs a re-import story).
- **Complexity**: medium
- **Risk**: medium

### Q3 Variant 3: Document the behavior only
- **Approach**: Leave serialization as-is and document that starting a run canonicalizes the spec, advising authors to keep their source elsewhere or author via the dashboard.
- **Trade-offs**:
  - Pro: trivial; zero code risk.
  - Con: does not solve the stated pain; hand-editing remains hostile.
  - Con: pushes the problem onto users.
- **Complexity**: small
- **Risk**: low

### Q3 Recommended: Variant 2
**Rationale**: Not overwriting the author's file is both the most correct fix and, in spirit, simpler than teaching the serializer reliable block-scalar plus comment round-tripping, which YAML tooling handles poorly. It directly matches the stated editor-foundation direction where the dashboard is the primary authoring surface and the file is read-only source.

### Q4 Variant 1: Reuse `waiting` with a structured reason + tick-driven notify
- **Approach**: The tick detects blocked/stalled underlying cards, transitions the run to the existing `waiting` state carrying an additive structured `attention_reason` (blocked card id + cause), and notifies the operator through the Hermes delivery router. `status` reports persisted state labeled as-of-last-tick with a `last_polled_at` timestamp.
- **Trade-offs**:
  - Pro: no new run state — `waiting` already means "run cannot proceed without external input," extended only by an additive reason field.
  - Pro: notification reuses the native delivery router; detection reuses the existing tick.
  - Pro: honest freshness via an explicit as-of timestamp; no card I/O on every `status` call.
  - Con: `status` still lags between ticks (no live read).
  - Con: overloading `waiting` requires consumers to read the reason to distinguish review-wait from blocked-wait.
- **Complexity**: medium
- **Risk**: low

### Q4 Variant 2: Derived health overlay + opportunistic live read-only status
- **Approach**: Persist no new run state; compute a "needs attention" health overlay at read time, and have `status` opportunistically read underlying card state read-only to surface blocked cards live. The stored run states stay exactly as they are.
- **Trade-offs**:
  - Pro: zero schema/state change; `status` is always fresh.
  - Pro: no risk of diverging run-state semantics.
  - Con: a derived overlay alone does not pause the run or notify anyone — gap (a)'s "move to needs-attention and notify" is unmet unless the tick still acts.
  - Con: per-call live card reads add I/O and a new read path to keep read-only.
- **Complexity**: medium
- **Risk**: medium

### Q4 Variant 3: New persisted `needs_attention` run sub-state with operator resume
- **Approach**: Add an explicit additive run state (e.g. `needs_attention`/`paused`); the tick transitions the run into it on a blocked/stalled card, notifies via the delivery router, and requires an explicit operator action to resume or fail.
- **Trade-offs**:
  - Pro: most explicit and discoverable; unambiguous separation from review-wait.
  - Pro: clear operator-driven resume semantics.
  - Con: adds a run state, enlarging the state machine and every consumer/switch that handles run states.
  - Con: closest to diverging from the existing state set the constraint cautions against.
- **Complexity**: large
- **Risk**: medium

### Q4 Recommended: Variant 1
**Rationale**: Reusing `waiting` with an additive structured reason keeps the run-state set unchanged while letting the native tick and delivery router do detection and notification, satisfying both gap (a) and the "no parallel mechanism / additive only" constraints. Labeling `status` as-of-last-tick with an explicit timestamp is the honest, KISS answer to freshness and avoids making every `status` call do live card I/O.

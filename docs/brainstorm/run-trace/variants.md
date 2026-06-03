# Per-run JSONL trace — variants (audit trail)

Primary consultant: Claude Code (claude -p), run 2026-06-03. Raw output: cli-output/claude.md (verbatim below). Fallback consultant not invoked (primary returned 3 parseable variants).

### Variant 1: Centralized post-hoc tracer in `_advance_step`
- **Approach**: Add a single `_emit_trace(prior_run, decision, run, completions)` call at the end of `Engine._advance_step`, mirroring the existing `_emit_lifecycle`/`_emit_memory` siblings. It derives the timeline by diffing the prior run snapshot against the post-decision run (node status transitions with `seq`/iteration, `schedule`, `run_status`) and reads completions and review/notification outcomes straight from data already in scope, then appends one JSONL line per derived event. A module-level `enabled` flag guards the whole call so a disabled run never touches the trace path.
- **Trade-offs**:
  - Pro: One insertion point, one new method — matches the established fail-open emit idiom exactly, so reviewers and future maintainers recognize the shape.
  - Pro: Zero-I/O-when-disabled is trivially satisfied by a single early-return guard; the tick path is untouched by default.
  - Pro: All required events (transitions, schedule, poll outcomes, review, notifications) are computable from `prior_run`/`completions`/`decision` without re-querying anything.
  - Con: Events are reconstructed by diffing rather than captured at the moment they occur, so fine intra-tick ordering is synthesized by the emit order rather than observed.
  - Con: Correlating per-node observer telemetry (sibling task) means re-reading `NodeRunState.telemetry` at settle time inside the tracer, not a natural live hand-off.
- **Complexity**: small
- **Risk**: low

### Variant 2: Threaded `Tracer` observer with call-site instrumentation
- **Approach**: Introduce a `Tracer` object (a no-op `NullTracer` when disabled) held on the engine or constructed per tick, and sprinkle `tracer.event(kind, run_id, node_id, payload)` calls at each natural site — completion poll, advance decision, `_schedule_node`, `_emit_lifecycle`, `_emit_memory`. This most directly mirrors the `nemo_relay` consumer pattern: an opt-in observer injected at construction that writes local JSONL and fails open. Each call site emits its own semantically precise event in true execution order.
- **Trade-offs**:
  - Pro: Events are captured where they happen, giving accurate ordering and the richest payloads (e.g. the actual poll outcome at the poll site, the notification result at the notify site).
  - Pro: Cleanest seam for the sibling observer-telemetry task to feed correlated API/tool spans through the same `Tracer` instance.
  - Pro: Faithful to the reference consumer pattern (opt-in observer, no outbound network, fails open when absent).
  - Con: Many call sites change, increasing diff surface and the chance instrumentation drifts out of sync as the engine evolves.
  - Con: Zero-I/O-when-disabled relies on every `NullTracer` method being a cheap no-op and the threading being free; more places to get the guard wrong than a single gate.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Unified event bus with trace as one sink
- **Approach**: Refactor `_emit_lifecycle`, `_emit_memory`, and tracing into a single per-tick event-emission pass that produces a canonical event stream, with notifications, memory writes, and the JSONL trace as independent subscribers/sinks. The trace sink simply serializes every event; the lifecycle and memory sinks filter for the events they care about. Tracing on/off becomes "is the trace sink registered," and the existing `notified` idempotency logic moves into the bus.
- **Trade-offs**:
  - Pro: Single source of truth for "what happened this tick"; lifecycle, memory, and trace can never disagree about transitions.
  - Pro: Future sinks (metrics, external observers) attach without touching the tick path.
  - Pro: The trace becomes a byproduct of effects the engine already emits, so coverage is inherently complete.
  - Con: Largest blast radius — it rewrites two working, idempotency-sensitive subsystems to deliver a feature that is supposed to be additive and opt-in.
  - Con: Higher regression risk to notifications/memory, the opposite of the "must not affect run advancement" constraint.
  - Con: Over-engineered relative to the stated scope; the bus only pays off if many sinks materialize.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 1
**Rationale**: It satisfies every hard constraint with the smallest, most idiomatic change — a single guarded `_emit_trace` sibling that returns immediately when disabled (true zero tick-path I/O by default) and swallows write failures exactly like `_emit_lifecycle`/`_emit_memory` already do. All required events are derivable from state already in scope at `_advance_step`, and the export wiring is a thin read of `traces/<run_id>.jsonl`. The `Tracer` seam from Variant 2 can be adopted incrementally later if the observer-telemetry correlation demands live call-site capture, without paying Variant 3's refactor risk now.

## Orchestrator decision

Variant 1 accepted, agreeing with the consultant. Two bounded additions beyond the strict single-call-site shape, both anticipated by the consultant's own caveats: a run_created emit in Engine.run and a review_decided emit in Engine.decide_review, because both facts are invisible to a prior-vs-post diff inside _advance_step (the review decision is already recorded on the loaded snapshot). The Tracer seam from variant 2 is preserved in spirit: the writer is injected into the engine, so call-site capture can be adopted later without changing the module contract.

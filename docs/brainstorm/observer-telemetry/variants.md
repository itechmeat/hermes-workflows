# Per-node observer telemetry — variants (audit trail)

Primary consultant: Claude Code (claude -p), run 2026-06-03. Raw output: cli-output/claude.md (verbatim below). Fallback consultant not invoked (primary returned 3 parseable variants).

### Variant 1: Worker-side aggregate sidecars, engine merges at tick
- **Approach**: Observer hooks run inside the kanban worker and accumulate per-node counters in process memory keyed by `HERMES_KANBAN_TASK` (the card id = `NodeRunState.hermes_task_id`). On each API/tool/subagent event the worker atomically rewrites one small aggregate JSON per node (tmp + `os.replace`, the existing `executor/store.py` pattern) into a telemetry directory. `_advance_step` reads the sidecar for each node and folds a `telemetry` object into `NodeRunState` before saving the run via the core CLI.
- **Trade-offs**:
  - Pro: reuses the proven atomic-sidecar idiom; stdlib-only; zero new dependencies.
  - Pro: only the orchestrator writes runs.db, so TS core stays the sole DB owner — additive schema change is contained.
  - Pro: incremental flushes mean the 2s inspector poll shows live token/tool counts before the node finishes.
  - Pro: fail-open is trivial — a missing/corrupt sidecar just yields absent telemetry; DirectExecutor nodes write nothing and load fine.
  - Con: aggregation logic lives in the worker; raw events are discarded, so future v1 fields not aggregated today are lost.
  - Con: another file class to garbage-collect alongside completion files.
- **Complexity**: small
- **Risk**: low

### Variant 2: Append-only raw event journal, deferred join in core CLI
- **Approach**: Hooks append one sanitized line per event (api/tool/subagent/approval) to a per-worker JSONL journal, fail-open, with the env card id stamped on every line. A new core CLI subcommand (or an engine pass) performs the correlation join — group events by card id → node — and computes aggregates, writing the `telemetry` object into run state. Raw events are retained for replay and forward-compatibility.
- **Trade-offs**:
  - Pro: forward-compatible — when the v1 contract enriches kwargs (status/error_type, meaningful `task_id`), re-aggregation needs no worker change.
  - Pro: keeps the worker callbacks dumbest-possible (just append), honoring "keep callbacks fast."
  - Pro: replayable/auditable; the join is a pure function that is easy to unit-test in isolation.
  - Con: more I/O and a parsing/aggregation stage that doesn't exist yet — larger surface.
  - Con: journals grow during long runs and need rotation/truncation; liveness requires the aggregation pass to run on each tick anyway.
  - Con: join location (TS core vs Python engine) is an extra decision that splits logic across the language boundary.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Worker writes telemetry rows directly to runs.db
- **Approach**: Worker hooks open runs.db via stdlib `sqlite3` and upsert telemetry rows into a dedicated table keyed by card id; the inspector/engine join card id → node at read time. Telemetry reaches the DB without waiting for an orchestrator tick.
- **Trade-offs**:
  - Pro: lowest latency to the inspector — no tick or merge step.
  - Pro: no sidecar/journal files to manage or clean up.
  - Con: couples the stdlib-only Python worker to a TS-owned schema, breaking the "TS core is sole runs.db owner" boundary and the "zero I/O outside workers is fine, but DB writes from workers" caution.
  - Con: many concurrent workers plus the engine's frequent full-run saves contend on a single SQLite file — lock/`BUSY` risk that can stall or, if mishandled, threaten run state integrity (violates fail-open intent).
  - Con: schema migrations must now stay in lockstep across two languages and two writers.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 1
**Rationale**: It maps directly onto patterns the codebase already trusts — atomic JSON sidecars from `executor/store.py`, fail-open side effects, and the engine saving the full run each tick — so it ships small with low risk and no new dependencies. It preserves the critical invariant that only TS core writes runs.db, keeps the `NodeRunState` change cleanly additive, and exploits the existing 2s inspector poll for live telemetry without the contention or cross-language coupling that sinks Variant 3. If forward-compatibility with richer v1 fields later becomes a priority, the worker's in-memory aggregation can be swapped for the Variant 2 journal behind the same sidecar interface.

## Orchestrator decision

Variant 1 accepted, agreeing with the consultant. One integration adjustment from project context: the approval-surfacing sibling task stores its pending/resolved approval state as a field inside the same per-task sidecar (rather than a separate event channel), which removes the fold-over-events ambiguity that task's consultant flagged. The variant 2 raw-event journal was rejected because the trace task already provides an append-only timeline at the orchestrator level; keeping aggregates worker-side avoids a second aggregation stage.

# Variants — event-driven workflow advance

Consultant: Claude (`claude-opus-4-8`), prompt at
`docs/brainstorm/event-driven-advance/cli-output/prompt.md`, raw output at
`docs/brainstorm/event-driven-advance/cli-output/claude.md`. Single successful
attempt (no retry needed — 3 distinct variants + clear recommendation).

---

## Variant 1: Event-triggered detached advance (reuse the cron shim, fired by the hook)

- **Approach:** The plugin registers a `kanban_task_completed`/`kanban_task_blocked`
  observer that loads in the worker subprocess. The observer does one cheap task
  lookup to read `workflow_template_id`/`current_step_key`; if the card belongs to a
  run, it spawns a **detached, reparented** invocation of the existing shim scoped to
  that run (`advance --run <id>`, falling back to `advance-all`) and returns
  immediately. The advance cycle therefore runs in a fresh gateway-side process that
  outlives the worker, and schedules the next node's card through the normal
  dispatcher path.
- **Trade-offs:**
  - Reuses the exact idempotent ingest→advance→schedule→persist cycle the cron already
    calls — no second runtime, no new logic in the hot path.
  - Clean across the process boundary: fire-and-forget, no long-lived scheduler inside
    the short-lived worker, no in-worker reentrancy (board writes happen in the
    detached process via the dispatcher's normal flow).
  - Crash-safe by construction: completion is already committed before the hook fires,
    so a worker that dies before spawning is recovered by the residual tick — no lost
    transition.
  - Spawn cost (Bun cold start, ~hundreds of ms) is trivial against the 2-minute
    floor, but near-simultaneous parallel-node completions can produce a small spawn
    burst; a short debounce/coalesce window and single-flight-per-workflow keep it
    from racing on `runs.db` (WAL + raised `busy_timeout` already cover concurrent
    writers).
  - `wait` nodes are untouched by card events, so a residual tick must remain —
    naturally satisfied by keeping the existing `sync_workflow_tick` lifecycle as the
    wait-poll + safety net at a coarser, configurable cadence.
- **Complexity:** small
- **Risk:** low

## Variant 2: Durable wake-outbox drained by a gateway-resident listener

- **Approach:** The worker hook performs only a cheap durable write — it enqueues a
  "wake" intent keyed by `run_id` (an outbox row in `runs.db` or a spool file), then
  exits. A long-lived gateway-side listener (a daemon thread in the plugin's gateway
  load, woken via filesystem watch / named pipe / socket rather than a clock) drains
  the outbox and runs the idempotent advance cycle once per coalesced batch.
- **Trade-offs:**
  - Strong delivery semantics: the intent is durable before the worker can crash, and
    many completions collapse into one drain — natural coalescing, no spawn storms.
  - Decouples producer (ephemeral worker) from consumer (gateway), so the worker does
    almost no work and there is no per-event subprocess cost.
  - Introduces a new long-lived component and its own wake mechanism — effectively a
    second runtime to supervise, start/stop, and reason about, which cuts against
    KISS and the "reuse the tick lifecycle, don't build a second engine" guidance.
  - Teardown is harder: the listener must idle correctly at zero active runs to
    preserve "no busy-polling," and a watch/socket adds failure modes (missed inotify
    events, stale sockets) that the cron model does not have.
  - `wait` nodes still need a timed poll; the listener can host it, but that further
    grows the bespoke daemon's responsibilities.
- **Complexity:** medium
- **Risk:** medium

## Variant 3: In-process scoped advance inside the worker hook

- **Approach:** The worker hook calls the idempotent advance cycle **directly
  in-process** via `cli_bridge`, scoped to the completing run: read the run/node,
  advance, persist to `runs.db`, and create the next node's card before the worker
  exits. No subprocess, no queue — lowest possible latency.
- **Trade-offs:**
  - Fastest path (no cold-start, no drain hop) and reuses the same pure `advance`.
  - Fragile against the worker lifecycle: the worker may be reaped immediately after
    `kanban_complete`, truncating a mid-flight advance and leaving the run wedged
    between persisting and scheduling — the one place idempotency does not save you,
    because the next process never runs.
  - Reentrancy hazard: scheduling the next card writes to the same board the worker
    just wrote, which the dispatcher can re-observe on its next tick; correctness now
    depends on careful single-flight and idempotency-key discipline inside a process
    that is trying to exit.
  - Couples the full workflow engine into every worker session, inflating worker load
    and blast radius — a slow or throwing advance now lives on the critical path of
    every completion despite the hook contract treating observers as fire-and-forget.
  - `wait` nodes are still uncovered, so a residual tick is needed regardless, meaning
    this adds risk without removing the poll.
- **Complexity:** medium
- **Risk:** high

---

### Recommended: Variant 1

It is the only option that gets near-instant advancement while reusing the existing
idempotent cycle and the existing tick lifecycle verbatim, rather than building a
second runtime (Variant 2) or moving the engine onto the fragile worker-exit path
(Variant 3). The detached spawn respects every process-boundary fact — the worker does
a trivial lookup and returns, the real work runs gateway-side and survives the worker,
and crash safety plus the `wait`-node gap are both covered by retaining the current
`sync_workflow_tick` as a coarse, configurable safety/poll net (which also preserves
"no busy-polling at zero runs"). With the event path handling card transitions, the
residual interval can be relaxed to a documented default and the
sub-minute-poll/configurable-interval asks collapse into a simple configurable
debounce.

---

## Decision

**Accepted Variant 1** as recommended. Rationale:

- It is the only variant that does not require building a second supervised runtime
  (Variant 2's gateway listener) and does not put a non-idempotent mid-flight advance
  on the worker-exit critical path (Variant 3). Both of those are exactly the
  constraints the project's "no second engine" / "no dirty hooks" rules forbid.
- It reuses the existing `Engine.advance` idempotent cycle and the existing
  `write_shim` / `sync_workflow_tick` machinery verbatim — the new surface is one CLI
  subcommand (`advance-run`) and one observer module, both small.
- Crash-safety falls out for free: the hook fires post-commit, so the residual tick is
  a correct fallback, not a workaround. This also covers the `wait`-node gap without
  extra design.
- The only refinement over the consultant's literal phrasing (`advance --run <id>`):
  the actual Python CLI exposes `advance-all` only, so the implementation adds a
  dedicated `advance-run <run_id>` subcommand (a thin wrapper around the already
  per-run `Engine.advance(spec_path, run_id)`) rather than a flag. This is a naming
  detail, captured in design.md "Design decisions" and plan.md.

Open question carried into design.md Risks: whether the worker subprocess loads a
`standalone` plugin and fires its hooks. Phase 1 must confirm this with a smoke test;
the fallback (dispatcher-side `kanban_task_claimed` or a board-scan in the residual
tick) keeps the chosen variant viable either way.

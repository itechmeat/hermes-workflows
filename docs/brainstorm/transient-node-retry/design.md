# TRANSIENT-NODE-RETRY — design

Scope: a single release fixing `t_26c092d3` — a transient provider HTTP 429 on
one `agent_task` node aborts the whole release run because engine-level node
retry never engages on the Kanban (project-scope) path. Slug:
`transient-node-retry`. Branch: `feat/transient-node-retry`. Bug-fix release;
per the project's established convention (v0.7.6 shipped a behavior addition as a
patch, not the minor its plan proposed) this is a **patch** bump 0.7.6 → 0.7.7.

## Problem

`t_b30e4db8` (shipped v0.7.6) added a transient-error classifier
(`executor/outcome.py`) and a bounded node-level retry — but only on the
**direct/global** path, inside `_detached_runner`. The **Kanban/project** path,
which every real release run uses, still aborts on a single 429:

1. The gateway's native dispatcher spawns a worker (`hermes -p <profile>`). The
   agent CLI exhausts its own internal HTTP retries on a 429 and then **exits 0**,
   printing `API call failed after N retries: HTTP 429 …` as its final message.
2. The dispatcher sees exit 0, records the card `done`/`completed`; its own
   `max_retries` (native card column) never fires — from its view the worker
   succeeded.
3. `bridge/kanban.read_completion` re-classifies the exit-0 summary and correctly
   returns `kind="transient"` — but `KanbanExecutor.poll` **drops `kind`** when it
   builds its `Completion`, so the engine only sees `outcome="failure"`.
4. The engine settles the node failure and routes to `notify_failure` → `aborted`.

Observed live: `hermes-workflows-feature-release` run `…fbd99081` died on the
first read-only node `inventory` this way (opencode-go 429), exactly as the two
`osb-feature-release` runs on 2026-06-26 recorded in the card.

## Fix

Complete the v0.7.6 promise on the Kanban path — no new provider calls, purely
folding the existing classifier verdict into the engine's settle/retry loop:

1. **Carry the verdict.** `Completion` gains a `kind` field; `KanbanExecutor.poll`
   passes `read_completion`'s `kind` through (Composite already forwards the
   sub-Completion unchanged). Direct/Script default `kind="success"` so they never
   trigger an engine retry (the direct path already retries internally).
2. **Engine-level retry with backoff.** When a single-card `agent_task` node
   settles a `kind="transient"` failure and has attempts left, the engine records
   an incremented `transient_retries` and a `retry_after` backoff deadline, drops
   the settled handle, and re-schedules a fresh card (distinct idempotency
   iteration) once the window elapses — instead of settling failure. The per-node
   cap is the node's `max_retries` (retries → +1 total attempts); backoff timing
   comes from the engine `RetryPolicy` (exponential, capped). Deterministic
   failures and multi-card adopt nodes are untouched (fail fast / existing
   stuck-handling).
3. **Durable state.** `transient_retries` / `retry_after` persist on
   `workflow_node_runs` (two TEXT columns, auto-migrated like `adopt_blocked_since`)
   so the count and backoff survive the per-tick reload.
4. **Classifier completeness.** Add the card's listed `usage limit` sentinel to
   the transient patterns (429 / 5xx / overloaded / connection-reset already
   present).

## Acceptance (TDD)

- A Kanban `agent_task` whose worker surfaces a 429 on a clean exit is classified
  transient and the engine re-schedules the node (up to `max_retries`) with
  backoff, rather than settling failure on attempt 1.
- After retries exhaust on a still-transient error, the node settles failure and
  routes per spec — a single blip with `max_retries >= 1` no longer aborts.
- Regression: `inventory` returns a 429-shaped failure once, then succeeds on the
  retry → the run proceeds to `lock-scope`.
- A deterministic (non-transient) failure is never retried.

## Out of scope

Terminal-quota (HTTP 402) fail-fast classification (a sibling concern noted in
the card's comment) — a separate change, kept out to hold one coherent scope.

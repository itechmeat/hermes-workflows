# Consultant prompt — event-driven workflow advance

You are a senior platform engineer advising the maintainer of **Hermes Workflows**, a
dashboard plugin for Hermes Agent. Produce architectural options for replacing the
current ~2-minute polled advance with event-driven (near-instant) run advancement.
Think carefully about cross-process mechanics, correctness, and operational safety.
**No code.** Variants + recommendation only.

---

## Project at a glance

- **Name:** Hermes Workflows (`hermes-workflows` plugin), v0.5.1.
- **Languages / runtimes:** TypeScript core on **Bun** (`packages/core`) — owns schema,
  validation, compiler, the **pure `advance` decision**, and run-state persistence
  (`runs.db`, SQLite/WAL). A thin **Python bridge** (`hermes_workflows/`) loads
  in-process inside the Hermes gateway, drives the core via a `cli_bridge`, and does
  Kanban / Cron / Profiles I/O through `bridge/*.py`. There is no separate engine —
  every node compiles to a native Hermes primitive (Kanban card, Cron job, Profile).
- **Execution model:** each advance tick (a) ingests completions for active nodes via
  the execution backend, (b) calls the pure `advance` core, (c) schedules newly-ready
  nodes, (d) persists run to `runs.db`. The backend is chosen by scope: a project run
  uses durable Kanban cards on the project board; a global run invokes the profile
  runner directly (no card). **Worker spawning is NOT the plugin's job** — the Hermes
  gateway hosts an embedded dispatcher that ticks every board on disk and spawns
  workers for ready cards.
- **Current advancement** is a transient **cron tick**: a single named singleton job
  `hermes-workflows-tick` runs the shim `exec hermes-workflows advance-all` on schedule
  `DEFAULT_TICK_SCHEDULE = "every 2m"`. The tick is created while active runs exist and
  torn down when none remain (`sync_workflow_tick(active=…)`), so tick jobs never
  accumulate. `advance` is pure and idempotent (a repeated tick never duplicates work;
  native `idempotency_key` protects card creation; loop edges re-run nodes on a fresh
  card keyed by iteration).
- **Gate:** full quality gate is `bun run validate` = typecheck → lint → core test →
  pytest → dashboard typecheck/test/build/check. Python tests via `python3 -m pytest`.

## The problem (both in-scope cards describe the same defect)

A multi-node run waits **up to ~2 minutes per node transition** because advancing is
polled on the 2-minute cron tick. A 3–4 node run takes ~10–12 min wall-clock even
though the actual compute per node is seconds. Operators perceive the engine as slow.

Sub-minute cadence (~10s) is NOT reachable through the current mechanism: the schedule
is a hardcoded constant in plugin code, AND Hermes cron has minute granularity (gateway
evaluates cron ~once a minute; cron syntax cannot express seconds). So this is a
plugin change, not a per-workflow YAML or cron-schedule edit.

### Acceptance (operator-stated)
- A simple multi-node run advances node-to-node in **seconds, not minutes**, while
  runs are active.
- **No busy-polling when zero runs are active** (lifecycle teardown preserved).
- Cadence/interval is **configurable** with a sane documented default.

## KEY ENABLER (newly available): native kanban lifecycle hooks (#50349, merged)

The installed Hermes main now fires plugin hooks on kanban state transitions, AFTER
the write txn commits (so the hook always sees durable state and a slow plugin never
holds the SQLite write lock; observers only, return values ignored, exceptions
swallowed so a misbehaving observer can never break a transition):

- `kanban_task_claimed` — fired by the **DISPATCHER process** (gateway-embedded
  dispatcher), right before the worker subprocess spawns. Kwargs: `task_id`, `board`,
  `assignee`, `run_id`, `profile_name`.
- `kanban_task_completed` — fired by the **WORKER process** (a `hermes -p <profile>
  chat -q` subprocess) when it calls `kanban_complete`. Kwargs: `task_id`, `board`,
  `assignee`, `run_id`, `summary`, `profile_name`.
- `kanban_task_blocked` — fired by the **WORKER process** (worker-initiated block).
  Kwargs: `task_id`, `board`, `assignee`, `run_id`, `reason`, `profile_name`.

CRITICAL PROCESS-BOUNDARY FACTS you must design around:
1. `kanban_task_completed`/`kanban_task_blocked` fire **inside the worker subprocess,
   not the gateway.** The plugin also loads in that worker session. A callback there
   can run local code, but it is a short-lived process that exits when the worker
   finishes. It cannot hold a long-lived scheduler, and in-process calls back into the
   same board it just wrote can re-enter via the dispatcher on the next tick.
2. The hook payload carries `task_id` but **NOT the workflow columns**
   (`workflow_template_id`, `current_step_key`) — those live on the `tasks` row and
   must be read with a task lookup to decide whether a completed card belongs to a
   workflow run. (Both columns exist on the `tasks` table.)
3. A card → run mapping requires going from the Hermes `task_id` (the card) back to a
   workflow run + node. The plugin's `runs.db` stores `hermes_task_id` /
   `driven_task_ids` / `task_ids_json` per node-run row, and the card itself carries
   `current_step_key` (the node id) + `workflow_template_id`.

## The pure `advance` decision (already implemented, do not redesign)

`advance(workflow, runState)` returns `{ run_status, finish_outcome?, schedule[],
waiting[], node_updates{}, inline_eligible }`. It is pure and idempotent. The Python
`tick()` / `advance_all(spec_roots)` already wraps the full per-run cycle (ingest
completions → advance → schedule → persist) and is what the cron shim calls today. Any
event-driven variant must reuse this same idempotent cycle, not bypass it.

## Additional context

- A prior reviewer note on the older card: **if event-driven advance (the preferred
  ask) lands, per-workflow polling intervals become largely moot** and a configurable
  sub-minute poll interval can be scoped down to "configurable debounce" or dropped.
  Keep this in mind when weighing the three asks (event-driven vs sub-minute poll vs
  configurable interval) — they partially substitute for each other.
- The `wait` node type is intentionally worker-free: the tick polls its `wait_for`
  predicate each tick. Event-driven card completion does not cover `wait` nodes —
  consider whether a residual tick / poll is still needed for them and how to keep it
  from regressing the "no busy-polling" acceptance point.
- Engineering rules: SOLID / KISS / DRY; no misleading fallbacks; no hardcoding;
  English-only strings (abstract multi-language). Prefer reusing the existing
  idempotent advance cycle and the existing tick lifecycle machinery over building
  a second runtime.

## Git log (recent)
```
36ddadd fix(adopt): dependency-ordered driving + skip un-completable umbrella cards (#25)
d4eab9f chore(release): v0.5.0 - template-param instantiation + adopt blocked-card time-box
1f53beb feat: workflow params instantiation + adopt blocked-card time-box (#24)
67415da feat: 0.4.0 - Prompt node, editor operator-input, off-board nodes (#23)
fc425eb chore(release): v0.3.0 - date the changelog, reset build counter to b1
383805f feat: 0.3.0 - operator control, authorable branches, run resilience (#22)
3c189d7 feat: Kanban-native runs, chat gates, worker-free wait (v0.2.0) (#21)
f37485c feat: native Hermes alignment for Workflows after Automation Blueprints (#20)
```

---

## YOUR OUTPUT FORMAT (exactly this, nothing else)

Produce **exactly 3 distinct architectural variants**, then **exactly one**
recommendation. Each variant must be a genuinely different mechanism, not a dressed-up
copy. Be concrete about HOW the worker-side hook reaches the advance machinery given
the process-boundary facts above (subprocess spawn? gateway HTTP/API? shared
file/queue? in-process?). Then weigh correctness (idempotency, no double-advance, no
lost events on worker crash), operational safety (busy-polling, resource teardown,
reentrancy), and the `wait`-node gap.

For each variant:

### Variant N: <name>
- **Approach:** 2–3 sentences.
- **Trade-offs:** bullets.
- **Complexity:** small | medium | large
- **Risk:** low | medium | high

Then exactly:

### Recommended: Variant N
<2–4 sentence rationale>

Do not output code, file lists, acceptance criteria, or anything outside the three
variants + the single recommendation.

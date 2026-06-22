# Implementation plan — event-driven advance

**Branch:** `feat/event-driven-advance` (shared by both in-scope cards — drive them
ONE AT A TIME on this branch; each worker must `git pull`/be git-aware and build on the
commits the previously-driven card already landed. Do not duplicate or conflict with
sibling tasks.)
**Combined design:** `docs/brainstorm/event-driven-advance/design.md`
**TDD:** every step below has an Acceptance line that is a passing test before the step
is considered done.

Both cards describe the same defect and ship together in this release. Drive
`t_c6a45c03` (the native-hook variant — the preferred solution) FIRST; its landing
makes `t_9cdf56de`'s event-driven ask true. `t_9cdf56de`'s "configurable interval" ask
is delivered by the shared `workflows.tick_schedule` knob; its supersession by
`t_c6a45c03` should be recorded (kanban comment / supersede link) when the second card
is driven.

**Overall release scope (ships together):**

- `t_c6a45c03` — Event-driven advance via native kanban lifecycle hooks (#50349): worker-side `kanban_task_completed`/`kanban_task_blocked` observers spawn a detached scoped `advance-run`, reusing the idempotent advance cycle; tick becomes safety-net + wait-poll.
- `t_9cdf56de` — Sub-minute / event-driven workflow advancer (replace 2m cron tick): the same event-driven path satisfies this card's ask #1; its ask #3 (configurable cadence) is delivered by exposing `workflows.tick_schedule`.

---

## Task: `t_c6a45c03` — Event-driven advance via native kanban lifecycle hooks (#50349)

### Files
- `hermes_workflows/hooks.py` (new) — `register(engine_cls_or_factory)` + the
  `_on_task_event(task_id, board, **fields)` observer: task lookup on `board` →
  workflow-card check (`workflow_template_id`/`current_step_key`) → resolve owning
  `run_id` from `runs.db` (`hermes_task_id`/`driven_task_ids`/`task_ids_json`) →
  per-run debounce check → detached spawn of the `advance-run <run_id>` shim.
  Best-effort throughout; never raises into the completion path.
- `hermes_workflows/__init__.py` — register `kanban_task_completed` and
  `kanban_task_blocked` hooks via the plugin manager's `register_hook`, delegating to
  `hooks.py`. Ensure registration happens in whatever process loads the plugin
  (gateway AND worker).
- `hermes_workflows/cli.py` — new `advance-run <run_id>` subcommand
  (`_advance_run(engine, run_id)`) wrapping `Engine.advance_run(run_id)`.
- `hermes_workflows/engine.py` — add `advance_run(run_id)`: resolve the spec path from
  the persisted run record (same enumeration `advance_all` uses), then call
  `self.advance(spec_path, run_id)`.
- `hermes_workflows/bridge/cron.py` — `write_shim("hermes-workflows-advance-run",
  "advance-run", run_id_placeholder)` helper for the detached shim, OR a single
  parameterised shim; mirror the existing tick-shim pattern.
- `hermes_workflows/config.py` — `event_debounce_seconds()` (small default, e.g. 2.0).
- `tests/python/test_advance_run_cli.py` (new).
- `tests/python/test_lifecycle_hooks.py` (new).
- `tests/python/test_advance_debounce.py` (new) — debounce/single-flight under a
  parallel-node completion burst.

### Acceptance
- `tests/python/test_advance_run_cli.py` passes: `advance-run <run_id>` advances
  exactly one run (others untouched), is idempotent on a second call, and errors
  cleanly (non-zero, message) on an unknown run id — no traceback.
- `tests/python/test_lifecycle_hooks.py` passes: a `kanban_task_completed` event for a
  **non-workflow** card spawns nothing; for a **workflow** card it spawns exactly one
  detached `advance-run` (spawn mocked/intercepted); a lookup error raises nothing and
  spawns nothing. Same shape for `kanban_task_blocked`.
- `tests/python/test_advance_debounce.py` passes: N near-simultaneous completions of
  cards on the same run within the debounce window produce at most one spawn; a later
  completion after the window produces another.
- `bun run validate` is green (typecheck + lint + core test + pytest + dashboard
  gate).

### Depends on
- Confirm the worker process actually loads the plugin and fires the hook (open
  question in design.md Risks). Add a one-line smoke assert in the lifecycle-hook test
  that the hook is registered in a worker-equivalent plugin load. If workers do NOT
  load standalone plugins, switch the observer to the dispatcher-side
  `kanban_task_claimed` hook OR fall back to a board-scan in the residual tick, and
  record the decision in the card comment.

---

## Task: `t_9cdf56de` — Sub-minute / event-driven workflow advancer (configurable cadence + supersession)

Drives the **configurable cadence** ask and records the supersession. The
event-driven ask itself is satisfied by `t_c6a45c03` (already landed on this branch by
the time this card is driven), so this card's work is the cadence knob + docs +
the explicit supersede record — it builds directly on `t_c6a45c03`'s commits.

### Files
- `hermes_workflows/config.py` — `tick_schedule()` reader: prefer
  `workflows.tick_schedule` from `config.yaml`, fallback `"every 2m"`.
- `hermes_workflows/bridge/cron.py` — `ensure_workflow_tick(schedule=…)` /
  `ensure_tick(schedule=…)` default `schedule` becomes `config.tick_schedule()`; keep
  all lifecycle behavior (`sync_workflow_tick` active/idle, teardown) identical.
- `hermes_workflows/__init__.py` / engine startup — pass `config.tick_schedule()` into
  the tick-sync call sites instead of the module constant (keep the constant as the
  fallback default for tests).
- `~/.hermes/config.yaml` (host, documented only — do not hardcode a value) — document
  the new `workflows.tick_schedule` key with the default in a comment.
- `docs/architecture.md` — "Execution model": note advancement is event-driven, with
  the tick as a configurable safety-net + `wait`-node poll.
- `README.md` — "Why" self-advancing-runs bullet updated.
- `CHANGELOG.md` — `### Changed` (configurable tick schedule) + cross-reference the
  event-driven `### Added` from `t_c6a45c03`.
- `tests/python/test_tick_schedule_config.py` (new).
- Card `t_9cdf56de` — record the supersession (kanban comment pointing at
  `t_c6a45c03`'s implementation) per the adopt/supersede convention.

### Acceptance
- `tests/python/test_tick_schedule_config.py` passes: `config.tick_schedule()` returns
  the default `"every 2m"` when unset, and a configured value when `workflows.tick_schedule`
  is set in config. `sync_workflow_tick(active=False)` still tears the tick down;
  `active=True` still ensures it exists with the configured schedule.
- A multi-node run advances node-to-node in **seconds** (event-driven path from
  `t_c6a45c03`) while runs are active, verified by an end-to-end test or a documented
  manual repro.
- No busy-polling at zero active runs (tick teardown preserved) — covered by the
  existing tick-lifecycle tests, which must stay green.
- `bun run validate` is green.
- The card body / a kanban comment records that `t_9cdf56de` is superseded by
  `t_c6a45c03` for the event-driven ask; the configurable-interval ask is delivered
  here.

### Depends on
- `t_c6a45c03` landed on the branch (the event-driven path). Read its commits first
  and reuse the `advance-run` / config plumbing it introduced — do not duplicate.

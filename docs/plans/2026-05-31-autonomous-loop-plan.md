# Close the Autonomous Loop — Implementation Plan

Status: implemented (PR #10). This document is the implementation plan that was
followed; all tasks A1-D1 shipped.

One PR closes all three wiring gaps in TZ point 1 (notifications, O2B writes,
lightweight inline mode); model-visible tools (§21) are already complete and out
of scope. TDD throughout: core uses `bun test`; the plugin uses pytest (route /
cron / kanban tests guarded with `importorskip`, run in the Hermes runtime
venv); frontend uses Vitest. After each task the relevant `validate` stays green
(oxlint zero warnings; committed bundle matches). Each task is one atomic
conventional commit on `feat/autonomous-loop`. The mode / O2B settings become
enforced, not cosmetic.

## A — Notifications

### Task A1: Core — `origin` on the run
- `schema/run.ts`: add `origin?: string` to `RunState`. `runtime/db/{schema,runRepository}.ts`:
  add an `origin` column (forward-compatible: a missing column / null reads as
  absent). `cli/commands.ts` + `cli.ts`: `run-create --origin <s>` persists it;
  `run-load` returns it. Also persist per-run notification markers (a `notified`
  JSON/text column or a small per-run set) so lifecycle notices stay once-only.
- **Acceptance**: `bun test` — a run created with `--origin telegram:1:2` round-trips
  through save/load; a run without origin loads with origin absent; a notified
  marker set on one tick is still present on reload.
- **Depends on**: none.

### Task A2: Plugin — capture origin via `pre_gateway_dispatch`
- `plugin.py`: register a `pre_gateway_dispatch` hook that records the current
  `SessionSource` as `<platform>:<chat>[:<thread>]`, correlated to the session /
  turn, and returns `None` (never alters dispatch). `_handle_run` reads the
  captured origin and threads it into `run-create --origin`. Falls back cleanly
  to no origin when none was captured (dashboard / CLI / headless).
- **Acceptance**: pytest — the hook turns a stub `event.source` into the right
  origin string and never changes the dispatch result; `workflow_run` started in
  a turn with a captured source creates a run carrying that origin; with no
  source, the run has no origin.
- **Depends on**: A1.

### Task A3: Plugin — `Sender` over Hermes delivery
- `notify_sender.py`: a `Sender` (`(target, message) -> None`) that parses the
  target via `gateway.delivery.DeliveryTarget` and delivers via `DeliveryRouter`,
  resolving the router from the in-process gateway; failure-isolated (logs, never
  raises) and a no-op when delivery is unavailable (headless).
- **Acceptance**: pytest — a valid target delivers through a stubbed router; an
  unavailable router / bad target is swallowed (no raise); the target string is
  parsed for `origin` / `local` / `<platform>:<chat>:<thread>`.
- **Depends on**: none (parallel with A1/A2).

### Task A4: Engine — fire lifecycle notices + Kanban subscribe
- `engine.py`: after `advance`, on a transition into `completed` / `failed` /
  `waiting` (review-needed) not already announced, call `notifications.notify_run`
  via the `Sender` to `origin || default` and record the marker (A1). When a
  Kanban-backed `human_review` / terminal node is scheduled, call
  `notifications.subscribe_task` with the run origin (native notifier). All
  effects fail-open.
- **Acceptance**: pytest — a run reaching completed delivers exactly one notice;
  a second advance on the still-completed run delivers none; a failed run notifies
  `failed`; a run entering review notifies `waiting` and subscribes the card; a
  delivery error does not change the run outcome.
- **Depends on**: A1, A3.

## B — Open Second Brain writes

### Task B1: Core — memory-event / memory-retro CLI
- `cli/commands.ts` + `cli.ts`: `memory-event --kind <run_started|node_failed|run_completed> --title --body`
  and `memory-retro --markdown-file <p>` resolve the provider from a spec's
  `defaults.memory` (auto / open_second_brain / none) and write fail-open via the
  existing `WorkflowMemoryProvider` (reuse `FailOpenMemoryProvider` +
  `O2BCLIProvider` / `NoopMemoryProvider`). `none` / unavailable → silent no-op.
- **Acceptance**: `bun test` — `memory-event`/`memory-retro` route to the provider
  selected by `defaults.memory.provider`; `none` writes nothing; a provider error
  is swallowed (exit 0, no write claimed).
- **Depends on**: none.

### Task B2: Core — retrospective markdown builder
- `memory/…` (or a small `retrospective` module): build the §22.6 markdown
  (title, project, result, started/finished, What happened / Decisions / Problems
  / Useful signals / Follow-up) from run data (status, node outcomes, outputs).
  Pure, unit-tested.
- **Acceptance**: `bun test` — a completed run renders a retrospective with the
  result and per-node outcomes; a failed run surfaces the failing node under
  Problems.
- **Depends on**: none.

### Task B3: Engine — emit memory on lifecycle, enforce settings
- `engine.py`: on transitions call the memory CLI — `run_started` (only when
  enabled), `node_failed` per newly failed node (`write_node_failures`),
  `run_completed` + `memory-retro` (`write_run_summaries`) — gated by the now-
  enforced `open_second_brain.{mode,write_run_summaries,write_node_failures,write_node_events}`
  settings; idempotent per (run, event) via the A1 markers; fail-open.
- **Acceptance**: pytest — a completed run writes one `run_completed` + one
  retrospective; with `write_run_summaries=false` it writes neither; a failed
  node writes one `node_failed`; re-advancing writes nothing new; `mode=none`
  writes nothing.
- **Depends on**: A1 (markers), B1, B2.

## C — Lightweight inline mode (§18.2)

### Task C1: Core — inline-eligibility signal
- `runtime/advance.ts`: the advance result reports whether the set it just
  scheduled is inline-eligible (every scheduled node is `script`; `condition` /
  `finish` resolve in-call already). `agent_task` / `human_review` make it
  ineligible. Pure.
- **Acceptance**: `bun test` — a script-only step is inline-eligible; a step that
  schedules an agent_task is not; a mixed tick reports not-eligible.
- **Depends on**: none.

### Task C2: Engine — inline advance loop honoring default_mode
- `engine.py`: when `execution.default_mode` permits inline (`direct`, or auto for
  eligible runs) and the advance reports inline-eligible, keep advancing in the
  same `run` / tick call (the script executor settles synchronously) until the run
  is terminal, `waiting`, or schedules a durable node — then return and let the
  tick continue durably. `durable` forces one-step-per-tick behaviour unchanged.
- **Acceptance**: pytest — a global script-only workflow reaches `completed` in a
  single `run()` call with no tick; a `script → condition → finish` graph
  completes inline; a `script → agent_task` graph runs the script inline then
  parks the agent_task durably; `default_mode=durable` disables the inline loop.
- **Depends on**: C1.

### Task C3: Enforce default_mode + O2B settings flags
- `config.py`: flip `enforced: true` for `execution.default_mode` and the
  `open_second_brain.*` knobs now honoured (A4/B3/C2). Update the dashboard
  settings test that asserts which knobs are enforced.
- **Acceptance**: pytest (settings schema) + Vitest (settings page) — the now-
  enforced knobs report `enforced: true`; the still-unenforced ones are unchanged.
- **Depends on**: A4, B3, C2.

## D — Docs, build, CHANGELOG

### Task D1: Docs + bundle + CHANGELOG
- `docs/execution.md` (inline mode, notifications wiring incl. origin capture +
  delivery, O2B writes + enforced settings), `docs/dashboard.md` /
  `docs/o2b-integration.md` as affected, README, and a CHANGELOG entry under the
  existing 0.1.0 header (no bump). Rebuild + commit `dashboard/dist` if any
  frontend changed (settings labels follow the `enforced` flags automatically).
- **Acceptance**: `bun run validate` green incl. the committed-bundle guard; the
  full pytest suite green in the Hermes runtime venv.
- **Depends on**: A1–C3.

## Verification (phase 4 QA)
- Core green (origin round-trip, inline-eligibility, memory CLI routing,
  retrospective builder).
- Plugin pytest green in the runtime venv (origin-capture hook, Sender, lifecycle
  notices once-only, Kanban subscribe, memory writes gated + idempotent, inline
  loop + durable fallback).
- Frontend typecheck, lint, vitest, build green; committed bundle matches.
- Smoke: a script-only global run finishes inline and (with O2B on) writes one
  retrospective; a project run delivers a completion notice to its origin.

## Notes
- Operator gate: implementation begins only on explicit go-ahead.
- Version stays 0.1.0 until the operator bumps it. No auto-merge armed.
- Reuse, not reinvent: delivery via `gateway/delivery.py`, Kanban notices via the
  native notifier, memory via the existing core provider through a CLI shim.
- O2B context *reads* (§22.7) are explicitly out of scope (writes only).

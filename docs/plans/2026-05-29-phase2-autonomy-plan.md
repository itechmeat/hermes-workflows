# Phase 2 — Autonomous Execution Implementation Plan

> Implement task-by-task off the `hermes-workflows` Kanban board. TDD inside each
> card (red -> green), keep `bun run validate` at zero warnings. Reference spec:
> `docs/specs/2026-05-29-phase2-autonomy-design.md`.

**Goal:** Autonomous execution with two backends — project-scoped (durable Kanban
cards on the project board) and global (direct profile-runner invocation, no
cards) — driven by a self-terminating advance+dispatch tick.

**Where code lives:** the executor seam and orchestration are **Python**
(`hermes_workflows/`), since both backends touch Hermes (Kanban bridge; profile
runner subprocess). The TypeScript core stays pure (the `advance` decision and
run-state persistence are unchanged).

**Build order:** P1 -> P2 -> P3 -> P4 -> P5 -> P6 -> P7 -> P8.

---

## P1 — Executor seam

### P1.1 NodeExecutor protocol + scope selection
**Objective:** Define `NodeExecutor` (schedule/poll) and a `select_executor(scope)`
factory.
**Files:** `hermes_workflows/executor/__init__.py`, `executor/base.py`,
`tests/python/test_executor_select.py`.
**Acceptance:** project scope -> KanbanExecutor; global -> DirectExecutor;
unknown scope raises.
**Deps:** none.

### P1.2 KanbanExecutor
**Objective:** Move the engine's Kanban calls behind `KanbanExecutor` (create card,
poll completion) using the existing `bridge/kanban`.
**Files:** `hermes_workflows/executor/kanban_executor.py`, `tests/python/test_kanban_executor.py`.
**Acceptance:** schedule creates a stamped idempotent card on a temp board; poll
maps `task_runs.outcome` -> success/failure; re-poll before completion -> not settled.
**Deps:** P1.1.

### P1.3 DirectExecutor
**Objective:** Run a global node by invoking the profile runner
(`~/.hermes/bin/agents/<profile>`) with the prompt, capturing stdout, with a
timeout; poll returns the captured result.
**Files:** `hermes_workflows/executor/direct_executor.py`, `tests/python/test_direct_executor.py`.
**Acceptance:** with a fake runner script echoing stdout, schedule runs it and poll
returns settled+success+output; a non-zero runner -> failure; a missing runner ->
clear error; runner timeout -> failure.
**Deps:** P1.1.

---

## P2 — Orchestrator routing

### P2.1 Scope-based routing in advance
**Objective:** `engine.advance` schedules and ingests through the executor selected
by workflow scope, replacing the inline Kanban calls.
**Files:** `hermes_workflows/engine.py`, `tests/python/test_engine.py` (extend).
**Acceptance:** existing project e2e still passes via KanbanExecutor; a global
workflow drives plan->...->finish via DirectExecutor (runner stub), no cards created.
**Deps:** P1.2, P1.3.

---

## P3 — Tick = advance + dispatch

### P3.1 advance-all
**Objective:** Advance every active run in one pass.
**Files:** `hermes_workflows/engine.py` (`advance_all`), `tests/python/test_advance_all.py`.
**Acceptance:** two active runs both advance; terminal runs are skipped.
**Deps:** P2.1.

### P3.2 Dispatch pass + self-terminating tick
**Objective:** After advancing, run a `hermes kanban dispatch` pass on each project
board with active cards; manage the singleton tick via `bridge/cron.sync_tick`
(ensure while active runs exist, teardown when none).
**Files:** `hermes_workflows/engine.py`, `hermes_workflows/bridge/kanban.py`
(dispatch wrapper), `tests/python/test_tick_dispatch.py`.
**Acceptance:** dispatch pass invoked for boards with ready cards (injected runner);
tick ensured when active, torn down when drained.
**Deps:** P3.1, existing `bridge/cron`.

---

## P4 — Command + cron wiring

### P4.1 `hermes-workflows` entrypoint
**Objective:** In-repo wrapper (`bin/hermes-workflows`, optionally symlinked at
`~/.hermes/bin/hermes-workflows`) exposing `run`, `advance-all`, `status`,
`review`; delegates to the Python orchestrator.
**Files:** `bin/hermes-workflows` (in-repo; optional symlink on install, else resolved in place),
`hermes_workflows/cli.py`, `tests/python/test_py_cli.py`.
**Acceptance:** `status <run>` and `advance-all` run through the wrapper on a temp HOME.
**Deps:** P3.1.

### P4.2 Cron trigger uses the command
**Objective:** A `cron` trigger compiles to a Hermes Cron job invoking
`hermes-workflows run <id>`; the tick invokes `hermes-workflows advance-all`.
**Files:** `hermes_workflows/bridge/cron.py` (script target), `tests/python/test_cron_bridge.py` (extend).
**Acceptance:** trigger/tick jobs created with the wrapper as the script target.
**Deps:** P4.1.

---

## P5 — Board model

### P5.1 Per-project board resolve + auto-ensure
**Objective:** Resolve the bound project's board from workflow scope (project slug
via the platform registry), auto-ensure it exists; global scope -> no board.
**Files:** `hermes_workflows/bridge/boards.py`, `tests/python/test_boards.py`.
**Acceptance:** project scope resolves+creates a board on a temp HOME; global -> None.
**Deps:** P1.2.

---

## P6 — Notifications (channel-agnostic)

### P6.1 Native delivery wiring
**Objective:** Subscribe origin for Kanban-backed human_review/completion via
`bridge/notify`; for run lifecycle use native delivery keyed by `origin`, falling
back to a configured default `deliver`. No Telegram hardcoding.
**Files:** `hermes_workflows/notifications.py`, `hermes_workflows/config.py` (deliver
default), `tests/python/test_notifications.py`.
**Acceptance:** origin present -> delivered to origin; absent -> default deliver;
no platform-specific literals.
**Deps:** P2.1.

---

## P7 — human_review resolution

### P7.1 resolveReview + wrappers
**Objective:** Channel-agnostic review resolution: core resolve (engine), CLI
`review`, model tool `workflow_review`, optional dashboard write route + button.
**Files:** `hermes_workflows/engine.py` (reuse `decide_review`), `hermes_workflows/tools.py`
(+`workflow_review`), `hermes_workflows/plugin.py` (register tool), `dashboard/plugin_api.py`
(+POST review), `tests/python/test_review.py`.
**Acceptance:** resolving approved advances the run; invalid decision rejected; the
tool/CLI both resolve.
**Deps:** P2.1.

---

## P8 — Verification, docs, limits

### P8.1 End-to-end both backends + tick
**Objective:** Live-style e2e for project-durable and global-direct, plus the tick.
**Files:** `tests/python/test_e2e_phase2.py`.
**Acceptance:** both backends reach `completed`; tick advances+dispatches and
self-terminates.
**Deps:** P3.2, P5.1, P6.1, P7.1.

### P8.2 Docs + limits
**Objective:** Update `docs/architecture.md` + add `docs/execution.md`; document the
DirectExecutor timeout/size caps; note `kind: hermes` global limitation.
**Files:** `docs/architecture.md`, `docs/execution.md`, `README.md`.
**Acceptance:** docs read as a new product; `bun run validate` green repo-wide.
**Deps:** all.

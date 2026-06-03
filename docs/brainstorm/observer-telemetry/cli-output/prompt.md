You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Per-node agent telemetry via hermes.observer.v1 hooks (host PR #38232).

**Source:** hermes-agent PR #38232 (merged 2026-06-03) — the host platform now ships a stable, read-only observer telemetry contract (`telemetry_schema_version = "hermes.observer.v1"`): session/turn/API/tool/approval/subagent lifecycle hooks with correlation IDs, sanitized payloads, timing, status, and error fields.

**Problem:** `NodeRunState` (packages/core/src/schema/run.ts) carries only `status` / `outcome` / `output` / `error`. A workflow run gives no visibility into what the agent actually did inside an `agent_task` node — no duration, no token usage, no API/tool call counts, no structured error type. The run inspector shows a status pill and the final output text, nothing else.

**Proposal:** register observer hooks in `hermes_workflows/plugin.py` (`register(ctx)` already exists and registers `pre_gateway_dispatch`) and correlate events to workflow nodes. Aggregate per node: wall-clock duration, total tokens (from `usage`), API attempt count, tool call count + per-status breakdown, structured error on failure, subagent count. Persist aggregates next to the run state (runs.db) and extend `NodeRunState` with an optional `telemetry` object — additive, backward-compatible. Surface in the dashboard: RunInspector node detail and a per-run total in the Runs view.

**Contract rules:** callbacks accept `**kwargs`; fail-open (a telemetry bug must never break a run); keep callbacks fast; register only consumed hooks; treat correlation IDs as opaque.

**Acceptance:** a completed project-scoped run shows per-node duration, token usage, and tool-call count in the run inspector; a failed agent_task node shows structured error info; a node executed by DirectExecutor (global scope) still completes with telemetry simply absent — no crash, no stall; unit tests for the correlation join and the fail-open path.

# Project context

Hermes Workflows: visual workflow orchestration plugin for Hermes Agent. TypeScript core engine on Bun (packages/core: schema, validation, pure advance engine, SQLite runs.db persistence via RunRepository), thin Python orchestrator (hermes_workflows/: Engine combines core CLI + Kanban I/O, loaded in-process by Hermes as a plugin), React 19 dashboard (apps/dashboard, built bundle in dashboard/).

Recent commits:
b06cf6a feat(dashboard): UI overhaul — plugin header, hash routing, shared component kit (#13)
7a4b3cb refactor: clean up workflow runtime backends (#12)
706261c fix(memory): write Open Second Brain notes via the real o2b CLI contract (#11)
84dbd6f feat: close the autonomous loop (notifications, Open Second Brain writes, inline mode) (#10)
eb8af6e feat: script node (deterministic shell-command step) (#9)

Related files:
- hermes_workflows/plugin.py — register(ctx), already registers pre_gateway_dispatch hook
- hermes_workflows/engine.py — _advance_step: polls executor completions, applies advance decision, saves run via core CLI
- hermes_workflows/executor/kanban_executor.py — nodes run as Kanban cards; NodeRunState.hermes_task_id is the card id
- packages/core/src/schema/run.ts — NodeRunState (additive field target)
- packages/core/src/runtime/db/{schema.ts,connection.ts,runRepository.ts} — runs.db; migrate() already does idempotent ALTERs
- dashboard/plugin_api.py — GET /runs/{id} (inspector polls every 2s)
- apps/dashboard/src/run/RunInspector.tsx — node detail panel

Verified host facts (installed hermes-agent v0.15.1, editable at /home/developer/hermes-agent — OLDER than the v1 contract but already fires these hooks):
- Plugin hooks fire in EVERY hermes process that loads plugins, including kanban worker subprocesses (`hermes -p <profile> chat -q …`) spawned by the dispatcher.
- The dispatcher injects `HERMES_KANBAN_TASK=<card id>` (and HERMES_KANBAN_BOARD) into the worker's process env. The `task_id` kwarg in tool/api hooks is a per-conversation UUID, NOT the kanban card id, in this version. So the only reliable node join today is the worker env var; the v1 contract may later make kwargs task_id meaningful.
- post_api_request kwargs: task_id, session_id, model, provider, api_call_count, api_duration (float s), finish_reason, usage ({input_tokens, output_tokens}), assistant_tool_call_count, …
- post_tool_call kwargs: tool_name, args, result, task_id, session_id, tool_call_id, duration_ms. No status/error_type yet (v1 adds them; read via kwargs.get).
- subagent_stop kwargs: parent_session_id, child_role, child_summary, child_status, duration_ms.
- invoke_hook is fail-open (per-callback try/except); no has_hook() in this version; unknown hook names warn but register.
- Worker process ≠ orchestrator tick process ≠ gateway dashboard process. Telemetry produced in workers must cross process boundaries to reach runs.db and the inspector.

Conventions:
- Python bridge is stdlib-only (pyproject: dependencies = []). TS core is pure; Python orchestrates out-of-process via the core CLI.
- Executors persist completions via small atomic JSON files (executor/store.py pattern: write tmp + os.replace).
- Fail-open everywhere on side effects (notifications, memory writes) — printed to stderr, never failing a run.
- runs.db is the source of truth for run state; the engine saves the full run each tick.

Constraints:
- No new external dependencies (Python stdlib, existing Bun APIs only).
- NodeRunState extension must be additive and backward-compatible (old runs load fine).
- Observer callbacks must be cheap and fail-open; zero I/O in processes that are not kanban workers.
- Do not change Hermes host behavior; observer-only.
- The run inspector polls GET /runs/{id} every 2s while a run is active — live-ness of telemetry display can exploit that.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.

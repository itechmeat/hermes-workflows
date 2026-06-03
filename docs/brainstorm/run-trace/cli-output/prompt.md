You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Per-run JSONL trace + export-logs integration (nemo_relay consumer pattern).

**Source:** hermes-agent PR #38232 — the bundled `nemo_relay` plugin demonstrates the reference consumer pattern: an opt-in observer that writes local trace files, no outbound network, fails open when its optional dependency is absent.

**Problem:** the Runs view has an export-logs action, but a run's history is reconstructed from run state snapshots — there is no append-only timeline of what happened when. Debugging a multi-tick run (why a node was re-entered by a loop edge, when a review stalled, how long a node sat scheduled before the worker picked it up) requires correlating runs.db state with Hermes gateway logs by hand.

**Proposal:** an opt-in per-run trace writer in the Python orchestrator:
- One JSONL file per run (e.g. `<store_dir>/traces/<run_id>.jsonl`), append-only.
- Events: run created/status transitions, node status transitions with `seq` and iteration, executor schedule/poll outcomes, review decisions, notification emissions — plus correlated observer events (API/tool spans per node) when the telemetry task lands.
- Each line carries `run_id`, `node_id` (when applicable), monotonic timestamp, event kind, and a compact payload.
- Wire into the existing export-logs action in the Runs view: export returns the trace file when present, falls back to the current behavior otherwise.
- Opt-in via config (`config.py`), off by default; writer failures are logged and swallowed (fail-open).

**Acceptance:** with tracing enabled, a full run (trigger → agent_task → condition → finish) produces a readable JSONL timeline covering every node transition; export-logs in the Runs view downloads the trace for a traced run; with tracing disabled (default), no trace I/O happens on the tick path; a write failure (read-only dir) does not affect run advancement.

# Project context

Hermes Workflows: visual workflow orchestration plugin for Hermes Agent. TypeScript core engine on Bun (packages/core: pure advance engine + SQLite runs.db), thin Python orchestrator (hermes_workflows/Engine: each tick polls executor completions, asks the core for an advance decision, applies node updates, schedules new nodes, emits lifecycle notifications and memory writes, saves the run), React 19 dashboard.

The engine tick (`Engine._advance_step` in hermes_workflows/engine.py) is the single place where every transition is visible: prior run state, completions ingested, the advance decision (node_updates, schedule, waiting, run_status), and the saved result. Lifecycle effects (notifications `_emit_lifecycle`, O2B memory `_emit_memory`) already follow a fail-open emit pattern with idempotency markers persisted on the run (`notified` list).

Settings: `config.py` exposes SETTINGS_SCHEMA (groups/fields with enforced flags) rendered by the dashboard Settings page; values resolve config ▸ env ▸ default via the Hermes config `plugins.workflows` namespace. Adding a field automatically surfaces it in Settings.

Export-logs today: GET /runs/{run_id}/export in dashboard/plugin_api.py returns `{run_id, filename: "<run_id>.run.json", json: <full run state>}`; the Runs page downloads it as a file.

A sibling task (same PR) adds per-node observer telemetry: kanban worker processes append observer events (API/tool spans) to per-task JSONL files keyed by the kanban card id, and the engine aggregates them into `NodeRunState.telemetry` at settle time.

Conventions:
- Python bridge is stdlib-only. Fail-open on all side effects (print to stderr, never fail a run).
- Executors persist small atomic JSON files (write tmp + os.replace); telemetry uses O_APPEND JSONL.
- Storage lives under `<hermes_home>/workflows/` (runs.db, runs/, direct/, scripts/).

Constraints:
- No new external dependencies.
- Zero trace I/O on the tick path when disabled (the default).
- A write failure must not affect run advancement.
- One JSONL file per run, append-only; lines must be self-describing (run_id, node_id when applicable, timestamp, event kind, compact payload).
- The export envelope must remain JSON (the host fetchJSON channel is JSON-only).
- Keep the trace writer in the Python orchestrator (the TS core stays pure).

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

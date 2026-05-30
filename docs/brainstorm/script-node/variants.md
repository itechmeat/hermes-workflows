# Brainstorm — Script node

Phase 0 of the feature-release-playbook. CLI consultants were not run this round
(same harness constraints as prior rounds); an in-process orchestrator pass
produced the variants. The orchestrator decides.

## Hermes / existing reuse audit

- **No Hermes Kanban no-agent task execution.** `no_agent` is a *cron-job* mode
  (script-only watchdog jobs; `tools/cronjob_tools.py`, `cron/scheduler.py`) —
  it runs a script on a schedule, not as a workflow step, and there is no Kanban
  task type that runs a deterministic command instead of an LLM worker. A script
  node therefore runs as a **local command in the plugin**, matching TZ §16
  ("local runner or Hermes no-agent/script mode *if available*" — it is not).
- **`cron/scheduler._run_job_script`** shows the canonical subprocess pattern
  (`subprocess.run(capture_output, timeout, cwd, env)` + redact) but is private /
  cron-internal — not a reusable API. The plugin's own `DirectExecutor` already
  embodies the same pattern (subprocess + timeout + capped output + file-backed
  durable completion); reuse it.
- **Secret redaction exists** — Hermes `agent/redact.py:redact_sensitive_text`
  and the plugin core `redactSecrets`. Reuse one (§25.1) rather than duplicate.
- **Settings, conditions, run-store all exist** — the `execution` settings group,
  the `node_status` edge condition, and node `output`/`error` fields already
  ship, so the enable gate, branching, and output all reuse existing surfaces
  with no new condition type and no run-schema change.

Only **how the script node plugs into the executor seam / execution model** is a
real architectural choice; the node schema, validation, inspector, and security
mitigations are mechanical.

## Variants (script execution wiring)

- **Variant 1 — Composite executor keyed on node kind.** The compiler tags each
  compiled work unit with `kind` (`agent` / `script`) and emits a `script_steps`
  list; the engine wraps the scope executor + a `ScriptExecutor` in a
  `CompositeExecutor` that routes `schedule` by kind and `poll` by handle prefix.
  Pro: smallest change to the durable advance loop (untouched); script runs the
  same in any scope; mixed agent+script graphs work uniformly; reuses the
  `DirectExecutor` store. Con: a poll-by-handle-prefix convention to keep
  disjoint. Complexity: medium. Risk: low.
- **Variant 2 — Per-node-type branching inside the engine.** Make the engine
  type-aware: it reads each node's type and calls the `ScriptExecutor` for script
  nodes and the scope executor for agent_task, persisting an executor tag on the
  node run so `poll` routes correctly. Pro: no handle-prefix convention. Con:
  rewrites the advance loop's single-executor assumption (schedule + poll +
  ingest), more surface to get wrong; the engine learns node types it currently
  ignores. Complexity: medium-large. Risk: medium.
- **Variant 3 — Lightweight inline mode (§18.2).** For script-only workflows, run
  synchronously at `run`/advance time: execute script → eval condition → next,
  until finish, with no tick/Kanban round-trip. Pro: lowest latency for
  script-only flows; matches §18.2 literally. Con: a *second* execution path to
  maintain alongside durable mode; does not cover mixed agent+script graphs
  (which still need durable mode); easy to drift from the durable semantics.
  Complexity: large. Risk: medium.

## Recommended: Variant 1

Variant 1 is the proportionate choice: it adds script execution as a peer on the
existing executor seam without re-architecting the advance loop, runs scripts
identically across global and project scope, and handles mixed agent+script
graphs — the common case — uniformly. It reuses the `DirectExecutor` file-backed
completion store, so durability comes for free. Variant 2's gain (no handle
prefix) does not justify rewriting the schedule/poll/ingest loop. Variant 3's
inline mode is a worthwhile *latency* optimization for script-only workflows and
is recorded as the fallback, but durable mode already executes script nodes
correctly, so it is deferred rather than built first.

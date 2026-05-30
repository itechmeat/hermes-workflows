You are a backend architecture consultant brainstorming ARCHITECTURAL VARIANTS for one epic. Do NOT write code, do NOT write a final design. Output exactly 3 variants and one recommendation.

# Task (Script node in the Hermes Workflows engine)

Add a `script` node type: a deterministic shell command (lint / tests / build),
run with no LLM, as a step inside a workflow graph. It is the last unbuilt MVP
node type (TZ §13.3). Fields: `command` (required), `workdir`, `timeout_seconds`,
optional env allowlist.

Already exists (audited):
- A pure TypeScript core (`packages/core`, Bun) owns the spec: schema, validation,
  the `compileToHermesPlan` preview, and the `advance` engine. The Python bridge
  (`hermes_workflows/`) drives runs.
- The engine selects ONE executor per run by workflow scope (`select_executor`:
  global → `DirectExecutor`, project → `KanbanExecutor`) and uses it for both
  `schedule` and `poll` of every node. `DirectExecutor` already runs a subprocess
  with a timeout, caps captured output, and persists a file-backed `Completion`
  keyed by `run:node:iteration` (durable across tick processes).
- Hermes has NO Kanban "no-agent / script" task execution — `no_agent` is a
  cron-job mode only. So a script node must run as a LOCAL command in the plugin.
- The `node_status` edge condition (success/failure) and the run-store
  `output`/`error` fields already exist, so a script node's outcome plugs into
  branching and the run inspector with no new condition type and no run-schema
  change.
- Settings infrastructure ships; security requires (§25.2) an explicit enable
  flag, an env allowlist (not full env), workdir-only cwd, a timeout, and
  redacted captured stdout/stderr.

# Constraints
- Do not write a custom cron/Kanban engine; reuse Hermes primitives where they
  exist and the plugin's own executor seam otherwise.
- Keep the durable advance loop (schedule → poll → ingest) working for mixed
  agent_task + script graphs; script nodes must run identically in any scope.
- Reuse the `DirectExecutor` file-backed completion store for durability.
- Operator chats in Russian; repo artifacts stay English.

# Required output format
Exactly 3 variants, each with Approach (2-3 sentences), Trade-offs (pros/cons),
Complexity (small|medium|large), Risk (low|medium|high). Differ on HOW the script
node plugs into the executor seam / execution model (the only real architectural
axis; the node schema, validation, inspector, and security mitigations are
mechanical): e.g. (a) a composite executor that routes by node kind; (b)
per-node-type branching inside the engine loop; (c) a lightweight inline
execution mode for script-only workflows. Then exactly one "Recommended:
Variant N" with a 2-3 sentence rationale. Output nothing outside these sections.

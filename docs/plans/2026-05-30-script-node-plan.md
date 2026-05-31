# Script Node — Implementation Plan

Planning snapshot captured before implementation; the implementation shipped in this PR.

TDD throughout. Core uses `bun test`; the plugin uses pytest (route/cron/kanban
tests guarded with `importorskip` and run in the Hermes runtime venv); frontend
uses Vitest + jsdom + RTL. After each task the relevant `validate` stays green
(oxlint zero warnings; committed bundle matches). Each task is one atomic
conventional commit on `feat/script-node`. The security gate (explicit enable +
env allowlist) is enforced, not cosmetic.

## Task S1: Core `script` node type
- `schema/nodes.ts`: add `ScriptNode` (`command: string` required; `workdir?`,
  `timeout_seconds?: number`, `env?: string[]` allowlist; plus `title?` /
  `description?` like other nodes) to `WorkflowNode`. `schema/load.ts`: add
  `"script"` to `NODE_TYPES` and a `parseScript` (reject a missing/non-string
  command; reject a non-list / non-string-item `env`). `index.ts`: export the type.
- **Acceptance**: `bun test` — `parseWorkflow(serializeWorkflow(w))` round-trips a
  script node (command + workdir + timeout + env); a script node without a
  command fails validation at parse; a non-list `env` fails.
- **Depends on**: none.

## Task S2: Core validation for script nodes
- `validation/validateWorkflow.ts`: a `script` node must have a non-empty
  `command`; a script node participates in entry/finish/reachability/branch rules
  exactly like a work node (no special-casing needed beyond the command check).
- **Acceptance**: `bun test` — a script node with an empty command is an error; a
  script→condition graph branching on its `node_status` validates; a script node
  is a legal entry node.
- **Depends on**: S1.

## Task S3: Core compiler — script steps + kind tag
- `compiler/compileToHermesPlan.ts`: emit each script node into a typed
  `script_steps: CompiledScript[]` (`node`, `command`, `workdir?`,
  `timeout_seconds?`, `env?`), and tag compiled work units with `kind`
  (`"agent"` for kanban_tasks, `"script"` for script_steps) so the engine can
  route by kind. `agent_task` output is unchanged.
- **Acceptance**: `bun test` — a mixed workflow compiles agent_task → kanban_tasks
  (`kind: "agent"`) and script → script_steps (`kind: "script"`) with command and
  workdir carried; a script-only workflow yields no kanban_tasks.
- **Depends on**: S1.

## Task S4: Plugin ScriptExecutor
- `executor/script_executor.py`: `ScriptExecutor` implementing the `NodeExecutor`
  protocol. `schedule` runs `command` via the shell with `cwd = workdir`,
  `env =` the allowlisted subset, a timeout, capping and **redacting** captured
  stdout/stderr; exit 0 → `success`, non-zero/timeout → `failure`; persists a
  file-backed `Completion` keyed `script:run:node:iteration` (reuse the
  `DirectExecutor` store layout). `poll` reads it back.
- **Acceptance**: pytest — a passing command settles `success` with stdout
  captured; a failing command settles `failure` with stderr; a hanging command
  times out to `failure`; only allowlisted env vars are visible to the command;
  a secret-shaped token in output is redacted; the handle round-trips through
  `poll`.
- **Depends on**: none (parallel with core).

## Task S5: Engine routing via CompositeExecutor
- `executor/composite.py`: `CompositeExecutor` wrapping the scope executor + the
  script executor; routes `schedule` by `params["kind"]` and `poll` by handle
  prefix (`script:` → script executor, else scope executor). `engine.py`: build
  script-node params from `plan["script_steps"]` alongside `kanban_tasks`, and
  wrap the scope executor in the composite so script nodes run locally in any
  scope.
- **Acceptance**: pytest — a mixed run schedules the agent_task on the scope
  backend and the script node on the script executor; polling settles both via
  the right backend; a global script-only run advances to `finish` with no
  Kanban card created.
- **Depends on**: S3, S4.

## Task S6: Security gate — enable flag + env allowlist
- `config.py`: under the `execution` group add `scripts_enabled` (bool,
  `enforced: true`, default false) and a script env allowlist (a `list` field
  type, or a comma-separated string split on read — smaller change wins). The run
  entrypoint (`cli.py` run + `dashboard/plugin_api.py POST /workflows/{id}/run`)
  refuses a workflow containing script nodes when `scripts_enabled` is false:
  CLI errors clearly; the route returns `409`. The script executor receives the
  allowlist from settings.
- **Acceptance**: pytest — running a script-containing workflow with scripts
  disabled is rejected (CLI non-zero / route `409`); enabling it allows the run;
  the executor only exposes allowlisted vars; a non-script workflow is unaffected
  when scripts are disabled.
- **Depends on**: S4, S5.

## Task S7: Frontend — script node in palette, inspector, preview
- `editor/NodePalette` + `NodeInspector`: add the script node (command textarea,
  workdir, timeout, env allowlist rows) writing through the existing
  `{ workflow, ui }` save path. `CompilePreview`: surface the compiled command
  (the §25.2 "command preview"). `api/types.ts`: extend the node/plan types.
- **Acceptance**: Vitest — adding a script node from the palette selects it and
  shows its fields; editing command/workdir/timeout/env round-trips; the compile
  preview renders the command. A disabled-scripts run surfaces the `409` message.
- **Depends on**: S3 (plan shape), S6 (run gate).

## Task S8: Build wiring, docs, CHANGELOG
- Rebuild + commit `dashboard/dist`; update README, `docs/dashboard.md`,
  `docs/workflow-schema.md`, and `docs/execution.md` (script node + the enable
  gate + env allowlist + the local-execution note); add a CHANGELOG entry under
  the existing version header (no bump).
- **Acceptance**: `bun run validate` green incl. the committed-bundle guard; the
  full pytest suite green in the Hermes runtime venv.
- **Depends on**: S1–S7.

## Verification (phase 4 QA)
- Core green (script round-trip, validation, compiler kind/script_steps).
- Plugin pytest green in the runtime venv (executor, composite routing, enable
  gate + env allowlist, redaction).
- Frontend typecheck, lint, vitest, build green; committed bundle matches.
- Smoke: a global script-only workflow runs end to end with scripts enabled and
  is refused when disabled.

## Notes
- Operator gate: implementation begins only on explicit go-ahead.
- Version stays 0.1.0 until the operator bumps it. No auto-merge armed.
- Scripts run locally in the plugin (Hermes has no no-agent Kanban task mode);
  the executor reuses the `DirectExecutor` file-backed completion store.
- Lightweight inline mode (§18.2) is deferred; durable mode executes script nodes.

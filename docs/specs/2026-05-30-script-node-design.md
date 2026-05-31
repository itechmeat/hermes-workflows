# Script Node — Design

Status: implemented (Variant 1 chosen)
Author: orchestrator (via feature-release-playbook)
Audience: implementation

## Problem statement

`script` is the one MVP node type (TZ §13.3, §26 item 10) not yet implemented.
It runs a deterministic shell command with no LLM — lint, tests, a build step —
inside a workflow graph. Without it, every "do work" node has to be an
`agent_task` (an LLM worker), which is wrong for purely deterministic steps and
blocks the lightweight script-only workflows the spec calls out (§18.2).

## Hermes / existing reuse (audited first)

- **No Hermes Kanban "no-agent" task execution.** Hermes' `no_agent` is a
  *cron-job* mode (script-only watchdog jobs; `tools/cronjob_tools.py`,
  `cron/scheduler.py`). It runs a script on a schedule, not as an on-demand
  workflow step, and there is no Kanban task type that runs a deterministic
  command instead of dispatching an LLM worker. So a script node **cannot** be a
  no-agent Kanban card — it runs as a local command in the plugin. The TZ
  anticipates this: §16 maps `script node -> local runner or Hermes
  no-agent/script mode if available` (it is not available for steps).
- **`cron/scheduler._run_job_script`** is the canonical Hermes subprocess
  pattern (`subprocess.run(capture_output=True, timeout=…, cwd=…, env=…)` then
  redact), but it is a private, cron-internal function that execs shim files —
  not a reusable API. We do **not** import it.
- **Reuse the plugin's own `DirectExecutor` pattern.** `executor/direct_executor.py`
  already runs a subprocess with a timeout, caps captured output, and persists an
  idempotent, file-backed `Completion` keyed by `run:node:iteration` so a
  multi-step global run stays durable across tick processes. The new
  `ScriptExecutor` is the same shape with a different invocation (a command in a
  workdir instead of a profile runner), and reuses the file-backed completion
  store verbatim.
- **Secret redaction already exists.** §25.1 requires redacting secrets before
  persisting logs. Hermes ships `agent/redact.py:redact_sensitive_text`, and the
  plugin core already ships `redactSecrets` (`packages/core/src/memory/redact.ts`,
  exported). The script executor redacts captured stdout/stderr before it is
  persisted — see "Design decisions" for which redactor.
- **Settings infrastructure already ships** (§20.10). `config.py:SETTINGS_SCHEMA`
  has an `execution` group; the explicit-enable gate and env allowlist (§25.2)
  reuse the existing schema / resolve / save machinery — no new settings plumbing.
- **The graph already branches on outcome.** The `node_status` edge condition
  (`equals: success | failure`) and the run-store `output` / `error` fields and
  node statuses already exist. A script node's exit-code outcome plugs into
  conditional edges and the run inspector with **no new condition type and no
  run-schema change**.

## Scope

- A core `script` node type: `command` (required), `workdir`, `timeout_seconds`,
  and an optional per-node `env` allowlist. Parsed, validated, serialized,
  compiled, and surfaced in the editor.
- A plugin `ScriptExecutor` that runs the command in `workdir` with a restricted
  environment, a timeout, and captured + redacted stdout/stderr, persisting a
  durable file-backed completion (reusing the `DirectExecutor` store).
- Engine routing so a script node runs **locally regardless of workflow scope**
  (global or project), while `agent_task` nodes keep using the scope executor.
- Security gate (§25.2): a workflow containing script nodes runs only when
  scripts are explicitly enabled in settings; the environment is an allowlist,
  not the full process env; the command runs only in its `workdir`; a timeout
  always applies; stdout/stderr are captured and redacted.
- Command preview: the compiled command is shown in the existing compile-preview
  (and the inspector), satisfying §25.2 "command preview before save".

## Out of scope (roadmap)

- Lightweight inline mode (§18.2) as a synchronous fast path for script-only
  runs — durable mode already executes script nodes correctly; inline mode is a
  later latency optimization, recorded as the fallback in `variants.md`.
- Hardened sandboxing beyond workdir + env allowlist + timeout (containers,
  seccomp, user namespaces). Remote / container execution.
- Post-MVP node types (§14) and post-MVP triggers (§13.1).

## Chosen approach (Variant 1 — composite executor keyed on node kind)

- **Core.** Add `ScriptNode` to the node union; `command` is required, `workdir`
  / `timeout_seconds` / `env` optional. Wire it through `load` (NODE_TYPES +
  parse, rejecting a missing/non-string command and a non-list env), `serialize`
  (handled by the generic emitter), `validateWorkflow` (command required), and
  `compileToHermesPlan` (emit the node into a typed `script_steps` list and tag
  each compiled step with `kind: "script"`; `agent_task` stays `kind: "agent"`).
- **Execution.** A `ScriptExecutor` (plugin) runs the command via the shell with
  `cwd = workdir`, `env =` the allowlisted subset, a timeout, and capped +
  redacted stdout/stderr; exit code 0 → `success`, else `failure`; output
  persisted through the reused file-backed completion store. The engine wraps the
  scope executor and the script executor in a **`CompositeExecutor`** that routes
  `schedule` by the compiled step's `kind` and `poll` by a handle prefix
  (`script:` vs the agent handle), so the existing single-executor advance loop
  is unchanged and script nodes run the same way in any scope.
- **Security gate.** Two settings under the existing `execution` group:
  `scripts_enabled` (bool, **enforced**) and a script env allowlist. The run
  entrypoint refuses to start a workflow that contains script nodes when
  `scripts_enabled` is false (HTTP `409` from the dashboard run route, a clear
  error from the CLI). The executor passes only allowlisted env vars.

## Design decisions

- **Local execution, not a Kanban card** — Hermes has no no-agent task mode, and
  a deterministic command does not belong on an LLM worker board. Scripts run in
  the plugin process via the executor seam, durable through the same file-backed
  store the `DirectExecutor` already uses.
- **Composite executor over re-architecting `_executor_for`** — the engine
  selects one executor per run today and uses it for both `schedule` and `poll`.
  A composite that routes by `kind` (schedule) and handle prefix (poll) keeps the
  advance loop untouched and makes script execution orthogonal to scope. This is
  the smallest change that supports mixed agent+script graphs.
- **No new condition type / no run-schema change** — a script node settles to
  `success` / `failure` like any work node, so existing `node_status` branching,
  the run inspector, retry, and cancel all work unchanged.
- **Redaction in the executor (Python), reusing the plugin's existing redactor** —
  stdout/stderr are captured in Python, so redaction happens there before
  persisting. Prefer the plugin's own redaction surface over importing Hermes
  `agent.redact` (the plugin must not couple to Hermes internals that may move);
  if a Python redactor is not already reachable, expose the core `redactSecrets`
  via a tiny CLI shim rather than duplicating the rule set. Resolve during
  implementation; the requirement (§25.1) is non-negotiable, the source is an
  implementation detail.
- **Explicit enable is enforced, env allowlist is enforced** — unlike the
  not-yet-enforced settings knobs, both of these gate real behaviour from day one
  (no silent no-ops), honouring §25.2.
- **English in the repo; operator chat in Russian.**

## Component / route map (target)

```text
packages/core/src/
  schema/nodes.ts        + ScriptNode (command, workdir?, timeout_seconds?, env?)
  schema/load.ts         + "script" in NODE_TYPES + parseScript
  validation/validateWorkflow.ts + command-required check
  compiler/compileToHermesPlan.ts + script_steps[] + kind tag on compiled steps

hermes_workflows/
  executor/script_executor.py   + ScriptExecutor (subprocess in workdir, env allowlist,
                                  timeout, redacted capture, file-backed completion)
  executor/composite.py         + CompositeExecutor (route by kind / handle prefix)
  engine.py              route script steps to the script executor; build script params
  config.py              + execution.scripts_enabled (enforced) + env allowlist
  cli.py / dashboard/plugin_api.py  refuse to run a script workflow when disabled (409)

apps/dashboard/src/editor/
  NodePalette / NodeInspector  + script node (command, workdir, timeout, env)
  CompilePreview               surface the command preview
```

## Risks and open questions

- **Shell injection / footguns** — the command is operator-authored, not
  model-authored, so the threat model is "an operator runs their own script."
  The MVP mitigations (workdir-only cwd, env allowlist, timeout, explicit enable,
  redacted capture) match §25.2; deeper sandboxing is out of scope and recorded.
- **`workdir` templating** — the TZ example uses `{{project.path}}`. MVP may
  accept a literal workdir and defer templating; decide in implementation and
  state the limit in docs if templating is deferred.
- **Poll routing** — encoding the executor kind in the handle (`script:` prefix)
  must not collide with agent handles; the composite owns handle minting so the
  prefixes stay disjoint. Covered by tests.
- **Env allowlist type in settings** — the current schema types are
  string/int/bool/enum; an allowlist is a list. Implementation either adds a
  `list` field type or stores a comma-separated string and splits on read; pick
  the smaller change and keep the Settings page able to render it.

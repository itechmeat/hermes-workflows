# Inter-node data flow - pass a node's output to a later node without host files

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

A workflow node can only hand data to a later node by writing a hardcoded local
file (the o2b-scope-suggester workflow uses `/tmp/o2b-scope/inventory.json` and
`/tmp/o2b-scope/proposals.md`). That buries the payload on one host, hides it
from the user, and breaks export/import. The node schema already advertises
`input_mapping` with the form `{{nodes.<id>.output}}`, but nothing resolves it:
the compiler copies `prompt` verbatim and never carries `input_mapping`, and no
substitution exists in TypeScript or Python. The field is a stub.

## Scope

This PR ships the engine mechanism (the repo half):

- The TypeScript compiler carries `input_mapping` onto each compiled agent task.
- `validateWorkflow` statically validates every `input_mapping` entry (well-formed
  reference, referenced node exists, is an ancestor, and the declared placeholder
  is actually used in the prompt).
- A pure Python resolver substitutes a node's `input_mapping` placeholders with
  the referenced upstream nodes' captured outputs, at the single scheduling seam
  (`engine._schedule_node`), for both executor backends.
- Tests (Bun + pytest), README / CHANGELOG / schema-doc updates.

## Out of scope

- Migrating the live o2b-scope-suggester workflow and its template off `/tmp`
  (kanban `t_f6620f4c`). Those specs live under `/root/.hermes/workflows/`, not in
  this repo, so they cannot ship in this PR; they are applied to the runtime once
  this feature is merged and verified with a full run.
- Resolving references inside `script` node `command` strings (shell-quoting a
  payload into a command is injection-prone; deferred, see Risks).
- Any change to the public node schema shape (`input_mapping` and `prompt` already
  exist).

## Chosen approach

Variant 1 (Python resolver at the scheduling seam), with `input_mapping` made the
single canonical mechanism rather than adding a parallel inline form.

A node declares the upstream outputs it consumes in `input_mapping`: each entry
maps a placeholder name to a source reference, e.g.
`input_mapping: { inventory: "{{nodes.collect.output}}" }`. The node's `prompt`
references the placeholder as `{{inventory}}`. At schedule time the resolver looks
up each referenced node's settled output in the run state and replaces `{{key}}`
in the prompt. The resolver runs in `engine._schedule_node`, the one place where
the live `run` dict (every settled node's `output`) and the node `params` (raw
prompt + `input_mapping`) already coexist, just before `executor.schedule(...)` -
so both `DirectExecutor` and `KanbanExecutor` get resolved text with zero
per-backend duplication.

Static authority stays in the core (`validateWorkflow`); runtime substitution is
orchestration and lives in Python. The two share only the fixed
`{{nodes.<id>.output}}` grammar.

## Design decisions

- **`input_mapping` is the one mechanism (no inline `{{nodes.X.output}}` in the
  prompt).** It makes a node's data inputs explicit, structured, and editable
  (matching the "fully editable" goal and enabling data-edge visualization), and
  it turns the existing stub field into a real feature instead of leaving it dead.
- **Placeholder indirection.** Prompt uses `{{key}}`; mapping value is
  `{{nodes.<id>.output}}`. The two token namespaces never collide because the
  source form only appears as a mapping value, never in the prompt.
- **Fail loud, never silent.** A reference whose source node has no settled output
  raises in the resolver and fails the node with a clear message; a malformed
  reference, an unknown node, a non-ancestor source, or a declared placeholder
  that the prompt never uses is a hard validation error. No empty-string fallback.
- **Resolve at `_schedule_node`, not in the compiler.** Outputs only exist at
  runtime; the compiler is stateless. Resolving once upstream of the executor seam
  keeps both backends identical (DRY) and adds no new compiled-plan artifact.
- **Ancestry check is static and topological.** `validateWorkflow` requires the
  consumer to be forward-reachable from the referenced node (`reachableFrom(src)`
  contains the consumer) and the source to differ from the consumer, so a
  reference can only point at a node that strictly precedes it in the graph and a
  self-reference is rejected. A conditional
  branch that does not execute on a given run leaves its output unset; that case
  is caught at runtime by the fail-loud resolver, not statically.
- **Non-recursive substitution.** The injected output is not re-scanned for
  placeholders, so a payload that happens to contain `{{...}}` cannot trigger
  further substitution or injection.
- **Pure resolver function** in its own module (`hermes_workflows/resolve.py`),
  unit-tested independently of the engine (SRP).

## File changes

New:
- `hermes_workflows/resolve.py` - pure `resolve_input_mapping(prompt, input_mapping, node_outputs)`.
- `tests/python/test_resolve.py` - resolver unit tests.

Modified (core, TypeScript):
- `packages/core/src/compiler/compileToHermesPlan.ts` - carry `input_mapping` onto the compiled task; extend `CompiledKanbanTask`.
- `packages/core/src/validation/validateWorkflow.ts` - static `input_mapping` checks (+ new error codes).
- core test files for compiler + validation (Bun).

Modified (Python):
- `hermes_workflows/engine.py` - call the resolver in `_schedule_node`.
- `tests/python/` - an engine/e2e test proving an output flows into a downstream prompt, plus a fail-loud test.

Modified (docs):
- `README.md`, `CHANGELOG.md`, and the schema/execution docs that describe node fields.

## Risks and open questions

- **Verbatim delivery (affects the out-of-scope o2b migration, not this PR).**
  When the migrated `deliver` node receives the composed message via
  `{{message}}` in its prompt and relays it to `hermes send`, an agent could
  paraphrase it. Mitigation for the migration task: instruct strict verbatim
  relay via stdin (`printf`/heredoc), or later add resolution for `script` nodes
  with the payload passed safely (not via a shell-quoted command). Captured here
  as a known constraint for `t_f6620f4c`.
- **Large outputs.** Outputs are already clipped to 100,000 chars before persist;
  substituting that into a prompt is acceptable.
- **Conditional/loop topology.** Static ancestry cannot guarantee a conditional
  predecessor actually ran; the runtime fail-loud path covers it.

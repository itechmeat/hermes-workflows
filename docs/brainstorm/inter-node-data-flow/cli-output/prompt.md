You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Make a workflow able to pass one node's output to a later node WITHOUT a hardcoded local file, so the workflow is 100% exportable, importable, and fully editable.

Today the node schema advertises `input_mapping?: Record<string, string>` with the documented form `{{nodes.<id>.output}}` (packages/core/src/schema/nodes.ts), and the dashboard editor already exposes an "input mapping" field. But the mechanism is UNIMPLEMENTED at runtime: the compiler (packages/core/src/compiler/compileToHermesPlan.ts) copies `prompt: node.prompt` verbatim and never carries `input_mapping`; there is no `{{...}}` substitution anywhere in TypeScript or Python. Because of this gap the existing o2b-scope-suggester workflow hands data between nodes through hardcoded `/tmp/o2b-scope/inventory.json` and `/tmp/o2b-scope/proposals.md` files, which hides the payload from the user, binds the workflow to one host's filesystem, and breaks export/import.

Implement engine-mediated inter-node data flow: at the moment a node is scheduled, resolve references to prior nodes' captured outputs and substitute them into the node's prompt. Then the scope-suggester workflow and its template can drop the `/tmp` files entirely.

# Project context

Project: Hermes Workflows. A thin orchestration layer over Hermes Agent. TypeScript core (Bun runtime, packages/core) plus a Python orchestrator (hermes_workflows/, FastAPI dashboard plugin). Workflows compile to native Hermes Kanban tasks / Cron / Profiles.

Recent commits:
3d3c15c fix: honor per-node model/provider/skills/timeout for global runs + clearer dashboard views (#17)
65bc8a6 feat: single-flight runs + workflow JSON export/import (#16)
4e5a5f5 feat(editor): Play button - run the edited workflow with live node progress (#15)
4ae4dcc feat: run observability - per-node telemetry, approval surfacing, JSONL trace (#14)

Architecture facts (verified in the code):
- The TypeScript compiler `compileToHermesPlan(workflow)` is STATELESS and runs at compile time, before any run exists. It produces `kanban_tasks` each with a raw `prompt`.
- The TypeScript `advance(workflow, run)` (packages/core/src/runtime/advance.ts) is a pure function that decides which nodes to schedule next, given the run state. The run state records each node's `output` (NodeRunState.output, persisted as output_json in runRepository).
- The Python engine drives execution. In `hermes_workflows/engine.py._advance_step`, it builds `task_params` from the compiled plan (raw prompts), polls/settles nodes (writing `run["nodes"][id]["output"]`), gets the advance decision, then calls `_schedule_node(executor, run, run_id, node_id, params)` for each node to schedule. `_schedule_node` has both the live `run` dict (with every settled node's `output`) and the node `params` (with the raw prompt) in scope, just before calling `executor.schedule(..., params=params)`.
- Two executor backends consume `params["prompt"]` uniformly behind one seam: `DirectExecutor` (global scope) and `KanbanExecutor` (project scope). A `CompositeExecutor` routes script nodes to a local `ScriptExecutor`.
- The graph is a DAG defined by edges; a node's valid data sources are its ancestors (nodes guaranteed settled before it runs). Loops exist (a back-edge re-runs a node on a higher seq).
- Schema parsing/validation/serialization for `input_mapping` already exist (schema/load.ts, validation/validateWorkflow.ts, serialize/serializeWorkflow.ts); only resolution is missing.

Conventions:
- SOLID, KISS, DRY. Senior-backend bar.
- No stubs and no silent fallbacks: a reference that cannot be resolved (unknown node, node not yet completed, no output) must FAIL LOUDLY, never substitute an empty string silently.
- Workflows must stay 100% exportable / importable / editable; no host-specific paths in a spec.
- The core (TypeScript) is the source of truth for spec semantics and static validation; the Python engine is the runtime orchestrator.
- Both executor backends must behave identically; resolution must not be duplicated per backend (DRY).

Constraints:
- Do not change the public node schema shape incompatibly; `input_mapping` and `prompt` already exist.
- Do not introduce a new external dependency.
- Resolution needs per-run node outputs, which only exist at runtime (not at compile time).
- Keep static, spec-level checks (does the referenced node exist, is it an ancestor) separable from runtime substitution.

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

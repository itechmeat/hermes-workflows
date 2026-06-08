# Inter-node data flow - implementation plan

## Tasks

### Task 1: Core - carry `input_mapping` and validate references (TypeScript)
- **Files**:
  - `packages/core/src/compiler/compileToHermesPlan.ts` (carry `input_mapping` onto `CompiledKanbanTask`; extend its type)
  - `packages/core/src/validation/validateWorkflow.ts` (static checks)
  - core test files (Bun): compiler carries the field; validation accepts a valid mapping and rejects each error case
- **Validation rules** (new error codes):
  - `invalid_input_mapping_ref` - value does not match `^{{nodes.<id>.output}}$`
  - `unknown_input_mapping_node` - referenced node id is not in the graph
  - `non_ancestor_input_mapping` - referenced node is not an ancestor of the consumer
  - `unused_input_mapping` - a declared placeholder is never referenced as `{{key}}` in the prompt
- **Acceptance**: `bun test packages/core` green; compiled task includes `input_mapping`; each rule has a passing+failing test.
- **Depends on**: none.

### Task 2: Python resolver + scheduling-seam wiring
- **Files**:
  - `hermes_workflows/resolve.py` (new) - `resolve_input_mapping(prompt, input_mapping, node_outputs) -> str`
  - `tests/python/test_resolve.py` (new) - unit tests
  - `hermes_workflows/engine.py` - call the resolver in `_schedule_node` before `executor.schedule`
  - `tests/python/` - engine/e2e test: an upstream output is substituted into a downstream prompt; a missing/unsettled source fails the node loudly
- **Resolver behaviour**:
  - For each `(placeholder, ref)` in `input_mapping`: parse `ref` to a source node id; look up `node_outputs[src]`; if absent or `None`, raise a clear error; replace every `{{placeholder}}` in the prompt.
  - Pure and non-recursive; returns a new prompt string, does not mutate inputs.
- **Acceptance**: `python3 -m pytest` green; resolver unit tests cover happy path, missing source (raises), no-mapping pass-through; engine test proves end-to-end substitution into the scheduled params.
- **Depends on**: Task 1 (compiler must carry `input_mapping` for the engine to read it from `params`).

### Task 3: Docs
- **Files**: `README.md`, `CHANGELOG.md`, schema/execution docs describing node fields and the `{{nodes.<id>.output}}` mechanism.
- **Acceptance**: docs describe how to wire one node's output into another via `input_mapping`; CHANGELOG has one entry under Unreleased.
- **Depends on**: Tasks 1-2.

## Verification (Phase 4 QA)
- `bun run validate` (typecheck + lint + bun test + pytest + dashboard typecheck/test/build + dist guard).
- Smoke: a minimal two-node global workflow whose second node's prompt consumes the first node's output runs and the second node receives the resolved text.

## Runtime follow-up (NOT in this PR - kanban t_f6620f4c)
- Migrate the live o2b-scope-suggester workflow + template under `/root/.hermes/workflows/` to use `input_mapping` and drop the `/tmp` files; verify with a full run delivering to Telegram 952.

### Variant 1: Python resolver at the scheduling seam
- **Approach**: Add one pure Python resolver invoked inside `_schedule_node`, just before `executor.schedule`, where the live `run` dict (every settled node's `output`) and the node `params` already coexist. The compiler carries `input_mapping` through onto each compiled task so it reaches `params` at runtime; the resolver substitutes `{{nodes.<id>.output}}` into the prompt for both backends in one place. TS `validateWorkflow` keeps all static authority (node exists, is an ancestor).
- **Trade-offs**:
  - Pro: smallest change; single chokepoint upstream of the executor seam satisfies "no per-backend duplication" directly.
  - Pro: leverages the exact scope where run outputs and params already meet — no new boundary crossing or payload serialization.
  - Pro: fail-loud is trivial (raise in the resolver on unknown/incomplete/empty output).
  - Con: the `{{...}}` grammar now has a runtime implementation in Python while TS owns the static grammar — two parsers to keep in sync.
  - Con: relies on the compiler being amended to propagate `input_mapping` (a real but contained change).
- **Complexity**: small
- **Risk**: low

### Variant 2: TS-authored resolution emitted by `advance()`
- **Approach**: Extend the runtime decision in core (either `advance` itself or a sibling pure function it calls) to substitute references using the per-node outputs the run state already carries, returning fully-resolved prompts in the schedule decision. Python becomes a pass-through that hands resolved prompts to whichever executor. Both static validation and runtime substitution share one TS parser for the `{{...}}` grammar.
- **Trade-offs**:
  - Pro: keeps spec semantics in the core source-of-truth; the grammar is defined and tested exactly once.
  - Pro: Python stays a dumb orchestrator; backend parity is automatic since both receive already-resolved text.
  - Con: requires shipping full (potentially large) node-output payloads across the TS↔Python runtime bridge on every advance, widening the serialization surface and coupling resolution to advance's invocation cadence.
  - Con: risks overloading `advance`'s single responsibility (scheduling vs. content rendering) unless carefully split into a separate function.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Compiler-normalized binding table + minimal shared filler
- **Approach**: The compiler carries `input_mapping` and normalizes each reference into an explicit per-task binding table (placeholder → source node id), validating existence/ancestry at compile time. At runtime a trivial, grammar-free filler (called once at the Python seam) maps each binding to the corresponding settled output and substitutes. Static binding lives in TS; runtime fill is mechanical key replacement.
- **Trade-offs**:
  - Pro: clean separation — all parsing/validation is compile-time in TS, leaving only dumb dictionary substitution at runtime, so almost nothing is duplicated and backends behave identically.
  - Pro: export/import unaffected because bindings derive deterministically from the spec, not the host.
  - Con: adds a new compiled-plan artifact (binding table), growing the plan/schema surface and the things that must round-trip on export/import.
  - Con: more moving parts than Variant 1 for the same end result; a small runtime substituter still lives outside core.
- **Complexity**: medium
- **Risk**: low

### Recommended: Variant 1
**Rationale**: It exploits the one place where the live run outputs and node params already coexist (`_schedule_node`, upstream of both executors), so it satisfies the no-per-backend-duplication and fail-loud constraints with the least machinery and no new plan artifacts or bridge payloads. The constraints assign *static validation* to TS — which `validateWorkflow` already covers — while runtime substitution is genuinely orchestration, Python's job; the only cost, a fixed and simple `{{nodes.<id>.output}}` grammar mirrored in Python, is far smaller than Variant 2's serialization coupling or Variant 3's added compiled surface.

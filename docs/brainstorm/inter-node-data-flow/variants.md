# Inter-node data flow - variants and decision

Primary consultant: Claude Code (`claude -p`), exit 0, 3 parseable variants, so
the Codex fallback was not run. Full verbatim output: `cli-output/claude.md`.

## Variant 1: Python resolver at the scheduling seam
One pure Python resolver invoked inside `_schedule_node`, just before
`executor.schedule`, where the live `run` dict and the node `params` coexist. The
compiler carries `input_mapping` onto each compiled task; the resolver substitutes
references into the prompt for both backends in one place; TS `validateWorkflow`
keeps static authority. Complexity: small. Risk: low.

## Variant 2: TypeScript-authored resolution emitted by `advance()`
Extend the core runtime decision to substitute references using the per-node
outputs the run state carries, returning fully-resolved prompts; Python becomes a
pass-through. One TS parser for the grammar. Cost: ships full node-output payloads
across the TS-Python bridge on every advance and risks overloading `advance`'s
responsibility. Complexity: medium. Risk: medium.

## Variant 3: Compiler-normalized binding table + minimal shared filler
The compiler normalizes each reference into an explicit per-task binding table
(placeholder -> source id), validated at compile time; a trivial grammar-free
filler substitutes at runtime. Clean separation but adds a new compiled-plan
artifact that must round-trip on export/import. Complexity: medium. Risk: low.

## Consultant recommendation
Variant 1.

## Orchestrator decision: Variant 1 (accepted), with one refinement

Accepted Variant 1: it uses the single place where run outputs and node params
already meet (`_schedule_node`, upstream of both executors), satisfying the
no-per-backend-duplication and fail-loud constraints with the least machinery, no
new plan artifact (rejecting Variant 3's added round-trip surface), and no large
payloads crossing the runtime bridge (rejecting Variant 2's serialization coupling
and its overload of `advance`'s single responsibility).

Refinement to the consultant's framing: make `input_mapping` the one canonical
mechanism (declared placeholders resolved into the prompt) instead of also
substituting raw `{{nodes.<id>.output}}` inline in the prompt. This keeps a single
way to express a data edge (KISS), turns the existing stub field into a real
feature rather than leaving it dead (the operator forbids stubs), keeps inputs
explicit and editable, and confines the source-reference grammar to mapping values
where it is statically validated.

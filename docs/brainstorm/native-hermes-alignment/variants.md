# Native Hermes alignment — variant audit

Consultant: Claude Code (`claude -p`), prompt in `cli-output/prompt.md`, raw output in
`cli-output/claude.md`. Three variants were produced; the consultant recommended Variant 1.

## Variant 1: Host-mirror in TS core (parallel to `blueprint_catalog.py`)
Treat the host `cron/blueprint_catalog.py` as the literal reference and build its parallel in
`packages/core`: a `WorkflowParam` interface mirroring `BlueprintSlot`, pure
`paramFormSchema` / `paramSlashCommand` / `paramDeeplink` / `catalogEntry` / `agentSeed` emitters,
a `fillParams` validator with a `ParamFillError`, plus `deliver` and the extended `Trigger` union
added directly to the existing schema files. Python stays I/O-only (delivery-target resolution +
`[SILENT]`, trigger compile-preview); the dashboard consumes emitter output. Each of the 5 features
is a thin vertical slice off these primitives.
- Complexity: medium · Risk: low

## Variant 2: Unified WorkflowTemplate + generic emitter registry
One cohesive `WorkflowTemplate` descriptor subsuming all five concerns and a generic
`surface -> (template, values) => rendering` registry, so every surface is a registered function
over a shared traversal. Strongest DRY and most extensible, but introduces an abstraction the host
does not have (works against the nativeness goal), and is over-engineered against KISS for only five
known surfaces — per-surface quirks (slash escaping vs deeplink encoding) fight a uniform contract.
- Complexity: large · Risk: medium

## Variant 3: Per-surface distributed ownership
Add only the minimal schema fields and let each surface render where it lives (React builds the form
from the raw slot array, Python composes slash/deeplink/docs, the orchestrator assembles agent-seed).
Fastest per-feature, but re-encodes slot semantics in TS, Python, and React — guaranteeing the exact
multi-runtime drift the blueprint alignment exists to remove, and splitting spec interpretation
across runtimes (violates "the TS engine is the one spec interpreter").
- Complexity: medium · Risk: high

## Decision: Variant 1 (agree with consultant)
It is the only variant that satisfies every hard constraint at once — TS core as the single spec
interpreter, pure emitters and a pure compiler, 1:1 field mirroring, and "never reinvent a host
primitive" — by directly paralleling the explicit reference module `blueprint_catalog.py` rather
than inventing structure around it. Variant 2's registry adds an abstraction the host lacks (against
nativeness and KISS for five surfaces); Variant 3 reintroduces exactly the cross-runtime drift this
epic exists to eliminate. The light copy-shape repetition Variant 1 risks across the emitters is
mitigated per project convention by extracting shared literals/format helpers, exactly as the host
module does (`_DELIVER`, `_humanize_schedule`).

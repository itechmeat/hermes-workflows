### Variant 1: Host-Mirror in TS Core (parallel-to-blueprint_catalog)
- **Approach**: Treat `cron/blueprint_catalog.py` as the literal template and build its parallel in `packages/core`: a `WorkflowSlot` interface mirroring `BlueprintSlot`, pure `workflow_form_schema`/`workflow_slash_command`/`workflow_deeplink`/`workflow_catalog_entry`/`agent_seed` emitters, a `fillWorkflow` validator with a `WorkflowFillError`, plus `deliver` and the extended `Trigger` union added directly to the existing schema files. Python stays I/O-only (delivery-target resolution in `notify_sender`/`notifications`, trigger compile-preview wiring), and the dashboard consumes emitter output through the plugin API. Each of the 5 features is a thin vertical slice hanging off these same primitives.
- **Trade-offs**:
  - Pro: Honors "TS engine is the one spec interpreter" and "field names mirror spec 1:1" exactly; the host module is the proven reference, so behavior parity (unknown-slot rejection, enum check, `strict=False`) is a direct port, not a re-derivation.
  - Pro: Lowest divergence risk — the dashboard "new workflow" form and the slash/deeplink emitters read from one schema, so they cannot drift.
  - Pro: Keeps the compiler pure; emitters are pure functions, trivially unit-testable under `bun test`, matching the existing compile-preview testing pattern.
  - Con: Five near-parallel emitter functions invite light copy-shaped repetition (mitigated by extracting shared literals/format helpers per conventions).
  - Con: Mirroring a Python dataclass structure into TS by hand requires care to keep the two conceptually aligned without a shared codegen link.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Unified WorkflowTemplate + Generic Emitter Registry
- **Approach**: Introduce one cohesive `WorkflowTemplate` descriptor in TS core that subsumes all five concerns (typed `slots`, `deliver`, extended `triggers`, `skills` catalog binding) and a generic surface-emitter registry — a map of `surface -> (template, values) => rendering` — so dashboard-form, slash, deeplink, docs, and agent-seed are registered functions over a shared traversal. The dashboard, validation, and compile-preview all drive off the registry; adding a future surface is registering one function.
- **Trade-offs**:
  - Pro: Maximal DRY — slot traversal, default application, and validation are written once and reused across every surface, eliminating the parallel-function repetition of Variant 1.
  - Pro: Most extensible if more surfaces or slot types arrive later; the registry is the single extension point.
  - Con: Introduces an abstraction layer the host does not have — risks diverging in shape from `blueprint_catalog.py`, weakening the "native/parallel to host" goal that is the epic's whole point.
  - Con: Over-engineering risk against KISS for only five known surfaces; the generic indirection costs more upfront design and makes per-surface quirks (e.g. slash escaping vs. deeplink encoding) awkward to express uniformly.
  - Con: Higher chance of a leaky generic contract that later needs special-casing anyway.
- **Complexity**: large
- **Risk**: medium

### Variant 3: Per-Surface Distributed Ownership
- **Approach**: Add only the minimal schema fields (`deliver`, slot list, trigger variants) to TS core, then let each surface own its own rendering where it lives: the React dashboard builds its form directly from the raw slot array, Python composes slash/deeplink/docs strings near its delivery and cron code, and the agent-seed is assembled at the orchestrator. No shared emitter layer.
- **Trade-offs**:
  - Pro: Fastest initial slice per feature; each surface team/file moves independently with little cross-coordination.
  - Pro: Each renderer can fully exploit its local context (React state, Python gateway helpers) without a shared contract.
  - Con: Directly violates the single-source-of-truth requirement — the same slot semantics get re-encoded in TS, Python, and React, guaranteeing drift (the exact failure mode the blueprint alignment is meant to eliminate).
  - Con: Splits spec interpretation across runtimes, contradicting "the TS engine is the one spec interpreter" and making parity with blueprint behavior unverifiable in one place.
  - Con: Emitters become impure/I/O-coupled, harder to unit-test than the pure compile-preview pattern.
- **Complexity**: medium
- **Risk**: high

### Recommended: Variant 1
**Rationale**: It is the only variant that satisfies every hard constraint at once — TS core as the single spec interpreter, pure emitters/compiler, 1:1 field mirroring, and "never reinvent a host primitive" — by directly paralleling the explicit reference module `blueprint_catalog.py` rather than inventing structure around it. Variant 2's generic registry adds an abstraction the host lacks, working against the nativeness goal and KISS for only five surfaces, while Variant 3's distributed ownership reintroduces exactly the multi-runtime drift the blueprint alignment exists to remove.

# Brainstorm — Visual editor polish

Phase 0 of the feature-release-playbook. CLI consultants were not run this round
(same harness constraints as prior rounds); an in-process orchestrator pass
produced the variants. The orchestrator decides.

## Hermes / existing reuse audit

- This is **purely a frontend concern** — Hermes provides nothing for graph
  layout, node inspection, or canvas editing. Nothing to reuse from Hermes here.
- The **core schema already defines** every node field; the inspector simply does
  not surface all of them yet (missing: `description` on all types; agent_task
  `workdir`, `workspace.type`, `input_mapping`, `max_retries`, `timeout_seconds`).
  So richer inspector fields need no schema change — they reuse the existing
  `{ workflow, ui }` save path.
- The editor already round-trips layout losslessly through `ui.xyflow`; auto-layout
  and duplicate-node write into that same block.
- There is **no layout library** in the dashboard deps, and the project keeps
  dependencies deliberately minimal.

Only auto-layout has an architectural choice; richer inspector fields and
duplicate-node are mechanical and dependency-free.

## Variants (auto-layout approach)

- **Variant 1 — Add `@dagrejs/dagre`.** A small, synchronous, battle-tested
  layered-graph layout; feed nodes/edges, read back positions, write to
  `ui.xyflow`. Pro: correct on branches and router loop-edges with little code.
  Con: adds a frontend build-time dependency (~weighs against the project's
  minimal-deps ethos). Complexity: small. Risk: low.
- **Variant 2 — Add `elkjs`.** A richer layout engine (orthogonal routing, more
  options), typically run in a web worker (async). Pro: best-looking layouts.
  Con: heaviest dependency, async/worker plumbing, overkill for the small DAGs
  here. Complexity: medium. Risk: medium.
- **Variant 3 — Dependency-free hand-rolled layered layout.** A longest-path
  layering (rank by distance from entry, sequence within a rank, fixed spacing),
  treating router/loop back-edges as non-ranking. Pro: zero dependencies — matches
  the project ethos; full control; trivially testable as a pure function. Con:
  more code than calling a library; we own edge cases (cycles via router edges,
  disconnected nodes). Complexity: medium. Risk: low.

## Recommended: Variant 3

The workflow graphs are small and the project deliberately keeps dependencies
minimal (zero runtime deps in core), so a dependency-free layered layout is the
proportionate choice and avoids a unilateral dependency add. It is a pure
`graph -> positions` function — easy to unit-test and round-trip through
`ui.xyflow`. If layouts later prove insufficient for larger graphs, Variant 1
(`dagre`) is the cheap upgrade path and is recorded as the fallback.

You are a frontend architecture consultant brainstorming ARCHITECTURAL VARIANTS for one epic. Do NOT write code, do NOT write a final design. Output exactly 3 variants and one recommendation.

# Task (Visual editor polish in the Hermes Workflows dashboard)

Three editor improvements remain (from the editor roadmap):
1. Richer node-inspector fields — expose the workflow-schema node fields the inspector does not edit yet.
2. Auto-layout — a button that arranges the graph tidily.
3. Duplicate-node-on-canvas — clone the selected node.

Already exists (audited):
- The editor is `@xyflow/react` 12 with a node palette, a per-type NodeInspector, validation/compile-preview panels, and lossless layout round-trip through the spec's `ui.xyflow` block (node positions + viewport). Save persists `{ workflow, ui }`.
- The core schema (`schema/nodes.ts`) defines the node fields. The inspector currently edits only: title; agent_task profile/model/skills/prompt; human_review options; finish outcome. NOT yet exposed: `description` (all node types), and agent_task `workdir`, `workspace.type`, `input_mapping`, `max_retries`, `timeout_seconds`.
- There is NO graph-layout library in the dashboard dependencies; the project keeps dependencies deliberately minimal (core has zero runtime deps; the dashboard bundles only React + react-dom + @xyflow/react).
- Nothing in Hermes provides graph layout — this is purely a frontend concern.

# Constraints
- Editing must keep round-tripping losslessly through `ui.xyflow`; new fields must serialize through the existing `{ workflow, ui }` save path with no schema change beyond what core already defines.
- Frontend builds to one Vite bundle; tests are Vitest + jsdom + RTL; oxlint zero warnings; the committed bundle must match a fresh build.
- Adding a runtime dependency is a deliberate decision the operator must be aware of — weigh dep-free options against a library.
- Operator chats in Russian; repo artifacts stay English.

# Required output format
Exactly 3 variants, each with Approach (2-3 sentences), Trade-offs (pros/cons), Complexity (small|medium|large), Risk (low|medium|high). Differ on the AUTO-LAYOUT approach (the only real architectural axis; the inspector fields and duplicate-node are mechanical): (a) add a layout library such as `@dagrejs/dagre`; (b) add `elkjs` (web-worker, richer); (c) a dependency-free hand-rolled layered DAG layout. Then exactly one "Recommended: Variant N" with a 2-3 sentence rationale. Output nothing outside these sections.

# Visual Editor Polish — Implementation Plan

NOT started — planning only; awaits operator go-ahead to implement.

TDD throughout. Frontend uses Vitest + jsdom + RTL; the layout util is tested as
a pure function. After each task the frontend `validate` and the root
`bun run validate` stay green (oxlint zero warnings; committed bundle matches).
Each task is one atomic conventional commit on `feat/editor-polish`. No core,
bridge, or backend changes.

## Task E1: Richer node-inspector fields
- `editor/NodeInspector.tsx`: add `description` (textarea) for every node type;
  for agent_task add `workdir` (text), `workspace.type` (select scratch|worktree),
  `input_mapping` (key/value rows), `max_retries` (number), `timeout_seconds`
  (number). All edits flow through the existing update path; Save persists them in
  `{ workflow }`. No schema change.
- **Acceptance**: Vitest — editing each new field updates the node and survives a
  serialize round-trip; `input_mapping` round-trips an empty map and rejects
  duplicate keys.
- **Depends on**: none.

## Task E2: Duplicate node on the canvas
- `editor/FlowEditor.tsx` + `editor/useFlowEditor.ts`: a "Duplicate node" action
  clones the selected node under a fresh slug-valid id (reuse the id/slug
  helpers), copies its fields, offsets the position, adds it to the graph and
  `ui.xyflow`, and selects it.
- **Acceptance**: Vitest — duplicating a selected node adds one node with a new
  unique id and copied fields at an offset; it becomes the selection and persists
  through Save.
- **Depends on**: none.

## Task E3: Auto-layout (dependency-free)
- `editor/layout.ts`: pure `layout(nodes, edges) -> Record<id, {x,y}>` — longest-
  path layering from the entry node, ordered within ranks, fixed spacing,
  back-edges (router loops) non-ranking, disconnected nodes trailing.
  `FlowEditor.tsx`: an "Auto-layout" button applies the result to the xyflow nodes
  and `ui.xyflow`; Save persists it.
- **Acceptance**: Vitest — `layout` ranks a linear graph in order, places a branch
  on parallel ranks, terminates on a graph with a router loop-edge, and handles a
  disconnected node; the button updates positions and they round-trip through
  `ui.xyflow`.
- **Depends on**: none.

## Task E4: Build wiring, docs, CHANGELOG
- Rebuild + commit `dashboard/dist`; update `docs/dashboard.md` (editor section);
  add a CHANGELOG entry under the existing version header (no bump).
- **Acceptance**: `bun run validate` green incl. the committed-bundle guard.
- **Depends on**: E1–E3.

## Verification (phase 4 QA)
- Frontend typecheck, lint, vitest, build green; committed bundle matches.
- Layout util covered for linear / branch / loop / disconnected graphs.

## Notes
- Operator gate: implementation begins only on explicit go-ahead.
- Version stays 0.1.0 until the operator bumps it. No auto-merge armed.
- Dependency-free layout by choice (Variant 3); `@dagrejs/dagre` is the recorded
  fallback if larger graphs outgrow the hand-rolled layout.

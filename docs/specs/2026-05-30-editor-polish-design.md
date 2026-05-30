# Visual Editor Polish — Design

Status: draft (brainstorm complete, Variant 3 chosen) — implementation NOT started
Author: orchestrator (via feature-release-playbook)
Audience: implementation

## Problem statement

The `@xyflow/react` editor covers the core authoring loop, but three roadmap
items remain: the node inspector exposes only a subset of the schema's node
fields, there is no auto-layout, and a node cannot be duplicated on the canvas.
This epic delivers all three.

## Hermes / existing reuse (audited first)

- **Purely frontend** — Hermes provides nothing for graph layout, node
  inspection, or canvas editing; there is nothing to reuse from Hermes here.
- The **core schema already defines** every node field; the inspector simply does
  not surface all of them. Missing today: `description` (all node types), and
  agent_task `workdir`, `workspace.type`, `input_mapping`, `max_retries`,
  `timeout_seconds`. Richer fields therefore need **no schema change** — they
  reuse the existing `{ workflow, ui }` save path.
- The editor already round-trips layout losslessly through `ui.xyflow`;
  auto-layout and duplicate-node write into that same block.
- No layout library is in the dashboard deps, and the project keeps dependencies
  minimal — so auto-layout is dependency-free (Variant 3).

## Scope

- **Richer node-inspector fields**: edit `description` on every node type, and
  agent_task `workdir`, `workspace.type` (scratch|worktree), `input_mapping`
  (key→source map), `max_retries`, `timeout_seconds`.
- **Auto-layout**: an "Auto-layout" button that arranges the graph and writes the
  new positions into `ui.xyflow`.
- **Duplicate node**: clone the selected node under a fresh id at an offset,
  carrying its field values; the copy is selectable and persists on save.

## Out of scope (roadmap)

- New node *types* (e.g. the deferred Script node) — this epic only exposes
  existing fields. Auto-routing of edges, multi-select duplicate, undo/redo.

## Chosen approach (Variant 3 — dependency-free auto-layout)

- **Inspector fields.** Extend `NodeInspector` with the missing fields, typed per
  node kind. `input_mapping` is edited as key/value rows; `workspace.type` as a
  select; numeric fields as number inputs; `description` as a textarea. All write
  through the existing edit path so Save persists them in `{ workflow }` with no
  schema change.
- **Auto-layout.** A pure `layout(nodes, edges) -> Record<nodeId, {x,y}>` util: a
  longest-path layering (rank = distance from the entry node along forward edges),
  ordered within each rank, with fixed inter-rank/intra-rank spacing; router/loop
  back-edges do not affect ranking, and disconnected nodes are placed in a
  trailing rank. The button applies the result to the xyflow nodes and the
  `ui.xyflow` layout; Save persists it. The util is unit-tested independently of
  React.
- **Duplicate node.** A canvas/inspector action clones the selected node: a new
  unique id (slug-valid), copied fields, position offset by a small delta; the new
  node is added to the graph and `ui.xyflow` and becomes the selection.

## Design decisions

- **No new dependency** for layout — a pure function matches the project's
  minimal-deps ethos and is easy to test; `@dagrejs/dagre` is the recorded
  fallback if larger graphs outgrow it.
- **No schema change** — every new inspector field already exists in
  `schema/nodes.ts`; the epic only surfaces them.
- **Everything round-trips through `ui.xyflow`** so layout/duplicate stay
  lossless and Save remains `{ workflow, ui }`.
- **English in the repo;** operator chat in Russian.

## Component / route map (target)

```
apps/dashboard/src/editor/
  NodeInspector.tsx  + description (all) + agent_task workdir / workspace.type /
                       input_mapping / max_retries / timeout_seconds
  layout.ts          + layout(nodes, edges) -> positions   (pure, dep-free)
  FlowEditor.tsx     + "Auto-layout" button (applies layout -> ui.xyflow)
                     + "Duplicate node" action (clone selected -> new id + offset)
  useFlowEditor.ts   wiring for duplicate / apply-layout into editor state
```
No core, bridge, or backend changes (no schema change; no new routes).

## Risks and open questions

- **Cyclic graphs** (router loop-edges): the layering must ignore back-edges to
  avoid infinite ranks — covered by treating edges that point to an
  already-ranked node as non-ranking; test with a loop fixture.
- **`input_mapping` editing UX**: key/value rows must round-trip an empty map and
  reject duplicate keys; validated on the existing Save path.
- **Duplicate id collisions**: generate a fresh slug-valid id (reuse the existing
  id/slug helpers) and ensure uniqueness within the graph.

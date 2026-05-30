# Visual Editor + Run Inspector — Implementation Plan

NOT started — planning only; awaits operator go-ahead to implement.

TDD throughout (Vitest + jsdom + React Testing Library; failing test first).
Each task is one atomic conventional commit on `feat/xyflow-editor`. A frontend
`validate` (typecheck + lint + vitest + build) must stay green after each task,
and the existing root `bun run validate` must remain green.

## Task 0: Bundling spike — host-React shim + react-dom decision
- Stand up `apps/dashboard` (Vite + TS + React 19), the `react` / `react/jsx-runtime`
  shims over `window.__HERMES_PLUGIN_SDK__.React`, and a `build.lib` IIFE config
  emitting to `dashboard/dist/index.js`.
- Determine whether `@xyflow/react` imports `react-dom` at runtime; set the
  externals/bundling accordingly (bundle pinned react-dom, or shim react only).
- **Acceptance**: a trivial `App` that renders an `@xyflow/react` canvas builds to
  one self-executing `dist/index.js` that, loaded against mocked host globals,
  calls `register("workflows", …)` and mounts using the host React (no second
  React instance). This proves the bundle shape before any real UI.

## Task 1: SDK + typed API client
- `src/sdk.ts` (typed access to the SDK globals + `fetchJSON`) and `src/api/client.ts`
  (typed calls: list, get, save, validate, compilePreview, run, listRuns, getRun,
  cancel, retry, o2bStatus).
- **Acceptance**: client methods build the right URLs/payloads and parse responses;
  tested against a mocked `fetchJSON` (no network).

## Task 2: Templates page
- `pages/TemplatesPage.tsx`: fetch `GET /workflows`, render id/name/scope/trigger,
  open + run actions.
- **Acceptance**: renders rows from a mocked client; "run" calls `POST .../run`;
  "open" routes to the editor with the workflow id.

## Task 3: Flow editor — canvas + load/save round-trip
- `editor/FlowEditor.tsx` + `nodes/*`: map `{workflow, ui}` → xyflow nodes/edges;
  drag/connect/delete; track dirty state; serialize back to `{workflow, ui}` and
  `PUT`.
- **Acceptance**: loading a fixture renders the expected nodes/edges at their ui
  positions; an edit + save sends a `{workflow, ui}` body whose round-trip matches;
  dirty state toggles correctly.

## Task 4: Node inspector + palette
- `editor/NodeInspector.tsx` (per-type fields: agent_task profile/model/skills/
  prompt/…, condition, human_review options, finish outcome) and
  `editor/NodePalette.tsx` (add nodes).
- **Acceptance**: editing a field updates the selected node; adding from the
  palette inserts a node; changes mark the graph dirty.

## Task 5: Validation panel + compile preview
- `editor/ValidationPanel.tsx` (calls `POST .../validate`, renders errors/warnings)
  and `editor/CompilePreview.tsx` (calls `POST .../compile-preview`, renders the plan).
- **Acceptance**: a graph with a known error shows that error; a valid graph shows
  the compiled plan; save is gated/warned on validation errors.

## Task 6: Run inspector
- `run/RunInspector.tsx`: poll `GET /runs/{id}`, render the graph with per-node
  status highlighting, show node detail, wire cancel / retry (whole-run and node).
- **Acceptance**: node colours reflect statuses from a mocked run; cancel calls
  `POST .../cancel`; retry (with/without node) calls `POST .../retry`; polling stops
  when the run is terminal.

## Task 7: App shell + tab wiring
- `App.tsx` + `index.tsx`: shell switching Templates ↔ editor ↔ inspector; the O2B
  badge; `register("workflows", App)`.
- **Acceptance**: navigating between views works against mocked clients; the
  registered component mounts under the host React.

## Task 8: Build wiring, docs, CHANGELOG
- Root `package.json` workspaces include `apps/*`; a `build:dashboard` script emits
  the committed `dashboard/dist` bundle; a check that the committed bundle matches
  source. Update README / docs/dashboard.md (the editor is now live; how to build).
  CHANGELOG entry under the **existing 0.1.0** header (do not bump the version).
- **Acceptance**: `bun run validate` green; the frontend `validate` (typecheck +
  lint + vitest + build) green; the committed `dist` matches a fresh build.

## Verification (phase 4 QA)
- Frontend: typecheck, lint, `vitest run`, `vite build` all green.
- Root `bun run validate` still green (core + Python untouched).
- Smoke: load the built bundle against mocked host globals; exercise
  load → edit → validate → compile-preview → save → run → inspect in tests.

## Notes
- Operator gate: implementation begins only on explicit go-ahead.
- Version stays 0.1.0 until the operator bumps it.
- No auto-merge will be armed; merge happens only on explicit operator instruction.

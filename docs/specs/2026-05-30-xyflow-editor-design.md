# Visual Editor + Run Inspector — Design

Status: draft (brainstorm complete, Variant 1 chosen) — implementation NOT started
Author: orchestrator (via feature-release-playbook)
Audience: implementation
Builds on: the editor backend foundation (`docs/specs/2026-05-30-editor-backend-design.md`)

## Problem statement

The workflow engine and the editor's backend API are merged, but the dashboard
ships only a build-free, read-only stub. This epic adds the first real frontend:
a `@xyflow/react` visual editor for authoring workflows and a live run inspector,
bundled the way the Hermes dashboard loads plugins.

## Scope

- An `apps/dashboard` build that emits the plugin bundle to `dashboard/dist/index.js`
  (+ `dist/index.css`).
- **Templates page**: list workflows (id, name, scope, trigger, last status);
  actions: open in editor, run.
- **Flow editor** (`@xyflow/react`): node palette, canvas (drag, connect, delete,
  zoom/pan, dirty state), node inspector (per-type fields), validation panel,
  compile preview. Round-trip: load → edit → validate → compile-preview → save → run.
- **Run inspector**: render a run's graph with live node-status highlighting
  (completed / running / failed / waiting), per-node detail, cancel / retry.
- Frontend test suite (Vitest + jsdom + React Testing Library), TDD.

## Out of scope (next epic)

- Schedules page (needs a schedule-CRUD backend that does not exist yet).
- Settings page.
- Realtime push (WebSocket); the inspector polls `GET /runs/{id}` for now.

## Chosen approach (Variant 1 — Vite library build over the host React)

The dashboard is a React 19.2.5 SPA that loads each plugin's `entry` bundle by URL
and exposes `window.__HERMES_PLUGIN_SDK__` (`React`, `hooks`, `api`, `fetchJSON`,
shadcn `components`) and `window.__HERMES_PLUGINS__.register(name, Component)`. It
does **not** expose `react-dom`.

- `apps/dashboard` is a Vite + TypeScript + React 19 (TSX) workspace using
  `@xyflow/react`. `build.lib` with a single IIFE/UMD format emits one
  self-executing file (no code-splitting) to `dashboard/dist/index.js` plus
  `dist/index.css`. The entry module calls
  `window.__HERMES_PLUGINS__.register("workflows", App)` on load.
- `react` and `react/jsx-runtime` are aliased (Vite `resolve.alias`) to small shim
  modules that re-export `window.__HERMES_PLUGIN_SDK__.React` and implement
  `jsx/jsxs/Fragment` over `React.createElement`. Result: the bundle uses the
  host's single React instance and ships no second copy.
- `react-dom` handling depends on the spike below.

### The react-dom question (first task — resolve before building UI)

`@xyflow/react` peer-depends on `react` and `react-dom`. The host provides only
`react`. The first task spikes whether @xyflow/react v12 actually imports from
`react-dom` at runtime:
- If **yes**: bundle `react-dom`, pinned to a 19.2.x release compatible with the
  host React's internals (react-dom shares mutable internals with the React
  instance, so the version must align with host 19.2.5). It binds to the
  host React via the same alias, and we never create a second root.
- If **no**: drop the concern entirely; only `react` is shimmed.

Either way the build shape (Vite lib, host-React shim, single bundle) is the same;
only the externals list changes. The plan front-loads this so no UI is built on an
unproven bundling assumption.

## Design decisions

- **One React instance.** The host owns the tree; our `App` is an ordinary
  component passed to `register`. No `createRoot` of our own.
- **Layout round-trips through `ui.xyflow`.** The editor reads node positions +
  viewport from `GET /workflows/{id}`'s `ui` block and writes them back via `PUT`.
  The backend already round-trips `ui` losslessly.
- **Validation/compile are server-authoritative.** The editor calls
  `POST .../validate` and `POST .../compile-preview` rather than re-implementing
  graph rules client-side; it renders `{valid, errors, warnings}` and the plan.
- **Inspector polls.** `GET /runs/{id}` on an interval while the run is active;
  no new realtime transport this epic.
- **Local state only.** Hooks/reducer per page; no global store at this size.
- **English in the repo.** All UI strings, code, and docs in English (operator
  chat stays Russian, per project convention).

## Component map (target)

```
apps/dashboard/
  src/
    index.tsx                 register("workflows", App)
    shims/react.ts            re-export host React
    shims/jsx-runtime.ts      jsx/jsxs/Fragment over React.createElement
    sdk.ts                    typed access to __HERMES_PLUGIN_SDK__ + fetchJSON
    api/client.ts             typed calls to the workflows routes
    App.tsx                   tab shell: Templates | (editor) | (inspector)
    pages/TemplatesPage.tsx
    editor/FlowEditor.tsx     @xyflow/react canvas + state
    editor/NodePalette.tsx
    editor/NodeInspector.tsx
    editor/ValidationPanel.tsx
    editor/CompilePreview.tsx
    nodes/*.tsx               per-type node renderers
    run/RunInspector.tsx      live graph by node status + cancel/retry
  vite.config.ts              build.lib -> ../../dashboard/dist
  vitest.config.ts            jsdom + RTL, setup mocks SDK globals + fetchJSON
```

## File changes (high level)

New: the `apps/dashboard` workspace above; `dashboard/dist/index.js`+`index.css`
(regenerated build artifacts, committed). Modified: root `package.json` workspaces
(add `apps/*`), `dashboard/manifest.json` if a styles entry is needed; README /
docs/dashboard.md to describe the editor and the build. The Bun core and Python
bridge are untouched (zero new core deps).

## Risks and open questions

- **react-dom / host-React internals compatibility** — the primary risk; the
  spike resolves it before any UI work. If a pinned react-dom cannot bind cleanly
  to host React 19.2.5, fall back to validating whether @xyflow can run react-dom-free.
- **Bundle size** — @xyflow/react (+ maybe react-dom) pushes well past the ~150KB
  kanban baseline; acceptable for an editor, but note it.
- **Committed build artifact drift** — `dashboard/dist` is generated; the plan
  includes a build step and a check so the committed bundle matches source.
- **Testing xyflow in jsdom** — canvas measurement APIs are stubbed in jsdom; tests
  target component behaviour and API wiring, not pixel layout (xyflow provides test
  helpers / `ReactFlowProvider` for this).
- **No realtime** — inspector polling is a deliberate simplification; a WebSocket
  feed is a later enhancement.

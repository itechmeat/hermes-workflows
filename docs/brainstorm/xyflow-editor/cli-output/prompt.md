You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Build the **visual workflow editor frontend** for the Hermes Workflows dashboard plugin, plus a **live run inspector**. This is the first frontend in the project. It must ship as a single bundle the Hermes dashboard loads, wired to an HTTP API that already exists.

Deliver (conceptually — you only produce variants here):
1. A frontend build that emits the plugin bundle the Hermes dashboard loads at `dashboard/dist/index.js` (+ optional `dist/index.css`).
2. A **Templates page**: list workflows (id, name, scope, trigger, last status) with actions (open, run).
3. A **Flow editor** using `@xyflow/react` (https://github.com/xyflow/xyflow): left node palette, center canvas (drag/connect/delete, zoom/pan, dirty state), right node inspector (per-type fields), bottom validation panel + compile preview. Round-trip: load graph -> edit -> validate -> compile-preview -> save -> run.
4. A **run inspector**: render a run's graph with live node-status highlighting (completed/running/failed/waiting), show per-node detail, and cancel / retry actions.

# Project context

hermes-workflows is a Hermes Agent dashboard plugin. The backend (already merged) exposes these routes under `/api/plugins/workflows/`:
- `GET /workflows`, `GET /workflows/{id}` -> `{ workflow, ui?, path }`
- `PUT /workflows/{id}` (body `{ workflow, ui }`; 400 on invalid graph / id mismatch)
- `POST /workflows/{id}/validate` -> `{ valid, errors, warnings }`
- `POST /workflows/{id}/compile-preview` -> Hermes plan
- `POST /workflows/{id}/run`
- `GET /runs`, `GET /runs/{id}` (full run state, per-node status), `POST /runs/{id}/cancel`, `POST /runs/{id}/retry` (optional `{node_id}`)
- `GET /o2b-status`

The workflow spec schema (TypeScript types) and a `ui.xyflow` layout block (node positions `{id,x,y}` + viewport `{x,y,zoom}`) already exist in `packages/core`. Node types: trigger (manual|cron), agent_task, condition, human_review, finish. Edges carry structured conditions (node_status, review_status) and a `fallback` flag.

## The Hermes dashboard host contract (verified, critical)

The dashboard is a React 19.2.5 single-page app. It loads each plugin's `entry` bundle (from `manifest.json`, currently `dist/index.js`) dynamically by URL, then the bundle registers itself by calling a global:

- `window.__HERMES_PLUGINS__.register(name, Component)` (also `.registerSlot`).
- `window.__HERMES_PLUGIN_SDK__` exposes:
  - `React` (the host's React 19.2.5 instance),
  - `hooks`: `{ useState, useEffect, useCallback, useMemo, useRef, useContext, createContext }`,
  - `api`, `fetchJSON` (HTTP helpers),
  - `components` (shadcn primitives: Card, CardHeader, ...).
- It does **NOT** expose `react-dom`, JSX runtime, a router, or a build toolchain.

Existing plugin frontends (kanban ~150KB, the current workflows stub) are **hand-written plain IIFE** files using `window.__HERMES_PLUGIN_SDK__.React` via `React.createElement` — no build step, no bundler. There is no `apps/` or Vite anywhere in this project yet.

## Constraints

- The bundle MUST reuse the host's React instance (a second React copy breaks hooks and bloats the bundle). The host exposes `React` but **not** `react-dom`.
- `@xyflow/react` is a real React component library with peer deps on `react` AND `react-dom` (it uses portals/measurement). The host does not provide `react-dom`. Resolving this cleanly is the crux.
- Output is a single committed bundle in `dashboard/dist/` (loaded by URL, so IIFE/UMD-style self-execution that calls `__HERMES_PLUGINS__.register`). No code-splitting / dynamic chunks (the host loads one entry file).
- The project keeps its existing zero-runtime-dependency posture for the Python/Bun core; the frontend is a separate build with its own devDeps. Do not add deps to the core.
- TDD is required: the playbook expects failing-tests-first. Propose how to test the editor without a real browser (jsdom + a React testing lib, mocking `fetchJSON`/the SDK globals).
- The operator answers the dashboard in Russian but all repo artifacts (code, UI strings, docs) stay in English.
- Keep scope to: build pipeline, Templates page, Flow editor, run inspector. Out of scope: schedules page, settings page (next epic).

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

The variants should differ primarily on the central fork: **how to build and bundle a React 19 + `@xyflow/react` app into one host-loadable file that reuses the host's React instance and resolves the missing `react-dom`** — e.g. (a) Vite library build with `react` externalized to a shim over `window.__HERMES_PLUGIN_SDK__.React` and `react-dom` bundled, (b) bundle both react and react-dom (accept a self-contained React island rendered into a container the host gives us), (c) avoid `@xyflow/react`'s react-dom needs some other way. Also cover, secondarily: how the editor's client state and API calls are structured, and the testing approach.

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why, given the host contract and constraints.

Output nothing outside of these sections.

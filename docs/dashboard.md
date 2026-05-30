# Dashboard

The dashboard ships a **Workflows** tab with a visual `@xyflow/react` workflow
editor and a live run inspector. The frontend is built from the `apps/dashboard`
workspace into a single bundle the Hermes dashboard loads; the backend exports an
`APIRouter` that the dashboard's running FastAPI app mounts (it never starts its
own web server).

## Contract

`dashboard/manifest.json` follows the Hermes dashboard-plugin contract:

```json
{
  "name": "workflows",
  "label": "Workflows",
  "icon": "Workflow",
  "version": "0.1.0",
  "tab": { "path": "/workflows", "position": "after:skills" },
  "slots": [],
  "entry": "dist/index.js",
  "css": "dist/index.css",
  "api": "plugin_api.py"
}
```

The dashboard host loads `entry` as a script and, when `css` is present, injects
it as a stylesheet `<link>` — that is how the bundled `@xyflow/react` styles are
applied.

## Backend

`dashboard/plugin_api.py` exports a FastAPI `APIRouter`, mounted by the dashboard
runtime at `/api/plugins/workflows/`. The routes are thin: each delegates to the
TypeScript core CLI (the core owns all spec logic) or the orchestrator.

Listing and status:

- `GET /workflows` — workflows discovered under the spec roots.
- `GET /runs` — active runs from `runs.db`.
- `GET /o2b-status` — `{ "connected": bool }`, best-effort and never raising.

Authoring (for the editor):

- `GET /workflows/{id}` — the full graph `{ workflow, ui?, path }`; `404` if absent.
- `PUT /workflows/{id}` — save an edited graph. Body is `{ workflow, ui? }`; the
  body id must match the URL. An invalid graph or id mismatch is a `400` (the
  core validates before writing, so no invalid spec is persisted).
- `POST /workflows/{id}/validate` — `{ valid, errors, warnings }` for the saved spec.
- `POST /workflows/{id}/compile-preview` — the Hermes plan the spec compiles to.

Execution control:

- `POST /workflows/{id}/run` — start a run (same path as the CLI `run`); `404` if absent.
- `GET /runs/{id}` — full run state with per-node detail, for the run inspector; `404` if absent.
- `POST /runs/{id}/cancel` — cancel a run; `404` if absent.
- `POST /runs/{id}/retry` — retry a run, or one failed node via `{ "node_id": "..." }`.

### Testing note

`fastapi` is a **test-only** dependency for this plugin and is intentionally not
declared in `pyproject.toml`: at runtime the Hermes dashboard provides the
FastAPI app and imports this router; the plugin never spawns its own instance.
The route tests are therefore guarded with `pytest.importorskip("fastapi")` and
skip cleanly in environments (like CI without the dashboard runtime) where
FastAPI is not installed.

## Frontend

The frontend lives in the `apps/dashboard` workspace (Vite + React 19 +
`@xyflow/react`, TypeScript) and builds to a single self-executing bundle at
`dashboard/dist/index.js` (+ `index.css`), which is committed.

### Host integration

The Hermes dashboard is a React 19 SPA that exposes its own React on
`window.__HERMES_PLUGIN_SDK__` but not `react-dom`. The build reuses that single
React instance: `react` is aliased to a shim that re-exports the host React (so
no second React ships), `react/jsx-runtime` stays the real production runtime,
and `react-dom` is bundled (pinned to the host's 19.2.x) for `@xyflow/react`'s
`createPortal`, binding to the host React through the same alias. The entry
registers the root component via
`window.__HERMES_PLUGINS__.register("workflows", App)`.

### Views

- **Templates** — lists workflows (name, id, scope, trigger) with Open (editor)
  and Run (starts a run, opens the inspector) actions.
- **Editor** — the `@xyflow/react` canvas with a node palette, a per-type node
  inspector, and bottom panels for server-side validation and compile preview.
  Layout round-trips losslessly through the spec's `ui.xyflow` block; Save sends
  `{ workflow, ui }` via `PUT` (the server rejects an invalid graph).
- **Run inspector** — renders the run graph with per-node status colours, polls
  `GET /runs/{id}` while the run is active (stopping once terminal), and offers
  whole-run cancel/retry plus per-node retry.

### Build

```bash
bun run dashboard:build      # build the committed bundle (apps/dashboard -> dashboard/dist)
bun run dashboard:test       # typecheck-free Vitest run (jsdom + RTL)
bun run dashboard:typecheck  # tsc --noEmit for the frontend
```

`bun run validate` runs the core checks plus the frontend typecheck, tests, a
fresh build, and a `git diff` guard that the committed `dashboard/dist` matches
that build. Tests use Vitest with jsdom and React Testing Library; the spec/run
types are shared from `@hermes-workflows/core` via type-only imports.

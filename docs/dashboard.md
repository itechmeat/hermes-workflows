# Dashboard

The dashboard ships a **Workflows** tab with a visual `@xyflow/react` workflow
editor, a live run inspector, and **Runs**, **Schedules**, and **Settings**
views. The frontend is built from the `apps/dashboard` workspace into a single
bundle the Hermes dashboard loads; the backend exports an `APIRouter` that the
dashboard's running FastAPI app mounts (it never starts its own web server).

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

- `GET /workflows` — workflows discovered under the spec roots. Each row carries
  `enabled` plus best-effort Templates-page columns: `last_run_at` / `last_status`
  (the workflow's most recent run) and `next_run_at` (its cron schedule, `null`
  when it has none). The columns are overlays — listing never fails if the run
  store is empty or the cron module is unavailable.
- `GET /runs?scope=active|all` — runs from `runs.db`, each shaped to the Runs-page
  row (run id, workflow, project, status, current node, started/finished,
  duration). `scope=active` (the default) keeps the historical active-only
  behaviour; `scope=all` adds finished runs.
- `GET /o2b-status` — `{ "connected": bool }`, best-effort and never raising.

Authoring (for the editor):

- `GET /workflows/{id}` — the full graph `{ workflow, ui?, path }`; `404` if absent.
- `POST /workflows` — create a new workflow. Body is `{ workflow, ui? }`; the core
  refuses to overwrite, so a clashing id is a `409` and an invalid graph or bad id
  is a `400`. Returns the created `{ workflow, ui?, path }`.
- `PUT /workflows/{id}` — save an edited graph. Body is `{ workflow, ui? }`; the
  body id must match the URL. An invalid graph or id mismatch is a `400` (the
  core validates before writing, so no invalid spec is persisted).
- `DELETE /workflows/{id}` — delete a workflow's spec; `{ deleted: true }`, or
  `404` if no spec matched.
- `GET /workflows/{id}/export` — the canonical on-disk YAML in a JSON envelope
  `{ id, filename, yaml }` (so it travels over the host's JSON-only `fetchJSON`);
  `404` if absent. The stored file is the authority — no second serializer.
- `POST /workflows/{id}/validate` — `{ valid, errors, warnings }` for the saved spec.
- `POST /workflows/{id}/compile-preview` — the Hermes plan the spec compiles to.
- `PUT /workflows/{id}/enabled` — enable/disable a workflow (body `{ "enabled": bool }`).
  Writes `enabled` into the spec (the single source of truth) and pauses/resumes
  any cron job to match; `404` if the workflow does not exist.

Execution control:

- `POST /workflows/{id}/run` — start a run (same path as the CLI `run`); `404` if
  absent, `409` if the workflow is disabled.
- `GET /runs/{id}` — full run state with per-node detail, for the run inspector; `404` if absent.
- `POST /runs/{id}/cancel` — cancel a run; `404` if absent.
- `POST /runs/{id}/retry` — retry a run, or one failed node via `{ "node_id": "..." }`.
- `GET /runs/{id}/export` — the full run-load bundle in a JSON envelope
  `{ run_id, filename, json }` for download; `404` if absent.

Schedules (thin shells over the Hermes cron bridge — Hermes cron owns the
schedules; these edit the live cron job, not the on-disk spec):

- `GET /schedules` — each workflow cron schedule (workflow, cron expression,
  timezone, enabled, last/next run, Hermes Cron ID).
- `POST /schedules/{id}/pause` · `.../resume` · `.../run` — pause, resume, or
  trigger now; `404` if the job is unknown.
- `PUT /schedules/{id}` — change the cron expression (body `{ "cron": "..." }`);
  a bad expression is `400`, an unknown job `404`.
- `DELETE /schedules/{id}` — remove the schedule; `404` if absent.

Settings (over the host config `plugins.workflows` namespace):

- `GET /settings` — `{ values, schema }`: effective values (config ▸ env ▸
  default) plus the field schema for rendering.
- `PUT /settings` — persist a patch (merged, not clobbering other config) and
  return the new effective values; an unknown key or invalid value is `400`.

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

- **Templates** — lists workflows (name, id, scope, trigger) with a Status badge
  (enabled/disabled) and run/schedule columns (Last run, Last status, Next run),
  and is the authoring surface. **New workflow** opens a modal (name, scope,
  trigger; the id is generated, not user-entered) that seeds a minimal valid graph
  and drops straight into the editor. Per row: Open (editor), Run (starts a run,
  opens the inspector; disabled for a disabled workflow), Enable/Disable (toggles
  the spec's `enabled` flag and syncs any cron job), Duplicate (copy under a new
  id), Export (download the canonical YAML), and Delete (with confirmation). A
  disabled row is dimmed.
- **Editor** — the `@xyflow/react` canvas with a node palette, a per-type node
  inspector, and bottom panels for server-side validation and compile preview.
  The inspector edits `description` on every node type and, for `agent_task`,
  profile, model, skills, prompt, workdir, workspace type, max retries, timeout,
  and `input_mapping` (key/value rows; a duplicate key is flagged and withheld);
  for a `script` node it edits command, workdir, timeout, and the env allowlist,
  and the compile preview shows the compiled command before a run.
  Toolbar actions **Duplicate node** (clone the selected node at an offset) and
  **Auto-layout** (arrange the graph by a dependency-free layered layout) write
  through the same save path. Layout round-trips losslessly through the spec's
  `ui.xyflow` block; Save sends `{ workflow, ui }` via `PUT` (the server rejects
  an invalid graph).
- **Run inspector** — renders the run graph with per-node status colours, polls
  `GET /runs/{id}` while the run is active (stopping once terminal), and offers
  whole-run cancel/retry plus per-node retry.
- **Runs** — a table of every run (Active-only filter) with the run id, workflow,
  project, status, current node, started/finished, and duration. Per row: Open
  (inspector), Cancel, Retry node, Retry run, and Export logs (downloads the
  run-load bundle as JSON).
- **Schedules** — a table of each workflow cron schedule (workflow, cron
  expression, timezone, enabled, last/next run, Hermes Cron ID). Per row: Pause,
  Resume, Run now, Edit (prompts for a new cron expression), and Delete; the list
  refreshes after each action.
- **Settings** — a schema-driven form over storage / execution / kanban /
  open_second_brain. It reads effective values (config ▸ env ▸ default) and saves
  to the Hermes config `plugins.workflows` namespace. `kanban.internal_board` is
  honoured at runtime; knobs the engine does not consume yet are labelled
  *not yet enforced*.

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

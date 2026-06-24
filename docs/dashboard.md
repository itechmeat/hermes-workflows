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

`dashboard/plugin_api.py` exports a FastAPI `APIRouter`, served at
`/api/plugins/workflows/`. The routes are thin: each delegates to the
TypeScript core CLI (the core owns all spec logic) or the orchestrator.

How the router reaches that path depends on the host. A **bundled** Hermes
dashboard auto-imports the router and mounts it directly. For a **non-bundled**
plugin (installed from a repo / symlink — `source: user`/`project`), Hermes no
longer auto-imports a plugin's Python backend (GHSA-5qr3-c538-wm9j): the same
router is served by a standalone sidecar instead — see
[Running the backend](#running-the-backend-standalone-sidecar) below. Either
way the router is the single source of truth; nothing re-declares the routes.

Listing and status:

- `GET /workflows` — workflows discovered under the spec roots. Each row carries
  `enabled` plus best-effort Templates-page columns: `last_run_at` / `last_status`
  (the workflow's most recent run) and `next_run_at` (its cron schedule, `null`
  when it has none). The columns are overlays — listing never fails if the run
  store is empty or the cron module is unavailable.
- `GET /runs?scope=active|all&workflow_id=...` — runs from `runs.db`, each shaped
  to the Runs-page row (run id, workflow, project, status, current node,
  started/finished, duration), newest first. `scope=active` (the default) keeps
  the historical active-only behaviour; `scope=all` adds finished runs;
  `workflow_id` narrows to one workflow's runs (the editor's attach lookup).
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
  absent, `409` if the workflow is disabled. Runs are **single-flight**: one
  workflow may have at most one active run (`created`/`running`/`waiting`), so a
  second start is a `409` whose detail names the blocking run — cancel it or
  wait for it to finish. The guard lives in the core at `run-create`, so the
  CLI and cron-scheduled starts are refused the same way.
- `GET /runs/{id}` — full run state with per-node detail, for the run inspector;
  `404` if absent. Nodes the engine has not settled yet get their worker's
  telemetry sidecar overlaid live (best-effort), so the inspector's poll shows
  token/tool counts and pending command approvals while a node runs.
- `POST /runs/{id}/cancel` — cancel a run; `404` if absent.
- `POST /runs/{id}/retry` — retry a run, or one failed node via `{ "node_id": "..." }`.
  Retry revives the run, so the single-flight guard applies here too: reviving
  next to a *different* active run of the same workflow is a `409` (retrying
  the active run itself is fine).
- `GET /runs/{id}/export` — the full run-load bundle in a JSON envelope
  `{ run_id, filename, json }` for download; `404` if absent. A traced run
  (`observability.trace_enabled`) additionally carries `trace` +
  `trace_filename`, which the Runs page saves as a second
  `<run_id>.trace.jsonl` file.

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

### Running the backend (standalone sidecar)

Recent Hermes refuses to auto-import the Python backend of a **non-bundled**
plugin — only bundled plugins may contribute dashboard backend routes
(GHSA-5qr3-c538-wm9j / #43719). Installed from a repo or symlink, this plugin is
non-bundled, so its `plugin_api.py` is not mounted by the gateway and the
Workflows tab loads but cannot fetch data.

The fix is to run the backend out-of-process. `hermes_workflows.dashboard_api`
builds an ASGI app that mounts the **same** `plugin_api.py` router (no routes are
re-declared) under `/api/plugins/workflows`, plus a `GET /healthz` liveness
route. Start it with the wrapper (preferred) or the module:

```bash
bin/hermes-workflows-dashboard-api          # uses the Hermes venv interpreter
python -m hermes_workflows.dashboard_api    # if fastapi/uvicorn are importable
```

Host and port come from `plugins.workflows.dashboard_api_host` /
`plugins.workflows.dashboard_api_port`
(config ▸ env ▸ default `127.0.0.1:9123`; env
`HERMES_WORKFLOWS_DASHBOARD_API_{HOST,PORT}`). The sidecar binds **loopback**
only and ships no auth of its own: it inherits the dashboard's trust model —
loopback bind plus the operator's reverse proxy, which already gates the Hermes
dashboard. Point that proxy's `/api/plugins/workflows/*` prefix at the sidecar,
**before** the catch-all that proxies the dashboard, so the frontend's existing
same-origin calls reach it unchanged.

Set this up once: point the service at the **stable install path**
(`~/.hermes/plugins/hermes-workflows`, not a version-specific copy) so a
`hermes plugins update` replaces the contents in place and never breaks the
service. The Workflows tab shows a copy-paste agent prompt for this exact setup
when its backend is unreachable.

systemd (Linux, user service):

```ini
# ~/.config/systemd/user/hermes-workflows-dashboard-api.service
[Unit]
Description=Hermes Workflows dashboard-API sidecar
After=network.target

[Service]
Type=simple
ExecStart=%h/.hermes/plugins/hermes-workflows/bin/hermes-workflows-dashboard-api
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now hermes-workflows-dashboard-api.service
```

launchd (macOS, LaunchAgent — runs at login, restarts on crash):

```xml
<!-- ~/Library/LaunchAgents/dev.hermes.workflows.dashboard-api.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>dev.hermes.workflows.dashboard-api</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/sh</string>
      <string>-lc</string>
      <string>exec "$HOME/.hermes/plugins/hermes-workflows/bin/hermes-workflows-dashboard-api"</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
  </dict>
</plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/dev.hermes.workflows.dashboard-api.plist
```

`KeepAlive=true` respawns the sidecar unconditionally. If its port is already
taken the process exits on bind and launchd restarts it in a throttled loop with
no backoff cap, so free the port (or change it, below) rather than leaving it to
spin. The systemd unit's `Restart=on-failure` is bounded by systemd's
start-limit; launchd has no equivalent.

The sidecar's host/port default to `127.0.0.1:9123`; override with the
`plugins.workflows.dashboard_api_{host,port}` config keys or the
`HERMES_WORKFLOWS_DASHBOARD_API_{HOST,PORT}` env vars, and point the proxy below
at the same address.

Caddy (inside the dashboard site block; site-level auth still gates both):

```
handle /api/plugins/workflows/* {
    reverse_proxy 127.0.0.1:9123 {
        header_up Host 127.0.0.1:9123
    }
}
handle {
    reverse_proxy 127.0.0.1:9119   # the Hermes dashboard
}
```

nginx (inside the `server {}` that proxies the dashboard; the more specific
`location` wins):

```nginx
location /api/plugins/workflows/ {
    proxy_pass http://127.0.0.1:9123;
}
location / {
    proxy_pass http://127.0.0.1:9119;   # the Hermes dashboard
}
```

A bundled install needs none of this — the gateway mounts the router directly.

### Testing note

`fastapi`/`uvicorn` ship with the Hermes dashboard runtime (the sidecar runs
under that interpreter) and are intentionally **not** declared in
`pyproject.toml`. The route and sidecar tests are guarded with
`pytest.importorskip("fastapi")` and skip cleanly in environments (like CI
without the dashboard runtime) where FastAPI is not installed.

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
  and drops straight into the editor. **Import** reads a workflow JSON file (the
  `{ workflow, ui? }` authoring shape, as Export JSON produces) and creates that
  workflow through the normal validation path — a clashing id (409) or invalid
  graph (400) is reported verbatim, never silently overwritten or renamed. Per
  row: Open (editor), Run (starts a run, opens the inspector; disabled for a
  disabled workflow), Enable/Disable (toggles the spec's `enabled` flag and syncs
  any cron job), Duplicate (copy under a new id), Export YAML (download the
  canonical on-disk YAML), Export JSON (download `<id>.workflow.json` — graph
  plus layout, importable here and readable by the spec store), and Delete (with
  confirmation). A disabled row is dimmed.
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
  an invalid graph). **Play** runs the workflow being edited: a dirty graph is
  saved first (a failed save aborts the start), the canvas then switches to the
  read-only run pipeline showing live per-node status at the editor's own node
  positions while editing stays locked, and once the run settles — or parks in
  `waiting` for a human review, which only the inspector can answer — the view
  hands off to the run inspector. A rejected start or a failed poll surfaces as
  a visible alert next to the toolbar status. Opening the editor while the
  workflow already has an active run **attaches** to it: the mount checks
  `GET /runs?scope=active&workflow_id=...` (Play is held until the check
  lands), the canvas enters the same read-only playback, and a run parked in
  `waiting` hands off to the inspector immediately. A start refused by the
  single-flight guard re-checks once and adopts the concurrent run while
  keeping the refusal visible; a failed attach check is reported, never
  silently treated as idle.
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

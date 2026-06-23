# Workflows dashboard backend as a standalone sidecar

## Problem

The Workflows dashboard tab loads its JavaScript but cannot fetch any data — it
appears empty / "doesn't open". The cause is an upstream Hermes security
hardening, not a defect in this plugin.

Hermes core (`hermes_cli/web_server.py`) now refuses to auto-import the Python
backend (`dashboard/plugin_api.py`) of any **non-bundled** plugin:

```python
_NON_BUNDLED_PLUGIN_SOURCES = frozenset({"user", "project"})
# only bundled plugins may auto-import Python backend routes;
# non-bundled plugins may extend the dashboard with static UI assets only
```

Reference: GHSA-5qr3-c538-wm9j (#29156) / #43719 — an attacker-controlled
manifest `api:` path could be imported as a Python module (RCE). The mitigation
is double-guarded (discovery nulls `_api_file`; the importlib call-site
re-refuses) and exposes **no operator allowlist / config escape hatch**.

`hermes-workflows` is installed as a symlink into `~/.hermes/plugins` →
`source: user` → non-bundled → its 26-route `plugin_api.py` is refused. The
dashboard registry reports `has_api: false` for `workflows` (vs `true` for
bundled `kanban`/`achievements`), and the gateway logs at startup:

```
WARNING hermes_cli.web_server: Plugin workflows: refusing dashboard backend
api=plugin_api.py (only bundled plugins may auto-import Python backend routes...)
```

The model-facing plugin tools (`workflow_run/status/...`) and the operator CLI
are unaffected — they do not depend on the dashboard backend. This breaks the
dashboard for every self-hosted user on the hardened Hermes, not just one
install.

## Goals

- Restore the Workflows dashboard tab (list/inspect workflows, runs, schedules,
  run/cancel/retry/review) on a hardened Hermes.
- Ship the fix inside the plugin repository as the supported way to run the
  dashboard backend — portable for all users, not a per-install ops hack.
- No edits to Hermes core or its install (the install is kept `== main`).
- Reuse the existing `plugin_api.py` router verbatim — no route duplication, no
  second backend to maintain.
- No frontend change.

## Non-goals

- Rewriting the backend in TypeScript. The 26 routes are a thin bridge that
  shells into the TS core CLI and reads Hermes-side state (config, `runs.db`,
  cron `jobs.json`, telemetry); the TS core remains the engine source of truth,
  invoked via subprocess exactly as today. A TS rewrite would duplicate the
  Hermes-integration glue in a second language and is a separate, larger
  refactor — out of scope here.
- An upstream allowlist for trusted non-bundled plugin APIs. Worth filing as a
  parallel upstream issue/PR, but it does not gate this fix and is tracked
  separately.
- Changing the dashboard's auth/trust model.

## Architecture

The dashboard backend moves from "auto-imported into the gateway process" to
"a standalone ASGI sidecar process", reached through the operator's existing
reverse proxy. The frontend keeps calling `/api/plugins/workflows/*`
same-origin; the proxy routes that path prefix to the sidecar instead of to the
gateway.

```
browser ──(/api/plugins/workflows/*)──▶ reverse proxy ──▶ sidecar (uvicorn, loopback)
        ──(everything else)───────────▶ reverse proxy ──▶ gateway dashboard :9119
```

### Components

1. **`hermes_workflows/dashboard_api.py`** (new module — the sidecar app)
   - Builds a `FastAPI()` app and mounts the **existing** router:
     `app.include_router(<router from dashboard/plugin_api.py>, prefix="/api/plugins/workflows")`.
   - `dashboard/plugin_api.py` lives outside the `hermes_workflows` package, so
     the module loads it by file path via `importlib.util` (resolving the path
     relative to the repo root), then reads its `router` attribute. The router
     stays the single source of truth; no routes are copied.
   - Adds a single liveness route `GET /healthz` → `{"status": "ok"}` for the
     systemd unit / readiness probes. It is defined on the app, outside the
     plugin prefix, so it never collides with plugin routes.
   - `main()` reads host/port (see Config) and runs `uvicorn.run(app, ...)`.
   - Module is runnable as `python -m hermes_workflows.dashboard_api`.

2. **`bin/hermes-workflows-dashboard-api`** (new wrapper)
   - Mirrors the existing `bin/hermes-workflows` wrapper; execs
     `python -m hermes_workflows.dashboard_api "$@"` under the same interpreter
     resolution the existing wrapper uses.

3. **Config** (reuse `hermes_workflows/config.py`)
   - Read `plugins.workflows.dashboard_api_host` (default `127.0.0.1`) and
     `plugins.workflows.dashboard_api_port` (default `9123`) through the existing
     config accessor that already reads the Hermes config tree. Provide an
     environment fallback (`HERMES_WORKFLOWS_DASHBOARD_API_HOST` /
     `_PORT`) for users who run the sidecar outside a Hermes config context.
     No hardcoded values in the app body.

### Why the router runs unchanged out-of-process

The routes are plain `async def`/`def` functions taking path/body params; there
are **no** `Depends(...)` injections and **no** `request.app.state` reads — they
operate against on-disk state (`runs.db`, `kanban.db`, cron `jobs.json`,
telemetry dir) and subprocess calls to the TS core CLI, all process-independent.
The gateway's `401` on these routes comes from a **global** auth middleware in
`web_server.py`, not from the router itself, so the standalone app serves the
router without that gate (security is provided at the proxy + loopback bind —
see below). **Build-time check:** confirm no auth dependency or app-state
coupling exists in `plugin_api.py` before wiring (grep already indicates none).

## Auth / exposure model

The sidecar inherits the exact trust model the gateway dashboard already uses:

- **Bind loopback only** (default `127.0.0.1`). The sidecar is never directly
  reachable from the network.
- The gateway dashboard is itself loopback-trusted (`should_require_auth`:
  loopback ⇒ no auth) and is gated in front by the operator's reverse proxy
  (on this VPS: Caddy `basic_auth` on `hermes.techmeat.dev`). The sidecar sits
  behind the **same** proxy on the **same** origin, so the same gate applies to
  `/api/plugins/workflows/*` with no new auth code and no token coupling.
- No new credentials, no CORS (same-origin), no public surface.

## Deployment

### This VPS

- **systemd user unit** `hermes-workflows-dashboard-api.service`: runs the
  `bin/hermes-workflows-dashboard-api` wrapper as the gateway user, on the
  configured loopback port, `Restart=on-failure`. Enabled + started.
- **Caddy** `hermes.techmeat.dev` block: add, **before** the catch-all
  `reverse_proxy 127.0.0.1:9119`, a path handler:

  ```
  handle /api/plugins/workflows/* {
      reverse_proxy 127.0.0.1:9123
  }
  ```

  The existing site-level `basic_auth` already wraps the whole block. Validate
  with `caddy validate` and graceful reload; the dashboard catch-all is
  unchanged.

### For all users (repo docs)

Ship documentation describing: the sidecar exists because Hermes restricts
non-bundled plugin backends; how to start it (`bin/hermes-workflows-dashboard-api`
or `python -m hermes_workflows.dashboard_api`); a systemd unit example; and
ready-to-paste reverse-proxy snippets for **Caddy** and **nginx** that route
`/api/plugins/workflows/*` to the sidecar in front of the Hermes dashboard.

## Testing

TDD — write failing tests first, then the module.

- **Sidecar mounting test** (`apps`/python test): build the app via the module,
  drive it with `fastapi.testclient.TestClient`, assert:
  - `GET /healthz` → 200 `{"status": "ok"}`.
  - At least one plugin route is reachable under the prefix
    (e.g. `GET /api/plugins/workflows/workflows` returns 200 JSON), proving the
    existing router is mounted at `/api/plugins/workflows`.
  - A route NOT under the prefix is 404 (prefix is correct, not a catch-all).
- **No route duplication**: assert the app's plugin-prefixed routes are exactly
  the imported router's routes (same count/paths), guarding against accidental
  re-declaration.
- Keep the existing core/dashboard test suites green; run repo validate at zero
  warnings.

## Repo deliverables

- `hermes_workflows/dashboard_api.py`, `bin/hermes-workflows-dashboard-api`,
  config accessor additions in `config.py`, tests, and docs (above).
- `CHANGELOG.md` entry under a single new version header; version bump in
  `package.json` / `pyproject.toml` / `plugin.yaml` (one version for this PR);
  README/LLMS pointer to the dashboard-backend doc.
- Release after merge.

## Acceptance

- On the hardened Hermes, the Workflows dashboard tab opens and lists/loads
  workflows, runs, and schedules again; run/cancel/retry/review work.
- No Hermes core or install edits; `git -C /usr/local/lib/hermes-agent status`
  stays clean.
- The sidecar reuses the existing router (tests assert no route duplication) and
  binds loopback only.
- Repo ships the systemd + Caddy/nginx wiring docs; this VPS is wired and the
  tab is verified working through `hermes.techmeat.dev`.

## Risks / open checks

- **Router self-containment** must be confirmed at build time (no
  `Depends`/`app.state`/global-middleware reliance). Strongly indicated by grep;
  verify before wiring.
- **Interpreter/deps**: the sidecar must run under an interpreter that has
  `fastapi`/`uvicorn` and can import `hermes_workflows` + the Hermes bridge
  (the gateway venv satisfies this: `uvicorn 0.41`, `fastapi 0.133`). The
  systemd unit pins that interpreter.
- **Port default** `9123` must not collide on a given host; it is configurable,
  and the docs call this out.
- **Cross-process side effects**: routes that arm the advance tick write Hermes
  cron `jobs.json`, which the running gateway's ticker picks up — already
  process-agnostic by design; no shared in-memory state.

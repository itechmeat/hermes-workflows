"""Standalone dashboard-API sidecar.

Upstream Hermes no longer auto-imports the Python backend of a non-bundled
plugin (GHSA-5qr3-c538-wm9j / #43719): only bundled plugins may contribute
dashboard backend routes, so this plugin's ``dashboard/plugin_api.py`` is
refused and the Workflows tab loads but cannot fetch data.

This module serves that same backend out-of-process. It mounts the EXISTING
``dashboard/plugin_api.py`` router verbatim — no routes are re-declared here —
under the ``/api/plugins/workflows`` prefix the frontend already calls, plus a
``/healthz`` liveness route. The operator's reverse proxy routes that path
prefix to this sidecar in front of the gateway dashboard; the sidecar binds
loopback only, inheriting the dashboard's own trust model (loopback + a
proxy-level gate), so no auth code lives here.

Run it with ``python -m hermes_workflows.dashboard_api`` or the
``bin/hermes-workflows-dashboard-api`` wrapper.
"""

from __future__ import annotations

import importlib.util

from fastapi import FastAPI

from hermes_workflows import config

API_PREFIX = "/api/plugins/workflows"


def _load_plugin_api_router():
    """Load the ``router`` from ``dashboard/plugin_api.py`` by file path.

    ``plugin_api.py`` lives outside the importable ``hermes_workflows`` package
    (under ``dashboard/``), so it is loaded the same way the gateway loads it —
    by path — keeping it the single source of truth for the routes."""
    plugin_api_path = config.repo_root() / "dashboard" / "plugin_api.py"
    spec = importlib.util.spec_from_file_location(
        "hermes_workflows._dashboard_plugin_api", plugin_api_path
    )
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise RuntimeError(f"cannot load dashboard plugin api from {plugin_api_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    router = getattr(module, "router", None)
    if router is None:  # pragma: no cover - defensive
        raise RuntimeError(f"{plugin_api_path} has no 'router' attribute")
    return router


def build_app() -> FastAPI:
    """The sidecar ASGI app: the existing plugin_api router under the dashboard
    prefix, plus a liveness route. Importable and side-effect-free for tests."""
    app = FastAPI(title="hermes-workflows dashboard API", docs_url=None, redoc_url=None)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    app.include_router(_load_plugin_api_router(), prefix=API_PREFIX)
    return app


def main() -> None:
    """Serve the sidecar on the configured loopback host/port."""
    import uvicorn

    uvicorn.run(
        build_app(),
        host=config.dashboard_api_host(),
        port=config.dashboard_api_port(),
        log_level="info",
    )


if __name__ == "__main__":
    main()

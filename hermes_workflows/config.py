"""Resolve user-owned storage paths. Everything lives under the Hermes home
(``~/.hermes`` by default, override with ``HERMES_HOME``). The runtime board is
where agent_task Kanban cards are created.

Plugin settings (the dashboard Settings page) live in the Hermes config under
the ``plugins.workflows`` namespace — reusing the host's config store rather
than a bespoke file. Effective values resolve config ▸ env ▸ default, so an
unset setting keeps today's behaviour."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

_TRUE_BOOL_VALUES = frozenset({"1", "true", "yes", "on"})
_FALSE_BOOL_VALUES = frozenset({"0", "false", "no", "off"})


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))


def workflows_dir() -> Path:
    return hermes_home() / "workflows"


def global_workflows_dir() -> Path:
    return workflows_dir() / "global"


def templates_dir() -> Path:
    return workflows_dir() / "templates"


def template_export_dir() -> Path:
    """Where `export --as-template` writes the generated `.template.yaml` /
    `.template.md` bundle and its cache sidecar. A repeat export of an unchanged
    version is served from this directory without re-running the AI generator."""
    return workflows_dir() / "template-exports"


def runs_db_path() -> Path:
    return workflows_dir() / "runs.db"


def runs_artifacts_dir() -> Path:
    return workflows_dir() / "runs"


def runtime_board() -> str:
    """Kanban board agent_task cards are created on. Honours the
    ``kanban.internal_board`` setting (config ▸ env ▸ default), so editing it on
    the Settings page takes effect without an env change."""
    return str(_setting_value("internal_board"))


def scripts_enabled() -> bool:
    """Whether workflows containing script nodes are permitted to run (TZ §25.2).
    Enforced at the run entrypoint; default off."""
    return bool(_setting_value("scripts_enabled"))


def script_env_allowlist() -> list[str]:
    """Env var names a script node may see, parsed from the comma-separated
    setting. Empty when unset — a script then inherits no process env."""
    raw = _setting_value("script_env_allowlist") or ""
    return [name.strip() for name in str(raw).split(",") if name.strip()]


def direct_store_dir() -> Path:
    """Completion store for global (no-board) node runs."""
    return workflows_dir() / "direct"


def script_store_dir() -> Path:
    """Completion store for local script-node runs (any scope)."""
    return workflows_dir() / "scripts"


def telemetry_dir() -> Path:
    """Per-task telemetry sidecars written by worker-side observers and read by
    the engine (settle merge) and the dashboard (live overlay)."""
    return workflows_dir() / "telemetry"


def traces_dir() -> Path:
    """Per-run JSONL trace files (opt-in via ``observability.trace_enabled``)."""
    return workflows_dir() / "traces"


def trace_enabled() -> bool:
    """Whether the per-run trace writer is on (default off)."""
    return bool(_setting_value("trace_enabled"))


def event_debounce_seconds() -> float:
    """Per-run debounce window (seconds) for the event-driven advance spawn:
    near-simultaneous card completions on one run coalesce to a single scoped
    ``advance-run`` within this window. Small by default (~2s)."""
    return float(_setting_value("event_debounce_seconds"))


def tick_schedule() -> str:
    """Cadence of the residual advance tick (``hermes-workflows advance-all``),
    resolved config ▸ env ▸ default. With event-driven advance handling card
    transitions, the tick is a coarse safety-net + the ``wait``-node poll, not
    the latency driver — so the operator's "configurable interval" ask is met by
    this one knob without a code edit. Default ``"every 2m"`` keeps today's
    behaviour; Hermes cron is minute-granular, so a sub-minute value is bounded
    by the scheduler."""
    return str(_setting_value("tick_schedule"))


def dashboard_api_host() -> str:
    """Bind host for the standalone dashboard-API sidecar. Defaults to loopback:
    the sidecar is never exposed directly — the operator's reverse proxy fronts
    it on the dashboard origin, exactly as it fronts the gateway dashboard."""
    return str(_setting_value("dashboard_api_host"))


def dashboard_api_port() -> int:
    """Bind port for the standalone dashboard-API sidecar."""
    return int(_setting_value("dashboard_api_port"))


def memory_settings() -> dict:
    """Open Second Brain write policy from the enforced settings, for the engine:
    mode + the write_* flags. Driven by the ``open_second_brain.*`` settings."""
    return {
        "mode": _setting_value("mode"),
        "write_run_summaries": bool(_setting_value("write_run_summaries")),
        "write_node_failures": bool(_setting_value("write_node_failures")),
        "write_node_events": bool(_setting_value("write_node_events")),
    }


def default_deliver() -> str | None:
    """Fallback Hermes delivery target for run lifecycle notifications when a run
    has no captured origin. ``None`` means deliver nowhere by default."""
    return os.environ.get("HERMES_WORKFLOWS_DELIVER") or None


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _stable_entrypoint(path: Path) -> Path:
    """Rewrite an entrypoint that lives inside a git worktree back to its stable
    parent-repo path. An adopt card runs in ``<repo>/.worktrees/<id>/`` and the
    bridge code may execute from that copy, so ``repo_root()`` (or an inherited
    ``HERMES_WORKFLOWS_BIN``) can resolve to the worktree. That path is deleted
    when the worktree is torn down; persisting it into a cron shim leaves the
    tick pointing at a vanished binary (exit 127), which silently stalls all run
    advancement (t_a13a2d5a). Truncating at the ``.worktrees`` segment yields the
    stable entrypoint that survives worktree cleanup."""
    parts = path.parts
    if ".worktrees" in parts:
        root = Path(*parts[: parts.index(".worktrees")])
        return root / "bin" / "hermes-workflows"
    return path


def command_path() -> Path:
    """Absolute path to the ``hermes-workflows`` entrypoint that cron shims exec.
    Prefers the installed symlink, falls back to the in-repo wrapper. Never
    returns a transient git-worktree path (see ``_stable_entrypoint``)."""
    override = os.environ.get("HERMES_WORKFLOWS_BIN")
    if override:
        return _stable_entrypoint(Path(override))
    installed = hermes_home() / "bin" / "hermes-workflows"
    if installed.exists():
        return installed
    return _stable_entrypoint(repo_root() / "bin" / "hermes-workflows")


def scripts_dir() -> Path:
    """Hermes cron only runs scripts living under ``HERMES_HOME/scripts``."""
    return hermes_home() / "scripts"


def core_cli() -> list[str]:
    """Argv prefix to invoke the TypeScript core CLI."""
    return ["bun", "run", str(repo_root() / "packages" / "core" / "src" / "cli.ts")]


def spec_roots() -> list[str]:
    return [str(global_workflows_dir()), str(templates_dir())]


def project_workflows_dir(cwd: str | os.PathLike[str] | None = None) -> Path | None:
    """Current repo-local workflows dir (`<cwd>/.hermes/workflows`) when it
    exists. Used by the shell CLI so `hermes-workflows run <id>` can see a
    project's own workflows without global registration."""
    base = Path(cwd) if cwd is not None else Path.cwd()
    candidate = base / ".hermes" / "workflows"
    return candidate if candidate.is_dir() else None


def cli_spec_roots(cwd: str | os.PathLike[str] | None = None) -> list[str]:
    """Spec roots visible to the shell CLI: the current repo-local workflows dir
    (when running inside a project) first, then global + templates. Spec
    resolution by id takes the first match across roots, so a repo-local copy
    overrides a same-id global spec rather than being silently shadowed by it -
    the v0.7.2 (#27) repo-local-discovery intent."""
    project = project_workflows_dir(cwd)
    roots = [str(project)] if project is not None else []
    roots.extend(spec_roots())
    return roots


# --- plugin settings (Hermes config `plugins.workflows`) ---------------------

# Field descriptors for the Settings page. ``enforced`` marks whether the engine
# already honours the knob (the UI labels the rest as not-yet-enforced). ``env``
# names an environment variable that overrides the default but loses to a stored
# config value. Path defaults are computed per-home in ``_default_for``.
SETTINGS_SCHEMA: dict = {
    "namespace": "plugins.workflows",
    "groups": [
        {
            "key": "storage",
            "label": "Storage",
            "fields": [
                {"key": "global_workflows_path", "type": "string", "enforced": False},
                {"key": "runs_db_path", "type": "string", "enforced": False},
            ],
        },
        {
            "key": "execution",
            "label": "Execution",
            "fields": [
                {
                    "key": "default_mode",
                    "type": "enum",
                    "options": ["durable", "direct"],
                    "default": "durable",
                    # Enforced: durable runs one step per tick; direct drains
                    # inline-eligible script steps synchronously (TZ §18.2).
                    "enforced": True,
                },
                {"key": "max_parallel_runs", "type": "int", "default": 4, "enforced": False},
                {"key": "default_timeout_seconds", "type": "int", "default": 120, "enforced": False},
                # Security gate (TZ §25.2): a workflow with script nodes runs only
                # when scripts are explicitly enabled, and a script sees only the
                # comma-separated allowlist of env var names. Both are enforced.
                {"key": "scripts_enabled", "type": "bool", "default": False, "enforced": True},
                {"key": "script_env_allowlist", "type": "string", "default": "", "enforced": True},
                # Event-driven advance: a burst of near-simultaneous card
                # completions on one run (parallel nodes) coalesces to a single
                # detached `advance-run` spawn within this per-run window. The
                # residual tick still covers anything the burst missed, so this
                # only avoids pointless spawns — correctness rides on the
                # idempotent advance cycle, not the debounce. Enforced.
                {"key": "event_debounce_seconds", "type": "int", "default": 2, "enforced": True},
                # Cadence of the residual advance tick (`hermes-workflows
                # advance-all`). With event-driven advance handling card
                # transitions, this tick is the coarse safety-net + the poll for
                # `wait` nodes, not the latency driver — so the operator's
                # "configurable interval" ask is satisfied by this one knob
                # without a code edit. Hermes cron is minute-granular, so a
                # sub-minute value is bounded by the scheduler; the default
                # stays the historical `every 2m`. Enforced (the cron bridge
                # reads it when (re)creating the tick).
                {"key": "tick_schedule", "type": "string", "default": "every 2m", "enforced": True},
            ],
        },
        {
            "key": "kanban",
            "label": "Kanban",
            "fields": [
                {
                    "key": "use_workflow_columns",
                    "type": "enum",
                    "options": ["auto", "on", "off"],
                    "default": "auto",
                    "enforced": False,
                },
                {
                    "key": "internal_board",
                    "type": "string",
                    "default": "hermes-workflows",
                    "env": "HERMES_WORKFLOWS_BOARD",
                    "enforced": True,
                },
            ],
        },
        {
            "key": "dashboard",
            "label": "Dashboard",
            "fields": [
                # The dashboard backend runs as a standalone sidecar process
                # (`hermes-workflows-dashboard-api`) reusing the plugin_api
                # router, because upstream Hermes no longer auto-imports a
                # non-bundled plugin's Python backend (GHSA-5qr3-c538-wm9j).
                # The operator's reverse proxy routes `/api/plugins/hermes-workflows/*`
                # to host:port; loopback default keeps it off the network.
                # Enforced: the sidecar binds exactly these.
                {
                    "key": "dashboard_api_host",
                    "type": "string",
                    "default": "127.0.0.1",
                    "env": "HERMES_WORKFLOWS_DASHBOARD_API_HOST",
                    "enforced": True,
                },
                {
                    "key": "dashboard_api_port",
                    "type": "int",
                    "default": 9123,
                    "env": "HERMES_WORKFLOWS_DASHBOARD_API_PORT",
                    "enforced": True,
                },
            ],
        },
        {
            "key": "observability",
            "label": "Observability",
            "fields": [
                # Enforced: when on, the engine appends one JSONL line per run
                # event (status transitions, scheduling, completions, review
                # decisions) to <workflows>/traces/<run_id>.jsonl, and the
                # export-logs action returns the trace alongside the run state.
                # Off (the default) means zero trace I/O on the tick path.
                {
                    "key": "trace_enabled",
                    "type": "bool",
                    "default": False,
                    "env": "HERMES_WORKFLOWS_TRACE",
                    "enforced": True,
                },
            ],
        },
        {
            "key": "open_second_brain",
            "label": "OpenSecondBrain",
            "fields": [
                # The engine enforces the write policy on lifecycle transitions:
                # `mode` gates all writes and picks the provider; the write_*
                # flags gate run summaries + retrospective, per-node failures,
                # and the granular run-start event. `fail_open` is the
                # per-workflow provider concern (defaults.memory.fail_open),
                # not an engine knob, so it stays not-yet-enforced here.
                {
                    "key": "mode",
                    "type": "enum",
                    "options": ["auto", "open_second_brain", "none"],
                    "default": "auto",
                    "enforced": True,
                },
                {"key": "fail_open", "type": "bool", "default": True, "enforced": False},
                {"key": "write_run_summaries", "type": "bool", "default": True, "enforced": True},
                {"key": "write_node_failures", "type": "bool", "default": True, "enforced": True},
                {"key": "write_node_events", "type": "bool", "default": False, "enforced": True},
            ],
        },
    ],
}


def _iter_fields():
    for group in SETTINGS_SCHEMA["groups"]:
        for field in group["fields"]:
            yield field


def _default_for(field: dict) -> Any:
    """The effective default — path fields resolve against the current home."""
    key = field["key"]
    if key == "global_workflows_path":
        return str(global_workflows_dir())
    if key == "runs_db_path":
        return str(runs_db_path())
    return field.get("default")


def _coerce(field: dict, raw: Any) -> Any:
    """Coerce a raw value (e.g. an env string) to the field's type."""
    if raw is None:
        return None
    kind = field["type"]
    if kind == "int":
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None
    if kind == "bool":
        if isinstance(raw, bool):
            return raw
        normalized = str(raw).strip().lower()
        if normalized in _TRUE_BOOL_VALUES:
            return True
        if normalized in _FALSE_BOOL_VALUES:
            return False
        return None
    return raw


def _stored_settings() -> dict:
    """The ``plugins.workflows`` namespace from the Hermes config, or ``{}``.
    Imported lazily so environments without ``hermes_cli`` (e.g. the core test
    venv) can still import this module."""
    try:
        from hermes_cli import config as hermes_config
    except Exception:
        return {}
    plugins = hermes_config.load_config().get("plugins")
    if not isinstance(plugins, dict):
        return {}
    workflows = plugins.get("workflows")
    return workflows if isinstance(workflows, dict) else {}


def _field_by_key(key: str) -> dict:
    for field in _iter_fields():
        if field["key"] == key:
            return field
    raise KeyError(key)


def _resolve(field: dict, stored: dict) -> Any:
    """Resolve one field: stored config value ▸ env override ▸ default."""
    key = field["key"]
    if key in stored:
        return _coerce(field, stored[key])
    env_name = field.get("env")
    env_val = os.environ.get(env_name) if env_name else None
    if env_val is not None:
        return _coerce(field, env_val)
    return _default_for(field)


def _setting_value(key: str) -> Any:
    """Effective value of a single setting (config ▸ env ▸ default)."""
    return _resolve(_field_by_key(key), _stored_settings())


def settings() -> dict:
    """Effective plugin settings: for each field, the stored config value wins,
    then an env override, then the default. Unset everywhere → today's behaviour."""
    stored = _stored_settings()
    return {field["key"]: _resolve(field, stored) for field in _iter_fields()}


def settings_schema() -> dict:
    """JSON-serializable schema for the Settings page: groups and fields with
    their resolved (concrete) defaults, so the client can render and reset."""
    groups = []
    for group in SETTINGS_SCHEMA["groups"]:
        fields = []
        for field in group["fields"]:
            entry = {
                "key": field["key"],
                "type": field["type"],
                "enforced": bool(field.get("enforced", False)),
                "default": _default_for(field),
            }
            if "options" in field:
                entry["options"] = list(field["options"])
            fields.append(entry)
        groups.append({"key": group["key"], "label": group["label"], "fields": fields})
    return {"namespace": SETTINGS_SCHEMA["namespace"], "groups": groups}


def validate_settings(incoming: dict) -> dict:
    """Validate and coerce a settings payload against the schema. Unknown keys
    and type/enum violations raise ``ValueError``; returns the coerced subset of
    recognised keys (only the provided ones)."""
    by_key = {field["key"]: field for field in _iter_fields()}
    unknown = set(incoming) - set(by_key)
    if unknown:
        raise ValueError(f"unknown setting(s): {', '.join(sorted(unknown))}")
    cleaned: dict = {}
    for key, raw in incoming.items():
        field = by_key[key]
        value = _coerce(field, raw)
        if field["type"] == "int" and value is None:
            raise ValueError(f"'{key}' must be an integer")
        if field["type"] == "bool" and value is None:
            raise ValueError(f"'{key}' must be a boolean")
        if field["type"] == "enum" and value not in field["options"]:
            raise ValueError(f"'{key}' must be one of {field['options']}")
        cleaned[key] = value
    return cleaned


def save_settings(incoming: dict) -> dict:
    """Persist a validated settings payload to the Hermes config
    ``plugins.workflows`` namespace (merging, not clobbering other config), and
    return the new effective values. Raises ``ValueError`` on invalid input."""
    cleaned = validate_settings(incoming)
    from hermes_cli import config as hermes_config

    cfg = hermes_config.load_config()
    plugins = cfg.setdefault("plugins", {})
    if not isinstance(plugins, dict):
        plugins = {}
        cfg["plugins"] = plugins
    workflows = plugins.setdefault("workflows", {})
    if not isinstance(workflows, dict):
        workflows = {}
        plugins["workflows"] = workflows
    workflows.update(cleaned)
    hermes_config.save_config(cfg)
    return settings()

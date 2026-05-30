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


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))


def workflows_dir() -> Path:
    return hermes_home() / "workflows"


def global_workflows_dir() -> Path:
    return workflows_dir() / "global"


def templates_dir() -> Path:
    return workflows_dir() / "templates"


def runs_db_path() -> Path:
    return workflows_dir() / "runs.db"


def runs_artifacts_dir() -> Path:
    return workflows_dir() / "runs"


def runtime_board() -> str:
    """Kanban board agent_task cards are created on. Honours the
    ``kanban.internal_board`` setting (config ▸ env ▸ default), so editing it on
    the Settings page takes effect without an env change."""
    return str(_setting_value("internal_board"))


def runner_dir() -> Path:
    """Where profile runners live (``<profile>`` executables). Used by the
    DirectExecutor to run global, unbound workflow nodes."""
    return Path(os.environ.get("HERMES_AGENT_RUNNERS", str(hermes_home() / "bin" / "agents")))


def direct_store_dir() -> Path:
    """Completion store for global (no-board) node runs."""
    return workflows_dir() / "direct"


def default_deliver() -> str | None:
    """Fallback Hermes delivery target for run lifecycle notifications when a run
    has no captured origin. ``None`` means deliver nowhere by default."""
    return os.environ.get("HERMES_WORKFLOWS_DELIVER") or None


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def command_path() -> Path:
    """Absolute path to the ``hermes-workflows`` entrypoint that cron shims exec.
    Prefers the installed symlink, falls back to the in-repo wrapper."""
    override = os.environ.get("HERMES_WORKFLOWS_BIN")
    if override:
        return Path(override)
    installed = hermes_home() / "bin" / "hermes-workflows"
    if installed.exists():
        return installed
    return repo_root() / "bin" / "hermes-workflows"


def scripts_dir() -> Path:
    """Hermes cron only runs scripts living under ``HERMES_HOME/scripts``."""
    return hermes_home() / "scripts"


def core_cli() -> list[str]:
    """Argv prefix to invoke the TypeScript core CLI."""
    return ["bun", "run", str(repo_root() / "packages" / "core" / "src" / "cli.ts")]


def spec_roots() -> list[str]:
    return [str(global_workflows_dir()), str(templates_dir())]


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
                    "enforced": False,
                },
                {"key": "max_parallel_runs", "type": "int", "default": 4, "enforced": False},
                {"key": "default_timeout_seconds", "type": "int", "default": 120, "enforced": False},
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
            "key": "open_second_brain",
            "label": "OpenSecondBrain",
            "fields": [
                {
                    "key": "mode",
                    "type": "enum",
                    "options": ["auto", "open_second_brain", "none"],
                    "default": "auto",
                    "enforced": False,
                },
                {"key": "fail_open", "type": "bool", "default": True, "enforced": False},
                {"key": "write_run_summaries", "type": "bool", "default": True, "enforced": False},
                {"key": "write_node_failures", "type": "bool", "default": True, "enforced": False},
                {"key": "write_node_events", "type": "bool", "default": False, "enforced": False},
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
        return str(raw).strip().lower() in {"1", "true", "yes", "on"}
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

"""Settings source in config.py: effective values resolve config ▸ env ▸
default over the Hermes config `plugins.workflows` namespace. Skipped where the
Hermes config module is unavailable (the core test venv)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")
pytest.importorskip("hermes_cli.config")

from hermes_workflows import config


def _write_config(home: Path, data: dict) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(yaml.safe_dump(data))


def test_defaults_when_unset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("HERMES_WORKFLOWS_BOARD", raising=False)
    vals = config.settings()
    assert vals["default_mode"] == "durable"
    assert vals["fail_open"] is True
    assert vals["write_node_events"] is False
    assert vals["internal_board"] == "hermes-workflows"
    assert vals["global_workflows_path"].endswith("/workflows/global")
    assert vals["runs_db_path"].endswith("/workflows/runs.db")


def test_env_overrides_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("HERMES_WORKFLOWS_BOARD", "from-env")
    assert config.settings()["internal_board"] == "from-env"


def test_config_wins_over_env_and_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_WORKFLOWS_BOARD", "from-env")
    _write_config(
        home,
        {"plugins": {"workflows": {"internal_board": "from-config", "max_parallel_runs": 9, "fail_open": False}}},
    )
    vals = config.settings()
    assert vals["internal_board"] == "from-config"
    assert vals["max_parallel_runs"] == 9
    assert vals["fail_open"] is False
    # untouched fields still fall back to defaults
    assert vals["default_mode"] == "durable"


def test_schema_is_json_serializable_with_concrete_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    schema = config.settings_schema()
    json.dumps(schema)  # must not raise
    keys = {f["key"] for g in schema["groups"] for f in g["fields"]}
    assert {"default_mode", "mode", "internal_board", "runs_db_path", "fail_open"} <= keys
    # the storage path default is resolved to a concrete string
    storage = next(g for g in schema["groups"] if g["key"] == "storage")
    runs_db = next(f for f in storage["fields"] if f["key"] == "runs_db_path")
    assert runs_db["default"].endswith("/workflows/runs.db")


def test_validate_rejects_unknown_and_bad_values(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    with pytest.raises(ValueError):
        config.validate_settings({"nope": 1})
    with pytest.raises(ValueError):
        config.validate_settings({"default_mode": "sideways"})
    with pytest.raises(ValueError):
        config.validate_settings({"max_parallel_runs": "not-an-int"})
    with pytest.raises(ValueError):
        config.validate_settings({"fail_open": "definitely"})
    # a valid subset coerces and passes
    assert config.validate_settings({"fail_open": "false", "max_parallel_runs": "7"}) == {
        "fail_open": False,
        "max_parallel_runs": 7,
    }


def test_internal_board_setting_drives_runtime_board(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("HERMES_WORKFLOWS_BOARD", raising=False)
    assert config.runtime_board() == "hermes-workflows"  # default
    config.save_settings({"internal_board": "team-board"})
    assert config.runtime_board() == "team-board"  # stored setting takes effect


def test_runtime_board_env_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("HERMES_WORKFLOWS_BOARD", "env-board")
    assert config.runtime_board() == "env-board"


def test_enforced_flags_are_honest(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    by_key = {f["key"]: f for g in config.settings_schema()["groups"] for f in g["fields"]}
    # internal_board is wired through runtime_board()
    assert by_key["internal_board"]["enforced"] is True
    # the script gate knobs gate real behaviour from day one
    assert by_key["scripts_enabled"]["enforced"] is True
    assert by_key["script_env_allowlist"]["enforced"] is True
    # the execution mode and Open Second Brain write policy are now enforced by
    # the engine (inline mode + lifecycle memory writes)
    for key in (
        "default_mode",
        "mode",
        "write_run_summaries",
        "write_node_failures",
        "write_node_events",
    ):
        assert by_key[key]["enforced"] is True
    # the rest are persisted/displayed but not yet honoured by the engine
    for key in (
        "global_workflows_path",
        "runs_db_path",
        "max_parallel_runs",
        "default_timeout_seconds",
        "use_workflow_columns",
        "fail_open",
    ):
        assert by_key[key]["enforced"] is False


def test_script_gate_defaults_off_with_empty_allowlist(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    assert config.scripts_enabled() is False
    assert config.script_env_allowlist() == []


def test_script_gate_reads_stored_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    config.save_settings({"scripts_enabled": True, "script_env_allowlist": "PATH, HOME ,CI"})
    assert config.scripts_enabled() is True
    # comma-separated, trimmed, empties dropped
    assert config.script_env_allowlist() == ["PATH", "HOME", "CI"]

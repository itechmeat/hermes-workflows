"""config.command_path resolution: the ``hermes-workflows`` entrypoint that cron
shims exec. There is no required ``~/.hermes/bin`` symlink; the in-repo wrapper
is the canonical fallback, an installed symlink is only an optional preference,
and ``HERMES_WORKFLOWS_BIN`` overrides both. Locks the behavior the header
comment and docs describe (t_25eb38d3)."""

from __future__ import annotations

from pathlib import Path

import pytest

from hermes_workflows import config

REPO_WRAPPER = config.repo_root() / "bin" / "hermes-workflows"


def test_falls_back_to_repo_wrapper_when_no_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No installed symlink and no override: resolves to the in-repo wrapper.
    This is the real server state - ~/.hermes/bin/hermes-workflows does not
    exist, so the fallback is the canonical path, not an error."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("HERMES_WORKFLOWS_BIN", raising=False)
    assert config.command_path() == REPO_WRAPPER


def test_prefers_installed_symlink_when_present(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When an installed entrypoint exists under HERMES_HOME/bin, prefer it."""
    home = tmp_path / "home"
    installed = home / "bin" / "hermes-workflows"
    installed.parent.mkdir(parents=True)
    installed.write_text("#!/usr/bin/env bash\n")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("HERMES_WORKFLOWS_BIN", raising=False)
    assert config.command_path() == installed


def test_env_override_wins(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """HERMES_WORKFLOWS_BIN overrides both the symlink and the repo fallback."""
    override = tmp_path / "custom" / "hermes-workflows"
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("HERMES_WORKFLOWS_BIN", str(override))
    assert config.command_path() == override

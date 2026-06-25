"""Test bootstrap: make the project package importable, and (for bridge tests)
locate the Hermes install so ``hermes_cli`` resolves. The Hermes path insertion
is a test-only convenience; at runtime the plugin is loaded in-process by Hermes
and ``hermes_cli`` is already importable.
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# The feature-development example's ``feature_request`` param is required and has
# no default, so any run created from it must supply a value. Lifecycle tests use
# the example as a representative multi-node workflow and do not care about the
# request text; this shared value keeps those runs valid.
EXAMPLE_PARAMS = {"feature_request": "Add a dark mode toggle"}


@pytest.fixture(autouse=True)
def _sandbox_cron_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Redirect the Hermes cron store into a per-test tmp dir so no test can
    write to the operator's real ``~/.hermes/cron``.

    ``cron.jobs`` resolves ``HERMES_DIR = get_hermes_home().resolve()`` at import
    time and derives ``CRON_DIR / JOBS_FILE / OUTPUT_DIR`` from it as module
    constants. Setting only ``HERMES_HOME`` does NOT redirect them, so a
    cron-touching test that forgot the trio wrote into whatever
    ``get_hermes_home()`` resolved at import — the operator's real store when
    ``bun run validate`` / pytest runs on a live host. A leaked job named exactly
    the tick name then shadowed the real tick and stalled auto-advancement of
    every run (t_8179b52f).

    This autouse sandbox makes the redirection unconditional and the single
    source of truth, so per-test fixtures no longer own the trio. Fail open:
    tests in environments without ``cron.jobs`` importable are unaffected.
    """
    try:
        from cron import jobs as cj
    except ModuleNotFoundError:
        yield
        return
    cron_dir = tmp_path / "cron"
    cron_dir.mkdir(exist_ok=True)
    monkeypatch.setattr(cj, "CRON_DIR", cron_dir)
    monkeypatch.setattr(cj, "JOBS_FILE", cron_dir / "jobs.json")
    monkeypatch.setattr(cj, "OUTPUT_DIR", cron_dir / "output")
    yield


@pytest.fixture(autouse=True)
def _reap_background_drive_threads():
    """Stop any ``tools.start_workflow`` background drive thread at test
    teardown. Those threads loop on the process-global ``HERMES_HOME`` (which
    each test re-points via monkeypatch), so a thread that outlived its test
    would spin into the NEXT test's databases — the source of intermittent
    "database is locked" / "disk image is malformed" failures in unrelated
    later tests. Setting the cooperative stop wakes the interruptible pause so
    the threads exit, then we join them before the next test rebinds the env.
    Import lazily and fail open: tests that never import ``tools`` are unaffected.
    """
    yield
    try:
        from hermes_workflows import tools
    except ModuleNotFoundError:
        return
    tools._drive_stop.set()
    for thread in threading.enumerate():
        if thread.name.startswith(("hw-drive-", "hw-resume-")):
            thread.join(timeout=10)
    lingering = [
        thread.name
        for thread in threading.enumerate()
        if thread.name.startswith(("hw-drive-", "hw-resume-")) and thread.is_alive()
    ]
    if lingering:
        raise RuntimeError(f"background workflow threads did not stop: {lingering}")
    tools._drive_stop.clear()


def sibling_spec(tmp_path: Path, spec: Path, suffix: str = "b") -> Path:
    """A copy of ``spec`` under a distinct workflow id, for tests that need two
    concurrently-active runs: single-flight forbids two active runs of one
    workflow, so each concurrent run gets its own workflow."""
    text = spec.read_text()
    source_id = next(
        line.removeprefix("id: ") for line in text.splitlines() if line.startswith("id: ")
    )
    path = tmp_path / f"{source_id}-{suffix}.workflow.yaml"
    path.write_text(text.replace(f"id: {source_id}", f"id: {source_id}-{suffix}", 1))
    return path


def fake_hermes_bin(path: Path, body: str = 'echo "ok"') -> str:
    """A stand-in ``hermes`` executable for tests that exercise the global
    (DirectExecutor) backend without a real agent. The executor invokes
    ``hermes -p <profile> [--skills X]... [-m model] -z <prompt>``; this script
    ignores the routing flags and runs ``body`` (which must exit 0 and print the
    node's final message to stdout). Returns the path as a str for
    ``DirectExecutor(hermes_bin=...)``."""
    import stat

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/usr/bin/env bash\n" + body + "\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IRWXU)
    return str(path)


def _ensure_hermes_importable() -> None:
    try:
        import hermes_cli  # noqa: F401

        return
    except ModuleNotFoundError:
        pass
    for candidate in (os.environ.get("HERMES_AGENT_HOME"), "/usr/local/lib/hermes-agent"):
        if candidate and (Path(candidate) / "hermes_cli").is_dir():
            sys.path.insert(0, candidate)
            return


_ensure_hermes_importable()

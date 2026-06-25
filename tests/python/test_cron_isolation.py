"""Regression guard for t_8179b52f — the cron-store test-isolation leak.

``cron.jobs`` resolves ``HERMES_DIR = get_hermes_home().resolve()`` at import
time and derives ``CRON_DIR / JOBS_FILE / OUTPUT_DIR`` from it as module
constants. A cron-touching test that set only ``HERMES_HOME`` (not the trio)
wrote into whatever ``get_hermes_home()`` resolved at import — the operator's
real ``~/.hermes/cron`` when ``bun run validate`` / pytest runs on a live host.
A leaked job named exactly the tick name then shadowed the real tick and
stalled auto-advancement of every run.

The fix is the autouse ``_sandbox_cron_store`` fixture in ``conftest.py``, which
redirects the trio into a per-test tmp dir for EVERY test. These guards fail
loudly if that sandbox is ever removed or stops covering the trio.
"""

from __future__ import annotations

from pathlib import Path

import pytest

cj = pytest.importorskip("cron.jobs")

from hermes_constants import get_hermes_home  # noqa: E402

from hermes_workflows.bridge import cron as cron_bridge  # noqa: E402


def test_cron_store_constants_are_sandboxed_under_tmp(tmp_path: Path) -> None:
    """The autouse sandbox points all three cron-store constants at the
    per-test tmp dir. Without it they resolve under the real Hermes home."""
    assert Path(cj.CRON_DIR).is_relative_to(tmp_path)
    assert Path(cj.JOBS_FILE).is_relative_to(tmp_path)
    assert Path(cj.OUTPUT_DIR).is_relative_to(tmp_path)


def test_arming_the_tick_never_touches_the_real_store() -> None:
    """Arming the tick writes only into the sandboxed store; the operator's real
    ``~/.hermes/cron/jobs.json`` is byte-for-byte unchanged across the call."""
    real_jobs = get_hermes_home().resolve() / "cron" / "jobs.json"
    before = real_jobs.read_bytes() if real_jobs.exists() else None

    cron_bridge.ensure_workflow_tick(schedule="every 2m")

    # The tick landed in the sandbox, not the real store.
    armed = cron_bridge.find_by_name(cron_bridge.TICK_NAME)
    assert armed is not None
    assert Path(cj.JOBS_FILE).is_relative_to(Path(cj.CRON_DIR))
    assert not Path(cj.JOBS_FILE).is_relative_to(real_jobs.parent.parent)

    after = real_jobs.read_bytes() if real_jobs.exists() else None
    assert after == before

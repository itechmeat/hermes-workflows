"""Test bootstrap: make the project package importable, and (for bridge tests)
locate the Hermes install so ``hermes_cli`` resolves. The Hermes path insertion
is a test-only convenience; at runtime the plugin is loaded in-process by Hermes
and ``hermes_cli`` is already importable.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


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

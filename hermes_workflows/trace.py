"""Per-run JSONL trace writer — the opt-in append-only timeline of what the
orchestrator did when (the nemo_relay consumer pattern: local files, no
network, fails open).

One file per run at ``<traces_dir>/<run_id>.jsonl``. Each line is
self-describing: ``{ts, run_id, kind, node_id?, ...payload}``. The engine holds
a writer only when ``observability.trace_enabled`` resolves true (see
``cli.build_engine``); with the default off there is no writer object and the
tick path performs zero trace I/O.

A write failure (read-only dir, full disk) prints one stderr note and is
otherwise swallowed — tracing must never affect run advancement.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any, Callable


class TraceWriter:
    """Append one JSON line per event to the run's trace file. ``now`` is
    injectable for deterministic tests."""

    def __init__(self, root: Path, *, now: Callable[[], float] = time.time) -> None:
        self.root = Path(root)
        self._now = now

    def emit(self, run_id: str, kind: str, **payload: Any) -> None:
        try:
            line: dict = {"ts": self._now(), "run_id": run_id, "kind": kind}
            line.update({key: value for key, value in payload.items() if value is not None})
            self.root.mkdir(parents=True, exist_ok=True)
            with open(self.root / f"{run_id}.jsonl", "a", encoding="utf-8") as handle:
                handle.write(json.dumps(line) + "\n")
        except Exception as exc:  # noqa: BLE001 - tracing never fails a run
            print(f"hermes-workflows: trace write failed: {exc}", file=sys.stderr)


def read_trace(root: Path, run_id: str) -> str | None:
    """The raw trace text for a run, or ``None`` when the run was not traced
    (or the file is unreadable — fail-open, an export overlay concern). The
    export route only reaches this for runs that exist in runs.db, but the
    separator guard keeps the path safety local rather than call-order-derived."""
    if "/" in run_id or "\\" in run_id:
        return None
    try:
        return (Path(root) / f"{run_id}.jsonl").read_text(encoding="utf-8")
    except Exception:
        return None

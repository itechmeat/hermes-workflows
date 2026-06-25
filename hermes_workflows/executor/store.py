"""File-backed completion persistence shared by local executors."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from .base import Completion

# Cap captured output so a runaway worker cannot bloat the run store.
MAX_OUTPUT_CHARS = 100_000


class CompletionStore:
    """Persist node completions under stable, filesystem-safe handles."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def read(self, handle: str) -> Completion:
        path = self._path(handle)
        if not path.is_file():
            return Completion(settled=False)
        data = json.loads(path.read_text())
        return Completion(
            settled=bool(data.get("settled")),
            outcome=data.get("outcome"),
            output=data.get("output"),
            started=bool(data.get("started")),
            transient_retries=int(data.get("transient_retries") or 0),
        )

    def write(self, handle: str, completion: Completion) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        path = self._path(handle)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(
            json.dumps(
                {
                    "settled": completion.settled,
                    "outcome": completion.outcome,
                    "output": completion.output,
                    "started": completion.started,
                    "transient_retries": completion.transient_retries,
                }
            )
        )
        os.replace(tmp, path)

    def path_for(self, handle: str) -> Path:
        """The completion file path for ``handle``. Public so a detached worker
        (DirectExecutor's runner) can write the same file this store reads."""
        return self._path(handle)

    def _path(self, handle: str) -> Path:
        safe = handle.replace("/", "_").replace(":", "_")
        return self.root / f"{safe}.json"


def clip_output(text: Optional[str]) -> str:
    cleaned = (text or "").strip()
    if len(cleaned) <= MAX_OUTPUT_CHARS:
        return cleaned
    return cleaned[:MAX_OUTPUT_CHARS] + "\n\u2026[truncated]"
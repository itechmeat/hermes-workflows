"""ScriptExecutor — runs a ``script`` node's deterministic command locally, with
no LLM. It is the peer of DirectExecutor on the same node-execution seam: a
subprocess with a timeout, capped + redacted captured output, and an idempotent
file-backed completion. Hermes has no no-agent Kanban task mode, so a script
node runs here regardless of workflow scope.

Security (TZ §25.2) is enforced, not cosmetic:
  - the command runs only in its ``workdir``;
  - the environment is an allowlist (the settings-level ``env_allowlist``
    intersected with the node's requested ``env``), never the full process env;
  - a timeout always applies;
  - captured stdout/stderr are clipped and redacted before they are persisted.

The completion handle is prefixed ``script:`` so a composite executor can route
``poll`` to the right backend by handle shape.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Optional, Sequence

from ..redact import redact_secrets
from .base import Completion

# Cap captured output so a runaway command cannot bloat the run store.
_MAX_OUTPUT_CHARS = 100_000

_HANDLE_PREFIX = "script:"


def _handle(run_id: str, node_id: str, iteration: int) -> str:
    return f"{_HANDLE_PREFIX}{run_id}:{node_id}:{iteration}"


class ScriptExecutor:
    def __init__(
        self,
        *,
        store_dir: Path,
        env_allowlist: Sequence[str] = (),
        timeout_seconds: float = 1800.0,
    ) -> None:
        self.store_dir = Path(store_dir)
        # The settings-level ceiling: a node may only see vars named here.
        self.env_allowlist = set(env_allowlist)
        self.timeout_seconds = timeout_seconds

    def schedule(
        self,
        *,
        run_id: str,
        node_id: str,
        workflow_id: str,
        params: dict,
        iteration: int = 0,
    ) -> str:
        handle = _handle(run_id, node_id, iteration)
        completion = self._invoke(params)
        self._persist(handle, completion)
        return handle

    def poll(self, handle: str) -> Completion:
        path = self._path(handle)
        if not path.is_file():
            return Completion(settled=False)
        data = json.loads(path.read_text())
        return Completion(
            settled=bool(data.get("settled")),
            outcome=data.get("outcome"),
            output=data.get("output"),
        )

    # --- internals --------------------------------------------------------

    def _invoke(self, params: dict) -> Completion:
        command = params.get("command") or ""
        workdir = params.get("workdir") or None
        timeout = params.get("timeout_seconds")
        timeout = float(timeout) if timeout is not None else self.timeout_seconds
        env = self._build_env(params.get("env"))
        try:
            proc = subprocess.run(
                command,
                shell=True,
                cwd=workdir,
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return Completion(
                settled=True,
                outcome="failure",
                output=f"script timed out after {timeout:g}s",
            )
        if proc.returncode == 0:
            return Completion(settled=True, outcome="success", output=_clean(proc.stdout))
        detail = proc.stderr.strip() or proc.stdout.strip()
        return Completion(settled=True, outcome="failure", output=_clean(detail))

    def _build_env(self, requested: Optional[Sequence[str]]) -> dict:
        """The command sees only vars whose names are both requested by the node
        and permitted by the settings allowlist — defense in depth."""
        names = self.env_allowlist if requested is None else self.env_allowlist & set(requested)
        return {name: os.environ[name] for name in names if name in os.environ}

    def _path(self, handle: str) -> Path:
        safe = handle.replace("/", "_").replace(":", "_")
        return self.store_dir / f"{safe}.json"

    def _persist(self, handle: str, completion: Completion) -> None:
        self.store_dir.mkdir(parents=True, exist_ok=True)
        self._path(handle).write_text(
            json.dumps(
                {
                    "settled": completion.settled,
                    "outcome": completion.outcome,
                    "output": completion.output,
                }
            )
        )


def _clean(text: Optional[str]) -> str:
    cleaned = redact_secrets((text or "").strip())
    if len(cleaned) <= _MAX_OUTPUT_CHARS:
        return cleaned
    return cleaned[:_MAX_OUTPUT_CHARS] + "\n…[truncated]"

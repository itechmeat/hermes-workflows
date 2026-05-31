"""DirectExecutor — the global (unbound) backend. A node with no project board
runs by invoking the profile runner (``<runner_dir>/<profile>``) directly, the
same contract Hermes uses elsewhere: the prompt is passed as an argument and the
worker's final message is emitted to stdout.

There are no Kanban cards here, so the completion is persisted to a small
file-backed store keyed by an idempotent handle (``run:node:iteration``). That
keeps a multi-step global workflow durable across tick processes, just as the
Kanban backend is durable through the board DB.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from .base import Completion
from .store import CompletionStore, clip_output


class RunnerNotFound(FileNotFoundError):
    """The profile runner for a global node does not exist or is not executable."""


def _handle(run_id: str, node_id: str, iteration: int) -> str:
    return f"{run_id}:{node_id}:{iteration}"


class DirectExecutor:
    def __init__(
        self,
        *,
        runner_dir: Path,
        store_dir: Path,
        timeout_seconds: float = 1800.0,
    ) -> None:
        self.runner_dir = Path(runner_dir)
        self.store = CompletionStore(Path(store_dir))
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
        if self.poll(handle).settled:
            return handle
        profile = params.get("assignee") or params.get("profile") or ""
        runner = self.runner_dir / profile
        if not profile or not runner.is_file():
            raise RunnerNotFound(f"no profile runner at {runner}")
        completion = self._invoke(runner, params.get("prompt", ""))
        self.store.write(handle, completion)
        return handle

    def poll(self, handle: str) -> Completion:
        return self.store.read(handle)

    # --- internals --------------------------------------------------------

    def _invoke(self, runner: Path, prompt: str) -> Completion:
        try:
            proc = subprocess.run(
                [str(runner), prompt],
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
            )
        except subprocess.TimeoutExpired:
            return Completion(
                settled=True,
                outcome="failure",
                output=f"runner timed out after {self.timeout_seconds:g}s",
            )
        if proc.returncode == 0:
            return Completion(settled=True, outcome="success", output=clip_output(proc.stdout))
        detail = proc.stderr.strip() or proc.stdout.strip()
        return Completion(settled=True, outcome="failure", output=clip_output(detail))

"""DirectExecutor — the global (unbound) backend. A node with no project board
runs by invoking the Hermes agent CLI in oneshot mode:

    hermes -p <profile> [--skills <s>]... [-m <model>] -z <prompt>

This is the same profile/model/skills contract the Kanban dispatcher uses for
project nodes (``hermes_cli.kanban_db``): ``-p`` activates the agent profile,
``--skills`` preloads each skill for the session, ``-m`` overrides the model,
and oneshot (``-z``) prints ONLY the agent's final message to stdout — which
becomes the node output. Carrying model/skills here is what makes a global
node honour the same per-node selections a project node already does.

There are no Kanban cards here, so the completion is persisted to a small
file-backed store keyed by an idempotent handle (``run:node:iteration``). That
keeps a multi-step global workflow durable across tick processes, just as the
Kanban backend is durable through the board DB.
"""

from __future__ import annotations

import os
import subprocess
import threading
from typing import Optional, Sequence

from .base import Completion
from .store import CompletionStore, clip_output


class ProfileNotSpecified(ValueError):
    """A global node carries no agent profile — the workflow is misconfigured
    (every ``agent_task`` resolves a profile via the node or ``defaults``)."""


def build_agent_argv(
    hermes_bin: str,
    profile: str,
    prompt: str,
    *,
    model: Optional[str] = None,
    skills: Optional[Sequence[str]] = None,
) -> list[str]:
    """The canonical oneshot agent command. ``--skills`` and ``-m`` are emitted
    only when set, so a node without them falls back to the profile's configured
    skill set and model rather than passing empty flags."""
    argv = [hermes_bin, "-p", profile]
    for skill in skills or []:
        name = str(skill).strip()
        if name:
            argv += ["--skills", name]
    if model:
        argv += ["-m", model]
    argv += ["-z", prompt]
    return argv


def _handle(run_id: str, node_id: str, iteration: int) -> str:
    return f"{run_id}:{node_id}:{iteration}"


def _profile_of(params: dict) -> str:
    return params.get("assignee") or params.get("profile") or ""


class DirectExecutor:
    def __init__(
        self,
        *,
        store_dir,
        hermes_bin: str = "hermes",
        timeout_seconds: float = 1800.0,
    ) -> None:
        self.hermes_bin = hermes_bin
        self.store = CompletionStore(store_dir)
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
        """Start the node's agent and return immediately. Non-blocking by
        contract: the engine persists the scheduled state right after this
        call, so a long agent node stays visible in the run state while it
        works and a concurrent tick (which sees the started marker below)
        cannot double-start it. A missing profile fails fast on the caller's
        thread — it is the operator's misconfiguration to see."""
        handle = _handle(run_id, node_id, iteration)
        current = self.poll(handle)
        if current.settled or current.started:
            return handle
        profile = _profile_of(params)
        if not profile:
            raise ProfileNotSpecified(f"global node {node_id!r} has no profile")
        # The started marker lands before the thread spawns, so any other
        # process polling this handle sees in-flight work. (Two processes
        # racing through this method in the same few ms could still double-
        # spawn; the completion store is idempotent — last write wins.)
        self.store.write(handle, Completion(settled=False, started=True))
        threading.Thread(
            target=self._run_to_completion,
            args=(handle, dict(params)),
            name=f"hw-direct-{handle}",
            daemon=True,
        ).start()
        return handle

    def poll(self, handle: str) -> Completion:
        return self.store.read(handle)

    # --- internals --------------------------------------------------------

    def _run_to_completion(self, handle: str, params: dict) -> None:
        """Runner thread body: always settles the handle, even on a crash in
        the invocation plumbing — an unsettled handle would strand the node."""
        try:
            completion = self._invoke(params)
        except Exception as exc:  # noqa: BLE001 - must settle, never strand
            completion = Completion(
                settled=True,
                outcome="failure",
                output=f"agent invocation crashed: {exc}",
            )
        completion.started = True
        self.store.write(handle, completion)

    def _invoke(self, params: dict) -> Completion:
        profile = _profile_of(params)
        argv = build_agent_argv(
            self.hermes_bin,
            profile,
            params.get("prompt", ""),
            model=params.get("model"),
            skills=params.get("skills"),
        )
        timeout = params.get("timeout_seconds") or self.timeout_seconds
        # HERMES_PROFILE is what tools (e.g. kanban_comment) read to attribute
        # authorship; -p activates the profile, the env var pins it for the
        # child regardless of how it loads config. Mirrors the Kanban worker.
        env = {**os.environ, "HERMES_PROFILE": profile}
        try:
            proc = subprocess.run(
                argv,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
            )
        except subprocess.TimeoutExpired:
            return Completion(
                settled=True,
                outcome="failure",
                output=f"agent timed out after {timeout:g}s",
            )
        if proc.returncode == 0:
            return Completion(settled=True, outcome="success", output=clip_output(proc.stdout))
        detail = proc.stderr.strip() or proc.stdout.strip()
        return Completion(settled=True, outcome="failure", output=clip_output(detail))

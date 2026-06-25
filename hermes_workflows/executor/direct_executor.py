"""DirectExecutor — the global (unbound) backend. A node with no project board
runs by invoking the Hermes agent CLI in oneshot mode:

    hermes -p <profile> [--skills <s>]... [-m <model>] -z <prompt>

This is the same profile/model/skills contract the Kanban dispatcher uses for
project nodes (``hermes_cli.kanban_db``): ``-p`` activates the agent profile,
``--skills`` preloads each skill for the session, ``-m`` overrides the model,
and oneshot (``-z``) prints ONLY the agent's final message to stdout — which
becomes the node output. Carrying model/skills here is what makes a global
node honour the same per-node selections a project node already does.

Because the captured output IS that final message, a long node that hits a
mid-run context auto-compression (session rotation) must run on a Hermes build
with the compression fixes #48584 + #48633, or the final turn can be lost
(see README, "Hermes compatibility"). Off-board nodes (``board: false``) route
here too and are exactly the long-reasoning steps that hit compression.

There are no Kanban cards here, so the completion is persisted to a small
file-backed store keyed by an idempotent handle (``run:node:iteration``). That
keeps a multi-step global workflow durable across tick processes, just as the
Kanban backend is durable through the board DB.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Optional, Sequence

from .base import Completion
from .outcome import RetryPolicy
from .store import CompletionStore

# The detached worker, run by absolute file path (never `-m`) so the fresh child
# stays stdlib-only - see _detached_runner for why the worker must outlive the
# short-lived advancing process.
_RUNNER_PATH = str(Path(__file__).with_name("_detached_runner.py"))


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
    """The canonical oneshot agent command. ``--skills`` is emitted once per
    skill.

    A ``model@provider`` selection is split into ``-m <model> --provider
    <provider>`` rather than passed whole to ``-m``. A provider baked into the
    model name reaches the inference API verbatim — ``qwen3.6-plus@opencode-go``
    is rejected as an unknown model — so the provider must travel in its own
    ``--provider`` flag to actually switch providers for the node, overriding
    the profile's configured default (a node with ``...@opencode-go`` must run
    on opencode-go even when the profile defaults to a different provider).

    Flags are emitted only when set, so a node without a model/skills falls back
    to the profile's configured model and skill set."""
    argv = [hermes_bin, "-p", profile]
    for skill in skills or []:
        name = str(skill).strip()
        if name:
            argv += ["--skills", name]
    if model:
        model_name, _, provider = model.partition("@")
        argv += ["-m", model_name]
        if provider:
            argv += ["--provider", provider]
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
        retry_policy: Optional[RetryPolicy] = None,
    ) -> None:
        self.hermes_bin = hermes_bin
        self.store = CompletionStore(store_dir)
        self.timeout_seconds = timeout_seconds
        # Bounded transient-error retry the detached worker applies around its
        # single agent invocation (429 / overloaded / 5xx / connection reset);
        # a deterministic failure never retries. None -> the bounded default.
        self.retry_policy = retry_policy or RetryPolicy()

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
        thread — it is the operator's misconfiguration to see.

        The agent runs in a DETACHED process (its own session), not a daemon
        thread of this caller: the advancing process is short-lived and exits
        right after this returns, so a thread-bound worker would be killed
        mid-flight and the node would hang unsettled (t_a06d9af5). The detached
        worker outlives the scheduler and writes its own settled completion."""
        handle = _handle(run_id, node_id, iteration)
        current = self.poll(handle)
        if current.settled or current.started:
            return handle
        profile = _profile_of(params)
        if not profile:
            raise ProfileNotSpecified(f"global node {node_id!r} has no profile")
        argv = build_agent_argv(
            self.hermes_bin,
            profile,
            params.get("prompt", ""),
            model=params.get("model"),
            skills=params.get("skills"),
        )
        # Explicit None check, not `or`: a node that set a value (even a falsy
        # one) gets it; only an unset timeout falls back to the executor default.
        timeout = params.get("timeout_seconds")
        if timeout is None:
            timeout = self.timeout_seconds
        completion_path = self.store.path_for(handle)
        # HERMES_PROFILE is what tools (e.g. kanban_comment) read to attribute
        # authorship; -p activates the profile, the env var pins it for the
        # child regardless of how it loads config. Mirrors the Kanban worker.
        spec = {
            "argv": argv,
            "timeout": timeout,
            "completion_path": str(completion_path),
            "env": {"HERMES_PROFILE": profile},
            "retry": {
                "max_attempts": self.retry_policy.max_attempts,
                "base_seconds": self.retry_policy.base_seconds,
                "ceiling_seconds": self.retry_policy.ceiling_seconds,
            },
        }
        # The started marker lands before the worker spawns, so any other process
        # polling this handle sees in-flight work and does not double-start it.
        # (Two processes racing here in the same few ms could still double-spawn;
        # the completion store is idempotent — last write wins.)
        self.store.write(handle, Completion(settled=False, started=True))
        spec_path = completion_path.with_name(completion_path.name + ".req.json")
        self.store.root.mkdir(parents=True, exist_ok=True)
        spec_path.write_text(json.dumps(spec))
        try:
            subprocess.Popen(
                [sys.executable, _RUNNER_PATH, str(spec_path)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except Exception as exc:  # noqa: BLE001 - never leave the node stranded as started
            self.store.write(
                handle,
                Completion(
                    settled=True,
                    outcome="failure",
                    output=f"could not launch direct worker: {exc}",
                    started=True,
                ),
            )
        return handle

    def poll(self, handle: str) -> Completion:
        return self.store.read(handle)

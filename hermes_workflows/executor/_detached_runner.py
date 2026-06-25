"""Detached worker for DirectExecutor. Runs ONE agent invocation and writes its
settled completion to the store file, then exits.

Why a separate process and not a thread: the engine advances a run from
short-lived processes (`hermes-workflows run`, and the `advance-all` tick shim).
``DirectExecutor.schedule`` is non-blocking by contract, so the advancing
process exits right after scheduling. A worker run in a daemon thread of that
process dies with it - the agent is orphaned, its result is never captured, and
the node hangs `started`-but-unsettled forever (the global/cron-driven hang,
t_a06d9af5). Launched as a detached process (its own session), this runner
outlives the scheduler and settles the node on its own.

Run by ABSOLUTE FILE PATH (``python <this file> <spec.json>``), never as
``-m hermes_workflows...``: a path run does not import the ``hermes_workflows``
package, so this stays stdlib-only and needs neither ``hermes_cli`` nor the
heavy ``executor`` package import in the fresh child. The completion-file
format mirrors ``store.CompletionStore`` (keys: settled/outcome/output/started).

Spec JSON (written by ``DirectExecutor.schedule``):
    {"argv": [...], "timeout": <float|null>, "completion_path": "<path>",
     "env": {"HERMES_PROFILE": "..."}}
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from typing import Optional

# Launched by absolute path (`python <this file> <spec>`), so sys.path[0] is this
# directory and `outcome` resolves as a sibling top-level module - it stays
# stdlib-only for exactly this reason, so the fresh child needs no package import.
# The fallback covers the rare case the runner is imported as part of the package.
try:
    from outcome import RetryPolicy, backoff_delay, classify, parse_node_outcome
except ImportError:  # pragma: no cover - package-context import
    from hermes_workflows.executor.outcome import (
        RetryPolicy,
        backoff_delay,
        classify,
        parse_node_outcome,
    )

# Mirror store.MAX_OUTPUT_CHARS: cap captured output so a runaway worker cannot
# bloat the run store.
MAX_OUTPUT_CHARS = 100_000


def _clip(text):
    cleaned = (text or "").strip()
    if len(cleaned) <= MAX_OUTPUT_CHARS:
        return cleaned
    return cleaned[:MAX_OUTPUT_CHARS] + "\n…[truncated]"


def _write_completion(path, *, settled, outcome, output, started=True, transient_retries=0):
    """Atomic write matching CompletionStore.write so a concurrent reader never
    sees a half-written file."""
    payload = json.dumps(
        {
            "settled": settled,
            "outcome": outcome,
            "output": output,
            "started": started,
            "transient_retries": transient_retries,
        }
    )
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        fh.write(payload)
    os.replace(tmp, path)


def _read_text(handle) -> str:
    handle.seek(0)
    return handle.read().decode("utf-8", "replace")


def _kill_process_group(proc) -> None:
    """SIGKILL the worker's whole process group - start_new_session made it the
    group leader, so any detached child it spawned dies too - then reap it."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        proc.kill()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def _attempt(argv, timeout, env_extra):
    """Run the agent argv ONCE, capturing stdout/stderr to temp files (NOT pipes
    - a detached grandchild inheriting the agent's stdio would otherwise wedge a
    pipe read past the timeout). Returns ``(completion_dict, kind)`` where ``kind``
    is the classifier's ``success`` | ``transient`` | ``deterministic`` so the
    retry loop can ride out a transient blip without re-parsing. A launch failure
    or a timeout is deterministic - neither is a provider blip a retry would fix."""
    env = {**os.environ, **(env_extra or {})}
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        try:
            proc = subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                env=env,
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            runner = argv[0] if argv else ""
            return (
                dict(
                    settled=True,
                    outcome="failure",
                    output=f"agent runner {runner!r} not found: {exc}",
                ),
                "deterministic",
            )
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_process_group(proc)
            return (
                dict(
                    settled=True, outcome="failure", output=f"agent timed out after {timeout:g}s"
                ),
                "deterministic",
            )
        stdout = _read_text(out)
        stderr = _read_text(err)
    if proc.returncode == 0:
        # Exit 0 is necessary but not sufficient: the agent CLI exits cleanly even
        # when its LLM call exhausted retries on a transient provider error (it
        # prints the error as its final message), and a node may self-report
        # failure via a `node_outcome` token. Classify rather than trust the code.
        token = parse_node_outcome(stdout)
        verdict = classify(proc.returncode, stdout, node_outcome_token=token)
        if verdict["outcome"] == "success":
            return dict(settled=True, outcome="success", output=_clip(stdout)), "success"
        # Keep the matched sentinel line (when one tripped) so the node output is
        # the cause, not the swallowed success message.
        detail = verdict["detail"] or stdout.strip()
        return dict(settled=True, outcome="failure", output=_clip(detail)), verdict["kind"]
    detail = stderr.strip() or stdout.strip()
    return dict(settled=True, outcome="failure", output=_clip(detail)), "deterministic"


def _retry_policy(spec_retry) -> RetryPolicy:
    """The transient-retry policy for this run, from the spec (or the defaults).
    A malformed/absent block falls back to the bounded default - a retry config
    error must never widen the cap or strand the node."""
    if not isinstance(spec_retry, dict):
        return RetryPolicy()
    return RetryPolicy(
        max_attempts=int(spec_retry.get("max_attempts", RetryPolicy.max_attempts)),
        base_seconds=float(spec_retry.get("base_seconds", RetryPolicy.base_seconds)),
        ceiling_seconds=float(spec_retry.get("ceiling_seconds", RetryPolicy.ceiling_seconds)),
    )


def _invoke(argv, timeout, env_extra, *, retry=None, sleep=time.sleep):
    """Run the agent with bounded transient-error retry. A 429 / overloaded /
    5xx / connection-reset blip (``kind == "transient"``) is retried with
    exponential backoff up to the policy cap; a deterministic failure (real work
    failed, a declared ``node_outcome: failure``, a launch error, or a timeout)
    fails fast with no retry. The settled completion carries the count of
    transient retries ridden out, so the dashboard shows the wait, not a silent
    stall. ``sleep`` is injectable so the seam tests need no wall-clock wait."""
    policy = _retry_policy(retry)
    transient_retries = 0
    result: dict = {}
    for attempt in range(1, policy.max_attempts + 1):
        result, kind = _attempt(argv, timeout, env_extra)
        if kind != "transient" or attempt >= policy.max_attempts:
            # Success, a deterministic failure, or the last allowed attempt: settle.
            break
        # A transient blip with attempts to spare: back off and try again.
        transient_retries += 1
        delay = backoff_delay(attempt, base=policy.base_seconds, ceiling=policy.ceiling_seconds)
        if delay > 0:
            sleep(delay)
    result["transient_retries"] = transient_retries
    return result


def main(argv) -> int:
    spec_path = argv[1] if len(argv) > 1 else ""
    # Recover the completion path from the request-file name up front, so a spec
    # that fails to parse (missing/corrupt, or absent completion_path) still
    # settles a failure rather than stranding the handle as started forever.
    completion_path: Optional[str] = (
        spec_path[: -len(".req.json")] if spec_path.endswith(".req.json") else None
    )
    try:
        with open(spec_path, encoding="utf-8") as fh:
            spec = json.load(fh)
        completion_path = spec.get("completion_path") or completion_path
        if not completion_path:
            raise ValueError("spec is missing completion_path")
        result = _invoke(
            spec["argv"], spec.get("timeout"), spec.get("env"), retry=spec.get("retry")
        )
    except Exception as exc:  # noqa: BLE001 - must settle, never strand the node
        result = dict(settled=True, outcome="failure", output=f"agent invocation crashed: {exc}")
    if completion_path is not None:
        _write_completion(completion_path, **result)
    # Best-effort cleanup of the one-shot request file.
    try:
        os.unlink(spec_path)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

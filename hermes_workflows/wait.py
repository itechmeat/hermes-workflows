"""Worker-free evaluation of a `wait` node's `wait_for` predicate, run inside the
engine tick (no Kanban card, no LLM worker).

Today one condition exists: ``github_pr_merged`` — poll a PR's state with
``gh pr view <ref> --json state``. MERGED settles the node success, CLOSED (not
merged) settles failure, OPEN keeps waiting. A transient `gh` error (network,
auth hiccup) returns "keep waiting" rather than failing the node, so a blip just
retries on the next tick. `gh` resolves its credentials from the engine
process's own HOME (the tick runs as the login user), so no extra env is needed.
"""

from __future__ import annotations

import json
import subprocess
from typing import Any, Callable, Mapping, Optional


# Cap a single `gh` poll so a hung CLI cannot stall the whole tick loop.
_GH_TIMEOUT_SECONDS = 30


def github_pr_state(
    ref: str, *, run: Callable[..., Any] = subprocess.run, gh_bin: str = "gh"
) -> Optional[str]:
    """The PR's state (``OPEN`` / ``CLOSED`` / ``MERGED``) for ``ref`` (a PR URL or
    number), or ``None`` when it cannot be determined right now (gh error, timeout,
    bad output) — the caller treats ``None`` as "keep waiting"."""
    try:
        proc = run(
            [gh_bin, "pr", "view", ref, "--json", "state"],
            capture_output=True,
            text=True,
            timeout=_GH_TIMEOUT_SECONDS,
        )
    except Exception:  # noqa: BLE001 - a gh failure/timeout is transient; keep waiting
        return None
    if getattr(proc, "returncode", 1) != 0:
        return None
    try:
        return json.loads(proc.stdout).get("state")
    except (ValueError, TypeError):
        return None


def evaluate(
    wait_for: Mapping[str, Any],
    *,
    gh_state: Optional[Callable[[str], Optional[str]]] = None,
) -> Optional[str]:
    """Settle a (already-resolved) wait condition to ``"success"`` / ``"failure"``,
    or ``None`` to keep waiting. Raises ValueError on an unknown condition.
    ``gh_state`` defaults to :func:`github_pr_state`, looked up at call time so a
    test can monkeypatch it."""
    state_fn = gh_state or github_pr_state
    if "github_pr_merged" in wait_for:
        state = state_fn(wait_for["github_pr_merged"])
        if state == "MERGED":
            return "success"
        if state == "CLOSED":
            return "failure"
        return None
    raise ValueError(f"unknown wait_for condition: {sorted(wait_for)}")

"""Pure failure classifier - the single contract shared by both executor paths.

A node's outcome must not be decided by exit code alone. The Hermes agent CLI
exits 0 even when its LLM call exhausts retries on a transient provider error: it
prints `API call failed after N retries: HTTP 429 …` as its final message and
returns cleanly. Settling such a node `success` lets the graph advance on
garbage (the 2026-06-24 lock-scope cascade). This classifier reads the exit code
plus stdout for provider-error sentinels, and honours a self-reported
`node_outcome` token (the same `{"node_outcome": "success"|"failure"}` contract
as `bridge/kanban._node_outcome_override`) so a node that knows its result can
declare it regardless of exit code.

It returns both the settled `outcome` (`success` | `failure`) and a `kind`
(`success` | `transient` | `deterministic`) so a retry policy can decide
transient-retry vs fail-fast without re-parsing. The `detail` field carries the
matched sentinel line so the node output is never a bare exit code.

No I/O, no side effects - unit-tested in isolation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, TypedDict

# Transient provider-error sentinels. Matched against individual stdout lines so a
# false positive needs the exact phrase on its own line, not a stray number in
# prose (a node that mentions "429 lines" must not be misclassified). The
# authoritative marker is the exhausted-retry line the agent CLI prints; the
# explicit `HTTP <code>` / "temporarily overloaded" / connection-reset phrases
# cover the same family of provider faults.
_TRANSIENT_PATTERNS = (
    re.compile(r"API call failed after \d+ retr(?:y|ies)", re.IGNORECASE),
    re.compile(r"HTTP\s*429", re.IGNORECASE),
    re.compile(r"HTTP\s*50[234]", re.IGNORECASE),
    re.compile(r"temporarily overloaded", re.IGNORECASE),
    re.compile(r"\boverloaded_error\b", re.IGNORECASE),
    re.compile(r"usage limit", re.IGNORECASE),
    re.compile(r"connection reset", re.IGNORECASE),
)

# The machine-readable self-report token, e.g. `{"node_outcome": "failure"}`. The
# agent emits it as a tail token in its final message; tolerant of internal
# whitespace but pinned to the exact key/value so prose never trips it.
_NODE_OUTCOME_TOKEN = re.compile(
    r'\{\s*"node_outcome"\s*:\s*"(success|failure)"\s*\}'
)


class Verdict(TypedDict):
    outcome: str  # "success" | "failure"
    kind: str  # "success" | "transient" | "deterministic"
    detail: Optional[str]  # the matched sentinel line, when one tripped


@dataclass(frozen=True)
class RetryPolicy:
    """The bounded transient-retry contract shared by both executor paths.

    ``max_attempts`` is the hard cap on total tries (so 3 means at most two
    retries after the first attempt); ``base_seconds`` / ``ceiling_seconds``
    bound the exponential backoff. The cap is what keeps a transient retry from
    amplifying a provider outage into an unbounded retry storm - a deterministic
    failure is never retried at all (the caller keys retry on the classifier's
    ``kind``). ``base_seconds == 0`` disables the wall-clock wait (the seam tests
    use to exercise the loop without sleeping)."""

    max_attempts: int = 3
    base_seconds: float = 2.0
    ceiling_seconds: float = 30.0


def backoff_delay(attempt: int, *, base: float, ceiling: float) -> float:
    """The wait (seconds) before transient retry ``attempt`` (1-indexed): an
    exponential ``base * 2**(attempt - 1)`` clamped at ``ceiling``. A
    non-positive attempt or a zero base yields no wait."""
    if attempt < 1 or base <= 0:
        return 0.0
    return min(base * (2 ** (attempt - 1)), ceiling)


def parse_node_outcome(text: Optional[str]) -> Optional[str]:
    """The agent's self-reported `node_outcome` token from its stdout, or None.

    When more than one token appears the agent's final (tail) declaration wins.
    This is the direct-path analogue of reading `node_outcome` from a Kanban
    run's metadata - same contract, different transport (stdout vs DB column)."""
    if not text:
        return None
    matches = _NODE_OUTCOME_TOKEN.findall(text)
    if not matches:
        return None
    return matches[-1]


def _match_transient(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    for line in text.splitlines():
        for pattern in _TRANSIENT_PATTERNS:
            if pattern.search(line):
                return line.strip()
    return None


def classify(
    returncode: int, stdout: str, *, node_outcome_token: Optional[str] = None
) -> Verdict:
    """Decide a node's outcome from its exit code, stdout, and self-report token.

    Precedence:
    1. A `node_outcome` token is authoritative in EITHER direction - a node that
       declares success despite a transient string still succeeds, and one that
       declares failure on a clean exit 0 still fails (deterministic: it knows).
    2. Otherwise a transient provider-error sentinel in stdout fails the node even
       on exit 0, classified `transient` so a retry policy may back off and retry.
    3. Otherwise the exit code decides: 0 -> success, non-zero -> deterministic
       failure (real work failed; no transient retry)."""
    if node_outcome_token == "success":
        return {"outcome": "success", "kind": "success", "detail": None}
    if node_outcome_token == "failure":
        return {"outcome": "failure", "kind": "deterministic", "detail": None}

    matched = _match_transient(stdout)
    if matched is not None:
        return {"outcome": "failure", "kind": "transient", "detail": matched}

    if returncode == 0:
        return {"outcome": "success", "kind": "success", "detail": None}
    return {"outcome": "failure", "kind": "deterministic", "detail": None}

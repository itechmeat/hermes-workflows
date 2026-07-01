"""Unit tests for the pure failure classifier (`executor/outcome.py`).

The classifier is the single contract shared by both executor paths: it must not
let exit code 0 alone settle a node `success` when the agent printed an exhausted
transient provider error, and it must honour a self-reported `node_outcome`
token in either direction regardless of exit code. It also returns a `kind`
(success | transient | deterministic) so a retry policy can decide
transient-retry vs fail-fast without re-parsing.
"""

from __future__ import annotations

import pytest

from hermes_workflows.executor.outcome import (
    RetryPolicy,
    backoff_delay,
    classify,
    parse_node_outcome,
)


# --- the clean path ---------------------------------------------------------


def test_clean_exit_zero_is_success() -> None:
    verdict = classify(0, "done: built the thing", node_outcome_token=None)
    assert verdict["outcome"] == "success"
    assert verdict["kind"] == "success"


def test_nonzero_exit_without_sentinel_is_deterministic_failure() -> None:
    verdict = classify(3, "traceback: boom", node_outcome_token=None)
    assert verdict["outcome"] == "failure"
    assert verdict["kind"] == "deterministic"


# --- transient provider-error sentinels on exit 0 ---------------------------


@pytest.mark.parametrize(
    "line",
    [
        "API call failed after 3 retries: HTTP 429: The service may be temporarily overloaded",
        "Error: HTTP 429 Too Many Requests",
        "the service may be temporarily overloaded, please try again",
        "upstream returned HTTP 503 Service Unavailable",
        "gateway error HTTP 502",
        "HTTP 504 gateway timeout",
        "API call failed after 5 retries",
        "provider rejected: usage limit reached, retry later",
    ],
)
def test_transient_sentinel_on_exit_zero_is_failure(line: str) -> None:
    stdout = f"working on it...\n{line}\n"
    verdict = classify(0, stdout, node_outcome_token=None)
    assert verdict["outcome"] == "failure"
    assert verdict["kind"] == "transient"
    # The matched line is preserved so the node output is not a bare exit code.
    assert line.strip() in (verdict["detail"] or "")


def test_bare_number_in_prose_is_not_a_false_positive() -> None:
    """A node that legitimately mentions a number must not be misclassified -
    only the specific exhausted-retry / API-failure sentinels trip the classifier."""
    stdout = "I reviewed 429 lines and found the 503 area code is fine."
    verdict = classify(0, stdout, node_outcome_token=None)
    assert verdict["outcome"] == "success"
    assert verdict["kind"] == "success"


# --- the self-reported node_outcome token (authoritative both ways) ---------


def test_declared_node_outcome_failure_is_deterministic() -> None:
    verdict = classify(0, "ran every check; CI drifted", node_outcome_token="failure")
    assert verdict["outcome"] == "failure"
    assert verdict["kind"] == "deterministic"


def test_declared_node_outcome_success_overrides_a_sentinel() -> None:
    """The token is authoritative in either direction: a node that knows it
    succeeded despite mentioning a transient string still settles success."""
    stdout = "retried past a HTTP 429 and recovered; all good"
    verdict = classify(0, stdout, node_outcome_token="success")
    assert verdict["outcome"] == "success"
    assert verdict["kind"] == "success"


# --- parsing the token out of agent stdout (direct-path contract) -----------


def test_parse_node_outcome_reads_the_json_token() -> None:
    assert parse_node_outcome('summary\n{"node_outcome": "failure"}') == "failure"
    assert parse_node_outcome('all done\n{"node_outcome": "success"}\n') == "success"


def test_parse_node_outcome_takes_the_tail_token() -> None:
    """When more than one token appears, the agent's final (tail) declaration wins."""
    text = '{"node_outcome": "success"}\n...changed my mind...\n{"node_outcome": "failure"}'
    assert parse_node_outcome(text) == "failure"


def test_parse_node_outcome_ignores_absent_or_invalid() -> None:
    assert parse_node_outcome("no token here") is None
    assert parse_node_outcome("") is None
    assert parse_node_outcome(None) is None
    assert parse_node_outcome('{"node_outcome": "maybe"}') is None


# --- the bounded backoff policy (shared by both executor retry loops) --------


def test_retry_policy_defaults_are_bounded() -> None:
    """The default policy caps attempts and the backoff ceiling so a transient
    retry can never amplify a provider outage into an unbounded loop."""
    policy = RetryPolicy()
    assert policy.max_attempts == 3
    assert policy.base_seconds > 0
    assert policy.ceiling_seconds >= policy.base_seconds


def test_backoff_delay_grows_exponentially_then_caps() -> None:
    """The wait before retry N grows base * 2**(N-1) and is clamped at the
    ceiling - the bound that keeps a retry storm from worsening an outage."""
    assert backoff_delay(1, base=2.0, ceiling=30.0) == 2.0
    assert backoff_delay(2, base=2.0, ceiling=30.0) == 4.0
    assert backoff_delay(3, base=2.0, ceiling=30.0) == 8.0
    # Far-out attempts saturate at the ceiling rather than exploding.
    assert backoff_delay(10, base=2.0, ceiling=30.0) == 30.0


def test_backoff_delay_is_zero_below_first_retry_and_with_zero_base() -> None:
    """A non-positive attempt has no wait, and a zero base disables the sleep
    entirely (the seam tests use to retry without real wall-clock delay)."""
    assert backoff_delay(0, base=2.0, ceiling=30.0) == 0.0
    assert backoff_delay(1, base=0.0, ceiling=30.0) == 0.0

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

from hermes_workflows.executor.outcome import classify, parse_node_outcome


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

"""Worker-free wait-node evaluation: poll a GitHub PR's state and settle the node
on MERGED (success) / CLOSED (failure), keep waiting on OPEN or a transient gh
error."""

from __future__ import annotations

import pytest

from hermes_workflows import wait


class _Proc:
    def __init__(self, returncode: int, stdout: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout


def test_github_pr_state_parses_state() -> None:
    run = lambda *a, **k: _Proc(0, '{"state": "MERGED"}')  # noqa: E731
    assert wait.github_pr_state("123", run=run) == "MERGED"


def test_github_pr_state_passes_a_timeout() -> None:
    seen: dict = {}

    def run(argv, **kwargs):
        seen.update(kwargs)
        return _Proc(0, '{"state": "OPEN"}')

    wait.github_pr_state("123", run=run)
    assert seen.get("timeout") == wait._GH_TIMEOUT_SECONDS


def test_github_pr_state_keeps_waiting_on_errors() -> None:
    assert wait.github_pr_state("x", run=lambda *a, **k: _Proc(1, "not found")) is None
    assert wait.github_pr_state("x", run=lambda *a, **k: _Proc(0, "not json")) is None

    def boom(*_a, **_k):
        raise OSError("gh missing")

    assert wait.github_pr_state("x", run=boom) is None


def test_evaluate_outcomes() -> None:
    assert wait.evaluate({"github_pr_merged": "1"}, gh_state=lambda _r: "MERGED") == "success"
    assert wait.evaluate({"github_pr_merged": "1"}, gh_state=lambda _r: "CLOSED") == "failure"
    assert wait.evaluate({"github_pr_merged": "1"}, gh_state=lambda _r: "OPEN") is None
    assert wait.evaluate({"github_pr_merged": "1"}, gh_state=lambda _r: None) is None


def test_evaluate_rejects_unknown_condition() -> None:
    with pytest.raises(ValueError):
        wait.evaluate({"some_future_signal": "x"})

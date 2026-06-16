"""P1.3 — DirectExecutor: run a global node by invoking the Hermes agent CLI in
oneshot mode (``hermes -p <profile> [--skills X]... [-m <model>] -z <prompt>``),
capture stdout, persist the completion under a results store keyed by an
idempotent handle. Oneshot (-z) prints only the agent's final message, which
becomes the node output — the same profile/model/skills contract the Kanban
dispatcher uses for project nodes.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from hermes_workflows.executor import Completion
from hermes_workflows.executor.direct_executor import (
    DirectExecutor,
    ProfileNotSpecified,
    build_agent_argv,
)


def _fake_hermes(path: Path, body: str) -> Path:
    """A stand-in for the ``hermes`` binary. Parses the oneshot prompt out of
    ``-z`` so a test can echo it back, then runs ``body``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "#!/usr/bin/env bash\n"
        'ARGV=("$@")\n'
        'PROMPT=""\n'
        'while [ $# -gt 0 ]; do case "$1" in -z) shift; PROMPT="$1";; esac; shift; done\n'
        f"{body}\n"
    )
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IRWXU)
    return path


@pytest.fixture()
def store_dir(tmp_path: Path) -> Path:
    return tmp_path / "store"


def _executor(tmp_path: Path, store_dir: Path, *, timeout: float = 10.0) -> DirectExecutor:
    hermes = _fake_hermes(tmp_path / "hermes", 'echo "done: $PROMPT"')
    return DirectExecutor(hermes_bin=str(hermes), store_dir=store_dir, timeout_seconds=timeout)


def _wait_settled(ex: DirectExecutor, handle: str, deadline_s: float = 10.0) -> Completion:
    import time

    deadline = time.monotonic() + deadline_s
    while time.monotonic() < deadline:
        completion = ex.poll(handle)
        if completion.settled:
            return completion
        time.sleep(0.02)
    raise AssertionError(f"handle {handle} never settled")


# --- the contract: model + skills + profile reach the agent ----------------


def test_build_argv_carries_profile_skills_and_model() -> None:
    """The selected agent (profile), skills, and model override must all land in
    the canonical oneshot command — this is the global-scope equivalent of the
    Kanban card's assignee / skills / model_override columns."""
    argv = build_agent_argv(
        "hermes",
        "product-tech-lead",
        "do the thing",
        model="deepseek-v4-pro@opencode-go",
        skills=["research-paper-writing", "blog-content-pipeline"],
    )
    # The provider is split out of the model into its own --provider flag so it
    # actually switches providers (a model name with an @provider suffix is
    # rejected by the inference API as unknown).
    assert argv == [
        "hermes",
        "-p",
        "product-tech-lead",
        "--skills",
        "research-paper-writing",
        "--skills",
        "blog-content-pipeline",
        "-m",
        "deepseek-v4-pro",
        "--provider",
        "opencode-go",
        "-z",
        "do the thing",
    ]


def test_build_argv_keeps_bare_model_without_a_provider_flag() -> None:
    """A model with no ``@provider`` suffix passes through as ``-m <model>`` with
    no ``--provider`` — Hermes then resolves the provider (profile default /
    auto-detect)."""
    argv = build_agent_argv("hermes", "p", "go", model="claude-sonnet-4")
    assert argv == ["hermes", "-p", "p", "-m", "claude-sonnet-4", "-z", "go"]
    assert "--provider" not in argv


def test_build_argv_omits_absent_model_and_skills() -> None:
    """A node with no model / no skills must not emit empty flags — the agent
    falls back to the profile's configured model and default skill set."""
    argv = build_agent_argv("hermes", "fullstack-engineer", "go", model=None, skills=None)
    assert argv == ["hermes", "-p", "fullstack-engineer", "-z", "go"]
    assert "--skills" not in argv
    assert "-m" not in argv


def test_build_argv_skips_blank_skill_names() -> None:
    argv = build_agent_argv("hermes", "p", "go", skills=["", "real", "  "])
    assert argv.count("--skills") == 1
    assert "real" in argv


def test_invocation_passes_skills_and_model_through_subprocess(tmp_path, store_dir) -> None:
    """End-to-end through the real subprocess path: the fake hermes records the
    argv it was launched with, proving model/skills are not dropped."""
    capture = tmp_path / "argv.txt"
    hermes = _fake_hermes(
        tmp_path / "hermes",
        f'printf "%s\\n" "${{ARGV[@]}}" > {capture}\necho "ok: $PROMPT"',
    )
    ex = DirectExecutor(hermes_bin=str(hermes), store_dir=store_dir, timeout_seconds=10)
    handle = ex.schedule(
        run_id="run-1",
        node_id="analyze",
        workflow_id="wf",
        params={
            "assignee": "product-tech-lead",
            "prompt": "design scopes",
            "model": "deepseek-v4-pro@opencode-go",
            "skills": ["research-paper-writing"],
        },
    )
    completion = _wait_settled(ex, handle)
    assert completion.outcome == "success"
    recorded = capture.read_text()
    assert "-p\nproduct-tech-lead" in recorded
    assert "--skills\nresearch-paper-writing" in recorded
    # Model and provider arrive as separate flags with a clean model name.
    assert "-m\ndeepseek-v4-pro\n" in recorded
    assert "--provider\nopencode-go" in recorded
    assert "deepseek-v4-pro@opencode-go" not in recorded
    assert "-z\ndesign scopes" in recorded


# --- lifecycle / durability (preserved from the runner_dir contract) --------


def test_success_settles_with_final_message_stdout(tmp_path, store_dir) -> None:
    ex = _executor(tmp_path, store_dir)
    handle = ex.schedule(
        run_id="run-1",
        node_id="research",
        workflow_id="wf",
        params={"assignee": "researcher", "prompt": "go"},
    )
    completion = _wait_settled(ex, handle)
    assert isinstance(completion, Completion)
    assert completion.settled is True
    assert completion.outcome == "success"
    assert completion.output == "done: go"


def test_nonzero_exit_settles_failure(tmp_path, store_dir) -> None:
    hermes = _fake_hermes(tmp_path / "hermes", 'echo "boom" >&2; exit 3')
    ex = DirectExecutor(hermes_bin=str(hermes), store_dir=store_dir, timeout_seconds=10)
    handle = ex.schedule(
        run_id="run-1", node_id="n", workflow_id="wf", params={"assignee": "researcher"}
    )
    completion = _wait_settled(ex, handle)
    assert completion.outcome == "failure"
    assert "boom" in (completion.output or "")


def test_missing_profile_raises_clear_error(tmp_path, store_dir) -> None:
    ex = _executor(tmp_path, store_dir)
    with pytest.raises(ProfileNotSpecified):
        ex.schedule(run_id="run-1", node_id="n", workflow_id="wf", params={})


def test_per_node_timeout_overrides_the_executor_default(tmp_path, store_dir) -> None:
    """The node's own ``timeout_seconds`` is honored — a slow agent fails at the
    node deadline, not the executor's generous default."""
    hermes = _fake_hermes(tmp_path / "hermes", "sleep 5")
    # Generous executor default; the per-node timeout (0.3s) must win.
    ex = DirectExecutor(hermes_bin=str(hermes), store_dir=store_dir, timeout_seconds=600)
    handle = ex.schedule(
        run_id="run-1",
        node_id="n",
        workflow_id="wf",
        params={"assignee": "slow", "timeout_seconds": 0.3},
    )
    completion = _wait_settled(ex, handle)
    assert completion.outcome == "failure"
    assert "timed out" in (completion.output or "")


def test_executor_default_timeout_applies_without_a_node_timeout(tmp_path, store_dir) -> None:
    hermes = _fake_hermes(tmp_path / "hermes", "sleep 5")
    ex = DirectExecutor(hermes_bin=str(hermes), store_dir=store_dir, timeout_seconds=0.3)
    handle = ex.schedule(
        run_id="run-1", node_id="n", workflow_id="wf", params={"assignee": "slow"}
    )
    completion = _wait_settled(ex, handle)
    assert completion.outcome == "failure"


def test_detached_child_holding_stdio_does_not_block_settling(tmp_path, store_dir) -> None:
    """The agent may spawn a detached child that outlives it and inherits its
    stdio (e.g. `hermes send`'s delivery worker). With pipe capture the node
    would hang until that grandchild exits — past its own timeout. Capturing to
    a file decouples them: the node settles as soon as the agent itself exits."""
    # `sleep 5 &` leaks a backgrounded grandchild holding the inherited stdio;
    # the agent then prints and exits. timeout is a short 2s, the wait deadline
    # 4s — both shorter than the 5s grandchild, so settling proves we did not
    # block on it.
    hermes = _fake_hermes(tmp_path / "hermes", 'sleep 5 & echo "done: $PROMPT"')
    ex = DirectExecutor(hermes_bin=str(hermes), store_dir=store_dir, timeout_seconds=2)
    handle = ex.schedule(
        run_id="run-1",
        node_id="n",
        workflow_id="wf",
        params={"assignee": "researcher", "prompt": "go"},
    )
    completion = _wait_settled(ex, handle, deadline_s=4)
    assert completion.outcome == "success"
    assert completion.output == "done: go"


def test_completion_survives_a_short_lived_scheduling_process(tmp_path, store_dir) -> None:
    """The advancing process (``hermes-workflows run`` / the ``advance-all`` tick
    shim) is short-lived: it calls ``schedule`` and exits immediately, since
    ``schedule`` is non-blocking by contract. The node's worker must NOT be tied
    to that process's lifetime - a worker run in a daemon thread of the scheduler
    dies when the scheduler exits, orphaning the agent and never writing the
    settled completion (the global/cron-driven hang reported in t_a06d9af5).

    Here a separate Python process schedules the node and exits before the fake
    agent (a 1s sleep) finishes; this process then polls the store. The worker
    must outlive its scheduler and settle the node on its own."""
    import subprocess
    import sys
    import textwrap

    hermes = _fake_hermes(tmp_path / "hermes", 'sleep 1; echo "done: $PROMPT"')
    repo_root = Path(__file__).resolve().parents[2]
    script = textwrap.dedent(
        f"""
        from hermes_workflows.executor.direct_executor import DirectExecutor
        ex = DirectExecutor(
            hermes_bin={str(hermes)!r}, store_dir={str(store_dir)!r}, timeout_seconds=10
        )
        ex.schedule(
            run_id="run-1", node_id="n", workflow_id="wf",
            params={{"assignee": "researcher", "prompt": "go"}},
        )
        """
    )
    # The scheduling process returns from schedule() and exits right away.
    # Carry this test's sys.path (which conftest seeded with the Hermes install)
    # so the bare subprocess can import the plugin package; the detached worker
    # it spawns is stdlib-only and needs none of this.
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(p for p in sys.path if p)}
    subprocess.run(
        [sys.executable, "-c", script], cwd=str(repo_root), check=True, timeout=10, env=env
    )
    # Poll from this process; the scheduler is already gone. A daemon-thread
    # worker would have died with it and never settled.
    poller = DirectExecutor(hermes_bin=str(hermes), store_dir=store_dir, timeout_seconds=10)
    completion = _wait_settled(poller, "run-1:n:0", deadline_s=6)
    assert completion.outcome == "success"
    assert completion.output == "done: go"


def test_poll_unknown_handle_is_not_settled(tmp_path, store_dir) -> None:
    ex = _executor(tmp_path, store_dir)
    completion = ex.poll("run-1:n:0")
    assert completion.settled is False
    assert completion.outcome is None


def test_handle_is_idempotent_per_iteration(tmp_path, store_dir) -> None:
    ex = _executor(tmp_path, store_dir)
    params = {"assignee": "researcher"}
    first = ex.schedule(run_id="run-1", node_id="n", workflow_id="wf", params=params)
    again = ex.schedule(run_id="run-1", node_id="n", workflow_id="wf", params=params)
    looped = ex.schedule(
        run_id="run-1", node_id="n", workflow_id="wf", params=params, iteration=1
    )
    assert first == again
    assert looped != first


def test_settled_handle_is_not_re_executed(tmp_path, store_dir) -> None:
    counter = tmp_path / "count"
    hermes = _fake_hermes(tmp_path / "hermes", f'echo "x" >> {counter}')
    ex = DirectExecutor(hermes_bin=str(hermes), store_dir=store_dir, timeout_seconds=10)
    params = {"assignee": "researcher"}
    first = ex.schedule(run_id="run-1", node_id="n", workflow_id="wf", params=params)
    _wait_settled(ex, first)
    again = ex.schedule(run_id="run-1", node_id="n", workflow_id="wf", params=params)
    assert first == again
    assert counter.read_text().count("x") == 1


def test_persisted_completion_survives_a_fresh_executor(tmp_path, store_dir) -> None:
    hermes = _fake_hermes(tmp_path / "hermes", 'echo "persisted"')
    first = DirectExecutor(hermes_bin=str(hermes), store_dir=store_dir, timeout_seconds=10)
    handle = first.schedule(
        run_id="run-1", node_id="n", workflow_id="wf", params={"assignee": "researcher"}
    )
    _wait_settled(first, handle)
    reopened = DirectExecutor(
        hermes_bin=str(hermes), store_dir=store_dir, timeout_seconds=10
    ).poll(handle)
    assert reopened.settled is True
    assert reopened.outcome == "success"
    assert reopened.output == "persisted"


def test_store_dir_is_created_on_demand(tmp_path, store_dir) -> None:
    ex = _executor(tmp_path, store_dir)
    assert not os.path.exists(store_dir)
    ex.schedule(run_id="run-1", node_id="n", workflow_id="wf", params={"assignee": "researcher"})
    assert os.path.isdir(store_dir)


def test_schedule_returns_before_the_agent_finishes(tmp_path, store_dir) -> None:
    """schedule() is non-blocking: the engine persists the scheduled state right
    after, so a long node is visible while it works (and a concurrent tick
    cannot double-start it)."""
    import time

    hermes = _fake_hermes(tmp_path / "hermes", 'sleep 3; echo "done"')
    ex = DirectExecutor(hermes_bin=str(hermes), store_dir=store_dir, timeout_seconds=10)
    t0 = time.monotonic()
    handle = ex.schedule(
        run_id="run-1", node_id="n", workflow_id="wf", params={"assignee": "slow"}
    )
    assert time.monotonic() - t0 < 1.0
    assert ex.poll(handle).settled is False
    completion = _wait_settled(ex, handle)
    assert completion.outcome == "success"
    assert completion.output == "done"


def test_inflight_handle_is_not_double_spawned(tmp_path, store_dir) -> None:
    counter = tmp_path / "count"
    hermes = _fake_hermes(tmp_path / "hermes", f'echo "x" >> {counter}; sleep 1')
    ex = DirectExecutor(hermes_bin=str(hermes), store_dir=store_dir, timeout_seconds=10)
    params = {"assignee": "slow"}
    first = ex.schedule(run_id="run-1", node_id="n", workflow_id="wf", params=params)
    again = ex.schedule(run_id="run-1", node_id="n", workflow_id="wf", params=params)
    assert first == again
    _wait_settled(ex, first)
    assert counter.read_text().count("x") == 1


def test_detached_runner_settles_failure_on_corrupt_spec(tmp_path) -> None:
    """A corrupt/unparseable spec file must not strand the handle: the runner
    recovers the completion path from the .req.json name and writes a settled
    failure (regression for the started-but-unsettled hang the detached worker
    exists to prevent)."""
    import json
    import subprocess
    import sys

    runner = Path(__file__).resolve().parents[2] / "hermes_workflows" / "executor" / "_detached_runner.py"
    completion = tmp_path / "run-1:n:0"
    req = tmp_path / "run-1:n:0.req.json"
    req.write_text("{ this is not valid json")

    subprocess.run([sys.executable, str(runner), str(req)], check=True, timeout=30)

    assert completion.exists(), "runner must settle a completion even for a bad spec"
    settled = json.loads(completion.read_text())
    assert settled["settled"] is True
    assert settled["outcome"] == "failure"
    assert not req.exists(), "the one-shot request file is cleaned up"

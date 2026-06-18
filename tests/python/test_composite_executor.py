"""S5 — CompositeExecutor routes scheduling by the compiled step's ``kind`` and
polling by the handle's shape, so script nodes run on the ScriptExecutor while
every other node keeps using the scope executor. No external deps.
"""

from __future__ import annotations

from hermes_workflows.executor import Completion
from hermes_workflows.executor.composite import CompositeExecutor


class _Recorder:
    def __init__(self, name: str, handle: str) -> None:
        self.name = name
        self.handle = handle
        self.scheduled: list[dict] = []
        self.polled: list[str] = []

    def schedule(self, *, run_id, node_id, workflow_id, params, iteration=0) -> str:
        self.scheduled.append({"node_id": node_id, "params": params})
        return self.handle

    def poll(self, handle: str) -> Completion:
        self.polled.append(handle)
        return Completion(settled=True, outcome="success", output=self.name)


def _composite():
    scope = _Recorder("scope", "t_abc123")
    script = _Recorder("script", "script:run-1:lint:0")
    return CompositeExecutor(scope=scope, script=script), scope, script


def _composite_with_direct():
    scope = _Recorder("scope", "t_abc123")
    script = _Recorder("script", "script:run-1:lint:0")
    direct = _Recorder("direct", "run-1:work:0")
    return CompositeExecutor(scope=scope, script=script, direct=direct), scope, script, direct


def test_schedule_routes_script_kind_to_the_script_executor() -> None:
    comp, scope, script = _composite()
    handle = comp.schedule(
        run_id="run-1", node_id="lint", workflow_id="wf",
        params={"kind": "script", "command": "make"},
    )
    assert handle == script.handle
    assert script.scheduled and not scope.scheduled


def test_schedule_routes_agent_kind_to_the_scope_executor() -> None:
    comp, scope, script = _composite()
    handle = comp.schedule(
        run_id="run-1", node_id="work", workflow_id="wf",
        params={"kind": "agent", "prompt": "do"},
    )
    assert handle == scope.handle
    assert scope.scheduled and not script.scheduled


def test_schedule_defaults_unmarked_params_to_the_scope_executor() -> None:
    comp, scope, script = _composite()
    comp.schedule(run_id="run-1", node_id="work", workflow_id="wf", params={"prompt": "do"})
    assert scope.scheduled and not script.scheduled


def test_poll_routes_script_prefixed_handles_to_the_script_executor() -> None:
    comp, scope, script = _composite()
    assert comp.poll("script:run-1:lint:0").output == "script"
    assert script.polled == ["script:run-1:lint:0"]
    assert not scope.polled


def test_poll_routes_other_handles_to_the_scope_executor() -> None:
    comp, scope, script = _composite()
    assert comp.poll("t_abc123").output == "scope"
    assert scope.polled == ["t_abc123"]
    assert not script.polled


def test_schedule_routes_off_board_nodes_to_the_direct_runner() -> None:
    comp, scope, script, direct = _composite_with_direct()
    handle = comp.schedule(
        run_id="run-1", node_id="work", workflow_id="wf",
        params={"kind": "agent", "prompt": "do", "off_board": True, "assignee": "p"},
    )
    assert handle == direct.handle
    assert direct.scheduled and not scope.scheduled and not script.scheduled


def test_schedule_keeps_on_board_nodes_on_the_scope_executor() -> None:
    comp, scope, _script, direct = _composite_with_direct()
    comp.schedule(
        run_id="run-1", node_id="work", workflow_id="wf",
        params={"kind": "agent", "prompt": "do"},
    )
    assert scope.scheduled and not direct.scheduled


def test_poll_routes_direct_shaped_handles_to_the_direct_runner() -> None:
    comp, scope, _script, direct = _composite_with_direct()
    assert comp.poll("run-1:work:0").output == "direct"
    assert direct.polled == ["run-1:work:0"]
    assert not scope.polled
    # A Kanban id still routes to the scope executor even with a direct backend.
    assert comp.poll("t_abc123").output == "scope"
    assert scope.polled == ["t_abc123"]


def test_off_board_without_a_direct_runner_fails_loud_in_project_scope() -> None:
    import pytest

    comp, scope, _script = _composite()  # no direct; scope is Kanban-like (has adopt)
    scope.adopt = lambda task_id, *, assignee: task_id  # mark scope as Kanban-backed
    with pytest.raises(ValueError, match="off-board"):
        comp.schedule(
            run_id="run-1", node_id="work", workflow_id="wf",
            params={"kind": "agent", "prompt": "do", "off_board": True},
        )

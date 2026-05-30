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

"""The engine resolves a node's input_mapping at the scheduling seam: the
downstream node's prompt receives the upstream node's captured output, for any
backend, and an unsatisfiable reference fails the node loudly instead of
scheduling it with an unresolved placeholder."""

from __future__ import annotations

from pathlib import Path

from hermes_workflows.engine import Engine
from hermes_workflows.executor import Completion


class FakeExec:
    """Records the params it was scheduled with; never settles on its own."""

    def __init__(self) -> None:
        self.captured: dict | None = None

    def schedule(self, *, run_id, node_id, workflow_id, params, iteration):
        self.captured = params
        return f"fake:{node_id}"

    def poll(self, handle):
        return Completion(settled=False, started=True)


def _engine(tmp_path: Path) -> Engine:
    return Engine(core_cli=["bun"], db_path=str(tmp_path / "runs.db"), direct=FakeExec())


def test_schedule_resolves_input_mapping_into_prompt(tmp_path: Path) -> None:
    eng = _engine(tmp_path)
    fake = FakeExec()
    run = {
        "workflow_id": "w",
        "origin": None,
        "nodes": {
            "a": {"status": "completed", "outcome": "success", "output": "INVENTORY", "seq": 1},
            "b": {"status": "pending"},
        },
    }
    params = {
        "node": "b",
        "kind": "agent",
        "prompt": "scope from {{data}}",
        "input_mapping": {"data": "{{nodes.a.output}}"},
    }
    eng._schedule_node(fake, run, "r1", "b", params)

    assert fake.captured is not None
    assert fake.captured["prompt"] == "scope from INVENTORY"
    assert run["nodes"]["b"]["status"] == "scheduled"
    assert run["nodes"]["b"]["hermes_task_id"] == "fake:b"


def test_schedule_without_mapping_passes_prompt_through(tmp_path: Path) -> None:
    eng = _engine(tmp_path)
    fake = FakeExec()
    run = {"workflow_id": "w", "origin": None, "nodes": {"b": {"status": "pending"}}}
    params = {"node": "b", "kind": "agent", "prompt": "plain prompt"}
    eng._schedule_node(fake, run, "r1", "b", params)

    assert fake.captured is not None
    assert fake.captured["prompt"] == "plain prompt"
    assert run["nodes"]["b"]["status"] == "scheduled"


def test_schedule_fails_loud_when_source_output_missing(tmp_path: Path) -> None:
    eng = _engine(tmp_path)
    fake = FakeExec()
    run = {
        "workflow_id": "w",
        "origin": None,
        "nodes": {
            "a": {"status": "completed", "outcome": "failure", "output": None},
            "b": {"status": "pending"},
        },
    }
    params = {
        "node": "b",
        "kind": "agent",
        "prompt": "use {{data}}",
        "input_mapping": {"data": "{{nodes.a.output}}"},
    }
    eng._schedule_node(fake, run, "r1", "b", params)

    # The node is settled failure, NOT scheduled with an unresolved placeholder.
    assert fake.captured is None
    node_b = run["nodes"]["b"]
    assert node_b["status"] == "completed"
    assert node_b["outcome"] == "failure"
    assert "input" in (node_b["output"] or "").lower()
    assert not node_b.get("hermes_task_id")

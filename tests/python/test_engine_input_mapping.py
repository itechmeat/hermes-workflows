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


def test_schedule_resolves_review_note_channel(tmp_path: Path) -> None:
    eng = _engine(tmp_path)
    fake = FakeExec()
    run = {
        "workflow_id": "w",
        "origin": None,
        "nodes": {
            "gate": {"status": "completed", "review_decision": "approved", "review_note": "use 1"},
            "b": {"status": "pending"},
        },
    }
    params = {
        "node": "b",
        "kind": "agent",
        "prompt": "operator said: {{note}}",
        "input_mapping": {"note": "{{nodes.gate.review_note}}"},
    }
    eng._schedule_node(fake, run, "r1", "b", params)
    assert fake.captured is not None
    assert fake.captured["prompt"] == "operator said: use 1"


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


def test_run_input_layers_above_an_agent_task_prompt(tmp_path: Path) -> None:
    """A run-level operator input is layered above the node prompt as the
    highest-priority block, before the original prompt (which is kept in full)."""
    eng = _engine(tmp_path)
    fake = FakeExec()
    run = {
        "workflow_id": "w",
        "origin": None,
        "input": "scope = only t_X and t_Y; keep it minimal",
        "nodes": {"b": {"status": "pending"}},
    }
    params = {"node": "b", "kind": "agent", "prompt": "propose three scopes"}
    eng._schedule_node(fake, run, "r1", "b", params)

    prompt = fake.captured["prompt"]
    assert "scope = only t_X and t_Y; keep it minimal" in prompt
    assert "propose three scopes" in prompt
    assert "highest priority" in prompt.lower()
    # Operator block precedes the node prompt (it has precedence).
    assert prompt.index("only t_X") < prompt.index("propose three scopes")


def test_run_input_layers_on_top_of_resolved_input_mapping(tmp_path: Path) -> None:
    """Operator input composes with input_mapping: the upstream output is
    substituted first, then the operator block is layered above the result."""
    eng = _engine(tmp_path)
    fake = FakeExec()
    run = {
        "workflow_id": "w",
        "origin": None,
        "input": "be terse",
        "nodes": {
            "a": {"status": "completed", "outcome": "success", "output": "INV", "seq": 1},
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

    prompt = fake.captured["prompt"]
    assert "scope from INV" in prompt  # input_mapping resolved
    assert "be terse" in prompt  # operator input layered
    assert prompt.index("be terse") < prompt.index("scope from INV")


def test_absent_run_input_leaves_the_prompt_byte_identical(tmp_path: Path) -> None:
    """No operator input and no mapping: the prompt is unchanged (no regression)."""
    eng = _engine(tmp_path)
    fake = FakeExec()
    run = {"workflow_id": "w", "origin": None, "nodes": {"b": {"status": "pending"}}}
    params = {"node": "b", "kind": "agent", "prompt": "base prompt"}
    eng._schedule_node(fake, run, "r1", "b", params)

    assert fake.captured["prompt"] == "base prompt"


def test_node_prompt_layers_above_the_node_prompt(tmp_path: Path) -> None:
    """A Prompt node's text (compiled onto the task as node_prompt) is layered
    above the node's own prompt as the primary instruction, before it."""
    eng = _engine(tmp_path)
    fake = FakeExec()
    run = {"workflow_id": "w", "origin": None, "nodes": {"b": {"status": "pending"}}}
    params = {
        "node": "b",
        "kind": "agent",
        "prompt": "do the work",
        "node_prompt": "ship the urgent fix first",
    }
    eng._schedule_node(fake, run, "r1", "b", params)

    prompt = fake.captured["prompt"]
    assert "ship the urgent fix first" in prompt
    assert "do the work" in prompt
    assert "operator directive" in prompt.lower()
    assert prompt.index("ship the urgent fix first") < prompt.index("do the work")


def test_node_prompt_becomes_the_whole_prompt_when_node_prompt_is_empty(tmp_path: Path) -> None:
    """An agent_task with an empty own prompt fed by a Prompt node runs on the
    Prompt node text alone - no wrapper noise around an empty instruction."""
    eng = _engine(tmp_path)
    fake = FakeExec()
    run = {"workflow_id": "w", "origin": None, "nodes": {"b": {"status": "pending"}}}
    params = {"node": "b", "kind": "agent", "prompt": "", "node_prompt": "investigate the outage"}
    eng._schedule_node(fake, run, "r1", "b", params)

    assert fake.captured["prompt"] == "investigate the outage"


def test_run_params_substituted_into_node_prompt(tmp_path: Path) -> None:
    """A run's resolved template params replace {{params.<name>}} placeholders in
    the node prompt at schedule time."""
    eng = _engine(tmp_path)
    fake = FakeExec()
    run = {
        "workflow_id": "w",
        "origin": None,
        "params": {"region": "eu", "tier": "gold"},
        "nodes": {"b": {"status": "pending"}},
    }
    params = {
        "node": "b",
        "kind": "agent",
        "prompt": "deploy to {{params.region}} as {{params.tier}}",
    }
    eng._schedule_node(fake, run, "r1", "b", params)

    assert fake.captured["prompt"] == "deploy to eu as gold"


def test_run_params_compose_with_input_mapping_and_operator_input(tmp_path: Path) -> None:
    """Params substitute alongside input_mapping and operator input: the upstream
    output and the param value both land, under the operator block."""
    eng = _engine(tmp_path)
    fake = FakeExec()
    run = {
        "workflow_id": "w",
        "origin": None,
        "input": "be terse",
        "params": {"region": "eu"},
        "nodes": {
            "a": {"status": "completed", "outcome": "success", "output": "INV", "seq": 1},
            "b": {"status": "pending"},
        },
    }
    params = {
        "node": "b",
        "kind": "agent",
        "prompt": "scope from {{data}} in {{params.region}}",
        "input_mapping": {"data": "{{nodes.a.output}}"},
    }
    eng._schedule_node(fake, run, "r1", "b", params)

    prompt = fake.captured["prompt"]
    assert "scope from INV in eu" in prompt
    assert "be terse" in prompt


def test_run_param_reference_without_value_fails_loud(tmp_path: Path) -> None:
    """A {{params.X}} placeholder with no run value settles the node failure
    loudly rather than scheduling it with an unresolved placeholder."""
    eng = _engine(tmp_path)
    fake = FakeExec()
    run = {"workflow_id": "w", "origin": None, "nodes": {"b": {"status": "pending"}}}
    params = {"node": "b", "kind": "agent", "prompt": "deploy to {{params.region}}"}
    eng._schedule_node(fake, run, "r1", "b", params)

    assert fake.captured is None
    node_b = run["nodes"]["b"]
    assert node_b["status"] == "completed"
    assert node_b["outcome"] == "failure"
    assert not node_b.get("hermes_task_id")


def test_operator_input_layers_above_a_node_prompt(tmp_path: Path) -> None:
    """Precedence: operator --input is highest, the Prompt node text is the
    node's primary instruction below it, then the node's own prompt."""
    eng = _engine(tmp_path)
    fake = FakeExec()
    run = {
        "workflow_id": "w",
        "origin": None,
        "input": "operator override",
        "nodes": {"b": {"status": "pending"}},
    }
    params = {
        "node": "b",
        "kind": "agent",
        "prompt": "own prompt",
        "node_prompt": "prompt node text",
    }
    eng._schedule_node(fake, run, "r1", "b", params)

    prompt = fake.captured["prompt"]
    assert prompt.index("operator override") < prompt.index("prompt node text")
    assert prompt.index("prompt node text") < prompt.index("own prompt")

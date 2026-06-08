"""Unit tests for the input_mapping resolver: it substitutes a node's declared
placeholders with the referenced upstream nodes' captured outputs, and fails
loudly when a reference cannot be satisfied."""

from __future__ import annotations

import pytest

from hermes_workflows.resolve import UnresolvedInput, resolve_input_mapping


def test_no_mapping_returns_prompt_unchanged() -> None:
    assert resolve_input_mapping("hello", None, {}) == "hello"
    assert resolve_input_mapping("hello", {}, {"a": "x"}) == "hello"


def test_substitutes_a_single_placeholder() -> None:
    out = resolve_input_mapping(
        "use {{data}} now", {"data": "{{nodes.a.output}}"}, {"a": "HELLO"}
    )
    assert out == "use HELLO now"


def test_substitutes_multiple_placeholders() -> None:
    out = resolve_input_mapping(
        "{{x}} and {{y}}",
        {"x": "{{nodes.a.output}}", "y": "{{nodes.b.output}}"},
        {"a": "A", "b": "B"},
    )
    assert out == "A and B"


def test_repeated_placeholder_is_replaced_everywhere() -> None:
    out = resolve_input_mapping(
        "{{d}}-{{d}}", {"d": "{{nodes.a.output}}"}, {"a": "Z"}
    )
    assert out == "Z-Z"


def test_substitution_is_not_recursive() -> None:
    # An injected output that itself contains a placeholder token is left as-is.
    out = resolve_input_mapping(
        "{{d}}", {"d": "{{nodes.a.output}}"}, {"a": "{{d}} literal"}
    )
    assert out == "{{d}} literal"


def test_missing_source_output_raises() -> None:
    with pytest.raises(UnresolvedInput):
        resolve_input_mapping("{{d}}", {"d": "{{nodes.a.output}}"}, {"a": None})


def test_source_absent_from_outputs_raises() -> None:
    with pytest.raises(UnresolvedInput):
        resolve_input_mapping("{{d}}", {"d": "{{nodes.a.output}}"}, {})


def test_malformed_reference_raises() -> None:
    with pytest.raises(UnresolvedInput):
        resolve_input_mapping("{{d}}", {"d": "nodes.a.output"}, {"a": "x"})

"""Unit tests for the input_mapping resolver: it substitutes a node's declared
placeholders with the referenced upstream node channels (a work node's
``output`` or a human_review gate's ``review_note``), and fails loudly when a
reference cannot be satisfied."""

from __future__ import annotations

import pytest

from hermes_workflows.resolve import UnresolvedInput, resolve_input_mapping, resolve_params


def outputs(**nodes: str | None) -> dict[str, dict[str, str | None]]:
    """Build a node-channel map where each node exposes only an ``output``."""
    return {nid: {"output": value} for nid, value in nodes.items()}


def test_no_mapping_returns_prompt_unchanged() -> None:
    assert resolve_input_mapping("hello", None, {}) == "hello"
    assert resolve_input_mapping("hello", {}, outputs(a="x")) == "hello"


def test_substitutes_a_single_placeholder() -> None:
    out = resolve_input_mapping(
        "use {{data}} now", {"data": "{{nodes.a.output}}"}, outputs(a="HELLO")
    )
    assert out == "use HELLO now"


def test_substitutes_multiple_placeholders() -> None:
    out = resolve_input_mapping(
        "{{x}} and {{y}}",
        {"x": "{{nodes.a.output}}", "y": "{{nodes.b.output}}"},
        outputs(a="A", b="B"),
    )
    assert out == "A and B"


def test_substitutes_a_review_note_channel() -> None:
    out = resolve_input_mapping(
        "operator: {{n}}",
        {"n": "{{nodes.gate.review_note}}"},
        {"gate": {"output": None, "review_note": "use option 1"}},
    )
    assert out == "operator: use option 1"


def test_repeated_placeholder_is_replaced_everywhere() -> None:
    out = resolve_input_mapping("{{d}}-{{d}}", {"d": "{{nodes.a.output}}"}, outputs(a="Z"))
    assert out == "Z-Z"


def test_substitution_is_not_recursive() -> None:
    # An injected output that itself contains a placeholder token is left as-is.
    out = resolve_input_mapping(
        "{{d}}", {"d": "{{nodes.a.output}}"}, outputs(a="{{d}} literal")
    )
    assert out == "{{d}} literal"


def test_cross_placeholder_token_in_output_is_not_resubstituted() -> None:
    # node a's output literally contains '{{y}}'; resolving y must NOT reach into
    # a's already-injected text. Single-pass substitution over the prompt.
    out = resolve_input_mapping(
        "{{x}} {{y}}",
        {"x": "{{nodes.a.output}}", "y": "{{nodes.b.output}}"},
        outputs(a="INJECT {{y}}", b="B"),
    )
    assert out == "INJECT {{y}} B"


def test_output_with_regex_replacement_chars_is_literal() -> None:
    # A backreference-like token in the output must be inserted verbatim.
    out = resolve_input_mapping("{{d}}", {"d": "{{nodes.a.output}}"}, outputs(a=r"\1 \g<0>"))
    assert out == r"\1 \g<0>"


def test_missing_source_output_raises() -> None:
    with pytest.raises(UnresolvedInput):
        resolve_input_mapping("{{d}}", {"d": "{{nodes.a.output}}"}, outputs(a=None))


def test_source_absent_from_outputs_raises() -> None:
    with pytest.raises(UnresolvedInput):
        resolve_input_mapping("{{d}}", {"d": "{{nodes.a.output}}"}, {})


def test_malformed_reference_raises() -> None:
    with pytest.raises(UnresolvedInput):
        resolve_input_mapping("{{d}}", {"d": "nodes.a.output"}, outputs(a="x"))


# --- resolve_params: substitute run template params ({{params.<name>}}) -------


def test_params_no_placeholder_returns_prompt_unchanged() -> None:
    assert resolve_params("plain prompt", {"region": "eu"}) == "plain prompt"
    assert resolve_params("plain prompt", None) == "plain prompt"


def test_params_substitutes_a_single_placeholder() -> None:
    assert resolve_params("deploy to {{params.region}}", {"region": "eu"}) == "deploy to eu"


def test_params_substitutes_multiple_and_repeated_placeholders() -> None:
    out = resolve_params(
        "{{params.a}} then {{params.b}} then {{params.a}}",
        {"a": "X", "b": "Y"},
    )
    assert out == "X then Y then X"


def test_params_coerces_non_string_values_to_text() -> None:
    assert resolve_params("n={{params.count}} on={{params.flag}}", {"count": 3, "flag": True}) == (
        "n=3 on=True"
    )


def test_params_missing_value_fails_loud() -> None:
    with pytest.raises(UnresolvedInput):
        resolve_params("use {{params.region}}", {})
    with pytest.raises(UnresolvedInput):
        resolve_params("use {{params.region}}", None)


def test_params_injected_value_is_not_re_scanned() -> None:
    # A value that itself contains a param-token literal is inserted verbatim,
    # never re-substituted (single pass over the original prompt).
    out = resolve_params("{{params.a}}", {"a": "{{params.b}}", "b": "SHOULD_NOT_APPEAR"})
    assert out == "{{params.b}}"

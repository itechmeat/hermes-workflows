"""Resolve a node's ``input_mapping`` against upstream node outputs.

A node declares the outputs it consumes as
``input_mapping: {placeholder: "{{nodes.<id>.output}}"}`` and references each
placeholder in its prompt as ``{{placeholder}}``. At schedule time the engine
substitutes every placeholder with the referenced node's settled output, so a
workflow passes data between nodes through the run state instead of a host file.

Fail loud, never silent: a reference whose source produced no output raises
rather than substituting an empty string. The core's ``validateWorkflow``
already guarantees the reference is well-formed and points at an ancestor, so the
only runtime gap this guards is a source that did not settle on this particular
run (e.g. an unexecuted conditional branch). Substitution is single-pass and
non-recursive: an injected output is never re-scanned for placeholders.

A placeholder that is declared but never referenced in the prompt is resolved
(and so still fails loud if unsatisfiable) but simply never substituted; the
core's ``validateWorkflow`` rejects that case statically (``unused_input_mapping``).
"""

from __future__ import annotations

import re
from typing import Mapping, Optional

# A reference reads one channel of one prior node: a work node's free-text
# ``output``, or a human_review gate's operator ``review_note``. The channel set
# mirrors the core ``validateWorkflow`` INPUT_REF_PATTERN.
_REF = re.compile(r"^\{\{nodes\.([A-Za-z0-9_-]+)\.(output|review_note)\}\}$")


class UnresolvedInput(ValueError):
    """A node's ``input_mapping`` references a value that is not available."""


def resolve_input_mapping(
    prompt: str,
    input_mapping: Optional[Mapping[str, str]],
    node_channels: Mapping[str, Mapping[str, Optional[str]]],
) -> str:
    """Return ``prompt`` with every declared placeholder replaced by the value of
    its referenced node channel. ``node_channels`` maps each node id to its
    available channels (``output``, ``review_note``). ``prompt`` is returned
    unchanged when there is no mapping."""
    if not input_mapping:
        return prompt
    # Resolve every placeholder's value first (failing loud on any unsatisfiable
    # reference), then substitute them all in a SINGLE pass over the prompt. A
    # per-entry sequential replace would let an output that contains another
    # placeholder's literal token be re-substituted by a later entry; one pass
    # over the original prompt guarantees injected text is never re-scanned.
    values: dict[str, str] = {}
    for placeholder, ref in input_mapping.items():
        match = _REF.match(str(ref).strip())
        if not match:
            raise UnresolvedInput(
                f"input_mapping[{placeholder!r}] is not of the form "
                f"'{{{{nodes.<id>.output}}}}' or '{{{{nodes.<id>.review_note}}}}': {ref!r}"
            )
        source, channel = match.group(1), match.group(2)
        value = node_channels.get(source, {}).get(channel)
        if value is None:
            raise UnresolvedInput(
                f"input_mapping[{placeholder!r}] references {channel!r} of node "
                f"{source!r}, which has no such value"
            )
        values[placeholder] = value
    return _substitute(prompt, values)


_PARAM_REF = re.compile(r"\{\{params\.([A-Za-z0-9_-]+)\}\}")


def resolve_params(prompt: str, params: Optional[Mapping[str, object]]) -> str:
    """Return ``prompt`` with every ``{{params.<name>}}`` placeholder replaced by
    its run value. ``params`` is the run's resolved template parameters (validated
    at run-create). Fail loud, never silent: a placeholder that references a param
    not present in ``params`` raises rather than leaving a literal token in the
    prompt - the same contract as ``input_mapping`` resolution. A prompt with no
    param placeholder is returned unchanged (so a non-template run is untouched)."""
    names = _PARAM_REF.findall(prompt)
    if not names:
        return prompt
    values = params or {}
    missing = [name for name in dict.fromkeys(names) if name not in values]
    if missing:
        raise UnresolvedInput(
            "prompt references "
            + ", ".join(f"{{{{params.{name}}}}}" for name in missing)
            + " but the run has no such param value"
        )
    # Single pass over the original prompt: an injected value is never re-scanned
    # for another placeholder's token.
    return _PARAM_REF.sub(lambda m: str(values[m.group(1)]), prompt)


def resolve_ref(ref: str, node_channels: Mapping[str, Mapping[str, Optional[str]]]) -> str:
    """Resolve a single value that is either a literal or one
    ``{{nodes.<id>.<channel>}}`` reference (output / review_note). A literal is
    returned unchanged; an unsatisfiable reference fails loud."""
    match = _REF.match((ref or "").strip())
    if not match:
        return ref
    source, channel = match.group(1), match.group(2)
    value = node_channels.get(source, {}).get(channel)
    if value is None:
        raise UnresolvedInput(
            f"reference {ref!r} points at {channel!r} of node {source!r}, which has no value"
        )
    return value


def _substitute(prompt: str, values: dict) -> str:
    # `values` is non-empty here: input_mapping was truthy and every entry above
    # either populated it or raised, so the alternation is never an empty regex.
    token = re.compile("|".join(re.escape("{{" + key + "}}") for key in values))
    # A callable replacement is used verbatim — re.sub does not interpret
    # backreferences or escapes in an output that happens to contain them.
    return token.sub(lambda m: values[m.group(0)[2:-2]], prompt)

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

_REF = re.compile(r"^\{\{nodes\.([A-Za-z0-9_-]+)\.output\}\}$")


class UnresolvedInput(ValueError):
    """A node's ``input_mapping`` references an output that is not available."""


def resolve_input_mapping(
    prompt: str,
    input_mapping: Optional[Mapping[str, str]],
    node_outputs: Mapping[str, Optional[str]],
) -> str:
    """Return ``prompt`` with every declared placeholder replaced by its source
    node's output. ``prompt`` is returned unchanged when there is no mapping."""
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
                f"'{{{{nodes.<id>.output}}}}': {ref!r}"
            )
        source = match.group(1)
        output = node_outputs.get(source)
        if output is None:
            raise UnresolvedInput(
                f"input_mapping[{placeholder!r}] references node {source!r}, "
                "which has produced no output"
            )
        values[placeholder] = output
    # `values` is non-empty here: input_mapping was truthy and every entry above
    # either populated it or raised, so the alternation is never an empty regex.
    token = re.compile("|".join(re.escape("{{" + key + "}}") for key in values))
    # A callable replacement is used verbatim — re.sub does not interpret
    # backreferences or escapes in an output that happens to contain them.
    return token.sub(lambda m: values[m.group(0)[2:-2]], prompt)

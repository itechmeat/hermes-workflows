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
    resolved = prompt
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
        resolved = resolved.replace("{{" + placeholder + "}}", output)
    return resolved

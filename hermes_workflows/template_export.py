"""Orchestrate `export --as-template`: the AI half that the pure-TS core cannot
do (it has no model access), wrapped around the deterministic core de-binding.

Flow (one default-model call, cached):
  1. PROBE the core (`export-template --probe`): compute the spec hash + the
     composite cache key and report whether an unchanged bundle is already on
     disk. A cache hit returns the persisted files verbatim — no model call.
  2. On a miss, the probe returns a `generation_request` (each node's purpose).
     We ask the DEFAULT Hermes model (`model.default`) for free-form role/model
     hints + a short overview, fail-open: any error → no hints (the core then
     falls back to deterministic hints).
  3. WRITE via the core (`export-template --hints-file …`), which persists the
     two artifacts plus the cache sidecar keyed on the composite.

The bundle is keyed on `(workflow_id, spec_sha, template_format,
generator_version)`, so a version bump OR any spec edit regenerates while a
repeat export of the unchanged version is served from cache.
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from . import cli_bridge, config

# A bounded budget for the single hint-generation call; on timeout we fall back
# to deterministic hints rather than wedging the export.
_HINT_TIMEOUT_SECONDS = 120.0


def default_model() -> Optional[str]:
    """The gateway's `model.default` from `~/.hermes/config.yaml`, or None."""
    try:
        import yaml

        with (config.hermes_home() / "config.yaml").open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
        model = data.get("model") if isinstance(data, dict) else None
        value = model.get("default") if isinstance(model, dict) else None
        return value if isinstance(value, str) and value else None
    except Exception:
        return None


def _generation_prompt(generation_request: dict) -> str:
    """Build the default-model instruction that turns each node's purpose into
    free-form role/capability hints. The vocabulary is intentionally OPEN — a
    workflow can be about anything ("make compote", "find a purchase"), so the
    model invents the hint from the node, never picks from a fixed list."""
    nodes = generation_request.get("nodes", [])
    lines = [
        "You are preparing an adaptation guide for a shareable workflow template.",
        "For EACH node below, in your own words derived from that node's purpose,",
        "recommend:",
        "  - role: the TYPE of agent/profile suited to it (free-form, e.g.",
        '    "experienced backend engineer", "careful copy editor" — NOT a fixed list);',
        "  - capability: the model CAPABILITY class it needs (free-form, e.g.",
        '    "strong reasoning", "long context", "fast and cheap").',
        "Also write a one-sentence overview of what the whole workflow does.",
        "",
        "Return ONLY a JSON object, no prose around it, of the shape:",
        '{"overview": "...", "nodes": [{"nodeId": "...", "role": "...", "capability": "..."}]}',
        "",
        "Nodes:",
        json.dumps(nodes, ensure_ascii=False, indent=2),
    ]
    return "\n".join(lines)


def _extract_json(text: str) -> Optional[dict]:
    """Pull the first JSON object out of a model reply (it may wrap the JSON in
    prose or a code fence). None when nothing parses."""
    text = text.strip()
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except ValueError:
        pass
    # Strip a ```json fence if present, else grab the outermost {...}.
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidate = fenced.group(1) if fenced else None
    if candidate is None:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            candidate = text[start : end + 1]
    if candidate is None:
        return None
    try:
        parsed = json.loads(candidate)
        return parsed if isinstance(parsed, dict) else None
    except ValueError:
        return None


def generate_hints(
    model: str,
    generation_request: dict,
    *,
    hermes_bin: str = "hermes",
    timeout: float = _HINT_TIMEOUT_SECONDS,
) -> Optional[dict]:
    """Ask the default model for free-form hints. Fail-open: any failure (no
    model, non-zero exit, timeout, unparseable reply) returns None so the export
    degrades to deterministic de-binding."""
    model_name, _, provider = model.partition("@")
    argv = [hermes_bin, "-m", model_name]
    if provider:
        argv += ["--provider", provider]
    argv += ["-z", _generation_prompt(generation_request)]
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
    if proc.returncode != 0:
        return None
    return _extract_json(proc.stdout)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def export(
    workflow_id: str,
    *,
    out_dir: Optional[Path] = None,
    model: Optional[str] = None,
    generated_at: Optional[str] = None,
    generator_version: Optional[int] = None,
    hermes_bin: str = "hermes",
) -> dict[str, Any]:
    """Produce (or serve from cache) the template bundle for `workflow_id`.

    Returns an envelope with both file contents so the dashboard can stream them
    over the JSON-only channel. Raises ``cli_bridge.CoreBridgeError`` (kind
    ``NotFoundError``) for an unknown workflow."""
    out = out_dir or config.template_export_dir()
    out.mkdir(parents=True, exist_ok=True)
    roots = ",".join(config.spec_roots())
    when = generated_at or datetime.now(timezone.utc).isoformat()

    chosen_model = model or default_model()
    base_argv = [
        *config.core_cli(),
        "export-template",
        "--id",
        workflow_id,
        "--roots",
        roots,
        "--out-dir",
        str(out),
        "--generated-at",
        when,
    ]
    if generator_version is not None:
        base_argv += ["--generator-version", str(generator_version)]
    if chosen_model:
        base_argv += ["--model", chosen_model]

    probe = cli_bridge.invoke([*base_argv, "--probe"])
    if not probe.get("cached"):
        hints = (
            generate_hints(chosen_model, probe["generation_request"], hermes_bin=hermes_bin)
            if (chosen_model and probe.get("generation_request"))
            else None
        )
        write_argv = list(base_argv)
        hints_path: str | None = None
        if hints is not None:
            with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False, encoding="utf-8"
            ) as fh:
                json.dump(hints, fh)
                hints_path = fh.name
            write_argv += ["--hints-file", hints_path]
        try:
            result = cli_bridge.invoke(write_argv)
        finally:
            if hints_path is not None:
                Path(hints_path).unlink(missing_ok=True)
    else:
        result = probe

    yaml_path = Path(result["files"]["yaml"])
    md_path = Path(result["files"]["md"])
    return {
        "id": workflow_id,
        "cached": bool(result.get("cached")),
        "revision": result["revision"],
        "human_version": result["human_version"],
        "spec_sha": result["spec_sha"],
        "yaml_filename": yaml_path.name,
        "yaml": _read(yaml_path),
        "md_filename": md_path.name,
        "md": _read(md_path),
    }

"""Redact secret-shaped tokens before captured output is persisted to the run
store (TZ §25.1). Conservative: masks well-known credential shapes and
``key: value`` secrets, leaving ordinary prose untouched.

This is the plugin's own Python redaction surface, intentionally self-contained
so it imports without ``hermes_cli``. It mirrors the core TypeScript redactor
(``packages/core/src/memory/redact.ts``); keep the two rule sets in step.
"""

from __future__ import annotations

import re

_VALUE_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9]{16,}\b"),  # OpenAI-style keys
    re.compile(r"\bghp_[A-Za-z0-9]{20,}\b"),  # GitHub tokens
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),  # AWS access key ids
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),  # Slack tokens
    re.compile(
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"
    ),
]

# `password = ...`, `api_key: ...`, etc. — mask the value, keep the key.
_KEYED_SECRET = re.compile(
    r"\b(password|passwd|secret|token|api[_-]?key)\b(\s*[:=]\s*)(\S+)",
    re.IGNORECASE,
)


def redact_secrets(text: str) -> str:
    out = text
    for pattern in _VALUE_PATTERNS:
        out = pattern.sub("[REDACTED]", out)
    out = _KEYED_SECRET.sub(lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]", out)
    return out

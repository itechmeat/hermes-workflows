"""Per-task telemetry sidecars — the cross-process channel between kanban
worker observers and the orchestrator/dashboard.

A worker process (gated on ``HERMES_KANBAN_TASK``, see ``observer.py``) holds a
``NodeTelemetryRecorder`` that accumulates observer events in memory and
atomically rewrites one small JSON aggregate per card (tmp + ``os.replace``,
the ``executor/store.py`` idiom). The aggregate IS the final ``NodeTelemetry``
shape — there is no second aggregation pass: the engine folds the file into
``NodeRunState.telemetry`` when the node settles, and the dashboard overlays it
live until then.

Everything here is fail-open: a write failure suppresses telemetry (one stderr
note), a missing or corrupt sidecar reads as ``None``. A telemetry bug must
never break a worker, a run, or a request handler.

A retried card spawns a fresh worker and therefore a fresh recorder, so the
sidecar reflects the most recent attempt — deliberate (KISS), matching how
``output`` already reflects the latest ``task_runs`` row.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional


def _safe(task_id: str) -> str:
    """Filesystem-safe sidecar name, same sanitization as CompletionStore plus
    backslashes (harmless on this Linux-only deployment, cheap insurance)."""
    return task_id.replace("/", "_").replace("\\", "_").replace(":", "_")


def sidecar_path(root: Path, task_id: str) -> Path:
    return Path(root) / f"{_safe(task_id)}.json"


def load_node_telemetry(root: Path, task_id: str) -> Optional[dict]:
    """The persisted aggregate for a card, or ``None`` for missing/corrupt
    sidecars (fail-open: absent telemetry is the designed degradation)."""
    try:
        raw = sidecar_path(root, task_id).read_text()
        data = json.loads(raw)
    except Exception:
        return None
    return data if isinstance(data, dict) and data else None


def clear_node_telemetry(root: Path, task_id: str) -> None:
    """Remove a card's sidecar; idempotent and fail-open."""
    try:
        sidecar_path(root, task_id).unlink(missing_ok=True)
    except Exception:
        pass


class NodeTelemetryRecorder:
    """Aggregate observer events for one card and write through atomically.

    Every ``record_*`` method swallows its own failures — the host's
    ``invoke_hook`` is already fail-open, but a recorder bug must not even
    reach it. ``now`` is injectable for deterministic tests.
    """

    def __init__(self, root: Path, task_id: str, *, now: Callable[[], float] = time.time) -> None:
        self.root = Path(root)
        self.task_id = task_id
        self._now = now
        self._data: dict = {}
        self._first_ts: Optional[float] = None

    # -- event recorders (one per consumed hook family) ---------------------

    def record_api_request(
        self, *, usage: Any = None, api_duration: Any = None, **_kwargs: Any
    ) -> None:
        """One successful provider attempt (``post_api_request``)."""
        try:
            self._bump("api_calls")
            self._add_usage(usage)
            self._touch_and_flush()
        except Exception:
            self._swallow()

    def record_api_error(self, *, error: Any = None, **_kwargs: Any) -> None:
        """One failed provider attempt (``api_request_error``, v1 hosts)."""
        try:
            self._bump("api_calls")
            if isinstance(error, dict):
                self._set_error(error.get("type"), error.get("message"))
            self._touch_and_flush()
        except Exception:
            self._swallow()

    def record_tool_call(
        self,
        *,
        status: Any = None,
        error_type: Any = None,
        error_message: Any = None,
        **_kwargs: Any,
    ) -> None:
        """One tool call (``post_tool_call``). ``status``/``error_*`` exist on
        v1 hosts only; their absence (v0.15.x) just means no error breakdown."""
        try:
            self._bump("tool_calls")
            if status == "error" or error_type:
                self._bump("tool_errors")
                self._set_error(error_type, error_message)
            self._touch_and_flush()
        except Exception:
            self._swallow()

    def record_subagent(self, **_kwargs: Any) -> None:
        """One delegated child agent finished (``subagent_stop``)."""
        try:
            self._bump("subagents")
            self._touch_and_flush()
        except Exception:
            self._swallow()

    def record_approval_request(
        self,
        *,
        command: Any = None,
        description: Any = None,
        surface: Any = None,
        session_key: Any = None,
        **_kwargs: Any,
    ) -> None:
        """A dangerous-command approval prompt opened (``pre_approval_request``).
        The worker is now blocked on a human answer; surface that as pending
        state. Approval events skip the duration stamp — waiting on a human is
        not agent activity."""
        try:
            approval: dict = {"state": "pending", "requested_at": self._now()}
            for key, value in (
                ("command", command),
                ("description", description),
                ("surface", surface),
                # Opaque host context only — verified to not embed the card id.
                ("session_key", session_key),
            ):
                if value:
                    approval[key] = str(value)
            self._data["approval"] = approval
            self._flush()
        except Exception:
            self._swallow()

    def record_approval_response(self, *, choice: Any = None, **_kwargs: Any) -> None:
        """The approval was answered or timed out (``post_approval_response``).
        Keeps command/description so a deny or timeout stays explainable after
        the node settles. A response with no recorded request (worker restart
        between the two hooks) still lands as a bare resolved record — the UI
        degrades gracefully when command/description are absent."""
        try:
            approval = dict(self._data.get("approval") or {})
            approval["state"] = "resolved"
            approval["resolved_at"] = self._now()
            if choice:
                approval["choice"] = str(choice)
            self._data["approval"] = approval
            self._flush()
        except Exception:
            self._swallow()

    # -- internals -----------------------------------------------------------

    def _bump(self, key: str) -> None:
        self._data[key] = int(self._data.get(key, 0)) + 1

    def _add_usage(self, usage: Any) -> None:
        if not isinstance(usage, dict):
            return
        input_tokens = usage.get("input_tokens", usage.get("prompt_tokens"))
        output_tokens = usage.get("output_tokens", usage.get("completion_tokens"))
        for key, value in (("input_tokens", input_tokens), ("output_tokens", output_tokens)):
            if isinstance(value, (int, float)):
                self._data[key] = int(self._data.get(key, 0)) + int(value)
        if "input_tokens" in self._data or "output_tokens" in self._data:
            self._data["total_tokens"] = int(self._data.get("input_tokens", 0)) + int(
                self._data.get("output_tokens", 0)
            )

    def _set_error(self, error_type: Any, error_message: Any) -> None:
        """Last error wins — the aggregate explains the most recent failure."""
        if error_type:
            self._data["error_type"] = str(error_type)
        if error_message:
            self._data["error_message"] = str(error_message)

    def _touch_and_flush(self) -> None:
        """Advance the observed-activity window and persist the aggregate."""
        ts = self._now()
        if self._first_ts is None:
            self._first_ts = ts
        self._data["duration_ms"] = int(round((ts - self._first_ts) * 1000))
        self._flush()

    def _flush(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        path = sidecar_path(self.root, self.task_id)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(self._data))
        os.replace(tmp, path)

    def _swallow(self) -> None:
        print(
            f"hermes-workflows: telemetry write failed for {self.task_id}",
            file=sys.stderr,
        )

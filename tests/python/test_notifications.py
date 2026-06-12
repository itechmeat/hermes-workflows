"""P6.1 — channel-agnostic notifications: deliver to the run's origin, else a
configured default; subscribe Kanban-backed nodes to their card events; never
hardcode a platform.
"""

from __future__ import annotations

from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")

from hermes_workflows import notifications


def test_origin_present_delivers_to_origin() -> None:
    sent: list[tuple[str, str]] = []
    note = notifications.notify_run(
        run_id="r1",
        event="completed",
        origin="alpha:99:7",
        default="fallback:1",
        send=lambda target, msg: sent.append((target, msg)),
    )
    assert note is not None
    assert note.target == "alpha:99:7"
    assert sent == [("alpha:99:7", note.text)]


def test_origin_absent_uses_default_deliver() -> None:
    note = notifications.notify_run(
        run_id="r1",
        event="failed",
        origin=None,
        default="fallback:1",
        send=lambda *_: None,
    )
    assert note is not None
    assert note.target == "fallback:1"


def test_no_target_is_silent() -> None:
    calls: list[object] = []
    note = notifications.notify_run(
        run_id="r1",
        event="completed",
        origin=None,
        default=None,
        send=lambda *a: calls.append(a),
    )
    assert note is None
    assert calls == []  # nothing delivered


@pytest.mark.parametrize(
    "origin,expected",
    [
        ("alpha:42:3", ("alpha", "42", "3")),
        ("beta:7", ("beta", "7", None)),
        ("beta:7:", ("beta", "7", None)),
        ("garbage", None),
        (":nochat", None),
    ],
)
def test_parse_origin(origin, expected) -> None:
    assert notifications.parse_origin(origin) == expected


def test_subscribe_task_registers_native_sub(tmp_path: Path) -> None:
    conn = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        task_id = kb.create_task(conn, title="review", assignee="qa")
        assert notifications.subscribe_task(conn, task_id=task_id, origin="alpha:55:2")
        subs = kb.list_notify_subs(conn, task_id)
        assert len(subs) == 1
        assert subs[0]["platform"] == "alpha"
        assert subs[0]["chat_id"] == "55"
    finally:
        conn.close()


def test_subscribe_task_without_origin_is_noop(tmp_path: Path) -> None:
    conn = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        task_id = kb.create_task(conn, title="x", assignee="qa")
        assert notifications.subscribe_task(conn, task_id=task_id, origin=None) is False
        assert notifications.subscribe_task(conn, task_id=task_id, origin="bad") is False
        assert kb.list_notify_subs(conn, task_id) == []
    finally:
        conn.close()


def test_source_has_no_platform_literals() -> None:
    src = Path(notifications.__file__).read_text().lower()
    for literal in ("telegram", "discord", "slack", "whatsapp", "ntfy"):
        assert literal not in src


# --- first-class delivery target + [SILENT] (t_13d09914) --------------------


def test_resolve_target_explicit_deliver_overrides_origin() -> None:
    # A workflow's declared deliver (a concrete platform target) wins over the
    # captured chat origin.
    assert notifications.resolve_target("alpha:1", "fallback:1", "team:chan") == "team:chan"


def test_resolve_target_origin_keyword_keeps_origin() -> None:
    # The literal "origin" means "the chat it came from" — same as today.
    assert notifications.resolve_target("alpha:1", "fallback:1", "origin") == "alpha:1"
    assert notifications.resolve_target(None, "fallback:1", "origin") == "fallback:1"


def test_resolve_target_no_deliver_is_origin_then_default() -> None:
    # Unchanged when unset: origin, else default, else nowhere.
    assert notifications.resolve_target("alpha:1", "fallback:1", None) == "alpha:1"
    assert notifications.resolve_target(None, "fallback:1", None) == "fallback:1"
    assert notifications.resolve_target(None, None, None) is None


def test_is_silenced() -> None:
    assert notifications.is_silenced("nothing new today [SILENT]") is True
    assert notifications.is_silenced("a normal result") is False
    assert notifications.is_silenced(None) is False


def test_notify_run_deliver_overrides_target() -> None:
    sent: list[tuple[str, str]] = []
    note = notifications.notify_run(
        run_id="r1",
        event="completed",
        origin="alpha:1",
        default="fallback:1",
        deliver="team:chan",
        text="the result",
        send=lambda target, msg: sent.append((target, msg)),
    )
    assert note is not None
    assert note.target == "team:chan"
    assert sent == [("team:chan", "the result")]

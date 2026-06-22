"""Release-branch stacking for an adopt node (Task t_f5badd0e).

A multi-card scope driven by an adopt node with ``stack: true`` must run each
card in a linked worktree based on the SHARED feature branch at its current tip,
and the engine must advance that branch to include each card's commits before
the next card starts. This makes "card N builds on cards 1..N-1" physically
true (the previous behavior branched every card off ``main`` in isolation, so
card N never saw cards 1..N-1). Per-card self-bump of version/CHANGELOG is also
suppressed at the instruction layer (the dedicated docs-version node owns that
once for the whole scope).
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")

from hermes_workflows.engine import Engine
from hermes_workflows.executor import KanbanExecutor

ROOT = Path(__file__).resolve().parents[2]
CLI = ["bun", "run", str(ROOT / "packages" / "core" / "src" / "cli.ts")]

BRANCH = "feat/test-release"


def _git(repo: Path, *args: str) -> str:
    out = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout.strip()


def _init_release_repo(tmp_path: Path) -> Path:
    """A project repo checked out on the shared release branch (as the lock-scope
    node leaves it)."""
    repo = tmp_path / "project"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    _git(repo, "config", "commit.gpgsign", "false")
    (repo / "README.md").write_text("base\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-q", "-b", BRANCH)
    return repo


def _engine(tmp_path: Path, board) -> Engine:
    return Engine(core_cli=CLI, db_path=str(tmp_path / "runs.db"), kanban=KanbanExecutor(board))


def _spec(tmp_path: Path, obj: dict) -> str:
    path = tmp_path / f"{obj['id']}.workflow.json"
    path.write_text(json.dumps(obj))
    return str(path)


def _stack_spec(repo: Path) -> dict:
    """collect -> drive(adopt, stack) -> done."""
    return {
        "id": "stack-adopt",
        "name": "Stack adopt",
        "version": 1,
        "scope": {"type": "project"},
        "trigger": {"type": "manual"},
        "defaults": {"profile": "worker"},
        "nodes": [
            {"id": "collect", "type": "agent_task", "prompt": "find", "profile": "scout"},
            {
                "id": "drive",
                "type": "agent_task",
                "prompt": "drive",
                "profile": "worker",
                "adopt": True,
                "task_ref": "{{nodes.collect.output.task_ids}}",
                "stack": True,
                "workdir": str(repo),
            },
            {"id": "done", "type": "finish", "outcome": "success"},
        ],
        "edges": [
            {"from": "collect", "to": "drive"},
            {"from": "drive", "to": "done"},
        ],
    }


def _surface_ids(board, collect_card: str, ids: list[str]) -> None:
    board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (collect_card,))
    board.execute(
        "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
        "VALUES (?, 'done', 'completed', ?, 1, 2)",
        (collect_card, "scope: drive " + " and ".join(ids) + " please"),
    )
    board.commit()


def _work_on_card(board, repo: Path, card: str, filename: str) -> str:
    """Simulate the native dispatcher + worker for a driven card: materialize the
    card's linked worktree exactly as Hermes would (honoring the workspace
    columns the engine stamped), commit one impl file onto it, mark it done.
    Returns the impl commit sha."""
    task = kb.get_task(board, card)
    assert task.workspace_kind == "worktree", task.workspace_kind
    assert task.workspace_path == str(repo), task.workspace_path
    ws = kb.resolve_workspace(task, board=None)
    (ws / filename).write_text(f"impl for {card}\n")
    _git(ws, "config", "user.email", "w@w")
    _git(ws, "config", "user.name", "w")
    _git(ws, "config", "commit.gpgsign", "false")
    _git(ws, "add", ".")
    _git(ws, "commit", "-qm", f"feat: {card}")
    sha = _git(ws, "rev-parse", "HEAD")
    board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (card,))
    board.execute(
        "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
        "VALUES (?, 'done', 'completed', 'ok', 1, 2)",
        (card,),
    )
    board.commit()
    return sha


def test_adopt_stacks_scope_cards_on_the_shared_branch(tmp_path: Path) -> None:
    repo = _init_release_repo(tmp_path)
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        a = kb.create_task(board, title="card A", created_by="op", triage=True)
        b = kb.create_task(board, title="card B", created_by="op", triage=True)
        c = kb.create_task(board, title="card C", created_by="op", triage=True)
        # Dependency order a -> b -> c so the scope is driven deterministically.
        kb.link_tasks(board, a, b)
        kb.link_tasks(board, b, c)
        eng = _engine(tmp_path, board)
        spec = _spec(tmp_path, _stack_spec(repo))

        run = eng.run(spec, "r")
        _surface_ids(board, run["nodes"]["collect"]["hermes_task_id"], [a, b, c])

        # Card A is promoted first, re-anchored onto the shared branch.
        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["driven_task_ids"] == [a]
        sha_a = _work_on_card(board, repo, a, "a.txt")

        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["driven_task_ids"] == [b]
        sha_b = _work_on_card(board, repo, b, "b.txt")

        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["driven_task_ids"] == [c]
        sha_c = _work_on_card(board, repo, c, "c.txt")

        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["status"] == "completed"
        assert run["nodes"]["drive"]["outcome"] == "success"
        assert run["status"] == "completed"

        # The shared branch carries exactly one impl commit per card, in order
        # (newest first), stacked on the base commit.
        shas = _git(repo, "log", "--format=%H", BRANCH).splitlines()
        assert shas[:3] == [sha_c, sha_b, sha_a]
        assert len(shas) == 4  # base + one impl commit per card

        # Each card was based on the branch tip that already included the prior
        # card (build-on-previous is physically true).
        def _is_ancestor(x: str, y: str) -> bool:
            return (
                subprocess.run(
                    ["git", "-C", str(repo), "merge-base", "--is-ancestor", x, y]
                ).returncode
                == 0
            )

        assert _is_ancestor(sha_a, sha_b)
        assert _is_ancestor(sha_b, sha_c)
        # The shared branch tip is card C's commit.
        assert _git(repo, "rev-parse", BRANCH) == sha_c
    finally:
        board.close()


def test_stacked_cards_are_told_not_to_self_bump_version(tmp_path: Path) -> None:
    repo = _init_release_repo(tmp_path)
    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        a = kb.create_task(board, title="only card", body="Implement X.", created_by="op", triage=True)
        eng = _engine(tmp_path, board)
        spec = _spec(tmp_path, _stack_spec(repo))

        run = eng.run(spec, "r")
        _surface_ids(board, run["nodes"]["collect"]["hermes_task_id"], [a])

        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["driven_task_ids"] == [a]

        # The driven card body is hardened: build on the shared branch, commit,
        # and do NOT bump version/CHANGELOG (the docs-version node owns that).
        body = (kb.get_task(board, a).body or "").lower()
        assert "do not" in body or "don't" in body
        assert "version" in body
        assert "changelog" in body
        assert BRANCH in (kb.get_task(board, a).body or "")
    finally:
        board.close()

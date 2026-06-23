"""Conformance: driven-card worktrees & worker cwd vs Hermes #49855 + #50348
(Task t_483b4f84).

Hermes upstream changed two things the release flow depends on:

- **#49855** — a worktree task is materialized as a real linked git worktree at
  ``<repo>/.worktrees/<task-id>``, anchored on the board's ``default_workdir``
  (a persistent project checkout) — NEVER under the dispatcher's incidental CWD
  (e.g. the Hermes code checkout the gateway launched from).
- **#50348** — the dispatcher pins the worker's ``TERMINAL_CWD`` to that
  resolved workspace, so ``file_tools._resolve_base_dir`` (relative writes) and
  ``build_context_files_prompt`` (AGENTS.md/context loading) anchor inside the
  workspace rather than the dispatching gateway's directory.

This suite is the validation layer for the release-branch stacking that the
sibling card (t_f5badd0e) added on top of that model: a stacked scope card's
linked worktree must be based on the shared ``feat/<slug>`` branch tip (so card
N builds on cards 1..N-1) and NOT on ``main``, and the worker that runs it must
resolve its cwd / context files inside the PROJECT repo, never the Hermes
checkout. It pins the dispatcher contract so a future upstream pull that
silently changes worktree anchoring or ``TERMINAL_CWD`` pinning fails loudly
here.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

kb = pytest.importorskip("hermes_cli.kanban_db")

from hermes_workflows.bridge import worktree
from hermes_workflows.engine import Engine
from hermes_workflows.executor import KanbanExecutor

ROOT = Path(__file__).resolve().parents[2]
CLI = ["bun", "run", str(ROOT / "packages" / "core" / "src" / "cli.ts")]

BRANCH = "feat/dispatch-conformance"


def _git(repo: Path, *args: str) -> str:
    out = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout.strip()


def _hermes_checkout_dir() -> Path:
    """The Hermes *code* checkout root (parent of the ``hermes_cli`` package) —
    the directory the dispatching gateway is typically launched from, and the
    one a worktree must NEVER be anchored inside (#49855)."""
    import hermes_cli

    return Path(hermes_cli.__file__).resolve().parent.parent


# --------------------------------------------------------------------------- #
# Runtime guard: assert_anchor_conformance                                    #
# --------------------------------------------------------------------------- #
def test_assert_anchor_conformance_accepts_a_project_repo_anchor(tmp_path: Path) -> None:
    """A release anchor that is a real project git repo (the board's
    default_workdir) is conformant; the guard returns the expected per-task
    worktree target ``<repo>/.worktrees/<task-id>``."""
    repo = tmp_path / "project"
    repo.mkdir()
    _git(repo, "init", "-q")

    target = worktree.assert_anchor_conformance(repo, "t_abc123")

    assert target == (repo.resolve() / ".worktrees" / "t_abc123")


def test_assert_anchor_conformance_rejects_an_anchor_inside_the_hermes_checkout() -> None:
    """An anchor that resolves inside the Hermes code checkout means the
    dispatcher would scatter the worktree under Hermes (the #49855 regression).
    The guard refuses loudly rather than letting a card land off-repo."""
    hermes_dir = _hermes_checkout_dir()

    with pytest.raises(ValueError, match="Hermes"):
        worktree.assert_anchor_conformance(hermes_dir / "sub" / "tree", "t_x")


# --------------------------------------------------------------------------- #
# #49855 — driven-card worktree is anchored on the shared branch, not main     #
# --------------------------------------------------------------------------- #
def _init_release_repo(tmp_path: Path) -> tuple[Path, str]:
    """A project repo with a `main` and a divergent shared release branch.

    `main` carries only the base commit; the shared branch carries one extra
    `feat`-only commit. A worktree anchored on the shared branch therefore
    contains that feat-only commit — which is NOT on `main` — so "based on
    feat/<slug>, not main" is a checkable, divergent fact. Returns
    ``(repo, feat_only_sha)``. Left checked out on the shared branch (the state
    the lock-scope node leaves)."""
    repo = tmp_path / "project"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    _git(repo, "config", "commit.gpgsign", "false")
    _git(repo, "checkout", "-q", "-b", "main")
    (repo / "README.md").write_text("base\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-q", "-b", BRANCH)
    (repo / "RELEASE.md").write_text("release seed\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "-qm", "chore: release seed")
    return repo, _git(repo, "rev-parse", "HEAD")


def _engine(tmp_path: Path, board) -> Engine:
    return Engine(core_cli=CLI, db_path=str(tmp_path / "runs.db"), kanban=KanbanExecutor(board))


def test_commit_barrier_fails_loudly_on_non_fast_forward_card_branch(tmp_path: Path) -> None:
    """The release branch must not silently skip a card whose branch cannot be
    fast-forwarded into the shared branch. A non-FF merge means card ordering or
    anchoring broke, so the barrier raises instead of letting the next card build
    on a stale shared tip."""
    repo, _ = _init_release_repo(tmp_path)
    before = _git(repo, "rev-parse", BRANCH)
    card_id = "t_nonff"

    _git(repo, "checkout", "-q", "main")
    _git(repo, "checkout", "-q", "-b", worktree.card_branch(card_id))
    (repo / "divergent.txt").write_text("not based on release branch\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "-qm", "feat: divergent card")
    _git(repo, "checkout", "-q", BRANCH)

    with pytest.raises(subprocess.CalledProcessError):
        worktree.commit_barrier(repo, BRANCH, card_id)

    assert _git(repo, "rev-parse", BRANCH) == before


def _stack_spec(tmp_path: Path, repo: Path) -> str:
    obj = {
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
        "edges": [{"from": "collect", "to": "drive"}, {"from": "drive", "to": "done"}],
    }
    path = tmp_path / "stack-adopt.workflow.json"
    path.write_text(json.dumps(obj))
    return str(path)


def _surface_ids(board, collect_card: str, ids: list[str]) -> None:
    board.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (collect_card,))
    board.execute(
        "INSERT INTO task_runs (task_id, status, outcome, summary, started_at, ended_at) "
        "VALUES (?, 'done', 'completed', ?, 1, 2)",
        (collect_card, "scope: drive " + " and ".join(ids) + " please"),
    )
    board.commit()


def _commit_on_card_worktree(board, repo: Path, card: str, filename: str) -> str:
    """Materialize the card's linked worktree via the REAL host resolver
    (exercising #49855), commit one impl file, mark the card done."""
    task = kb.get_task(board, card)
    ws = kb.resolve_workspace(task, board=None)
    _git(ws, "config", "user.email", "w@w")
    _git(ws, "config", "user.name", "w")
    _git(ws, "config", "commit.gpgsign", "false")
    (ws / filename).write_text(f"impl {card}\n")
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


def test_driven_card_worktree_anchors_on_shared_branch_not_main(tmp_path: Path) -> None:
    """A stacked scope card's host-materialized linked worktree lives at
    ``<repo>/.worktrees/<task-id>`` and is based on the shared ``feat/<slug>``
    branch tip (which includes the prior card AND the feat-only seed that is NOT
    on main) — never on ``main``. This is the #49855 + sibling-stacking contract
    end to end."""
    repo, feat_seed = _init_release_repo(tmp_path)

    def _is_ancestor(x: str, y: str) -> bool:
        return (
            subprocess.run(
                ["git", "-C", str(repo), "merge-base", "--is-ancestor", x, y]
            ).returncode
            == 0
        )

    # The feat-only seed is genuinely off main (proves divergence is meaningful).
    assert not _is_ancestor(feat_seed, "main")

    board = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        a = kb.create_task(board, title="card A", created_by="op", triage=True)
        b = kb.create_task(board, title="card B", created_by="op", triage=True)
        kb.link_tasks(board, a, b)
        eng = _engine(tmp_path, board)
        spec = _stack_spec(tmp_path, repo)

        run = eng.run(spec, "r")
        _surface_ids(board, run["nodes"]["collect"]["hermes_task_id"], [a, b])

        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["driven_task_ids"] == [a]

        # The engine stamped card A onto the worktree model anchored at the repo.
        task_a = kb.get_task(board, a)
        assert task_a.workspace_kind == "worktree"
        assert task_a.workspace_path == str(repo)

        sha_a = _commit_on_card_worktree(board, repo, a, "a.txt")

        run = eng.advance(spec, "r")
        assert run["nodes"]["drive"]["driven_task_ids"] == [b]

        # Card B's worktree, materialized by the real host resolver, is the
        # per-task linked worktree under the PROJECT repo.
        task_b = kb.get_task(board, b)
        ws_b = kb.resolve_workspace(task_b, board=None)
        assert ws_b == repo / ".worktrees" / b
        head_b = _git(ws_b, "rev-parse", "HEAD")

        # Based on feat/<slug>: B's worktree HEAD contains the feat-only seed and
        # card A's commit; it is NOT anchored on main (the seed is off main).
        assert _is_ancestor(feat_seed, head_b)
        assert _is_ancestor(sha_a, head_b)
        assert not _is_ancestor(head_b, "main")
    finally:
        board.close()


# --------------------------------------------------------------------------- #
# #50348 — worker TERMINAL_CWD is pinned to the project worktree               #
# --------------------------------------------------------------------------- #
def test_worker_terminal_cwd_pins_to_worktree_inside_project_repo(
    tmp_path: Path, monkeypatch
) -> None:
    """The dispatcher's worker spawn pins ``TERMINAL_CWD`` (and the child's cwd)
    to the resolved per-task worktree, which is inside the project repo and NOT
    the Hermes checkout. This is the #50348 contract the release flow relies on
    for file tools + context-file resolution."""
    monkeypatch.setenv("HERMES_KANBAN_HOME", str(tmp_path / "khome"))
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_WORKSPACES_ROOT", raising=False)
    monkeypatch.delenv("TERMINAL_CWD", raising=False)
    slug = "relboard"

    repo, _ = _init_release_repo(tmp_path)
    kb.write_board_metadata(slug, default_workdir=str(repo))
    board = kb.connect(db_path=kb.kanban_db_path(slug))
    try:
        card = kb.create_task(
            board,
            title="worktree card",
            created_by="op",
            assignee="worker",
            workspace_kind="worktree",
            workspace_path=str(repo),
            branch_name=worktree.card_branch("t_demo"),
        )
        task = kb.get_task(board, card)
        workspace = str(kb.resolve_workspace(task, board=slug))

        captured: dict = {}

        class _FakeProc:
            pid = 4242

        def _fake_popen(args, **kwargs):  # noqa: ANN001
            captured["args"] = args
            captured["kwargs"] = kwargs
            return _FakeProc()

        monkeypatch.setattr(kb.subprocess, "Popen", _fake_popen)

        pid = kb._default_spawn(task, workspace, board=slug)
        assert pid == 4242

        env = captured["kwargs"]["env"]
        # TERMINAL_CWD is pinned to the worktree, and so is the child cwd.
        assert env["TERMINAL_CWD"] == workspace
        assert captured["kwargs"]["cwd"] == workspace
        # The worktree is inside the project repo, never the Hermes checkout.
        ws_path = Path(workspace).resolve()
        assert ws_path.is_relative_to(repo.resolve())
        assert not ws_path.is_relative_to(_hermes_checkout_dir())
    finally:
        board.close()


# --------------------------------------------------------------------------- #
# #50348 — context files / relative paths resolve in the worktree, not Hermes  #
# --------------------------------------------------------------------------- #
def test_context_and_file_tools_resolve_in_worktree_not_hermes_checkout(
    tmp_path: Path, monkeypatch
) -> None:
    """With ``TERMINAL_CWD`` pinned to the worktree (as the dispatcher sets it),
    the AGENTS.md/context-file loader and the file-tools base-dir resolver both
    anchor inside the project worktree — not the dispatching gateway's Hermes
    checkout (the #34619 / #41312 bugs #50348 fixed)."""
    from agent.prompt_builder import build_context_files_prompt
    from tools import file_tools

    worktree_dir = tmp_path / "project" / ".worktrees" / "t_demo"
    worktree_dir.mkdir(parents=True)
    (worktree_dir / "AGENTS.md").write_text("PROJECT_CONTEXT_MARKER\n")

    # A stand-in for the dispatching gateway's own AGENTS.md (the Hermes checkout
    # directory). The worker must NOT load this.
    gateway_dir = tmp_path / "hermes-gateway"
    gateway_dir.mkdir()
    (gateway_dir / "AGENTS.md").write_text("HERMES_GATEWAY_CONTEXT_MARKER\n")

    # Context-file loader resolves from the worktree cwd, not the gateway dir.
    from_worktree = build_context_files_prompt(cwd=str(worktree_dir), skip_soul=True)
    assert "PROJECT_CONTEXT_MARKER" in from_worktree
    assert "HERMES_GATEWAY_CONTEXT_MARKER" not in from_worktree

    # The file-tools base dir honours the pinned TERMINAL_CWD: a relative write
    # path lands inside the worktree, not whatever the process cwd happens to be.
    monkeypatch.chdir(gateway_dir)
    monkeypatch.setenv("TERMINAL_CWD", str(worktree_dir))
    base = file_tools._resolve_base_dir()
    assert base == worktree_dir.resolve()

"""Release-branch stacking for adopt-driven scope cards.

When an adopt node stacks a multi-card scope on a shared feature branch
(``feat/<slug>``), each driven card must run in a worktree based on that
branch's CURRENT tip (so card N sees the commits of cards 1..N-1), and the next
card must not start until the current card's commits are on the shared branch.

This module provides the two primitives the engine needs:

- :func:`stamp_release_worktree` re-anchors a driven card's workspace onto the
  shared branch: the native dispatcher still materializes the linked worktree
  (Hermes #49855) — we only set its base ref (its own per-card branch off the
  shared branch tip) and append a release directive to the card body so the
  worker builds on the branch and does NOT self-bump version/CHANGELOG.
- :func:`commit_barrier` advances the shared branch to include a finished card's
  commits via a fast-forward. Because each card branches off the shared branch
  tip and only adds commits, this is always a clean fast-forward — no merge
  commit, no conflicts (design decision 3). It is a no-op for a card that
  produced no commit, so the gate never wedges on an empty change.

Everything here is a pure git + Kanban-column operation on the PROJECT repo; it
introduces no second VCS/run concept (design decision 2).
"""

from __future__ import annotations

import sqlite3
import subprocess
from pathlib import Path
from typing import Optional

from hermes_cli import kanban_db as kb

# Marker so the release directive is appended to a driven card body at most once
# (a card may be re-stamped across ticks). The visible text is operator-facing.
_DIRECTIVE_MARKER = "[hermes-workflows: release stacking]"


def card_branch(task_id: str) -> str:
    """The per-card branch a driven card commits onto. Unique per card so the
    host can check it out in the card's own linked worktree (two worktrees can
    never share one branch); the engine fast-forwards it into the shared branch
    once the card is done."""
    return f"wf/{task_id}"


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=check,
    )


def current_branch(repo: Path) -> Optional[str]:
    """The branch ``repo`` currently has checked out, or None if not resolvable
    (detached HEAD / not a git repo)."""
    try:
        out = _git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    except subprocess.CalledProcessError:
        return None
    name = out.stdout.strip()
    return name if name and name != "HEAD" else None


def _branch_exists(repo: Path, branch: str) -> bool:
    return (
        _git(repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}", check=False).returncode
        == 0
    )


def _hermes_checkout_root() -> Optional[Path]:
    """The Hermes *code* checkout (the parent of the installed ``hermes_cli``
    package). Worktrees must never be anchored inside it: it is the directory
    the gateway is typically launched from — the incidental dispatcher CWD that
    Hermes #49855 deliberately stopped anchoring worktrees on. None if Hermes is
    not importable (never let detection wedge the run)."""
    try:
        import hermes_cli

        return Path(hermes_cli.__file__).resolve().parent.parent
    except Exception:  # noqa: BLE001
        return None


def assert_anchor_conformance(repo_root: Path, task_id: str) -> Path:
    """Validate the release anchor against the dispatcher worktree contract and
    return the per-task linked-worktree target the host will materialize.

    Dispatcher contract (Hermes #49855 + #50348), the invariant this release
    relies on and that this guard pins:

    - A ``worktree`` task is materialized as a real linked git worktree at
      ``<repo>/.worktrees/<task-id>``, anchored on the board's
      ``default_workdir`` (a persistent project checkout) — NEVER under the
      dispatcher's incidental CWD (the Hermes code checkout the gateway launched
      from). #49855.
    - The worker's ``TERMINAL_CWD`` is pinned to that resolved workspace, so its
      file tools and AGENTS.md/context-file loader resolve inside the workspace,
      not the dispatching gateway's directory. #50348.

    The release engine stamps each driven scope card with ``workspace_kind=
    'worktree'`` and ``workspace_path=<repo_root>`` so the host resolves exactly
    that ``<repo>/.worktrees/<task-id>`` target on the shared branch's tip. This
    guard fails loudly when the resolved anchor is the Hermes checkout — the
    exact regression #49855 fixed — so a misconfigured board ``default_workdir``
    or node ``workdir`` cannot silently route a driven card's worktree (and its
    commits) off the project repo.
    """
    repo_resolved = repo_root.expanduser().resolve(strict=False)
    hermes_root = _hermes_checkout_root()
    if hermes_root is not None:
        try:
            inside = repo_resolved == hermes_root or repo_resolved.is_relative_to(hermes_root)
        except ValueError:
            inside = False
        if inside:
            raise ValueError(
                f"release anchor {repo_resolved} is inside the Hermes checkout "
                f"{hermes_root}: a driven card's worktree must be anchored on the "
                "project repo (the board default_workdir), not the dispatcher's "
                "CWD (Hermes #49855). Point the board default_workdir / node "
                "`workdir` at the project repo."
            )
    return repo_resolved / ".worktrees" / task_id


def _release_directive(branch: str) -> str:
    return (
        f"\n\n---\n{_DIRECTIVE_MARKER}\n"
        f"You are one card in a stacked release targeting the shared branch `{branch}`. "
        "Your worktree is checked out on a per-card branch created from the shared "
        "branch's current tip, which includes the commits of the cards driven before "
        "you — build on them, do not duplicate or revert their work. COMMIT your "
        "changes on this per-card branch before you finish; the engine will "
        "fast-forward the shared branch after the card succeeds. Do NOT switch "
        "branches. Do NOT bump the version or edit CHANGELOG/manifests: "
        "the dedicated docs-version step runs the version bump ONCE for the whole "
        "release scope.\n"
    )


def stamp_release_worktree(
    conn: sqlite3.Connection, task_id: str, *, repo_root: Path, branch: str
) -> str:
    """Re-anchor a driven card onto the shared release branch.

    The card is materialized by the dispatcher as a linked worktree at
    ``<repo>/.worktrees/<task-id>`` on its own per-card branch, which git creates
    off the repo's HEAD — kept at the shared branch tip by :func:`commit_barrier`
    — so the card builds on every prior card. The release directive is appended
    to the card body (idempotently). Returns the per-card branch name.
    """
    branch_name = card_branch(task_id)
    # Fail loud at drive time if the anchor would scatter the worktree under the
    # Hermes checkout instead of the project repo (Hermes #49855 contract).
    assert_anchor_conformance(repo_root, task_id)
    row = conn.execute("SELECT body FROM tasks WHERE id = ?", (task_id,)).fetchone()
    body = (row["body"] if row is not None else "") or ""
    if _DIRECTIVE_MARKER not in body:
        body = body + _release_directive(branch)
    conn.execute(
        "UPDATE tasks SET workspace_kind = 'worktree', workspace_path = ?, "
        "branch_name = ?, body = ? WHERE id = ?",
        (str(repo_root), branch_name, body, task_id),
    )
    conn.commit()
    return branch_name


def commit_barrier(repo_root: Path, branch: str, finished_task_id: str) -> None:
    """Advance the shared ``branch`` to include a finished card's commits.

    Fast-forward only: each card branches off the shared branch tip and only
    adds commits, so advancing the shared branch to the card branch is always a
    clean fast-forward (no merge commit, no conflicts). Tolerant by design:

    - a card whose worktree the dispatcher never created (e.g. a card already
      terminal, or one that committed nothing) has no per-card branch, or a
      branch equal to the shared tip — both fast-forward to a no-op, an accepted
      pass so an empty change never wedges the run (see design Risks).
    """
    card = card_branch(finished_task_id)
    if not _branch_exists(repo_root, card):
        return
    # Make the shared branch current so a fast-forward updates it (you cannot
    # force-update a branch checked out in another worktree). The release tree is
    # where lock-scope left the shared branch checked out.
    if current_branch(repo_root) != branch:
        _git(repo_root, "checkout", branch)
    _git(repo_root, "merge", "--ff-only", card)


def resolve_release_context(
    conn: sqlite3.Connection, *, workdir: Optional[str], branch: Optional[str]
) -> tuple[Path, str]:
    """Resolve the (release working tree, shared branch) for a stacked adopt.

    The working tree is the explicit ``workdir`` or, failing that, the board's
    ``default_workdir``. The shared branch is the explicit ``branch`` or the
    branch the working tree currently has checked out (what the lock-scope step
    left open). Fails loud rather than guessing."""
    repo = Path(workdir).expanduser() if workdir else _board_default_workdir(conn)
    if repo is None:
        raise ValueError(
            "stacked adopt requires a release working tree: set the node's "
            "`workdir`, or the board's default_workdir to the project repo."
        )
    if not (repo / ".git").exists() and current_branch(repo) is None:
        raise ValueError(f"release working tree {repo} is not a git repository")
    explicit_branch = branch.strip() if (branch and "{{" not in branch) else None
    resolved = explicit_branch or current_branch(repo)
    if not resolved:
        raise ValueError(
            f"could not resolve the shared release branch for {repo} "
            "(detached HEAD?); set the node's `branch` explicitly."
        )
    if explicit_branch and current_branch(repo) != explicit_branch:
        _git(repo, "checkout", explicit_branch)
    return repo, resolved


def _board_default_workdir(conn: sqlite3.Connection) -> Optional[Path]:
    """The board's configured ``default_workdir`` (a project checkout), resolved
    from the connection's db file path. None when unset / not derivable."""
    slug = _board_slug(conn)
    try:
        meta = kb.read_board_metadata(slug)
    except Exception:  # noqa: BLE001 - never let metadata reads wedge the run
        return None
    default = (meta.get("default_workdir") or "").strip()
    return Path(default).expanduser() if default else None


def _board_slug(conn: sqlite3.Connection) -> Optional[str]:
    """Derive the board slug from the connection's db path
    (``.../boards/<slug>/kanban.db``). None for the legacy default location."""
    try:
        rows = conn.execute("PRAGMA database_list").fetchall()
    except sqlite3.Error:
        return None
    for row in rows:
        path = row[2] if not isinstance(row, sqlite3.Row) else row["file"]
        if not path:
            continue
        parent = Path(path).parent
        if parent.parent.name == "boards":
            return parent.name
    return None

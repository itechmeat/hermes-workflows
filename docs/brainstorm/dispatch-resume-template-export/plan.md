# Plan — dispatch-resume-template-export

Per-task implementation plan for the bundle. Follow each section under TDD (failing
test first, then green, then one atomic conventional commit). Cards are driven ONE
AT A TIME on the shared branch `feat/dispatch-resume-template-export`; each worker
MUST build on (git-aware) the commits previously-driven in-scope cards already
landed and must not duplicate or conflict with sibling tasks.

Ordered for dependency: Task 3 (template) and Task 2 (resume) are independent of
each other and of the dispatch pair. Task 1 must land before/with Task 4 (Task 4
asserts Task 1's behavior).

---

## Task t_f5badd0e — drive scope cards stacked on feat/<slug>; docs+version once

**Problem.** `adopt`-driven scope cards run in isolated worktrees off `main`, so
card N never sees cards 1..N-1; each card self-bumps version/CHANGELOG, causing
consolidation conflicts.

### Files
- `hermes_workflows/engine.py` — resolve the shared branch (from the
  `lock-scope` node output) and re-anchor each driven scope card's worktree base
  onto `feat/<slug>@tip`; add a commit barrier (next card promoted only after the
  current card's worktree HEAD is an ancestor of the branch tip).
- `hermes_workflows/executor/kanban_executor.py`, `hermes_workflows/bridge/kanban.py`
  — convey the per-card base ref to the dispatcher's worktree allocation; if the
  native board API has no per-task base, set the scope board's `default_workdir`
  to the release branch for the run.
- `tests/python/test_adopt_branch_anchor.py` (new) — engine + dispatch tests.

### Acceptance (a passing test)
- A unit/integration test where a 3-card scope is driven: after the run's
  adopt phase, `git log feat/<slug>` contains one impl commit per card in
  dependency order, and `git merge-base --is-ancestor <cardN-1> <cardN>` is true
  (card N's worktree was based on the branch tip that includes card N-1).
- A test asserting no driven card commits a version/CHANGELOG bump (the
  docs-version node owns that).
- `bun run validate` green (pytest + core + dashboard).

### Depends on
- Nothing in-scope (Task 4 validates this; land this before/with Task 4).
- The brainstorm node's per-card body already tells workers to build on the
  branch and not self-bump (harden if needed).

---

## Task t_483b4f84 — reconcile driven-card worktrees & worker cwd with #49855 + #50348

**Problem.** Validate that workflow-driven scope cards land in the intended
worktree/branch and read the correct repo context under the dispatcher's new
per-task linked-worktree + pinned `TERMINAL_CWD` model.

### Files
- `tests/python/test_dispatch_worktree_conformance.py` (new) — conformance suite.
- Possibly a thin runtime assertion in `hermes_workflows/engine.py` if a
  mismatch is detectable at drive time (final shape under TDD).
- Reference: `hermes_cli/kanban_db.py` (host) for the worktree/cwd columns.

### Acceptance (a passing test)
- A test driving a scope card and asserting the dispatcher-materialized worktree
  at `<repo>/.worktrees/<task-id>` has base ref `feat/<slug>` (not `main`), and
  the worker's resolved `TERMINAL_CWD` + AGENTS.md/context-file resolution lands
  inside the project repo (not the Hermes checkout).
- Documents (in code comment / doc) the dispatcher contract for future
  contributors.

### Depends on
- Task t_f5badd0e (its re-anchor is what this validates).

---

## Task t_30c5fb9c — operator CLI resume + dashboard Resume action

**Problem.** A stalled/failed run can only restart from scratch; `retryRun`
exists in core but is not in any operator interface, and the dashboard `/retry`
route does not advance.

### Files
- `hermes_workflows/cli.py` — `resume <run_id> [--node <id>] [--all]` subcommand
  (`_dispatch` + `_parser`); calls core `run-retry` then `advance_run`; clean
  `SystemExit` on single-flight refusal and structural drift refusal.
- `packages/core/src/cli/commands.ts` (+ `cli.ts` if a verb is added) — a pure-TS
  `structuralFingerprint(workflow)` helper (node-id set + edge adjacency) for the
  drift guard if the guard lives in core.
- `dashboard/plugin_api.py` — extend `POST /runs/{run_id}/retry` to advance after
  reset; add the drift guard (compare live spec node set vs run's persisted nodes).
- `apps/dashboard/src` Runs page — Resume action on `failed`/`cancelled` runs +
  per-failed-node resume; show which node it resumes from.
- `tests/python/test_cli_resume.py`, `packages/core/tests/cli.test.ts` (or new
  fingerprint test), dashboard test.

### Acceptance (a passing test)
- `hermes-workflows resume <run_id>` on a failed run resets the failed node,
  keeps completed-node outputs, and advances to completion under the current
  spec.
- A test simulating a `docs-version`-style timeout fixed in the spec resumes
  successfully (re-runs the failed node under the fixed prompt/timeout) without
  redoing earlier phases.
- A test where a node was added/removed/renamed in the live spec since the run
  started is refused with a clear message (structural drift); a prompt/timeout
  edit (same node set) is NOT refused.
- Single-flight preserved (resume of a run next to an active sibling refused).
- Dashboard Resume action test (button present on failed/cancelled, calls the
  endpoint, run resumes).

### Depends on
- Nothing in-scope (independent of dispatch pair and template).

---

## Task t_3a0c3a33 — export --as-template + .template.yaml + .template.md; spec_sha

**Problem.** Exported workflows carry installation bindings; cannot be shared.

### Files
- `packages/core/src/serialize/specSha.ts` (new) — `specSha(workflow)` stable
  content hash over serialized spec.
- `packages/core/src/templates/exportTemplate.ts` (new) — pure de-binding pass
  (tokenise scope/profile/model/deliver/provider/board/repo/paths), the
  `template:` versioning block, the composite cache key, the in-prompt-reference
  inventory scan.
- `packages/core/src/cli/commands.ts` + `packages/core/src/cli.ts` —
  `export --as-template <id>` (flag on existing export) writing both files.
- `packages/core/src/templates/params.ts` — extend `WorkflowTemplate`/adjacent
  types with the `template:` provenance block if it belongs here.
- `dashboard/plugin_api.py` — template export route (alongside the existing
  verbatim-YAML export).
- `apps/dashboard/src` Templates page — "Download template" affordance.
- AI guide generation: a single default-model (`model.default`) call for the
  hints + guide; cached on `(workflow_id, spec_sha, template_format,
  generator_version)`.
- `packages/core/tests/exportTemplate.test.ts`, `specSha.test.ts`.

### Acceptance (a passing test)
- `export --as-template <id>` writes `<id>.template.yaml` + `<id>.template.md`.
- The template YAML contains no concrete project/profile/model/channel/board/
  repo/path values — all free-form placeholders; the file parses structurally.
- The guide opens with the REQUIRED hermes-workflows + RECOMMENDED o2b
  prerequisites (with `llms.txt` links), then per-placeholder recommendations and
  the in-prompt-reference inventory.
- Second export of the same version is served from cache (no AI call); a version
  bump OR a `spec_sha` change regenerates.
- `spec_sha` is stable for identical specs and changes on any content edit.

### Depends on
- Nothing in-scope (independent). The `spec_sha` primitive is standalone.

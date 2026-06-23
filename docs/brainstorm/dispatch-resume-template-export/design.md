# Design — dispatch-resume-template-export

Bundle: four LEAF cards shipping as one release on the shared branch
`feat/dispatch-resume-template-export`. Two pairs of tightly-coupled work
(release-card dispatch correctness + worktree reconciliation; run resume +
template export) plus one cross-cutting primitive (`spec_sha`) whose shape is
decided once and consumed by the template task only.

Chosen architecture: **Variant 1 — thin independent slices, engine sets the
anchor.** Logic that is logic stays pure TypeScript in core; the Python engine
only orchestrates native workspace params and a new commit gate. The dispatcher's
new per-task linked-worktree model is accepted and re-anchored, not fought.

## Problem

1. **Release-card dispatch breaks cross-card context.** `adopt`-driven scope
   cards run in isolated worktrees branched off `main`, so card N cannot build on
   the commits of cards 1..N-1. Each card also self-bumps version/CHANGELOG,
   guaranteeing consolidation conflicts.
2. **No operator-facing run resume.** A stalled/failed run can only be restarted
   from scratch or finished by hand, even though `retryRun` already exists in
   core and the dashboard already has a `/retry` route (unused, and it does not
   advance).
3. **Exported workflows carry this installation's bindings**, so they cannot be
   shared and run on a different Hermes.
4. **Worktree/cwd reconciliation.** Hermes upstream (#49855 + #50348) now gives
   each task its own linked worktree and pins worker `TERMINAL_CWD` to it; the
   release flow must be validated against that model.

## Scope (in-scope task ids)

- t_f5badd0e [P4] — drive scope cards stacked on `feat/<slug>`; docs+version once.
- t_30c5fb9c [P4] — operator CLI `resume` + dashboard Resume action.
- t_3a0c3a33 [P4] — `export --as-template` + `.template.yaml` + `.template.md`;
  `spec_sha` primitive.
- t_483b4f84 [P3] — reconcile driven-card worktrees/cwd with #49855 + #50348.

## Out of scope

- Template importer (v1 is export-only; the guide leads manual adaptation).
- Prompt-body rewriting during template export (bodies are inventoried, not
  edited).
- A unified spec-identity module combining the template `spec_sha` with the
  resume drift fingerprint (deliberately kept separate — see Design decisions).
- A run-level "release workspace" DB column / first-class run concept (the
  single-flight, one-run-per-workflow model does not need it).

## Chosen approach (Variant 1)

Four independent slices, each the smallest change that satisfies its contract.
Tasks 1 and 4 are ordered (4 validates 1); tasks 2 and 3 are independent of each
other and of the dispatch pair.

### Task 1 + 4 — shared-branch anchor with a commit barrier

The native dispatcher already materializes a per-task linked worktree
(`#49855`) anchored on the board's `default_workdir`, and pins worker
`TERMINAL_CWD` to it (`#50348`). Rather than fight isolation (Variant 3) or
rebuild the workspace as a run-level concept (Variant 2), the engine **re-anchors
the per-card worktree from `main`/`default_workdir` onto `feat/<slug>` at its
current tip**, and adds a **commit barrier** between cards so card N cannot start
until card N-1 has committed onto the branch.

Mechanism surface (final shape settled by the implementer under TDD; the anchor
is the key decision):
- The engine knows the shared branch name (resolved at `lock-scope`; it already
  opens `feat/<slug>`). When driving a scope card via `adopt`, the engine stamps
  the card so the dispatcher's worktree allocation bases it on `feat/<slug>@tip`
  rather than the board default. How the per-card base ref is conveyed to the
  dispatcher is exactly the integration point Task 4 validates; if the native
  board API exposes a per-task `workspace` base, use it; otherwise fail closed
  rather than mutating shared board state. The release anchor must stay
  run-scoped and must not fall back to a board-wide default branch mutation.
- A commit gate: `adopt` driving is already sequential and dependency-ordered
  (commit `36ddadd`). The engine promotes the next card only after the current
  card's worktree HEAD is an ancestor of the shared branch tip (i.e. the card
  committed). This makes "card N builds on 1..N-1" physically true. No card is
  allowed to finish without an explicit commit or equivalent marker; empty-diff
  cards must still produce a marker before the next card is promoted. The
  docs-version node (run once) owns version/CHANGELOG, and driven cards are
  instructed NOT to self-bump (this is also written into each card body by the
  brainstorm node).

Task 4 is the validation/conformance layer for the above: a test suite (and, if
needed, a thin runtime assertion) that confirms a workflow-driven scope card's
linked worktree's base ref is `feat/<slug>` (not `main`) and that
`TERMINAL_CWD`/context-file resolution lands inside the project repo (not the
Hermes checkout). Task 1 must land before or alongside Task 4 so the assertions
have the intended behavior to assert against.

### Task 2 — resume

Pure operator-surface work over the existing `retryRun` primitive.

Flag→primitive mapping is the one subtlety implementers must not invert. The
core primitive `retryRun(run, opts)` (packages/core/src/runtime/runMutations.ts)
behaves asymmetrically: `opts.node` set → resets exactly that one `failed` node
and sets the run `running`; `opts.node` omitted → resets the *whole graph* to
`pending` and sets the run `created`. So the CLI surface must translate the
operator's intent onto the *opposite* arg shape:

- `resume <run_id>` (bare default) — "resume the failed node and advance": the
  CLI resolves the run's failed node, then calls core `run-retry` WITH
  `--node <failed_id>`, then `advance_run`. If the run has **more than one**
  failed node, bare `resume` refuses with a message listing them and tells the
  operator to pick `--node <id>`; it does not silently pick one. If the run has
  **zero** failed nodes (e.g. it stalled in a non-failed state), bare `resume`
  refuses with a clear "no failed node to resume" message.
- `resume <run_id> --node <id>` — calls core `run-retry --node <id>` then
  `advance_run` (explicit single-node resume).
- `resume <run_id> --all` — "full restart": calls core `run-retry` **without**
  `--node` (whole-graph reset to `created`), then `advance_run`.

Because `retryRun({node})` requires `node.status === "failed"`, a node left in a
non-`failed` terminal state (notably `cancelled`) cannot be single-node resumed
as-is. Resume is therefore offered on runs whose status is `failed`, and on
`cancelled` runs **only via `--all`** (whole-graph restart always works). The
dashboard surfaces the two affordances accordingly: "Resume" (bare / per failed
node) on `failed` runs, and "Restart from scratch" (`--all`) on both `failed`
and `cancelled` runs.

Both paths mirror `_advance_run`'s clean `SystemExit`-on-`ValueError` handling,
and surface single-flight refusal and structural drift refusal as messages, not
tracebacks.
- Dashboard: two distinct affordances matching the CLI semantics above — a
  **Resume** action (bare resume of the single failed node, with a per-failed-node
  picker when more than one exists) on `failed` runs, and a **Restart from
  scratch** action (`--all` semantics) on both `failed` and `cancelled` runs.
  Both are wired to the existing `POST /runs/{run_id}/retry` route, which is
  extended to **advance after retry** (today it only resets). Shows which node it
  will resume from (the failed node, or the entry node for `--all`).
- Spec-drift guard: before advancing, resume compares the live spec's node
  id+kind signature against the run's persisted node signature. A structural
  mismatch (added/removed/renamed/retyped node) is refused with a clear message;
  prompt/timeout/config edits (same node id+kind set) are the supported case and
  must NOT trip the guard. This uses a **structure-only fingerprint**,
  deliberately NOT the full-content `spec_sha` (see Design decisions).

### Task 3 — export as template

- `spec_sha`: new pure-TS helper — a stable content hash over the serialized
  spec (`serializeWorkflow` output). Required because the spec can change
  without a `version` bump. Lives next to the serializer; exported from the
  package barrel.
- De-binding: a pure TS pass that tokenises installation-specific bindings into
  placeholders (`${PROJECT}`, `${PROFILE:<hint>}`, `${MODEL:<hint>}`,
  `${DELIVER_TARGET}`, path/board/provider/repo tokens). The placeholder syntax
  reuses the existing `${...}` interpolation token already valid in the spec.
  No prompt bodies are rewritten; instead an inventory scan lists remaining
  in-prompt references (paths, project/repo names, channel ids, the kanban
  wrapper path) for the guide.
- AI guide + hints: one call to the resolved default model (`model.default`)
  generates the free-form role/capability hints (derived from each node's
  purpose) and the adaptation guide. Caching keyed on `(workflow_id, spec_sha,
  template_format, generator_version, resolved_model)`; regenerate iff any
  component changed. If model rotation is intentionally treated as compatible,
  bump `generator_version` with that change.
- Versioning `template:` block in `.template.yaml`:
  - `template_format` (int) — artifact schema version.
  - `source: { workflow_id, workflow_version, spec_sha }`.
  - `generation: { generator_version, model, generated_at }`.
  - `revision` — short deterministic hash of the composite cache key.
  - Human-readable string `fmt<format>·wf<workflow_version>·r<revision-short>`.
- CLI: `export --as-template <id>` on the existing export (flag form), emits both
  files. Dashboard gains a "Download template" affordance alongside the existing
  verbatim-YAML export.
- `.template.md` opens with the PREREQUISITES block (REQUIRED hermes-workflows +
  its `llms.txt` link; RECOMMENDED `o2b` + its `llms.txt` link), then per-node
  placeholder guidance + the in-prompt inventory, then a short instantiate
  preamble.

## Design decisions

1. **Two separate hashes, on purpose.** The template cache key needs a
   **full-content** hash (`spec_sha`) so any spec change invalidates the cached
   bundle. The resume drift guard needs a **structure-only** fingerprint (node
   ids + edges) so the *safe, supported* case (editing a prompt, a timeout, a
   config value without changing the graph) does not look like drift. Unifying
   them (Variant 2) would make a safe prompt edit trip the resume guard.
   Keeping them separate is correct, not redundant.

2. **Re-anchor, do not rebuild the workspace.** The dispatcher's per-task
   linked-worktree model (#49855) is accepted. The engine only changes the
   anchor ref and adds a commit barrier — no VCS layer, no new run-level DB
   concept, honoring "no second engine".

3. **Commit barrier is cheap because driving is already sequential.** `adopt`
   driving is single-flight and dependency-ordered (commit `36ddadd`), so adding
   a "committed before next" gate serializes nothing that was parallel.

4. **Resume = retry + advance, reading the live spec.** `advance` already
   resolves the spec via `config.spec_roots()` (live file, not a frozen
   snapshot), so "fix the node then resume" works for free. The existing
   dashboard `/retry` route is extended to advance, not replaced.

5. **spec_sha is a standalone primitive.** It is NOT entangled with resume's
   drift fingerprint, so task 3 is independently TDD-able and ships even if the
   dispatch pair slips.

6. **Per-card self-bump is suppressed at the instruction layer, not the engine.**
   Each driven card body (written by the brainstorm node) tells its worker: do
   NOT bump version or edit CHANGELOG; the dedicated docs-version node owns that
   once for the whole scope. (Already the case in the brainstorm contract; this
   release hardens it.)

## File changes (indicative)

Task 1 + 4:
- `hermes_workflows/engine.py` — resolve + stamp the shared branch on driven
  scope cards; commit barrier before next promotion.
- `hermes_workflows/executor/kanban_executor.py` / `bridge/kanban.py` — convey
  the per-card base ref to the dispatcher's worktree allocation (or set the
  scope board's `default_workdir`).
- `packages/core/tests/` + `tests/python/` — conformance tests for worktree base
  ref and cwd resolution.

Task 2:
- `hermes_workflows/cli.py` — `resume` subcommand.
- `dashboard/plugin_api.py` — extend `/retry` to advance after reset; drift
  guard.
- `packages/core/src/cli/commands.ts` — optional `structural-fingerprint` helper
  if the guard lives in core (pure TS).
- `apps/dashboard/src` Runs page — Resume button + per-node resume.

Task 3:
- `packages/core/src/serialize/specSha.ts` (new) — `spec_sha`.
- `packages/core/src/templates/exportTemplate.ts` (new) — de-binding +
  `template:` block + cache key.
- `packages/core/src/cli/commands.ts` + `cli.ts` — `export --as-template`.
- `dashboard/plugin_api.py` — template export route.
- `apps/dashboard/src` Templates page — download template.

## Risks

- **Dispatcher honors per-card base ref (Task 1).** If the native board API does
  not expose a per-task worktree base, the fallback is the scope board's
  `default_workdir` = the release branch. Task 4's assertions catch a silent
  regression; their ordering behind/with Task 1 is explicit.
- **Resume drift guard sensitivity.** A structure-only fingerprint must not miss
  a rename (which a pure add/remove set diff would). Use node-id set + edge
  adjacency, and treat any id-set change as structural drift.
- **Template AI generation cost/availability.** Caching on `spec_sha` keeps it
  to one call per real spec change; generation is fail-open-documented (a missing
  model degrades to deterministic de-binding without hints).
- **Commit barrier liveness.** A card that cannot commit (e.g. empty change)
  must not wedge the run; the gate accepts "no diff to commit" as a pass.

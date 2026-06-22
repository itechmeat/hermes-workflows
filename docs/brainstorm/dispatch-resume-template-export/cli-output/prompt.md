You are a senior software architect reviewing a BUNDLE of four related features for "Hermes Workflows" and proposing architecture variants. This is a brainstorm: produce EXACTLY three distinct architectural variants, then EXACTLY ONE recommendation. No code. Read carefully.

# Project: Hermes Workflows

Hermes Workflows is a dashboard plugin for Hermes Agent (a multi-platform LLM gateway). A user draws an automation as a graph (agent_task, script, condition, human_review, wait, finish nodes) and it runs on Hermes' own primitives: Kanban cards, Cron jobs, and Profiles. It is NOT a second engine — every node compiles to a native Hermes primitive.

Two languages by design:
- **TypeScript core on Bun** (`packages/core`): engine, compiler, schema, CLI. Pure functions where possible. `advance.ts` is a pure decision function (no I/O). `runtime/db/` is SQLite (WAL).
- **Thin Python bridge** (`hermes_workflows/`): orchestrator. Dependency-free. Adapts the core to the host, polls the board, runs node work via `executor/`. `engine.py` is the orchestrator (`_advance_step` polls cards, evaluates wait nodes, applies node updates). `bridge/` adapts Kanban/Cron/Profiles/notify.
- **Dashboard** (`apps/dashboard` React 19 + `@xyflow/react` editor; built to `dashboard/dist`). Backend API in `dashboard/plugin_api.py` (FastAPI router). Frontend in `apps/dashboard/src/`.

Core CLI: `packages/core/src/cli.ts` (dispatch) + `packages/core/src/cli/commands.ts` (handlers). JSON-in/JSON-out, invoked by the Python orchestrator via `cli_bridge`. Operator CLI: `hermes_workflows/cli.py` (subcommands run/advance-all/advance-run/status/cancel/review), execed via `bin/hermes-workflows`.

Runs are single-flight: at most one active run per workflow. Node outputs captured into typed channels; an `adopt` node drives board cards a prior node RESOLVED (via `task_ref: "{{nodes.<id>.output.task_ids}}"`).

Conventions: TypeScript strict, ESM, `.ts` extension imports, Bun. Python 3.11+, dependency-free bridge, tests in `tests/python`. TDD (failing test first, then green, then atomic conventional commit). Prose: neutral and measured, no exclamation marks, regular hyphen not em-dash. All repository artifacts in English.

Git log (recent):
```
db96e35 feat: event-driven advance via native Kanban lifecycle hooks (v0.6.0)
36ddadd fix(adopt): dependency-ordered driving + skip un-completable umbrella cards
d4eab9f chore(release): v0.5.0 - template-param instantiation + adopt blocked-card time-box
1f53beb feat: workflow params instantiation + adopt blocked-card time-box
67415da feat: 0.4.0 - Prompt node, editor operator-input, off-board nodes
fc425eb chore(release): v0.3.0
383805f feat: 0.3.0 - operator control, authorable branches, run resilience
3c189d7 feat: Kanban-native runs, chat gates, worker-free wait (v0.2.0)
65bc8a6 feat: single-flight runs + workflow JSON export/import
4ae4dcc feat: run observability
```

# The four in-scope tasks (driven as ONE release on a shared feature branch)

These four LEAF cards ship together in one release. The first two are tightly coupled (both about how adopt-driven scope cards land on git); the third is run-resume; the fourth is template export.

---

## TASK 1 (t_f5badd0e, P4): adopt-implement drives in-scope cards in isolated worktrees off main, breaking cross-card context.

**Problem (correctness bug in the multi-card release flow).** When a workflow like `osb-feature-release` drives a multi-card scope through its `adopt` node (Phase 2 — "adopt-implement"), each in-scope card is implemented in its OWN isolated git worktree branched straight off the base branch (main), NOT stacked on the shared `feat/<slug>` release branch and NOT stacked on previously-completed sibling cards. As a result the coding agent for card N never sees the code that cards 1..N-1 produced, so the "build on the commits the previously-driven in-scope cards already landed" contract (written into each card body by the brainstorm node) is physically impossible. Cards that logically depend on each other get duplicate / conflicting implementations, and consolidation onto the release branch becomes N independent merges.

Additional symptom: each isolated card branch performs its OWN docs+version bump as if it were a standalone release (e.g. `docs(mcp): document HTTP transport; bump to v1.17.0`), so with N cards each self-bumping version and editing CHANGELOG/manifests independently off main, consolidation onto the shared release branch hits guaranteed version/CHANGELOG conflicts.

**Desired fix direction (for the variant, not prescriptive).** Drive each in-scope card on the SHARED `feat/<slug>` branch, stacked on the prior card's commit — e.g. allocate the card worker a worktree checked out on `feat/<slug>` at its current tip, and require each card to COMMIT its work onto that branch before the next card starts. Guarantee the core/first card commits too (no uncommitted leftovers). Run docs+version ONCE for the whole scope (the dedicated docs-version node), not per card.

**Key architecture facts.**
- The `adopt` node is implemented in the engine (`hermes_workflows/engine.py`, `_advance_step`). It resolves the task ids from the prior node's `task_ids` channel, then for each id calls `executor.adopt(task_id, assignee=...)` which delegates to `KanbanExecutor.adopt` -> `kanban.adopt_task` (assigns the card + promotes it into the dispatch lane). The native Hermes dispatcher (the gateway's embedded dispatcher, `hermes kanban dispatch`, which ticks every board) then CLAIMS the card and runs it — in a worktree/workspace the DISPATCHER allocates, NOT the workflow engine.
- `KanbanExecutor.schedule` passes `workspace=params.get("workspace") or "scratch"` into `create_node_task` -> `kb.create_task(..., workspace_kind=workspace, ...)`. `workspace_kind` is a native Kanban task column: "scratch" (fresh tmp dir), "dir" (shared directory), or "worktree" (git worktree). This is how a regular agent_task node tells the dispatcher where to run.
- BUT the `adopt` path does NOT go through `schedule`/`create_node_task` — it drives an EXISTING card by id. The existing card was created by a human (triage) and carries its own `workspace_kind`. So today, adopt-driven scope cards run wherever their existing card's workspace_kind says (default scratch), independently — the workflow engine never sets a shared branch/workspace for them.
- The `lock-scope` node opens the shared `feat/<slug>` branch in the project's main working tree (shared by later steps). Driven card workers, however, are dispatched to their own workspaces by the native dispatcher.

**Task 4 (t_483b4f84, P3) is DIRECTLY RELEVANT and ships in the same bundle.** Hermes upstream recently (merged #49855 + #50348) changed dispatcher workspace allocation: #49855 materializes a real per-task linked git worktree at `<repo>/.worktrees/<task-id>`, anchored on the board's `default_workdir` (never under the dispatcher CWD); #50348 pins worker `TERMINAL_CWD` to the task workspace, so file tools and the AGENTS.md/context-file loader resolve inside the workspace. This task is to VALIDATE that workflow-driven scope cards land in the intended worktree/branch and read the correct repo context (not the Hermes checkout), and reconcile the workflow's shared-branch intent with the dispatcher's new per-task worktree model. So Task 1's "shared branch" fix MUST be designed in light of the dispatcher now giving each card its OWN linked worktree by default — there is a real tension: the dispatcher wants isolation per card, the release flow wants stacking on a shared branch.

---

## TASK 2 (t_30c5fb9c, P4): Operator-facing resume of a stalled run (expose retryRun in CLI + dashboard).

**Problem.** When a workflow run stalls or fails mid-way (node timeout, deadlock, transient error), the work done so far is left hung: the run is terminal (`failed`/`cancelled`), its feature branch + commits, driven cards, and brainstorm docs sit on disk, and the only operator options today are (a) start a brand-new run from scratch (redoing inventory/lock-scope/brainstorm/adopt) or (b) finish it by hand. There is no operator-facing way to resume the SAME run from where it died.

**Key finding: a resume primitive ALREADY EXISTS in core but is NOT exposed in any operator interface.**
- `retryRun(run, {node?})` in `packages/core/src/runtime/runMutations.ts`, surfaced as the core CLI verb `run-retry` (`cmdRunRetry` in `commands.ts`). With a `node` (which must be `failed`) it resets just that node and resumes the run `running`; with no node it resets the whole graph to `created`. It clears the node's `hermes_task_id` for a fresh handle. The save path (`reviveRun`) keeps the single-flight guard (excludes the run itself).
- It is NOT in the operator CLI (`hermes_workflows/cli.py` has only run/advance-all/advance-run/status/cancel/review) and NOT surfaced in the dashboard UI.
- The dashboard backend ALREADY has a `POST /runs/{run_id}/retry` route (plugin_api.py) that calls core `run-retry` (with optional `--node`). But it is NOT wired to any dashboard frontend action, and crucially it does NOT advance the run afterward (it only resets state) — so as-is it leaves the run revived-but-stalled, needing a separate advance. The frontend has no "Resume" button.

**Bonus from architecture.** `advance` resolves the spec via `config.spec_roots()` — it reads the LIVE spec file, not a frozen snapshot. So resume = `run-retry` + `advance` re-runs the failed node under the CURRENT (just-edited) spec. "Fix the node, then resume the same run" works for free — exactly the timed-out-docs-version scenario.

**Desired scope.**
- Operator CLI (`cli.py`): add `resume <run_id> [--node <id>] [--all]` -> call core `run-retry` (reset failed node, or whole graph with `--all`) -> then advance. Default (no `--node`) resumes from THE failed node (keep completed prefix + node outputs); `--all` is a full restart. Mirror clean operator-facing error handling (single-flight refusal as `SystemExit` message, not traceback).
- Dashboard: a "Resume" action on a `failed`/`cancelled` run (and a per-failed-node resume), wired to a backend endpoint that calls `retryRun` + advances. Show which node it will resume from.

**Guards/edge cases.** Single-flight preserved. Spec drift: if the live spec's node set differs structurally from the run's persisted nodes (node added/removed/renamed since the run started), resume must refuse/warn rather than advance into a mismatched graph. Prompt/timeout/config edits (same node set) are the safe supported case. Only terminal-or-failed runs are resumable.

**Key files.** `packages/core/src/runtime/runMutations.ts` (retryRun/RetryError), `packages/core/src/cli/commands.ts` (cmdRunRetry), `packages/core/src/cli.ts` (run-retry verb), `hermes_workflows/cli.py` (operator subcommands `_dispatch`/`_parser`; spec resolution via `_spec_path_for_run`/`config.spec_roots()`), `hermes_workflows/engine.py` (advance_run, cancel), `dashboard/plugin_api.py` (existing /retry route + /cancel route), `apps/dashboard/src` Runs page.

---

## TASK 3 (t_3a0c3a33, P4): Workflow "export as template" — decouple from installation + AI-authored adaptation guide.

**Problem.** Workflow export today emits the spec as-is (it carries this installation's concrete bindings: project scope, agent profiles, models, delivery channels, kanban board, provider, repo slug, absolute paths). That makes an exported workflow useless to anyone else — it cannot be shared publicly and run on a different Hermes.

**Goal.** Add an "export as template" mode that DECOUPLES a workflow from this installation so it can be shared publicly and instantiated by anyone on their own Hermes, with their own profiles, models, projects, channels. Substance/logic stays intact; only installation-specific bindings are genericised. Ships with an adaptation guide (an llms.txt analog) explaining how to turn the template into a runnable workflow.

**Command + output.** `workflows export --as-template <id>` (flag on existing export, or sibling verb) produces a bundle of two files:
- `<id>.template.yaml` — the workflow with installation bindings decoupled into free-form placeholders.
- `<id>.template.md` — the adaptation guide (llms.txt analog).

**What gets decoupled (structured bindings -> free-form placeholders).** Placeholders are self-documenting tokens with a FREE-FORM hint derived from each node's purpose (NOT a fixed enum/vocabulary — workflows can be on any topic):
- `scope.projects`/project name -> `${PROJECT}`
- `defaults.profile` and per-node `profile` -> `${PROFILE:<free-form role hint>}`
- `model` -> `${MODEL:<free-form capability hint, e.g. strong reasoning / long context>}`
- `deliver` and channel ids -> `${DELIVER_TARGET}`
- `provider`, `board`, repo slug, absolute paths (`/srv/...`, `/tmp/...`, `/root/.hermes/...`) -> tokens
- `task_ref`, `skills` -> tokenise/flag when installation-specific

**Prompt bodies are NOT rewritten.** The export INVENTORIES installation-specific references still present in prompt bodies (paths, project/repo names, channel ids, the kanban wrapper path) and lists them in the guide as "adapt these" items — without modifying the prose.

**Instruction file `<id>.template.md` (llms.txt analog).** MUST open with a PREREQUISITES block: REQUIRED — the `hermes-workflows` plugin must be installed (link to its `llms.txt`); RECOMMENDED — install the `o2b` plugin per its `llms.txt` (link). Then, per placeholder/node: what it is, the recommended profile TYPE and model CAPABILITY class (free-form, derived from the node's purpose); prerequisites for the node; the list of remaining in-prompt references to adapt (from the inventory). Plus a short "how to instantiate" preamble.

**AI generation + caching.** The free-form recommendations and the guide require understanding each node's purpose, so AI-generated using the DEFAULT Hermes model (`model.default`, currently `nemotron-3-ultra-free`). The deterministic structural de-binding (tokenising paths/scope/channels/board/repo) runs without AI; only the hints + guide need the model. Cache key: composite `(workflow_id, spec_sha, template_format, generator_version)`. Regenerate iff any component changed; otherwise serve cached bundle.

**New primitive required: `spec_sha`** (serialized-spec content hash) does not exist yet — add it.

**Versioning (three independent axes, in a `template:` block in `<id>.template.yaml`):**
1. `template_format` (int) — schema version of the template ARTIFACT (placeholder syntax, params shape, guide structure, prerequisites block). Bump ONLY when the format changes. Compatibility contract: a consuming plugin declares which `template_format` it can read.
2. `source` — `{ workflow_id, workflow_version, spec_sha }`: exact source-workflow snapshot. `workflow_version` reuses existing integer spec `version`. `spec_sha` is NEW (content hash of serialized spec) — required because the spec can change WITHOUT a version bump.
3. `generation` — `{ generator_version, model, generated_at }`: the AI generator has its own version; bump when generation logic improves.

The template's own `revision` = a short deterministic hash of the composite cache key. Human-readable version string: `fmt<format>·wf<workflow_version>·r<revision-short>`, e.g. `fmt1·wf5·r9c3a`.

**v1 non-goals.** Export only. NO automated "instantiate from template" importer (the guide leads a human/agent to adapt placeholders by hand). No prompt-body rewriting.

**Key files.** `packages/core/src/serialize/serializeWorkflow.ts` (current export/serialisation, lossless round-trip), `packages/core/src/templates/params.ts` (existing WorkflowTemplate/key/params shape — the `template:` block lives next to these), `packages/core/src/cli.ts` (export verb/flag wiring), `packages/core/src/schema/` (binding fields to enumerate: scope, defaults.profile/model, node profile/model/deliver/provider/board/task_ref/skills), `dashboard/plugin_api.py` (existing `GET /workflows/{workflow_id}/export` returns verbatim YAML), default model from gateway `model.default`.

---

# Your task

Produce EXACTLY THREE distinct architectural variants for delivering this bundle. Consider how the four tasks interact (especially Task 1 + Task 4's shared-branch-vs-per-card-worktree tension, and how the resume + template tasks share the spec-resolution / spec_sha primitives). Each variant must cover all four tasks.

For EACH variant, give:
- **Approach:** 2-3 sentences describing the core architectural shape.
- **Trade-offs:** bullets.
- **Complexity:** small | medium | large.
- **Risk:** low | medium | high.

Then EXACTLY ONE section "Recommended: Variant N" with a concise rationale tying it to the project constraints (two-language split, single-flight, idempotency, no second engine, TDD).

Output ONLY the three variant sections and the single recommendation. Nothing else.

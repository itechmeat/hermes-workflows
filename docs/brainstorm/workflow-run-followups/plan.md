# workflow-run-followups - implementation plan

Atomic commits on `feat/workflow-run-followups`, ordered by dependency. Each is
TDD: failing test(s) first, then implementation, then format+lint+commit.

## Task 1: t_24e49f63 node-type icons on canvas
- **Files**: new `apps/dashboard/src/editor/nodeTypeIcons.tsx`; edit
  `FlowEditor.tsx`, `nodes/WorkflowNodeView.tsx`, `ui/theme.css`; test
  `apps/dashboard/tests/`.
- **Acceptance**: WorkflowNodeView renders the type icon before the label;
  FlowEditor add-menu uses the shared map; one icon source (no duplicate list).
- **Depends on**: none.

## Task 2: t_c1aa8c8f read-only inspector during run
- **Files**: `NodeInspector.tsx` (readOnly prop), `FlowEditor.tsx`,
  `run/RunNodeView.tsx`; tests.
- **Acceptance**: during a run a node opens in a fully disabled inspector; no
  field is editable; idle behaviour unchanged.
- **Depends on**: none.

## Task 3: t_896520df spec block scalars
- **Files**: `packages/core/src/serialize/serializeWorkflow.ts`; tests
  `packages/core/tests/serialize.test.ts`.
- **Acceptance**: multiline strings emit as `|` block scalars; round-trip
  deep-equal holds; non-block-safe strings keep quoted form.
- **Depends on**: none.

## Task 4: t_18848067 cancel CLI
- **Files**: `hermes_workflows/cli.py`; test `tests/python/test_py_cli.py`.
- **Acceptance**: `hermes-workflows cancel <run_id>` cancels via core run-cancel;
  idempotent on terminal runs.
- **Depends on**: none (core run-cancel already exists).

## Task 5: t_f6e62787 human_review payload
- **Files**: `schema/run.ts`, `engine.py` (decide_review), `cli.py` (review),
  `resolve.py` (review_note/review_option tokens), dashboard review surface;
  tests core+python.
- **Acceptance**: a gate decision carries an optional note/option; downstream
  prompt resolves `{{nodes.<gate>.review_note}}` / `review_option`; `.output`
  unchanged.
- **Depends on**: none.

## Task 6: t_797d3917 drive existing card
- **Files**: `schema/nodes.ts`, `compileToHermesPlan.ts`, `validateWorkflow.ts`,
  `executor/kanban_executor.py`, `bridge/kanban.py`, `engine.py`; tests.
- **Acceptance**: an adopt agent_task drives an existing card (assign->promote,
  no create), polls to terminal, idempotent.
- **Depends on**: none (foundation for 7, 8).

## Task 7: t_0de31c59 typed task-id data-flow
- **Files**: `resolve.py` (`.output.task_ids`), `validateWorkflow.ts`,
  executor adopt id-list resolution; tests.
- **Acceptance**: `task_ref: "{{nodes.X.output.task_ids}}"` resolves a typed id
  list; each validated/driven; node gates on all terminal; fails loud on a
  missing id.
- **Depends on**: Task 6.

## Task 8: t_d351a2aa native review stage
- **Files**: `schema/nodes.ts` (`review_profile`), executor review transition,
  `bridge/kanban.py` (claim_review path); tests.
- **Acceptance**: a driven card with `review_profile` routes through native
  `review` before the node settles; optional, default off.
- **Depends on**: Task 6.

## Task 9: t_cdea7c99 + t_64a30497 actionable gate notice + chat-reply docs
- **Files**: `engine.py` (`_notice_text` waiting), README/docs; tests.
- **Acceptance**: the waiting notice states the options and how to resolve
  (dashboard/CLI) and warns chat replies do not reach the run; docs note the gap
  and the upstream ask.
- **Depends on**: none.

## Task 10: t_b5b5f772 + t_0c352b34 blocked cards + status freshness
- **Files**: `engine.py` (`_advance_step` blocked detection + notice; `status`
  live read), `bridge/kanban.py` (expose blocked status via read_completion);
  tests.
- **Acceptance**: a blocked underlying card produces one operator notice and is
  surfaced; the run is never silently inert; `status` shows live card state.
- **Depends on**: none.

## Task 11: t_6583cda3 HOME contract
- **Files**: `executor/script_executor.py` (HOME passthrough), README/docs;
  tests.
- **Acceptance**: a script node's subprocess sees HOME (and the documented
  credential-home); the agent bash-tool caveat is documented.
- **Depends on**: none.

## Phase 3-5
- Self-review (requesting-code-review + verification), full `validate`
  (typecheck, lint, core tests, pytest, dashboard typecheck/test/build, dist
  guard), README + CHANGELOG. Stop at the pre-push gate (no PR without operator
  go-ahead).

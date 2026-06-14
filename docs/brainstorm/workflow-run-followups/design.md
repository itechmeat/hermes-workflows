# workflow-run-followups - design

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

The 2026-06-14 triage batch collects dashboard-editor UX gaps and findings from
the osb-feature-release test run. They span the React editor, the TypeScript core
engine, and the Python orchestrator. Today: nodes cannot be inspected mid-run;
canvas nodes lack their type icon; a workflow cannot drive a real board card
(every agent_task creates a new one); human_review carries no operator payload;
operators get no actionable signal at a gate and chat replies silently never
reach a paused run; a blocked underlying card hangs the run silently; `status`
lags the tick; there is no `cancel` CLI; the authored YAML spec loses its
readable formatting; and HOME-credential CLIs fail under script nodes.

## Scope

One PR (branch `feat/workflow-run-followups`), each task an atomic commit.

- **t_24e49f63** Node-type icons on canvas nodes (shared icon map).
- **t_c1aa8c8f** Open the node inspector during a run in a fully read-only state.
- **t_797d3917** agent_task `adopt` mode: drive an existing Kanban card.
- **t_0de31c59** Typed `{{nodes.X.output.task_ids}}` channel feeding `task_ref`.
- **t_d351a2aa** Optional native `review` stage for a driven card.
- **t_f6e62787** human_review operator-input payload (`review_note`/`review_option`).
- **t_cdea7c99** Actionable ACTION-NEEDED notice on entering a gate.
- **t_64a30497** Document that chat replies do not reach a run; point to the
  dashboard/CLI; native button/tagged-reply routing flagged as an upstream ask.
- **t_b5b5f772** Detect blocked underlying cards: surface + notify, never inert.
- **t_0c352b34** `status` opportunistically reads live card state.
- **t_18848067** `hermes-workflows cancel <run_id>` CLI subcommand.
- **t_896520df** Serializer emits block scalars for multiline strings.
- **t_6583cda3** HOME contract for script nodes + documented agent bash-tool caveat.

## Out of scope

- Native Telegram inline-button / tagged-reply event routing into a paused run
  (host-gated; Hermes has no event->run wiring - upstream ask, no local stub).
- Workflow-author UX for choosing which board cards to adopt (separate task).
- Changing the existing icon set or node-type set.
- Comment round-tripping in the YAML serializer (fragile; documented limit).
- Any new run-state value (engine state machine stays as-is).

## Chosen approach (per task)

### Editor (t_24e49f63, t_c1aa8c8f)
- New React module `editor/nodeTypeIcons.tsx` exporting `NODE_TYPE_ICON:
  Record<NodeType, ReactNode>` + `nodeTypeIcon(type)`. `graphMapping.ts` stays
  React-free (its file header is explicit), so the icon map lives beside it, not
  in it. `FlowEditor` builds its add-menu from this map; `WorkflowNodeView`
  renders `nodeTypeIcon(node.type)` before `nodeTypeLabel(node.type)` in
  `.hw-node__type`. Icon uses the existing `hw-icon` convention (currentColor,
  1em, aria-hidden); a small `.hw-node__type` flex-align rule in `theme.css`.
- `NodeInspector` gains a `readOnly?: boolean` prop that disables every Input /
  Textarea / Select / Checkbox. During a run the canvas allows opening a node
  (double-click + the open button on the run node) and `FlowEditor` renders the
  inspector modal with `readOnly` and a Close-only footer. The open path is the
  only run gate relaxed; nothing becomes editable.

### Drive real cards (t_797d3917, t_0de31c59, t_d351a2aa)
- Schema: `AgentTaskNode` gains optional `adopt?: boolean`, `task_ref?: string`
  (a literal id, or a `{{nodes.<id>.output.task_ids}}` reference), and
  `review_profile?: string`. Compiler carries them onto `CompiledKanbanTask`.
- Resolver: add a typed `.output.task_ids` channel. A node publishes a structured
  id list by emitting, as its output, a payload the resolver can read as a list;
  the resolver exposes `{{nodes.X.output.task_ids}}` (fails loud on missing/empty,
  same contract as `.output`). `task_ref` resolves to one or more ids.
- `KanbanExecutor.adopt` path: for each resolved id, `get_task` (must exist),
  `assign_task(profile)` then `promote_task(force=True)` (assign before promote -
  assigning a ready card drops it to todo); return the existing id(s) as the
  handle without creating. Idempotent: a card already running/owned is left
  alone. Completion gates on ALL driven cards terminal.
- `review_profile` (t_d351a2aa): when set, a driven card that reaches `done` is
  routed once through the native `review` stage (reviewer assignee + the native
  `claim_review_task` path); the node settles only when the review terminal.
  Optional - absent leaves adopt settling on first `done`.

### human_review payload (t_f6e62787)
- `NodeRunState` gains optional `review_note?: string` and
  `review_option?: string`. `decide_review` (engine.py) + the `review` CLI +
  the dashboard accept an optional note/option. Resolver exposes
  `{{nodes.<gate>.review_note}}` and `{{nodes.<gate>.review_option}}`. `.output`
  and `review_decision` unchanged.

### Operator signal (t_cdea7c99, t_64a30497)
- Enrich the `waiting` lifecycle notice text: `ACTION NEEDED: resolve gate
  <node> (<allowed options>) via the dashboard or `hermes-workflows review
  <run> <node> <decision>`. Do not reply in chat - a chat reply does not reach
  this run.` Single change to `_notice_text`; reuses the existing waiting-notify
  path (already fired once per gate via `notified` markers).
- Document the chat-reply gap in README + a docs note; the native operator->run
  channel (Telegram buttons / tagged reply) is an upstream ask.

### Run health (t_b5b5f772, t_0c352b34)
- In `_advance_step`, after polling, detect a polled card whose live status is
  `blocked` (or otherwise stalled). Record an additive attention marker and
  deliver ONE operator notice per blocked card (idempotent via `notified`).
  Run stays `running` (it has an active node and the tick keeps ticking, so it
  auto-recovers when unblocked) - no silent inert run, no engine state change.
- `status`: opportunistically read-only-poll each active node's card and annotate
  the printed run with the live card status + a pending-completion flag, clearly
  marked as a live read.

### Lifecycle CLI (t_18848067)
- `hermes-workflows cancel <run_id>`: wraps the existing core `run-cancel`
  (`cancelRun` is already in core + the `run-cancel` CLI command). Idempotent on
  terminal runs (cancelRun already returns terminal runs unchanged).

### Spec formatting (t_896520df)
- `serializeWorkflow` emits `|` block scalars for multiline strings, choosing the
  chomping indicator from trailing newlines; non-block-safe strings keep the
  JSON-quoted form. Round-trip `parseWorkflow(serializeWorkflow(w))` stays
  deep-equal. Comments are not preserved (documented).

### HOME contract (t_6583cda3)
- `ScriptExecutor` guarantees `HOME` (and a documented credential-home) reaches
  the subprocess so HOME-credential CLIs (claude/codex/gh) resolve. Document the
  contract and the agent bash-tool HOME caveat (a host concern) in docs.

## Design decisions

- Icons live in a React module, NOT in `graphMapping.ts`, to honour that file's
  React-free contract while still being the single shared icon source (DRY).
- Adopt reuses one node type + the existing poll path (no new node type) to keep
  `profile` routing and completion shared.
- Typed channel is additive: `.output` stays the default free-text channel.
- Blocked-card handling stays Python-side and additive; the pure engine's run
  states are untouched (no divergence from Hermes intent).
- Block scalars only when lossless; otherwise fall back to quoted (correctness
  over prettiness).

## File changes

- New: `apps/dashboard/src/editor/nodeTypeIcons.tsx`.
- Edit: `FlowEditor.tsx`, `nodes/WorkflowNodeView.tsx`, `NodeInspector.tsx`,
  `run/RunNodeView.tsx` (open affordance during run), `ui/theme.css`.
- Edit (core): `schema/nodes.ts`, `schema/run.ts`, `compiler/compileToHermesPlan.ts`,
  `validation/validateWorkflow.ts`, `serialize/serializeWorkflow.ts`,
  `cli.ts` / `cli/commands.ts` as needed.
- Edit (python): `resolve.py`, `engine.py`, `executor/kanban_executor.py`,
  `bridge/kanban.py`, `cli.py`, `executor/script_executor.py`.
- Tests across `packages/core/tests`, `tests/python`, `apps/dashboard/tests`.
- Docs: `README.md`, `CHANGELOG.md`, `docs/`.

## Risks and open questions

- Adopt of a `triage` card: `promote_task` only applies to `todo`/`blocked`, so
  the executor must move `triage`->`todo` first (native single write). Confirm
  the native helper during implementation; fail loud if a card cannot be driven.
- Block-scalar round-trip edge cases (trailing whitespace, CRLF) - covered by
  the quoted-scalar fallback and round-trip tests.
- `review_profile` settle semantics must not double-count the original `done`;
  guard with a per-node review marker.

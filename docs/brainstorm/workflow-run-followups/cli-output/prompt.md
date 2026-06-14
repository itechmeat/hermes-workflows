You are brainstorming architectural variants for a batch of related tasks in one repository. Do not write code. Do not write a final design. Only produce variants and a recommendation for EACH of the four open design questions below.

# Project context

hermes-workflows: a TypeScript core engine (`packages/core`, run with Bun) that compiles multi-node workflow DAGs to a Hermes plan, a Python orchestrator (`hermes_workflows/`) that ticks runs by driving native Hermes Kanban cards, a FastAPI dashboard plugin API, and a React 19 / @xyflow/react dashboard (`apps/dashboard`, built to a committed `dashboard/dist`).

Recent commits:
f37485c feat: native Hermes alignment for Workflows after Automation Blueprints (#20)
454da3e feat(dashboard): Base UI controls + O2B indicator link + import normalisation (#19)
96f30a4 feat: inter-node data flow via input_mapping (no host-file handoffs) (#18)
3d3c15c fix: honor per-node model/provider/skills/timeout for global runs (#17)
65bc8a6 feat: single-flight runs + workflow JSON export/import (#16)

Key facts about the current code:
- agent_task nodes compile to a CompiledKanbanTask and the executor CREATES a new Kanban card (`kanban_db.create_task`) per node. `KanbanExecutor.schedule`/`poll`. Card status read via a `read_completion`/`poll` path. VALID_STATUSES: triage, todo, scheduled, ready, running, blocked, review, done, archived.
- Native Hermes mechanics: `kanban_db.assign_task(conn, task_id, profile)` sets assignee but assigning a card that is already `ready` drops it to `todo`; the gateway dispatcher claims `ready` cards (`claim_task`, ready->running) ordered by priority DESC; reviewers claim `review` cards via `claim_review_task` (review->running).
- input_mapping already resolves `{{nodes.X.output}}` tokens into a node prompt at schedule time (single-pass regex in `resolve.py`, fails loud on missing output). It only supports `.output` (free text), nothing typed.
- human_review nodes resolve to one of approved|rejected|needs_changes (`engine.py decide_review`), stored as node.review_decision. No payload channel.
- Run states: created|running|waiting|completed|failed|cancelled. Node states include scheduled|running|waiting_for_review|completed|failed|cancelled. The Python tick `advance_all` polls scheduled/running cards, settles completions, then calls the TS `advance` decision function.
- On-disk workflow specs are YAML. The serializer deliberately emits JSON-quoted scalars (multiline as "\n", not `|` block scalars) and drops comments; starting a run rewrites the spec to this canonical form.
- `status` reads persisted run state, only updated when the 2-minute tick polls cards, so it lags reality between ticks.

Conventions:
- SOLID/KISS/DRY; extract magic values to named constants; no do-nothing or misleading fallbacks (surface errors loudly); no stubs.
- Stay native to Hermes: reuse Hermes primitives (kanban_db, delivery router, cron.jobs), never build a parallel mechanism; never diverge from Hermes schema/intent (e.g. do not invert sort, do not repurpose a default).
- TDD: tests first. TS tests with Bun, Python with pytest, dashboard with vitest. A `validate` script gates typecheck+lint+tests+dashboard build+committed-dist guard.

Constraints:
- One PR for the whole batch; each unit an atomic commit.
- Do not add a parallel webhook/job receiver; reuse Hermes.
- Do not change the meaning of existing fields; additive schema only.
- Per-node agent_task.profile must stay (it is the kanban assignee routing each node to a specialist).

# Open design questions (produce 3 variants + 1 recommendation for EACH)

## Q1 - Drive an existing Kanban card instead of creating one (adopt mode)
An agent_task should optionally DRIVE a pre-existing board card (by id, possibly a list of ids resolved from an upstream node's output `{{nodes.X.output...}}`) rather than create a new one: assign the node's profile, promote todo->ready (assign BEFORE promote, since assigning a ready card drops it to todo), let the dispatcher claim it, then poll it to terminal via the existing poll path. Must be idempotent (re-adopting an already-running/owned card is a no-op). Consider: schema shape (an `adopt: true` flag + a `task_ref` field vs a dedicated node mode/type), how the executor returns the existing id as the handle without creating, how typed task-id lists flow from an upstream node (extend the `{{nodes.X.output}}` resolver to a typed `.output.task_ids` channel vs parse ids out of free-text output vs a dedicated structured-output contract), and how to gate the node's completion on ALL driven cards reaching terminal.

## Q2 - human_review operator-input payload + consumption downstream
human_review resolution should optionally carry a structured/free-text payload (e.g. an operator note or a chosen option) that lands in run state and is consumable downstream, analogous to `{{nodes.<gate>.output}}` / a new `{{nodes.<gate>.review_note}}`. Consider: where the payload is stored on node state, how decide_review/CLI/dashboard accept it, and how the input_mapping resolver is extended to expose a second per-node channel beyond `.output` without breaking the existing single-channel `.output` contract.

## Q3 - Spec serialization preserving human-readable formatting
Starting a run rewrites the authored YAML (block scalars `prompt: |`, comments) into canonical one-line quoted JSON-ish YAML, making hand-editing painful. Consider: (a) make the serializer emit block scalars for multiline strings and round-trip comments; (b) treat the on-disk authored spec as read-only source of truth and keep the canonical form internal/in-DB only (never overwrite the author's file); (c) only document the behavior. Weigh complexity vs the editor-foundation goal that the dashboard is the primary authoring surface.

## Q4 - Run health visibility: blocked underlying cards + status freshness
Two related gaps: (a) when an underlying card goes `blocked`, the run sits running/scheduled forever with no signal - the tick should detect blocked/stalled cards, surface them, notify the operator, and move the run to a paused-needs-attention state or fail it loudly; (b) `status` lags the tick. Consider how to model "needs attention" without diverging from existing run states (new run sub-state vs reuse `waiting` with a reason vs a derived/annotated status), and whether `status` should opportunistically read live card state read-only vs label output as-of-last-tick.

# Required output format

For EACH question Q1..Q4, produce exactly 3 distinct architectural variants:

### Q<n> Variant <k>: <short name>
- **Approach**: 2-3 sentences.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

Then exactly one recommendation per question:

### Q<n> Recommended: Variant <k>
**Rationale**: 2-3 sentences considering the project context and constraints.

Output nothing outside of these sections.

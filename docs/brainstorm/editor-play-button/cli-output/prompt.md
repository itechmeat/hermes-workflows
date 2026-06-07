You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

**Problem:** the workflow editor page (`#editor/<id>`, FlowEditor) has no way to execute the workflow being edited. To run it the operator must go back to the Templates list (or use the CLI), and after starting a run there is no feedback on the editor canvas — node progress is only visible after manually navigating to the run inspector.

**Proposal:** a Play button in the FlowEditor header actions that:

- starts a run via the existing `POST /workflows/{id}/run` route (`client.runWorkflow`);
- while the run is in flight, polls `GET /runs/{run_id}` (same cadence as RunInspector, 2s) and overlays live node status on the editor canvas — which node is currently running, which already completed/failed (reuse the run-status mapping from `apps/dashboard/src/run/runView.ts` / RunNodeView styling where possible, DRY);
- when the run reaches a terminal state, immediately redirects to the run inspector (`#run/<run_id>`);
- any error (start rejected: 404/409 disabled workflow/scripts gate, poll failure, run failed) is surfaced explicitly in the UI — no silent fallbacks, no swallowed errors, no stubs.

**Acceptance:**
- Play button on the editor page starts the current workflow and the canvas shows live per-node progress (running / completed / failed) during playback.
- On run completion (terminal status) the dashboard navigates to the run inspector for that run automatically.
- A disabled workflow / failed start / failed poll shows an explicit error message on the editor page.
- Unit tests cover the start-poll-redirect flow and the error paths (dashboard test suite, mocked WorkflowsApi).

# Project context

hermes-workflows — visual workflow orchestration plugin for the Hermes agent platform. TypeScript + React 18 dashboard (apps/dashboard, bundled into dashboard/dist, tested with Bun + happy-dom + @testing-library/react), TypeScript core (packages/core, Bun), Python orchestrator (hermes_workflows, FastAPI plugin routes in dashboard/plugin_api.py).

Recent commits:
4ae4dcc feat: run observability — per-node telemetry, approval surfacing, JSONL trace (#14)
b06cf6a feat(dashboard): UI overhaul — plugin header, hash routing, shared component kit (#13)
7a4b3cb refactor: clean up workflow runtime backends (#12)
706261c fix(memory): write Open Second Brain notes via the real o2b CLI contract (#11)
84dbd6f feat: close the autonomous loop (notifications, Open Second Brain writes, inline mode) (#10)
eb8af6e feat: script node (deterministic shell-command step) (#9)
42eefa5 feat(dashboard): Templates enable/disable + editor polish (#8)
3ee207e feat(dashboard): Runs, Schedules, and Settings pages (#7)

Related files:
- apps/dashboard/src/App.tsx — view state + hash routing; views: templates | runs | schedules | settings | editor/<id> | run/<runId> (run inspector); navigation via `go(view)` callback; FlowEditor currently receives only `detail`, `client`, `onSaved`, `onBack`.
- apps/dashboard/src/editor/FlowEditor.tsx — the workflow page; header actions portal (Add node, Save, Duplicate, Auto-layout, Tools, status label); ReactFlow canvas with WorkflowNodeView nodes (editable).
- apps/dashboard/src/editor/useFlowEditor.ts — editor state hook (nodes/edges/dirty/save).
- apps/dashboard/src/editor/graphMapping.ts — pure spec<->flow mapping; WORKFLOW_NODE_TYPE; WorkflowNodeData { node }.
- apps/dashboard/src/run/runView.ts — pure run helpers: isTerminalRun(status), statusColor, applyRunStatus(detail, run) building RunFlowNode[] with { node, status?, approvalPending? }; TERMINAL_RUN_STATUSES = completed|failed|cancelled.
- apps/dashboard/src/run/RunNodeView.tsx — read-only node renderer with data-status driven styling (.hw-node--run).
- apps/dashboard/src/run/RunInspector.tsx — loads run + workflow, polls getRun every 2s while !isTerminalRun, Cancel/Retry actions, telemetry detail.
- apps/dashboard/src/api/client.ts — WorkflowsApi: runWorkflow(id, options?) -> { run_id, status }; getRun(id) -> RunState { status: created|running|waiting|completed|failed|cancelled, nodes: Record<nodeId, NodeRunState { status: pending|scheduled|running|waiting_for_review|completed|failed|skipped|cancelled, ... }> }.
- dashboard/plugin_api.py — POST /workflows/{id}/run raises 404 (unknown), 409 (workflow disabled / scripts gate); the run advances asynchronously via the engine tick cron after start; GET /runs/{run_id} returns full run state.
- apps/dashboard/tests/*.test.tsx — existing component tests with a mocked WorkflowsApi, happy-dom, fake timers in some suites.

Conventions:
- Comments explain WHY, dense file-top docblocks describing the module's role.
- Pure helpers extracted into React-free modules so they unit-test without DOM (graphMapping.ts, runView.ts pattern).
- Shared UI kit in src/ui/components (Button, Menu, Modal, Badge); icons in src/ui/icons.
- Status colours / labels live in single Records (STATUS_COLORS, NODE_TYPE_LABEL) — no scattered literals.
- Errors are surfaced in the UI (save status label shows "Save failed: <message>"); the project owner explicitly forbids silent no-op fallbacks and stubs: an error must be visibly shown, never swallowed.
- Tests: bun test with @testing-library/react; client injected via props.
- oxfmt + oxlint must pass before every commit.

Constraints:
- Do not change existing public API routes; the existing POST /workflows/{id}/run and GET /runs/{run_id} are sufficient.
- No new external dependencies.
- SOLID / KISS / DRY; extract repeated literals into constants; reuse runView.ts helpers instead of duplicating status mapping.
- The editor stays editable when no run is playing; consider what happens to editing while a run plays (dirty state, node clicks).
- A workflow with a human_review node parks the run in `waiting` (node `waiting_for_review`) — it may never reach a terminal state on its own; the editor has no review controls but the run inspector does. Decide how the play flow handles this.
- An unsaved (dirty) editor would run the stale on-disk spec — decide how the play flow treats a dirty editor.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.

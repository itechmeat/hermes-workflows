# Editor play button — run with live node progress, then redirect to the run

**Status:** accepted
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

The workflow editor page (`#editor/<id>`, FlowEditor) cannot execute the
workflow being edited. The operator has to leave the editor to start a run and
gets no canvas feedback while the run plays — node progress is only visible by
manually opening the run inspector. The feature adds a Play button that runs
the current workflow, shows live per-node progress on the editor canvas, and
redirects to the run inspector once the run has fully played.

## Scope

- A Play button in the FlowEditor header actions, next to Save.
- Save-before-play gate: a dirty editor is saved first; a failed save aborts
  the start with the existing visible save error.
- Playback mode: while a run is in flight the canvas switches to the read-only
  run pipeline — `applyRunStatus` building `RunFlowNode[]` rendered by
  `RunNodeView` — so running / completed / failed nodes look exactly like the
  run inspector. Editing affordances (add node, save, duplicate, node clicks,
  drag, connect, delete keys) are disabled for the duration.
- A shared `useRunPolling` hook (extracted from RunInspector's poll loop,
  adopted by both RunInspector and the playback mode) polls `GET /runs/{id}`
  every 2 s while the run is active.
- Redirect: when the run reaches a terminal status (`completed` / `failed` /
  `cancelled`) — or parks in `waiting` (human review; the editor has no review
  controls, the inspector does) — the dashboard navigates to `#run/<run_id>`.
- Explicit errors: a rejected start (404 / 409 disabled workflow / scripts
  gate) and a failed poll surface a visible error message in the editor header
  status area. No silent fallbacks, no swallowed errors.
- Unit tests for the start → poll → redirect flow and every error path, with
  the existing mocked `WorkflowsApi` pattern.

## Out of scope

- Cancel / retry from the editor — the run inspector already owns those and
  the flow redirects there.
- Live telemetry detail on the editor canvas (inspector-only).
- Any backend change: `POST /workflows/{id}/run` and `GET /runs/{run_id}`
  are sufficient as shipped.
- A global "run in progress" indicator across dashboard views (variant 3
  territory).

## Chosen approach

Variant 2 from `variants.md` — playback mode that swaps to the run-view
pipeline. Pressing Play (after the save-if-dirty gate) calls
`client.runWorkflow(id)`, stores the returned `run_id`, and flips FlowEditor
into a read-only playing state. While playing, the canvas renders the same
read-only graph the run inspector renders (`applyRunStatus` + `RunNodeView`),
fed by a `useRunPolling` hook shared with RunInspector. When polling observes
a redirect-worthy status (terminal or `waiting`), FlowEditor calls the new
`onOpenRun(runId)` prop and App navigates to the inspector.

## Design decisions

- **Reuse the run pipeline instead of tinting editable nodes.** The project
  already ships the status mapping (`runView.ts`) and the status-styled node
  renderer (`RunNodeView`); rendering playback with them is the DRY move and
  keeps one source of truth for status colours and badges.
- **Stable node-type registry.** ReactFlow warns when the `nodeTypes` object
  identity changes between renders. Both renderers are registered once in one
  module-level registry keyed by distinct type constants (`WORKFLOW_NODE_TYPE`
  → editable view, run node type → `RunNodeView`); playback remaps node
  `type`, never the registry object.
- **Save-before-play, not run-the-stale-spec.** Running a dirty editor's
  on-disk spec would silently execute something other than what the operator
  sees — a misleading fallback, which the project forbids. Play saves first
  through the existing `ctrl.save()` path; its failure already surfaces in the
  status label and the run does not start.
- **Redirect on `waiting`, not only on terminal.** A `human_review` node parks
  the run in `waiting` indefinitely; the editor has no review controls. The
  inspector does, so the flow hands over instead of stalling the operator on a
  canvas that can never finish. (`created` / `running` keep playing.)
- **Poll errors stay visible but do not kill playback.** A failed poll writes
  an explicit error message into the playback status (no `.catch(() => {})`);
  the next successful poll clears it. Stopping playback on a transient blip
  would discard a healthy run — also a misleading failure mode.
- **Errors render in the header status area** — the same place save errors
  already live (`statusLabel` pattern), so failure UX is consistent.
- **`useRunPolling` is extracted, RunInspector adopts it.** Touching working
  inspector code is the accepted cost of not having two poll loops; the
  existing inspector tests pin its behavior.

## File changes

New:
- `apps/dashboard/src/run/useRunPolling.ts` — shared active-run poll hook
  (load + interval + stop-on-terminal + explicit poll-error state).
- `apps/dashboard/src/editor/useRunPlayback.ts` — start → poll → settle state
  machine for the editor (idle / starting / playing + run state + error).
- `apps/dashboard/tests/editor-playback.test.tsx` — feature tests.

Modified:
- `apps/dashboard/src/editor/FlowEditor.tsx` — Play action, playing mode
  (read-only canvas via run pipeline), error surfacing, `onOpenRun` prop.
- `apps/dashboard/src/run/runView.ts` — run node type constant, the shared
  node-type registry, and the pure redirect predicate (`shouldHandOff`);
  stays a React-light, unit-tested module.
- `apps/dashboard/src/run/RunInspector.tsx` — adopt `useRunPolling`.
- `apps/dashboard/src/App.tsx` — pass `onOpenRun` through `EditorLoader` to
  FlowEditor.
- `apps/dashboard/tests/run-inspector.test.tsx` — keep green over the hook
  extraction (adjust only if the public behavior surface moved).
- `dashboard/dist/*` — rebuilt bundle (committed, checked by
  `dashboard:check`).
- `README.md`, `CHANGELOG.md`, `docs/dashboard.md` — document the capability.

## Risks and open questions

- **ReactFlow renderer swap.** The riskiest piece per the consultant; the
  stable-registry decision above de-risks it. Verified by a feature test that
  asserts run-status rendering appears while playing.
- **Redirect-on-`waiting` timing.** The run may already be `waiting` in the
  `POST /run` response (fast review-only workflows) — the playback hook must
  evaluate the start response with the same redirect predicate as poll
  results, or the editor would stall before the first poll.
- **Run start latency.** Between click and `run_id` arriving the button shows
  a starting state and stays disabled — double-start is prevented by state,
  not by debouncing.
- **Editor unmount mid-run.** Navigating away while playing must stop the
  poll loop (interval cleanup in the hook), same as RunInspector today.

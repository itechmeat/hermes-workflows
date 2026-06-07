### Variant 1: Co-located playback hook in FlowEditor
- **Approach**: Add a `useRunPlayback` hook living next to `useFlowEditor` that owns the active `run_id`, the 2s poll loop, and an error string. The hook calls `runWorkflow` then polls `getRun`, and FlowEditor injects per-node status into the existing editable `WorkflowNodeData` (reusing `applyRunStatus` + `statusColor` from `runView.ts`) so the current `WorkflowNodeView` renders a status tint. On terminal status it calls `onBack`-style navigation to `#run/<id>`.
- **Trade-offs**:
  - Pro: smallest blast radius — one new hook, no change to App routing or node-type registry.
  - Pro: reuses `runView.ts` pure helpers directly (DRY on the mapping logic).
  - Con: status overlay is grafted onto the *editable* node renderer, so `RunNodeView`'s `.hw-node--run` styling must be partly duplicated or conditionally applied — weaker reuse of the run-view *rendering*.
  - Con: editing-lock and dirty handling are ad-hoc flags inside FlowEditor; easy to get inconsistent (e.g. node drag while polling).
- **Complexity**: medium
- **Risk**: low

### Variant 2: Playback mode that swaps to the run-view pipeline
- **Approach**: FlowEditor gains an explicit `playing` mode; pressing Play (after a save-if-dirty gate) starts the run and flips the canvas from the editable `WorkflowNodeView` pipeline to the read-only run pipeline — `applyRunStatus` building `RunFlowNode[]` rendered by `RunNodeView`, exactly as RunInspector does. The poll loop is factored into a shared `useRunPolling` hook adopted by both RunInspector and the editor, and terminal status triggers redirect to `#run/<id>`.
- **Trade-offs**:
  - Pro: maximal DRY — the same `applyRunStatus` + `RunNodeView` + polling hook serve both surfaces; no duplicated status styling.
  - Pro: editing-while-running is solved by construction — playback mode is read-only, so dirty/click concerns vanish during a run.
  - Pro: a parked `waiting` run naturally shows the same waiting affordance RunInspector uses; an explicit "open inspector" link covers the never-terminal case.
  - Con: requires a node-renderer/type swap inside one ReactFlow instance (or remount), which is fiddly and the riskiest piece.
  - Con: refactoring RunInspector onto the shared polling hook touches working observability code (#14).
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Lift run orchestration into App
- **Approach**: App.tsx becomes the owner of an "active playing run" — it holds `run_id`, runs the poll loop, and centralizes the terminal redirect, passing `runState` down as a prop to both FlowEditor (overlay) and the run inspector. Play in the editor just asks App to begin a run for the current id; App drives navigation and error surfacing globally.
- **Trade-offs**:
  - Pro: single source of truth for run state; the start→poll→redirect flow lives in one place and could power a global "run in progress" indicator across views.
  - Pro: editor and inspector consume identical `runState`, so overlay and inspector can never diverge.
  - Con: largest change — widens App's responsibilities and the FlowEditor prop contract, against the current thin `go(view)` routing model.
  - Con: lifecycle bugs are more likely (poll surviving view changes, double-start, stale run on navigate-away); error surfacing must be threaded back down to the editor.
  - Con: harder to unit-test in isolation — the flow now spans App + editor rather than one mockable hook.
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 2
**Rationale**: It best satisfies the explicit DRY mandate — reusing `applyRunStatus`, `RunNodeView` styling, and a shared poll hook instead of regrafting status onto editable nodes (Variant 1) or rebuilding orchestration at the App level (Variant 3). Making playback a read-only mode cleanly resolves the editing-while-running, dirty-spec (save-before-play gate), and `waiting`/human-review constraints by construction, and the start-poll-redirect-and-error logic stays inside one hook that the existing mocked-`WorkflowsApi` test suite can drive directly.

# Editor play button — implementation plan

## Tasks

### Task 1: Shared run polling hook
- **Files**: `apps/dashboard/src/run/useRunPolling.ts` (new),
  `apps/dashboard/src/run/RunInspector.tsx`,
  `apps/dashboard/tests/run-inspector.test.tsx`
- **Acceptance**: RunInspector behavior is unchanged (existing inspector tests
  green) with its load + 2 s poll + stop-on-terminal loop served by the new
  hook; the hook exposes poll errors as state instead of swallowing them.
- **Depends on**: none

### Task 2: Playback view helpers (pure)
- **Files**: `apps/dashboard/src/run/runView.ts` (run node type constant,
  shared node-type registry, redirect predicate `shouldHandOff(status)`),
  `apps/dashboard/src/run/RunInspector.tsx` + `apps/dashboard/src/editor/FlowEditor.tsx`
  (consume the shared registry), unit tests beside the existing runView
  coverage
- **Acceptance**: a pure predicate returns true for `completed` / `failed` /
  `cancelled` / `waiting` and false for `created` / `running`; both canvases
  use one module-level nodeTypes registry (no per-render object identity).
- **Depends on**: none

### Task 3: useRunPlayback state machine
- **Files**: `apps/dashboard/src/editor/useRunPlayback.ts` (new),
  `apps/dashboard/tests/editor-playback.test.tsx` (new)
- **Acceptance**: tests drive a mocked `WorkflowsApi` through: start →
  `run_id` → polled states → hand-off callback fired exactly once on a
  redirect-worthy status (including when the start response itself is already
  redirect-worthy); start failure and poll failure produce explicit error
  state; unmount stops polling; double-start is impossible while not idle.
- **Depends on**: Task 1, Task 2

### Task 4: FlowEditor + App integration
- **Files**: `apps/dashboard/src/editor/FlowEditor.tsx`,
  `apps/dashboard/src/App.tsx`,
  `apps/dashboard/tests/editor-playback.test.tsx`
- **Acceptance**: feature tests show — Play with a dirty editor saves first
  (failed save aborts, error visible); while playing the canvas renders
  run-status nodes and editing actions are disabled; a redirect-worthy status
  navigates to the run inspector view; start/poll errors are visible in the
  header status area.
- **Depends on**: Task 3

### Task 5: Bundle + docs
- **Files**: `dashboard/dist/*` (rebuild), `README.md`, `CHANGELOG.md`,
  `docs/dashboard.md`
- **Acceptance**: `bun run validate` fully green (typecheck, lint, core +
  python + dashboard tests, dashboard build, `dashboard:check` clean diff);
  docs describe the play flow.
- **Depends on**: Task 4

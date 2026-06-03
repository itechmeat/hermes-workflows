# Pending command-approval surfacing — implementation plan

## Tasks

### Task 1: approval state in the recorder + observer callbacks
- **Files**: `hermes_workflows/telemetry.py`, `hermes_workflows/observer.py`,
  `tests/python/test_telemetry.py`, `tests/python/test_observer.py`
- **Acceptance**: `pre_approval_request` writes
  `approval = {state: "pending", command, description, surface, requested_at}`
  into the sidecar; `post_approval_response` flips it to
  `{state: "resolved", choice, resolved_at}` keeping command/description; both
  tolerate missing kwargs and never raise; both register only behind the
  `HERMES_KANBAN_TASK` gate.
- **Depends on**: observer-telemetry tasks 1–2 (recorder + registration)

### Task 2: schema member + inspector surfacing
- **Files**: `packages/core/src/schema/run.ts`,
  `apps/dashboard/src/run/RunInspector.tsx`,
  `apps/dashboard/src/run/runView.ts`, `apps/dashboard/src/run/RunNodeView.tsx`,
  `apps/dashboard/src/ui/theme.css`, dashboard tests
- **Acceptance**: an active node whose telemetry carries a pending approval
  shows the "waiting for command approval" annotation with the command text in
  the node detail and a badge on the node card; the annotation disappears when
  the overlay shows the approval resolved; a settled node with
  `choice: "deny"` or `"timeout"` shows that choice in the node detail
  (component tests cover all three states).
- **Depends on**: Task 1, observer-telemetry tasks 3–5 (persistence + overlay)

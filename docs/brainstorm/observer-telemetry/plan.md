# Per-node observer telemetry — implementation plan

## Tasks

### Task 1: telemetry sidecar module
- **Files**: `hermes_workflows/telemetry.py` (new), `hermes_workflows/config.py`
  (`telemetry_dir()`), `tests/python/test_telemetry.py` (new)
- **Acceptance**: recorder accumulates api/tool/subagent/error events into the
  `NodeTelemetry` aggregate shape and atomically persists it; `load_node_telemetry`
  returns the aggregate, `None` for missing/corrupt files (fail-open);
  `clear_node_telemetry` unlinks idempotently. All proven by unit tests using a
  tmp dir.
- **Depends on**: none

### Task 2: observer hook callbacks + registration gate
- **Files**: `hermes_workflows/observer.py` (new), `hermes_workflows/plugin.py`,
  `tests/python/test_observer.py` (new), `tests/python/test_register.py`
- **Acceptance**: with `HERMES_KANBAN_TASK` set, `register(ctx)` registers
  `post_api_request`, `post_tool_call`, `api_request_error`, `subagent_stop`;
  without it, none are registered. Callbacks tolerate arbitrary/missing kwargs
  (v0.15.1 and v1 payload shapes both tested) and never raise (fail-open test
  with an unwritable directory).
- **Depends on**: Task 1

### Task 3: core schema + persistence round-trip
- **Files**: `packages/core/src/schema/run.ts`,
  `packages/core/src/runtime/db/{schema,connection,runRepository}.ts`,
  `packages/core/tests/` (run repository tests)
- **Acceptance**: `NodeRunState.telemetry` survives save → load; a pre-existing
  runs.db without `telemetry_json` is migrated idempotently; `RunSummary`
  carries `total_tokens` summed over node telemetry; old rows (NULL column)
  load with `telemetry` absent.
- **Depends on**: none

### Task 4: engine merge at settle + cleanup
- **Files**: `hermes_workflows/engine.py`, `tests/python/test_engine_telemetry.py` (new)
- **Acceptance**: a node whose card settles with a sidecar present gets
  `node["telemetry"]` persisted (visible via `engine.status`); the sidecar file
  is removed after the save; a missing or corrupt sidecar leaves the node
  without telemetry and the run advances normally (fail-open).
- **Depends on**: Tasks 1, 3

### Task 5: dashboard live overlay + UI
- **Files**: `dashboard/plugin_api.py`, `tests/python/test_dashboard_api.py`,
  `apps/dashboard/src/api/types.ts`, `apps/dashboard/src/run/RunInspector.tsx`,
  `apps/dashboard/src/run/runView.ts` (if needed),
  `apps/dashboard/src/pages/RunsPage.tsx`, dashboard tests
- **Acceptance**: `GET /runs/{id}` attaches sidecar telemetry to active nodes
  (route test with a seeded sidecar); the inspector node detail renders
  duration, tokens, API calls, tool calls, error type/message when present
  (component test); the Runs page shows the total-tokens figure when the
  summary carries one.
- **Depends on**: Tasks 1, 3, 4

# Per-run JSONL trace — implementation plan

## Tasks

### Task 1: trace writer module + config knob
- **Files**: `hermes_workflows/trace.py` (new), `hermes_workflows/config.py`
  (`traces_dir()`, `trace_enabled()`, `observability` settings group),
  `tests/python/test_trace.py` (new), `tests/python/test_settings_config.py`
- **Acceptance**: `TraceWriter.emit` appends one self-describing JSON line per
  call (ts, run_id, kind, node_id when given, payload); a write failure
  (read-only dir) is swallowed with a stderr note; the new setting appears in
  `settings()` / `settings_schema()` with default `False`.
- **Depends on**: none

### Task 2: engine instrumentation
- **Files**: `hermes_workflows/engine.py`, `hermes_workflows/cli.py`,
  `tests/python/test_engine_trace.py` (new)
- **Acceptance**: with a writer injected, a full run (run → settle → advance →
  finish) produces a timeline covering run_created, node_scheduled, node
  status transitions, node_settled with outcome, review_decided, run_status,
  and marker events; with `trace=None` (default) the traces dir is never
  created and no trace I/O happens (asserted); a writer that raises does not
  affect run advancement.
- **Depends on**: Task 1

### Task 3: export integration
- **Files**: `dashboard/plugin_api.py`, `apps/dashboard/src/api/types.ts`,
  `apps/dashboard/src/pages/RunsPage.tsx`,
  `tests/python/test_dashboard_run_routes.py`, `apps/dashboard/tests/runs-page.test.tsx`
- **Acceptance**: export of a traced run returns `trace` + `trace_filename` in
  the envelope and the Runs page saves both files; export of an untraced run
  returns exactly today's envelope and the page behaves as before.
- **Depends on**: Task 1

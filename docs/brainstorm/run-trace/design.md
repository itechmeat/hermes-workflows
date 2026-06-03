# Per-run JSONL trace — centralized tracer in the advance tick

**Status:** accepted
**Author:** Sol Aitken (via feature-release-playbook)
**Audience:** implementation

## Problem statement

A run's history is reconstructed from run-state snapshots; there is no
append-only timeline of what happened when. Debugging a multi-tick run (loop
re-entries, stalled reviews, queue waits) requires correlating runs.db state
with Hermes gateway logs by hand. The Runs view's export-logs action exports
only the final state bundle.

## Scope

- An opt-in trace writer in the Python orchestrator: one append-only JSONL file
  per run at `<hermes_home>/workflows/traces/<run_id>.jsonl`.
- Event coverage: run created, run status transitions, node status transitions
  (with `seq`), settled completions (with outcome), nodes scheduled (with the
  executor handle), review decisions, notification/memory lifecycle markers.
- A `trace_enabled` setting (new `observability` group in `SETTINGS_SCHEMA`,
  default off, enforced) surfacing automatically on the Settings page.
- Export integration: `GET /runs/{run_id}/export` adds the trace to the
  envelope when present; the Runs page downloads it as a second
  `<run_id>.trace.jsonl` file alongside the state JSON.

## Out of scope

- Tracing inside worker processes (the telemetry sidecar task covers per-node
  agent activity; its aggregate lands on the node and is visible in the
  exported state).
- Rotation/retention of trace files (opt-in feature; the operator owns the dir).
- A trace viewer UI.

## Chosen approach

Variant 1 of the consultant round (see `variants.md`): a centralized post-hoc
tracer. `Engine._advance_step` snapshots the run before mutation and calls one
`_emit_trace(prior, completions, decision, run)` at the end, deriving events by
diffing prior vs post state — the same shape as the existing `_emit_lifecycle`
and `_emit_memory` siblings, including their fail-open discipline. Two
additional single-line emits cover what a diff cannot see: `run_created` (in
`Engine.run`) and `review_decided` (in `Engine.decide_review`, which records
the decision before the advance step runs and would otherwise be invisible to
the prior-vs-post diff).

## Design decisions

- **One writer module, `hermes_workflows/trace.py`.** A small `TraceWriter`
  bound to the traces dir with `emit(run_id, kind, node_id=None, **payload)`;
  disabled mode is a `None` writer on the engine (no object, no I/O, one `if`).
  The engine receives it from `build_engine()` the same way it receives the
  sender and memory settings (dependency injection keeps the engine testable).
- **Zero I/O when disabled (the default).** `build_engine` passes `trace=None`
  unless `observability.trace_enabled` resolves true; every emit site guards on
  `self.trace is None` first.
- **Append-only with `O_APPEND` line writes.** One `json.dumps` line per event:
  `{ts, run_id, kind, node_id?, ...payload}`. `ts` is `time.time()`; lines are
  self-describing per the task contract.
- **Fail-open.** The writer catches every exception, prints one stderr line
  (same pattern as `_notify` failures) and keeps going; acceptance includes a
  read-only-dir test proving the run still advances.
- **Diff-derived events, observed completions.** Node transitions come from
  comparing prior node statuses to post-decision statuses; settled completions
  are emitted from the ingest loop where outcome/output are in scope, so the
  trace shows both "what the executor reported" and "what the engine decided".
- **Notification markers ride the `notified` diff.** New markers appearing in
  `run["notified"]` after the lifecycle/memory emits become `marker` events —
  no instrumentation inside `_emit_lifecycle`/`_emit_memory`.
- **Export keeps both artifacts.** The export envelope gains optional
  `trace` / `trace_filename` fields. The Runs page keeps downloading the state
  JSON and additionally saves the trace file when the fields are present —
  falling back to exactly today's behavior otherwise (additive contract; the
  envelope stays JSON for the host's fetchJSON channel).

## File changes

New:
- `hermes_workflows/trace.py`
- `tests/python/test_trace.py`, `tests/python/test_engine_trace.py`

Modified:
- `hermes_workflows/config.py` — `traces_dir()`, `trace_enabled()`,
  `observability` settings group.
- `hermes_workflows/engine.py` — `trace` constructor param, `_emit_trace`,
  `run_created` / `review_decided` emits.
- `hermes_workflows/cli.py` — `build_engine` wires the writer when enabled.
- `dashboard/plugin_api.py` — export route attaches the trace.
- `apps/dashboard/src/api/types.ts` — optional `trace` / `trace_filename` on
  `ExportedRun`.
- `apps/dashboard/src/pages/RunsPage.tsx` — download the second file when present.
- `tests/python/test_dashboard_run_routes.py`, dashboard runs-page test.

## Risks and open questions

- **Intra-tick ordering is synthesized** (emit order, not capture order) — the
  consultant flagged this; acceptable for a debugging timeline whose unit of
  resolution is the tick.
- **Settings dependency in worker-less contexts**: `trace_enabled()` resolves
  through the Hermes config loader, which is already import-guarded in
  `config.py` (`_stored_settings` returns `{}` without `hermes_cli`).
- **Inline drain** (`default_mode=direct`) emits one trace block per drained
  step because `_advance_step` is the loop body — correct and desirable.

# Runs Page — Implementation Plan

NOT started — planning only; awaits operator go-ahead to implement.

TDD throughout. Backend uses pytest (`importorskip("fastapi")`). Frontend uses
Vitest + jsdom + RTL with the API client injected. After each task the frontend
`validate` and the root `bun run validate` stay green. Each task is one atomic
conventional commit on `feat/runs-page`.

## Task A1: List route — all runs with the page fields
- `dashboard/plugin_api.py`: `GET /runs` gains a `scope` query (`active` default,
  `all`). Map each run to `{run_id, workflow_id, project_id, status,
  current_node, started_at, finished_at, duration}` from `RunState` + `RunMeta`.
- **Acceptance**: pytest — `scope=active` unchanged (back-compat); `scope=all`
  returns finished + active runs with every field; duration computed; empty list
  when no runs.
- **Depends on**: none.

## Task A2: Export-logs route
- `GET /runs/{id}/export`: return the full run-load bundle (run + per-node detail,
  incl. Hermes task ids) as a JSON download envelope `{filename, run_id, json}`;
  `404` if absent.
- **Acceptance**: pytest — export of an existing run returns the bundle and a
  `<run_id>.run.json` filename; missing run → `404`.
- **Depends on**: none.

## Task A3: API client + types
- `api/client.ts`: `listRuns(scope?: "active" | "all")` (default active),
  `exportRunLogs(id)`. `api/types.ts`: a `RunListItem` with the page fields and
  an `ExportedRun` envelope.
- **Acceptance**: client builds the right URL/query/verb and parses responses
  against a mocked fetch layer.
- **Depends on**: A1, A2.

## Task A4: RunsPage UI + shell wiring
- `pages/RunsPage.tsx`: table (host DS + `hw-` styles) with the TZ columns and
  row actions — Open (inspector), Cancel, Retry failed node, Retry whole run,
  Export logs (download). `App.tsx`: a Runs nav entry/view; Open routes to the
  existing inspector.
- **Acceptance**: Vitest — renders a row per run; Open navigates to the inspector;
  Cancel/Retry call the existing client methods; Export triggers a download
  (stubbed `downloadTextFile` / `URL.createObjectURL`).
- **Depends on**: A3.

## Task A5: Build wiring, docs, CHANGELOG
- Rebuild + commit `dashboard/dist`; update README + `docs/dashboard.md`; add a
  CHANGELOG entry under the existing version header (no version bump).
- **Acceptance**: `bun run validate` green incl. the committed-bundle guard.
- **Depends on**: A1–A4.

## Verification (phase 4 QA)
- Backend pytest green (list scopes + export + 404).
- Frontend typecheck, lint, vitest, build green; committed bundle matches.
- Smoke (in tests): list → Open → inspector; Cancel; Retry; Export.

## Notes
- Operator gate: implementation begins only on explicit go-ahead.
- Version stays 0.1.0 until the operator bumps it. No auto-merge armed.

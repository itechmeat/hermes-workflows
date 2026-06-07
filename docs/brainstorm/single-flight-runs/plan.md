# Single-flight workflow runs — implementation plan

## Tasks

### Task 1: Core guard — `ActiveRunExistsError` on create
- **Files**: `packages/core/src/runtime/db/runRepository.ts`,
  `packages/core/src/cli/commands.ts`, `packages/core/src/index.ts` (export),
  core tests (`packages/core/tests/run-repository.test.ts` or the existing
  run-store suite).
- **Acceptance**: failing-first tests pass — creating a run while the same
  workflow has an active run (`created`/`running`/`waiting`) throws
  `ActiveRunExistsError` naming the active run id; creating after the sibling
  settles (or for a different workflow) succeeds; the check+insert happens in
  one immediate transaction (test with two connections to one db file).
- **Depends on**: none.

### Task 2: Core guard — retry revival + summary workflow filter
- **Files**: `packages/core/src/cli/commands.ts` (`cmdRunRetry`,
  `cmdRunListSummary`), `packages/core/src/cli.ts` (`--workflow` flag),
  `packages/core/src/runtime/db/runRepository.ts` (`listRunSummaries` filter),
  core tests.
- **Acceptance**: retrying a settled run while another run of the same workflow
  is active throws `ActiveRunExistsError` (whole-run and node retry); retrying
  with no active sibling works as before; `run-list-summary --workflow X
  --active` returns only X's active runs, newest `started_at` first.
- **Depends on**: Task 1.

### Task 3: Python surface — 409 mappings, runs filter, clean CLI error
- **Files**: `dashboard/plugin_api.py`, `hermes_workflows/cli.py`,
  `tests/python/test_dashboard_run_routes.py`, `tests/python/test_py_cli.py`.
- **Acceptance**: starting a workflow that already has an active run returns
  `409` whose detail names the active run id; `POST /runs/{id}/retry` returns
  `409` in the same situation; `GET /runs?scope=active&workflow_id=X` filters;
  the CLI `run` command exits with the clean message, no traceback.
- **Depends on**: Tasks 1–2.

### Task 4: Frontend — editor attaches to the active run
- **Files**: `apps/dashboard/src/api/client.ts`,
  `apps/dashboard/src/editor/useRunPlayback.ts`,
  `apps/dashboard/src/editor/FlowEditor.tsx`,
  `apps/dashboard/tests/editor-playback.test.tsx`,
  `apps/dashboard/tests/api-client.test.ts` (or the existing client suite).
- **Acceptance**: failing-first RTL tests pass — mounting the editor while the
  workflow has an active run enters playback (statuses shown, editing locked,
  Play shows `Running…`) without any Play click and hands off when the run
  settles; mounting with no active run leaves Play idle; the attach query
  failure surfaces in the alert slot; a failed Play start re-checks and
  attaches when a concurrent run exists while still showing the start error;
  Play is disabled until the mount check lands.
- **Depends on**: Task 3 (route filter shape).

### Task 5: Docs + full QA + live smoke
- **Files**: `docs/dashboard.md`, `README.md` (if applicable), `CHANGELOG.md`
  — none exists yet, skip; no release per operator.
- **Acceptance**: `bun run validate` fully green (core tests, pytest, dashboard
  typecheck/tests/build, dist diff); live smoke on the running dashboard:
  second Play on an in-flight workflow returns 409 with the run id, re-opening
  the editor during a run shows live statuses and locked editing.
- **Depends on**: Tasks 1–4.

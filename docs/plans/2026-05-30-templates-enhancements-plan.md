# Templates Page Enhancements — Implementation Plan

NOT started — planning only; awaits operator go-ahead to implement.

TDD throughout. Core uses `bun test`; backend uses pytest
(`importorskip("fastapi")`); frontend uses Vitest + jsdom + RTL with the client
injected. After each task the relevant `validate` stays green (oxlint zero
warnings; committed bundle matches). Each task is one atomic conventional commit
on `feat/templates-enhancements`.

## Task T1: Core `enabled` field on the workflow spec
- `schema/workflow.ts`: add `enabled?: boolean`. `schema/load.ts`: parse it
  (reject non-boolean). `serialize/serializeWorkflow.ts`: emit it. Default is
  `true` (absent = enabled), so existing specs are unchanged.
- **Acceptance**: `bun test` — `parseWorkflow(serializeWorkflow(w))` round-trips
  `enabled`; an absent field reads as enabled; a non-boolean fails validation.
- **Depends on**: none.

## Task T2: Core latest-run-by-workflow aggregation
- `runtime/db/runRepository.ts`: `latestRunByWorkflow()` → map `workflow_id` →
  `{ run_id, status, started_at, finished_at }` (most recent by `started_at`,
  tie-broken deterministically). Add a `run-latest` CLI command.
- **Acceptance**: `bun test` — with several runs across workflows, each workflow
  maps to its most recent run; workflows with no run are absent from the map.
- **Depends on**: none.

## Task T3: Backend — list enrichment, toggle route, run gate
- `dashboard/plugin_api.py`: `GET /workflows` rows gain `enabled` (from the spec),
  `last_run_at` / `last_status` (from `run-latest`), `next_run_at` (from the cron
  bridge; null when no cron job). `PUT /workflows/{id}/enabled` (`{ enabled }`)
  writes `enabled` into the spec via spec-save and pauses/resumes the cron job
  when one exists. `POST /workflows/{id}/run` returns `409` when the workflow is
  disabled.
- **Acceptance**: pytest — list rows carry the four fields; toggling off then on
  flips the spec and (for a cron workflow) the cron job's enabled state; running a
  disabled workflow is `409`; enabling re-allows it.
- **Depends on**: T1, T2.

## Task T4: API client + types
- `api/client.ts`: `setWorkflowEnabled(id, enabled)`. `api/types.ts`:
  `WorkflowListItem` gains `enabled`, `last_run_at`, `last_status`, `next_run_at`.
- **Acceptance**: Vitest — the client builds the right URL/verb/body and parses
  the enriched list rows against a mocked fetch.
- **Depends on**: T3.

## Task T5: TemplatesPage UI — toggle + columns
- `pages/TemplatesPage.tsx`: add Last run / Last status / Next run columns and an
  Enable/Disable control per row (host DS + `hw-` styled). Toggling calls
  `setWorkflowEnabled` and refreshes; a disabled row is visually marked and its
  Run action disabled.
- **Acceptance**: Vitest — columns render from a mocked enriched list; toggling
  calls the client and refreshes; a disabled row disables Run.
- **Depends on**: T4.

## Task T6: Build wiring, docs, CHANGELOG
- Rebuild + commit `dashboard/dist`; update README + `docs/dashboard.md`; add a
  CHANGELOG entry under the existing version header (no bump).
- **Acceptance**: `bun run validate` green incl. the committed-bundle guard.
- **Depends on**: T1–T5.

## Verification (phase 4 QA)
- Core green (enabled round-trip, latest-run aggregation).
- Backend pytest green (enriched list, toggle + cron sync, disabled-run 409).
- Frontend typecheck, lint, vitest, build green; committed bundle matches.

## Notes
- Operator gate: implementation begins only on explicit go-ahead.
- Version stays 0.1.0 until the operator bumps it. No auto-merge armed.
- `enabled` lives on the spec (single source of truth); the cron job follows it
  via the existing pause/resume bridge — no parallel state store.

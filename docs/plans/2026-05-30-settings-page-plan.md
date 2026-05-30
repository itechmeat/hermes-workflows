# Settings Page — Implementation Plan

NOT started — planning only; awaits operator go-ahead to implement.

TDD throughout. Backend uses pytest (`importorskip("fastapi")`); frontend uses
Vitest + jsdom + RTL with the client injected. After each task the relevant
`validate` stays green. Each task is one atomic conventional commit on
`feat/settings-page`.

## Task C1: Settings source in `config.py` (Hermes config `plugins.workflows`)
- Add `SETTINGS_SCHEMA` (fields, types, options, defaults for storage/execution/
  kanban/open_second_brain) and `settings()` that reads `plugins.workflows.*`
  from the Hermes config with the existing env/default fallback (unset → today's
  behaviour).
- **Acceptance**: pytest — effective values resolve config ▸ env ▸ default; a
  written `plugins.workflows` value wins over env; defaults apply when unset.
- **Depends on**: none.

## Task C2: Backend routes
- `dashboard/plugin_api.py`: `GET /settings` → `{values, schema}`; `PUT /settings`
  validates against the schema and persists the `plugins.workflows` namespace via
  the host config write path (reused), returning new effective values; invalid →
  `400`.
- **Acceptance**: pytest — GET returns effective values + schema; PUT persists and
  re-reads; invalid value (bad enum / non-int) → `400`; other config untouched.
- **Depends on**: C1. (First confirms the host config write contract; falls back
  to a plugin-owned namespaced section if direct write is unavailable.)

## Task C3: API client + types
- `api/client.ts`: `getSettings()`, `saveSettings(values)`. `api/types.ts`:
  `WorkflowSettings` (grouped) + a `SettingsField`/`SettingsSchema` shape.
- **Acceptance**: client builds the right URLs/verbs/bodies against a mocked fetch;
  parses `{values, schema}`.
- **Depends on**: C2.

## Task C4: SettingsPage UI + shell wiring
- `pages/SettingsPage.tsx`: four grouped sections rendered from the schema with DS
  inputs/selects/checkboxes (`hw-` styled); load via `getSettings`, save via
  `saveSettings`; show saved + validation-error states; label not-yet-enforced
  knobs. `App.tsx`: a Settings nav entry/view.
- **Acceptance**: Vitest — renders all groups/fields from a mocked schema; editing
  + save posts the values; a validation error renders inline; not-enforced labels
  show.
- **Depends on**: C3.

## Task C5: Wire in-scope knobs into behaviour
- Make `config.py` consumers read from `settings()` where a consumer exists: O2B
  `mode`/`fail_open`/write-flags, default execution mode, internal board, deliver
  target. Persist+display the rest (`max_parallel_runs`,
  `default_timeout_seconds`, `use_workflow_columns`) and open a follow-up to
  enforce them.
- **Acceptance**: pytest — changing an enforced setting changes the corresponding
  behaviour (e.g. O2B mode `none` disables writes; default mode selects the
  executor); deferred knobs are documented as not-yet-enforced.
- **Depends on**: C1.

## Task C6: Build wiring, docs, CHANGELOG
- Rebuild + commit `dashboard/dist`; update README + `docs/dashboard.md` (Settings
  page + which knobs are enforced); CHANGELOG under the existing version header
  (no bump).
- **Acceptance**: `bun run validate` green incl. the committed-bundle guard.
- **Depends on**: C1–C5.

## Verification (phase 4 QA)
- Backend pytest green (settings read/write/validate + enforced-knob behaviour).
- Frontend typecheck, lint, vitest, build green; committed bundle matches.

## Notes
- Operator gate: implementation begins only on explicit go-ahead.
- Version stays 0.1.0 until the operator bumps it. No auto-merge armed.
- Settings live in the Hermes config `plugins.workflows` namespace — no bespoke
  settings store.

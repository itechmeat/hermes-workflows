# Settings Page — Design

Status: draft (brainstorm complete, Variant 1 chosen) — implementation NOT started
Author: orchestrator (via feature-release-playbook)
Audience: implementation

## Problem statement

The plugin's behaviour (storage paths, execution defaults, Kanban integration,
OpenSecondBrain mode) is fixed in code/env with no UI to view or change it
(TZ §20.10). This epic adds a Settings page backed by the **host's own config
mechanism**, not a new settings store.

## Hermes / existing reuse (audited first)

- **Hermes already has a config system**: a typed config (`config.yaml`) with a
  schema, defaults, and dashboard endpoints `GET /api/config`,
  `GET /api/config/schema`, `GET /api/config/defaults`, `PUT /api/config`, plus a
  `plugins:` section. Settings belong there, under a `plugins.workflows`
  namespace — reusing the host's read/write/validate path rather than inventing a
  store.
- **`config.py` already centralises** every knob the plugin reads (spec roots,
  `runs.db` path, runtime board, deliver target, runner dir). Today these read
  from env/defaults; this epic adds a config-namespace source with the same
  env/default fallback, so behaviour is unchanged when no settings are written.
- **Host design-system** components + the project's `hw-` theme tokens render the
  form. (The host's generic `AutoField`/config UI is not exposed to plugins, so
  the page renders its own grouped fields with the DS primitives.)

## Scope (TZ §20.10)

A Settings page exposing, grouped:

- **storage**: `global_workflows_path`, `runs_db_path`
- **execution**: `default_mode` (durable|direct), `max_parallel_runs`,
  `default_timeout_seconds`
- **kanban**: `use_workflow_columns` (auto|on|off), `internal_board`
- **open_second_brain**: `mode` (auto|open_second_brain|none), `fail_open`,
  `write_run_summaries`, `write_node_failures`, `write_node_events`

Read effective values (config ▸ env ▸ default) and persist edits to
`plugins.workflows` in the Hermes config.

## Out of scope (roadmap)

- Wiring *every* knob into runtime behaviour. This epic delivers the settings
  surface + persistence and wires the knobs that already have a consumption point
  (O2B mode/fail-open, default execution mode, internal board, deliver). Knobs
  without a current consumer (`max_parallel_runs`, `default_timeout_seconds`,
  `use_workflow_columns`) are persisted and displayed, with a follow-up to honour
  them in the engine. Each such knob is flagged in the UI as not-yet-enforced.
- Editing arbitrary Hermes config (only the `plugins.workflows` namespace).

## Chosen approach (Variant 1 — store in Hermes config `plugins.workflows`)

- **Settings source.** Add a `settings` accessor in `config.py` that reads
  `plugins.workflows.*` from the Hermes config with the existing env/default
  fallback chain, so unset settings keep today's behaviour. A small typed
  schema/defaults map defines the fields above.
- **Backend.** `GET /settings` returns `{values, schema}` (effective values +
  field metadata for rendering); `PUT /settings` validates and writes the
  `plugins.workflows` namespace via the host config write path (reused, not a new
  YAML writer), returning the new effective values. Invalid values → `400`.
- **Frontend.** A `SettingsPage` renders the four groups with DS inputs/selects/
  checkboxes (`hw-` styled), loads via `GET /settings`, saves via `PUT /settings`,
  shows a saved/again-disabled state and validation errors. A Settings nav entry.

## Design decisions

- **Reuse the host config store** (`plugins.workflows`) — no bespoke settings
  file, no second schema authority. `config.py` stays the single read point.
- **Effective-value semantics**: config ▸ env ▸ default, so the page never breaks
  existing env-driven deployments.
- **Honesty about enforcement**: knobs not yet consumed by the engine are clearly
  labelled, with a roadmap task to wire them — no silent no-ops.
- **English in the repo;** operator chat in Russian.

## Component / route map (target)

```
hermes_workflows/config.py
  + settings() : read plugins.workflows.* with env/default fallback
  + a typed SETTINGS_SCHEMA (fields, types, options, defaults)
dashboard/plugin_api.py
  + GET /settings   -> { values, schema }
  + PUT /settings   -> validate + write plugins.workflows; 400 on invalid
apps/dashboard/src/
  api/client.ts   + getSettings / saveSettings
  pages/SettingsPage.tsx  grouped form (storage/execution/kanban/o2b) + Settings nav
```

## Risks and open questions

- **Host config write API contract**: confirm whether the plugin can write a
  `plugins.workflows` subtree via the in-process config module or the
  `PUT /api/config` path, and that it round-trips/merges without clobbering other
  config. Resolve in the first backend task; if direct write is unavailable,
  fall back to a namespaced section the plugin owns.
- **Path settings safety**: `global_workflows_path` / `runs_db_path` changes move
  where specs/runs live; validate and surface clearly (no silent data move).
- **Which knobs are enforced now** vs deferred — finalise the list in the design
  review before implementation, so the UI labels are accurate.

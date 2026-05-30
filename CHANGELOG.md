# Changelog

All notable changes to Hermes Workflows are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 - 2026-05-30

The editor backend foundation plus the visual `@xyflow/react` editor and live
run inspector it drives.

### Added

- Typed, lenient `ui.xyflow` layout (node positions + viewport) on the workflow
  schema. A spec without `ui` still loads and runs; malformed layout is dropped.
- Zero-dependency workflow serializer. `parseWorkflow(serializeWorkflow(w, ui))`
  round-trips losslessly (YAML structure, scalars via `JSON.stringify`), so the
  project keeps no runtime dependencies.
- Spec write path in the core `SpecStore`: `getById`, `saveWorkflow` (validates
  before writing, so no invalid spec is persisted), `createWorkflow`,
  `deleteSpec`, and scope-based root routing (`chooseWriteRoot`).
- Core CLI subcommands `spec-get`, `spec-save`, `spec-create`, `spec-delete`.
- Run mutations `cancelRun` and `retryRun` (whole-run or one failed node), exposed
  as the `run-cancel` and `run-retry` CLI subcommands.
- Dashboard HTTP routes for the editor: `GET`/`PUT /workflows/{id}`,
  `POST /workflows/{id}/validate`, `.../compile-preview`, `.../run`,
  `GET /runs/{id}`, `POST /runs/{id}/cancel`, `POST /runs/{id}/retry`. Invalid
  graphs and id mismatches return `400`; missing workflows/runs return `404`;
  unexpected core failures return `500` (the core CLI emits a structured error
  kind the bridge maps to a status).
- Dashboard frontend (`apps/dashboard`, Vite + React 19 + `@xyflow/react`) built
  to a single committed bundle (`dashboard/dist/index.js` + `index.css`). It
  reuses the host's React via a shim (no second React ships) and bundles a
  pinned `react-dom` for `@xyflow/react`; the manifest's `css` entry loads the
  stylesheet.
- Visual editor: a flow canvas with a node palette, a per-type node inspector
  (agent_task profile/model/skills/prompt, human_review options, finish outcome),
  and validation + compile-preview panels. The layout round-trips losslessly
  through `ui.xyflow`, and Save persists `{ workflow, ui }`.
- Templates page (list, open, run) and a live run inspector that polls the run,
  colours nodes by status, and offers whole-run cancel/retry and per-node retry.
- Dashboard workflow authoring lifecycle: create a workflow from a modal
  (name/scope/trigger; the id is generated, not user-entered), seeded with a
  minimal valid graph and opened straight in the editor; duplicate under a new id;
  export the canonical YAML; and delete
  with confirmation. Backed by `POST /workflows` (refuse-overwrite; a clashing id
  is `409`, an invalid graph `400`), `DELETE /workflows/{id}` (`404` if absent),
  and `GET /workflows/{id}/export` (the on-disk YAML in a JSON envelope, so no
  second serializer ships to the browser). The core gains a distinct
  `SpecExistsError` so the bridge can map a duplicate id to `409`.
- Typed API client over the host `fetchJSON`, sharing spec/run/plan types from
  `@hermes-workflows/core` via type-only imports.
- Root `dashboard:*` scripts and a `bun run validate` that builds the frontend
  and guards that the committed `dashboard/dist` matches a fresh build.
- Runs page: lists every run (not just active) with run id, workflow, project,
  status, current node, started/finished, and duration, plus row actions Open
  (inspector), Cancel, Retry node, Retry run, and Export logs. Backed by
  `GET /runs?scope=active|all` (active stays the default for back-compat) and
  `GET /runs/{id}/export` (the full run-load bundle in a JSON envelope). A core
  `run-list-summary` command returns a flat `RunSummary` with timing meta and a
  derived current node; the existing `run-list` is unchanged.
- Schedules page: lists each workflow cron schedule (workflow, cron expression,
  timezone, enabled, last/next run, Hermes Cron ID) with row actions Pause,
  Resume, Run now, Edit (cron expression), and Delete. Backed by `GET /schedules`,
  `POST /schedules/{id}/pause|resume|run`, `PUT /schedules/{id}` (`400` on a bad
  cron), and `DELETE /schedules/{id}` (`404` if absent), all thin shells over the
  Hermes cron bridge — Hermes cron owns the schedules; the page edits the live
  job, not the on-disk spec.
- Settings page: a schema-driven form over storage / execution / kanban /
  open_second_brain, reading effective values (config ▸ env ▸ default) and
  persisting edits to the Hermes config `plugins.workflows` namespace via
  `GET`/`PUT /settings`. The `kanban.internal_board` setting is honoured by the
  runtime; other knobs are persisted and displayed but labelled not-yet-enforced
  pending engine wiring.

### Removed

- Dead `workflow_schedules` store in the core `RunRepository` (table, types, and
  the five schedule methods). It was referenced only by tests; Hermes cron is the
  single source of truth for workflow schedules.

### Fixed

- Production dashboard bundle loads under the host: `NODE_ENV` is inlined to
  `production` and the production JSX runtime is used, so the bundle no longer
  throws a `process is not defined` `ReferenceError` that prevented the plugin
  from calling `register()`.

### Security

- Workflow ids are validated against a slug charset, so an id can never escape
  the storage root via path traversal when written as `<root>/<id>.workflow.yaml`.
- Map keys (including user-controlled `agent_task.input_mapping` keys) are
  JSON-quoted on serialization, closing a YAML-injection / round-trip break.

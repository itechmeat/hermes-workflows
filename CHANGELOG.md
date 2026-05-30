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
- Typed API client over the host `fetchJSON`, sharing spec/run/plan types from
  `@hermes-workflows/core` via type-only imports.
- Root `dashboard:*` scripts and a `bun run validate` that builds the frontend
  and guards that the committed `dashboard/dist` matches a fresh build.

### Security

- Workflow ids are validated against a slug charset, so an id can never escape
  the storage root via path traversal when written as `<root>/<id>.workflow.yaml`.
- Map keys (including user-controlled `agent_task.input_mapping` keys) are
  JSON-quoted on serialization, closing a YAML-injection / round-trip break.

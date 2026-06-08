# Changelog

All notable changes to Hermes Workflows are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

A visual overhaul of the dashboard plugin on a shared component kit, richer
`agent_task` editing backed by live host data, run observability built on
the Hermes observer-hook contract — per-node agent telemetry, pending
command-approval surfacing, an opt-in per-run JSONL trace — and editor
playback: run the workflow you are editing and watch it play on the canvas.

### Added

- Inter-node data flow: an `agent_task` can consume a prior node's output by
  declaring `input_mapping: { <placeholder>: "{{nodes.<id>.output}}" }` and
  referencing `{{<placeholder>}}` in its prompt. The engine substitutes each
  placeholder with the referenced node's captured output at schedule time (one
  pass, for both the global and project backends), so a workflow passes data
  through the run state instead of a host file and stays fully exportable. The
  reference is validated when the workflow is authored — the source must be a
  prior (ancestor) node, and every declared placeholder must appear in the
  prompt — and an output that never materialised fails the node loudly rather
  than substituting empty text.
- Editor Play button: run the workflow straight from the editor page. A dirty
  graph is saved first (a failed save aborts the start); while the run plays,
  the editor canvas switches to the read-only run pipeline and shows live
  per-node status (running / completed / failed) at the editor's node
  positions with editing locked; when the run reaches a terminal status — or
  parks in `waiting` for a human review, which only the inspector can answer —
  the dashboard redirects to the run inspector. A rejected start or a failed
  poll is shown as a visible alert; a poll error clears on the next successful
  poll instead of killing playback. Both run surfaces now share one polling
  hook and one canvas node-type registry, and the run inspector reports poll
  and cancel/retry failures inline instead of swallowing them.
- Non-blocking run start: `POST /workflows/{id}/run` records the run, arms the
  advance tick, and drives the run from a background loop (advance every 2 s
  until it settles or parks for review), returning the created state
  immediately. Previously the route executed the first advance synchronously —
  for a global-scope `agent_task` that held the request open for the whole
  first node. The CLI `run` command and the dashboard route now both ensure
  the singleton tick cron while the run is active, so a multi-node run keeps
  advancing even with no schedule and no dashboard process alive.
- Truthful `running` status for global nodes: the Direct executor starts the
  profile runner in a background thread, marks the handle started, and the
  engine flips the node from `scheduled` to `running` while the agent works
  (the started marker also prevents a concurrent tick from double-starting
  the node). Running renders fixed blue and completed fixed green on the
  canvas — the theme's ring token rendered near-white, reading as no status.
- Per-node agent telemetry: observer hooks registered inside kanban worker
  processes aggregate API attempts, token usage, tool calls, subagents, and
  structured errors into a per-card sidecar; the engine folds it into
  `NodeRunState.telemetry` (new `telemetry_json` column, migrated in place)
  when the node settles, and `GET /runs/{id}` overlays the sidecar live while
  the node is still running. The run inspector's node detail renders the
  telemetry block; the Runs page gains a Tokens column from the per-run total.
- Pending command-approval surfacing: while a node's worker is blocked on a
  dangerous-command approval, the node card shows a waiting badge and the node
  detail names the command; a deny or timeout stays visible after the node
  settles so a subsequent failure has context. Observer-only — no change to
  the approval flow itself.
- Opt-in per-run JSONL trace (`observability.trace_enabled`, default off): the
  engine appends one self-describing line per event — run created, node
  scheduled/settled with outcome and seq, status transitions, review
  decisions, lifecycle markers — to `traces/<run_id>.jsonl`, and the Runs
  page export downloads the timeline as a second file when present. Disabled
  means zero trace I/O on the tick path; a write failure never affects a run.
- Plugin header with section navigation (Workflows / Runs / Schedules / Settings),
  an OpenSecondBrain connection indicator, and a portal slot the active view fills
  with its own title and actions.
- Hash-based routing: every view (including an open editor or run inspector) maps
  to a URL hash, so deep links, refresh, and browser back/forward work.
- Shared UI kit under `src/ui/components` (`Button`, `Badge`, `Field`, `Menu`,
  `Modal`, `PageHeader`) and an inline SVG icon set, with component tests.
- `GET /profiles` plugin route serving agent-profile names from the Hermes
  roster, and a model list read from the host model picker
  (`/api/model/options`); the node inspector offers both as select fields while
  preserving values not in the current roster/model list.

### Changed

- All dashboard styling moved to token-driven `hw-` classes in `theme.css`;
  no inline `style` objects remain.
- The editor adds nodes from a toolbar Add-node menu instead of a side palette,
  and a freshly added node opens directly in the inspector.
- The dashboard test suite runs test files sequentially with a 30s per-test
  timeout, so the in-suite bundle build cannot starve interaction tests on a
  loaded machine.

### Removed

- `NodePalette` component (superseded by the toolbar Add-node menu).

### Fixed

- `GET /o2b-status` now resolves the OpenSecondBrain CLI and config from the
  filesystem (home from the passwd database) instead of probing `o2b status`
  in a subprocess, which misreported "not connected" under the dashboard
  service's sanitized environment.

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
- Spec-level `enabled` flag (absent means enabled, so existing specs are
  unchanged) with an `isWorkflowEnabled` helper; non-boolean values are rejected
  at parse time. A core `run-latest` command and `latestRunByWorkflow` map each
  workflow to its most recent run.
- Templates page enable/disable: a Status badge plus Last run / Last status /
  Next run columns, and an Enable/Disable action per row. Backed by
  `PUT /workflows/{id}/enabled`, which writes the flag into the spec and
  pauses/resumes any cron job to match; a disabled workflow's Run action is
  disabled and `POST /workflows/{id}/run` returns `409`. The `GET /workflows`
  rows carry `enabled` and best-effort `last_run_at` / `last_status` /
  `next_run_at` columns.
- Editor node inspector exposes the full node field set: `description` on every
  node type, and for agent_task workdir, workspace type, max retries, timeout,
  and `input_mapping` (edited as key/value rows; a duplicate key is flagged and
  withheld so the saved spec never carries a collision). No schema change — the
  fields already existed in core.
- Editor canvas actions: **Duplicate node** (clone the selected node under a
  fresh id at an offset) and **Auto-layout** (a dependency-free layered layout
  that ranks nodes by longest forward distance, stacks branch siblings, trails
  disconnected nodes, and treats router loop-edges as back-edges). Both write
  through the existing save path and round-trip through `ui.xyflow`.
- `script` node type: a deterministic shell command run with no LLM (lint,
  tests, a build step) as a step in any workflow. `command` is required;
  `workdir`, `timeout_seconds`, and an `env` allowlist are optional. It settles
  `success`/`failure` by exit code, so existing `node_status` branching, the run
  inspector, retry, and cancel all apply unchanged. Scripts run locally in the
  plugin (a `ScriptExecutor` reusing the durable file-backed completion store)
  in any scope — the engine wraps the scope executor in a `CompositeExecutor`
  that routes by node kind. Security (TZ §25.2) is enforced: a workflow with
  script nodes runs only when `execution.scripts_enabled` is on, a script sees
  only the `execution.script_env_allowlist` env vars, runs in its `workdir`
  under a timeout, and its captured output is redacted. The editor offers the
  node in the palette/inspector and previews the compiled command before a run.
- Autonomous loop closed end to end. A run captures its chat `origin` (a
  `pre_gateway_dispatch` hook keyed by the gateway session, or a cron schedule's
  delivery target) and the engine delivers a single run-lifecycle notice on
  completed / failed / review-needed - through Hermes' native delivery to the
  origin or a configured default - while Kanban-backed cards are subscribed to
  their terminal events via the native notifier, so durable runs close the loop
  out-of-process. Notices are idempotent (persisted per-run markers) and
  fail-open (a delivery error never fails a run).
- Open Second Brain writes on lifecycle transitions: a `run_completed` event
  plus a terminal-run retrospective (the structured run summary - workflow,
  result, what happened, problems, follow-up) on a terminal run, one
  `node_failed` per failed node, and an optional `run_started` event. Writes route through the core
  memory provider via new `memory-event` / `memory-retro` CLI commands (the
  retrospective markdown is built in the core, not duplicated), gated by the now
  enforced `open_second_brain.{mode,write_run_summaries,write_node_failures,write_node_events}`
  settings, idempotent per event, and fail-open.
- Lightweight inline mode (TZ §18.2): when `execution.default_mode` is `direct`
  (or auto-eligible) the engine drains inline-eligible script-only steps
  synchronously within one call, so a script-only run finishes with no tick
  round-trip; a run that reaches an agent_task / human_review node parks it
  durably. `durable` keeps the unchanged one-step-per-tick behaviour. The
  `execution.default_mode` knob is now enforced.

### Removed

- Dead `workflow_schedules` store in the core `RunRepository` (table, types, and
  the five schedule methods). It was referenced only by tests; Hermes cron is the
  single source of truth for workflow schedules.

### Fixed

- Open Second Brain writes reach the real `o2b` CLI. The provider invoked
  `o2b brain note --kind … --title … --body …`, but the CLI takes a single
  positional `<text>` argument (with an optional `--agent`); the unsupported
  flags made every memory write a silent no-op (swallowed by fail-open). Writes
  now compose a one-line note (`[workflow:<kind>] <title> — <body>`, the
  retrospective markdown collapsed) tagged with `--agent hermes-workflows`, and
  the provider test asserts the real CLI contract.
- Production dashboard bundle loads under the host: `NODE_ENV` is inlined to
  `production` and the production JSX runtime is used, so the bundle no longer
  throws a `process is not defined` `ReferenceError` that prevented the plugin
  from calling `register()`.

### Security

- Workflow ids are validated against a slug charset, so an id can never escape
  the storage root via path traversal when written as `<root>/<id>.workflow.yaml`.
- Map keys (including user-controlled `agent_task.input_mapping` keys) are
  JSON-quoted on serialization, closing a YAML-injection / round-trip break.

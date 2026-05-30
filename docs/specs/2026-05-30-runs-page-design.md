# Runs Page — Design

Status: draft (brainstorm complete, Variant 1 chosen) — implementation NOT started
Author: orchestrator (via feature-release-playbook)
Audience: implementation
Builds on: the live run inspector (`docs/specs/2026-05-30-xyflow-editor-design.md`)

## Problem statement

The dashboard can start a run and open the run inspector, but only immediately
after starting it. There is no list of runs, so past or concurrent runs are
unreachable from the UI (TZ §20.7). This epic adds a Runs page that lists every
run and links each to the existing inspector.

## Hermes / existing reuse (audited first)

- **Run store already exists.** `RunRepository` + the `run-list` CLI subcommand
  return runs; without `--active` it returns *all* runs. `RunMeta`
  (`started_at`, `finished_at`, `error`) is already persisted.
- **Inspector, cancel, retry already exist.** `GET /runs/{id}`,
  `POST /runs/{id}/cancel`, `POST /runs/{id}/retry` (whole run or one node) ship
  already; the page reuses them for Open / Cancel / Retry.
- **Host design system** (Card/Table/Badge/Button) + the project's `hw-` theme
  tokens style the list — no new styling system.

So the only genuinely new surface is: an all-runs list route (currently
`GET /runs` returns active-only), a per-run **export logs** route, and the page
UI + navigation.

## Scope (TZ §20.7)

- A **Runs page**: one row per run with `Run ID`, `Workflow`, `Project`,
  `Status`, `Current node`, `Started`, `Finished`, `Duration`.
- Row actions: **Open** (inspector), **Cancel**, **Retry failed node**,
  **Retry whole run**, **Export logs**.
- Backend: `GET /runs?scope=all` (all runs with the listed fields) and
  `GET /runs/{id}/export` (a downloadable log/state bundle). Cancel/retry reuse
  existing routes.

## Out of scope

- Server-side pagination / search (the run set is small for one operator; revisit
  when a run-count threshold makes the flat list slow).
- Live auto-refresh of the list (the inspector already polls a single run; the
  list refreshes on demand / on navigation).
- Script-node stdout/stderr in the export (depends on the script node epic).

## Chosen approach (Variant 1 — extend `GET /runs`, reuse inspector)

- **Backend.** Generalise the list route: `GET /runs` gains a `scope` query
  (`active` default for backward compatibility, `all` for the page). It maps each
  run to the TZ fields by reading `RunState` + `RunMeta` (current node = the
  running/last-advanced node from the graph state; duration = `finished_at -
  started_at`). The core `run-list` already returns the rows; the bridge shapes
  them. `GET /runs/{id}/export` returns the full run state + per-node detail as a
  downloadable JSON bundle (the inspector already loads this shape via
  `run-load`).
- **Frontend.** A `RunsPage` lists runs (host DS table + `hw-` styles), each row
  wired to the existing client methods: Open → inspector view, Cancel →
  `cancelRun`, Retry node / Retry run → `retryRun`, Export → download via the
  existing `downloadTextFile` helper. The shell gains a Runs nav entry.

## Design decisions

- **One list route, a query flag** — not a second route — so active-only callers
  are unchanged and the page just asks for `scope=all`.
- **Export = the existing run-load shape**, streamed as JSON. No new serializer;
  the inspector and the export read the same core output.
- **Reuse cancel/retry** verbatim; the page is new wiring over an existing API.
- **English in the repo;** operator chat in Russian.

## Component / route map (target)

```
dashboard/plugin_api.py
  ~ GET /runs?scope=active|all      -> run-list (active flag), shaped to TZ fields
  + GET /runs/{id}/export           -> run-load bundle as a JSON download
apps/dashboard/src/
  api/client.ts   + listRuns(scope?) , exportRunLogs(id)
  pages/RunsPage.tsx  table + row actions (Open/Cancel/Retry/Export)
  App.tsx         + Runs nav entry and view
```

## Risks and open questions

- **Current node** derivation: confirm the run state exposes the active/last node
  cleanly; if not, derive from node statuses in the bridge.
- **Export content** for Kanban-backed nodes: include the Hermes task id (already
  in node detail); script-node logs are deferred to the script-node epic.

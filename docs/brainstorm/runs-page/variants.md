# Brainstorm — Runs page (TZ §20.7)

Phase 0 of the feature-release-playbook. CLI consultants (`claude -p`,
`codex exec`) were not run this round (same harness constraints as prior epics);
an in-process orchestrator pass produced the variants. The orchestrator decides.

## Hermes / existing reuse audit

- `run-list` CLI returns all runs (drop `--active`); `RunMeta` already persists
  started/finished/error. Inspector, cancel, retry routes already exist. Host DS
  + `hw-` tokens style the table. The page is mostly new wiring over an existing
  API; the only new endpoints are an all-runs list shape and an export.

## Variants

- **Variant 1 — Extend `GET /runs` with a `scope` flag + reuse inspector.**
  One list route serves active (default) and all; a new `GET /runs/{id}/export`
  streams the run-load bundle; Open/Cancel/Retry reuse existing routes/UI.
  Complexity: small. Risk: low.
- **Variant 2 — Separate `GET /runs/all` route + client-side log assembly.**
  A dedicated all-runs route and an export built in the browser from
  `getRun`. Con: a second list route to keep in sync, and client-side bundle
  assembly duplicates the run-load shape. Complexity: small. Risk: medium.
- **Variant 3 — Runs as a Kanban-board view.** Render runs from the underlying
  Kanban cards/board instead of the run store. Con: project runs map to Kanban
  but global runs do not, so the view would be partial and conflate two models;
  the run store is the authority. Complexity: medium. Risk: high.

## Recommended: Variant 1

It reuses the run store, the inspector, and cancel/retry verbatim, adds the
smallest backend surface (a query flag + one export route), keeps the export on
the canonical run-load shape (no second serializer), and is the cleanest to test
through the injected client. Variant 2 duplicates the list/serializer; Variant 3
conflates the run model with Kanban and can't represent global runs.

# Workflow JSON export/import — implementation plan

## Tasks

### Task 1: Pure transfer module
- **Files**: `apps/dashboard/src/templates/transfer.ts`,
  `apps/dashboard/tests/transfer.test.ts`.
- **Acceptance**: failing-first unit tests pass — `workflowJsonFile(detail)`
  returns `{ filename: "<id>.workflow.json", content }` with pretty JSON of
  `{ workflow, ui? }` (no `path`, `ui` omitted when absent, trailing newline);
  `parseWorkflowJsonFile(text)` returns the `CreateWorkflowBody` for valid
  input, throws "not valid JSON" on parse failure and "not a workflow JSON
  export" on a wrong shape (missing `workflow`, non-string `id`);
  round-trip: `parseWorkflowJsonFile(workflowJsonFile(d).content)` equals
  `{ workflow: d.workflow, ui: d.ui }`.
- **Depends on**: none.

### Task 2: Templates page wiring
- **Files**: `apps/dashboard/src/pages/TemplatesPage.tsx`,
  `apps/dashboard/tests/templates-page.test.tsx`.
- **Acceptance**: failing-first RTL tests pass — the row menu offers
  **Export YAML** (existing behaviour, relabelled) and **Export JSON**
  (downloads via the transfer module with `application/json`); a page-level
  **Import** button accepts a `.json` file (`userEvent.upload`), calls
  `createWorkflow` with the parsed body, reports "Imported <id>" and reloads
  the list; a clashing id / invalid graph error from the API lands verbatim in
  the status line; a non-workflow file shows the transfer module's message and
  never calls `createWorkflow`; picking the same file twice fires both times.
- **Depends on**: Task 1.

### Task 3: Docs + QA
- **Files**: `docs/dashboard.md`, `README.md`.
- **Acceptance**: Templates view docs mention Export YAML / Export JSON /
  Import with the conflict rule; `bun run validate` fully green (incl. the
  committed-bundle diff); live smoke: export a workflow as JSON, re-import it
  under a free id, observe the 409 message on a clash.
- **Depends on**: Tasks 1–2.

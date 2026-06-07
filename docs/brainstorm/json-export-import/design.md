# Workflow JSON export/import — transfer format over the existing authoring API

**Status:** accepted
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

The Templates page can export a workflow only as the canonical on-disk YAML,
and cannot import anything. Operators need a JSON transfer format: download a
workflow (graph + `ui` layout) as a `.json` file and re-create a workflow from
such a file, with explicit errors on id clashes and invalid graphs.

## Scope

- **Export JSON** (per-row action): `getWorkflow(id)` → `{ workflow, ui? }`
  (the `path` field is dropped — it is server-local) → pretty-printed JSON
  downloaded as `<id>.workflow.json`. The existing YAML action is relabelled
  **Export YAML**; the new one is **Export JSON**.
- **Import JSON** (page-level action next to **New workflow**): a hidden file
  input reads the chosen file, parses and shape-checks it, and calls the
  existing `createWorkflow` (`POST /workflows`). Core validation is the
  authority: an id clash surfaces the 409 detail, an invalid graph the 400
  detail, in the page's existing `role="status"` line. Success reports the
  imported id and refreshes the list.
- **Pure transfer module** `apps/dashboard/src/templates/transfer.ts`:
  `workflowJsonFile(detail)` → `{ filename, content }` and
  `parseWorkflowJsonFile(text)` → `CreateWorkflowBody`, which throws
  descriptive errors ("not valid JSON" / "not a workflow JSON export") so the
  page handler stays thin and the format logic is unit-testable without DOM.
- **Round-trip**: the exported `{ workflow, ui? }` is byte-for-byte the shape
  `POST /workflows` accepts, so export → import reproduces the workflow
  (subject to the id-clash rule); re-export of the imported workflow matches
  because both sides serialize the same parsed spec object.

## Out of scope

- A server-side JSON export endpoint (variant 2) — `getWorkflow` already
  returns the deterministic parsed spec; no third backend layer for it.
- A versioned envelope (`format`/`version` markers, variant 3) — speculative;
  the bare authoring shape is the format. A cheap additive follow-up if ever
  needed.
- Overwrite/rename flows on import conflict — the 409 is surfaced verbatim;
  the operator resolves it (delete/rename) explicitly.
- Multipart upload — the host transport is JSON-only; the file is read
  client-side.

## Chosen approach

Variant 1 of the brainstorm (consultant-recommended, accepted): client-side
export/import reusing the proven Duplicate pattern (`getWorkflow` →
`createWorkflow`) and the bare `{ workflow, ui? }` authoring shape. One graft
from variant 3: a minimal shape check before `createWorkflow` (`workflow`
object with a string `id`) so a wrong file fails with "not a workflow JSON
export" instead of a confusing graph-validation 400. No backend changes, no
second serializer, YAML export contract untouched.

## Design decisions

- **The transfer format is the authoring shape.** `{ workflow, ui? }` is what
  `POST /workflows` and `PUT /workflows/{id}` already speak; inventing an
  envelope would add an unwrap step and a second contract for no stated need.
- **`path` never travels.** It is a server filesystem detail; export strips it.
- **Filename `<id>.workflow.json`** mirrors the on-disk naming the spec store
  already reads, so an exported file is also directly usable as a spec file.
- **Validation stays in core.** The client shape check only classifies "not a
  workflow file at all"; everything semantic (graph validity, id rules, clash)
  is the existing `spec-create` path and its 409/400 mapping.
- **Errors land in the existing status line** (`role="status"`), matching
  every other Templates action; success messages name the imported id.
- **The file input resets after each pick** so importing the same file twice
  in a row (e.g. after deleting the clash) fires the change event again.

## File changes

- `apps/dashboard/src/templates/transfer.ts` — new pure module (serialize +
  parse with descriptive errors).
- `apps/dashboard/src/pages/TemplatesPage.tsx` — Export YAML / Export JSON
  menu items, Import button + hidden file input, thin handlers.
- `apps/dashboard/tests/transfer.test.ts` — unit tests for the module
  (round-trip, ui omitted, bad JSON, wrong shape).
- `apps/dashboard/tests/templates-page.test.tsx` — JSON export download,
  import success (+reload), import 409/400 surfaced, wrong-file error,
  relabelled YAML export.
- `docs/dashboard.md`, `README.md` — Templates actions description.

## Risks and open questions

- **jsdom file reading** — jsdom does not implement `Blob.text()`, so both the
  import handler and the tests read files via `FileReader`
  (`readTextFile` in `templates/download.ts`), which works in jsdom and
  browsers alike. (Risk hit during TDD and resolved this way.)
- **`JSON.stringify` determinism** — key order follows the parsed object from
  the core (insertion order), which is stable for a given spec; good enough
  for the round-trip guarantee stated above.
- **Single PR with single-flight-runs** — operator-requested; the surfaces do
  not overlap (Templates page vs run pipeline) beyond shared docs files.

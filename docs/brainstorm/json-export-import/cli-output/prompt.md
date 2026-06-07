You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Export and import workflows as JSON in the dashboard.

Today the Templates page only exports a workflow as YAML (`GET /workflows/{id}/export` returns the canonical on-disk YAML in a `{ id, filename, yaml }` JSON envelope; the page downloads it via a client-side blob helper). There is no import at all.

Required behaviour:

1. **JSON export**: download a workflow (graph + its `ui` layout block) as a `.json` file from the Templates page.
2. **JSON import**: upload a JSON file on the Templates page and create that workflow. A clashing id and an invalid graph must be explicit errors (the existing `POST /workflows` already returns `409` for an id clash and `400` for an invalid graph) — no silent overwrites, no auto-renames the operator did not ask for.
3. **Round-trip**: export → import must reproduce the same workflow (modulo the id-clash rule), byte-stable enough that a re-export matches.
4. Errors must surface explicitly in the UI; silent fallbacks and stubs are forbidden by project policy.

# Project context

hermes-workflows — a Hermes dashboard plugin: TypeScript core (Bun, `packages/core`) owns spec validation/persistence and is invoked as a CLI by a Python orchestrator (`hermes_workflows/`), which a FastAPI router (`dashboard/plugin_api.py`) wraps for the dashboard SPA (React 19, `apps/dashboard`, committed bundle `dashboard/dist`).

Storage facts:
- On-disk specs live as `<id>.workflow.yaml`; the spec store also *reads* `*.workflow.json` files, but every write goes through `serializeWorkflow` to YAML (`packages/core/src/runtime/specStore.ts:119`). The stored YAML file is the authority; the docs explicitly forbid a second serializer for the YAML export route.
- `POST /workflows` body is `{ workflow, ui? }` → core `spec-create` validates and refuses to overwrite (`SpecExistsError`→409, `SpecValidationError`/`WorkflowParseError`→400). `GET /workflows/{id}` returns `{ workflow, ui?, path }`.
- The SPA's typed client (`apps/dashboard/src/api/client.ts`) already has `getWorkflow`, `createWorkflow`, `exportWorkflow`; the host transport is JSON-only `fetchJSON`.
- The Templates page (`apps/dashboard/src/pages/TemplatesPage.tsx`) has an Actions menu per row (Open / Run / Enable / Duplicate / Export / Delete), a page-level `role="status"` message for outcomes/errors, and a `downloadTextFile(filename, content, type)` helper. Duplicate already does `getWorkflow` → `createWorkflow` client-side with a `window.prompt` for the new id.
- Recent commits: #15 editor Play button, #14 run observability, #13 UI overhaul. Branch also carries a single-flight-runs feature (unrelated surface: runs).

Conventions:
- TDD; Vitest (jsdom+RTL) for the SPA, `bun test` for core, pytest for FastAPI routes.
- SOLID/KISS/DRY; no do-nothing fallbacks; errors must surface explicitly.
- Additive API changes preferred; the YAML export contract must not break.

Constraints:
- Do not introduce a second YAML serializer; JSON export must not re-serialize YAML.
- Import must validate through the existing core validation path (no client-side-only trust of the file).
- The JSON format should be the same `{ workflow, ui? }` shape the authoring API already speaks, unless a variant argues for an envelope (e.g. a format/version marker) — weigh that explicitly.
- Keep the dashboard host transport JSON-only (`fetchJSON`); file upload happens client-side (FileReader) since the host transport does not do multipart.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.

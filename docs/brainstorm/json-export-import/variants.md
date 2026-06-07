# Workflow JSON export/import — brainstorm audit trail

Consultant: Claude Code CLI (`claude -p`), prompt in `cli-output/prompt.md`,
raw output in `cli-output/claude.md`. Fallback (Codex) not needed — the
primary returned three parseable variants and a recommendation.

## Variants (consultant output, verbatim)

### Variant 1: Client-side, reuse existing endpoints
- **Approach**: Mirror the existing Duplicate flow exactly. Export calls `getWorkflow(id)` → strips `path` → `downloadTextFile(`${id}.json`, JSON.stringify({ workflow, ui }, null, 2), "application/json")`. Import wires a hidden `<input type="file">` to the Actions menu, reads the file with `FileReader`, `JSON.parse`s it, and calls the existing `createWorkflow({ workflow, ui })`, letting core's 409/400 surface in the page-level `role="status"` region. No new API, no new serializer.
- **Trade-offs**:
  - Pro: Smallest possible diff; no backend, no FastAPI, no core changes — all work lives in `TemplatesPage.tsx` + client + Vitest.
  - Pro: Import validates through the real core path (`createWorkflow` → `spec-create`); no client-side trust.
  - Pro: Uses the bare `{ workflow, ui? }` shape the authoring API already speaks — zero new contract.
  - Pro: YAML export route untouched; no second serializer.
  - Con: Round-trip byte-stability rests on `getWorkflow`'s object being deterministic and `JSON.stringify` key order — no server-canonicalized output to lean on.
  - Con: No format/version marker, so a malformed-but-parseable JSON only fails at core validation (acceptable, but the error is "invalid graph" rather than "wrong file type").
- **Complexity**: small
- **Risk**: low

### Variant 2: Server-side canonical JSON export endpoint
- **Approach**: Add an additive `GET /workflows/{id}/export.json` (or `?format=json`) that returns a canonical `{ workflow, ui? }` JSON envelope produced from the same in-memory spec object the core already parses — deterministic key ordering owned server-side, paralleling the YAML export route. Import stays client-side (`FileReader` → `createWorkflow`), as the host transport can't do multipart.
- **Trade-offs**:
  - Pro: Byte-stable round-trip is guaranteed by a single server-owned canonical serializer, not by client `JSON.stringify` behavior.
  - Pro: Export/import symmetry with the existing YAML export endpoint; consistent mental model.
  - Con: Touches FastAPI router, Python orchestrator, and likely a core CLI flag — three layers and pytest coverage for a feature the client could already assemble from `getWorkflow`.
  - Con: Risks looking like a "second serializer"; must be carefully scoped to JSON-of-the-spec-object, not YAML re-encoding, to honor the constraint.
  - Con: Asymmetric design (server export, client import) is slightly awkward to explain.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Versioned envelope with explicit unwrap/validate
- **Approach**: Wrap exports in `{ format: "hermes-workflow", version: 1, workflow, ui? }`, written client-side from `getWorkflow`. Import reads the file, asserts `format`/`version` before unwrapping to `{ workflow, ui? }` and calling `createWorkflow`; an unrecognized or missing marker is an explicit "not a Hermes workflow file" error distinct from core's 400.
- **Trade-offs**:
  - Pro: Forward-compatible — a future schema migration can branch on `version` instead of guessing.
  - Pro: Sharper import errors: wrong-file-type rejected before it ever reaches core.
  - Pro: Still client-only, no backend or serializer changes.
  - Con: Diverges from the bare `{ workflow, ui? }` authoring shape the API speaks, so import needs an unwrap step and export needs a wrap step — extra surface to keep in sync and test.
  - Con: Round-trip now means "envelope re-export matches"; the envelope keys add ordering surface to stabilize.
  - Con: Speculative future-proofing (YAGNI) against a versioning need the task doesn't state.
- **Complexity**: small
- **Risk**: low

### Recommended: Variant 1 (consultant)
**Rationale (consultant)**: It satisfies every hard constraint with the least surface — additive, no second serializer, YAML route untouched, and import validated through the real core path — by reusing the already-proven Duplicate pattern (`getWorkflow` → `createWorkflow`) and the bare `{ workflow, ui? }` shape the API already speaks. Variant 2's server-canonical export is the only thing Variant 1 lacks, but `getWorkflow` already returns the deterministic parsed spec object, so client `JSON.stringify` round-trips stably without a new three-layer endpoint; Variant 3's envelope is speculative versioning the task explicitly doesn't require. If a versioning need later materializes, the envelope is a cheap additive follow-up on top of Variant 1.

## Orchestrator decision

**Variant 1 accepted** as recommended, with two small deviations:

1. One graft from variant 3 — a minimal client-side shape check before
   `createWorkflow` (`workflow` object with a string `id`), so a wrong file
   fails with "not a workflow JSON export" instead of a confusing
   graph-validation 400. No envelope, no version marker — the bare authoring
   shape stays the format.
2. Filename `<id>.workflow.json` (not `<id>.json`) — it mirrors the on-disk
   naming the spec store already reads, so an exported file doubles as a valid
   spec file.

Implementation lands on the `feat/single-flight-runs` branch by operator
request — one PR ships both features.

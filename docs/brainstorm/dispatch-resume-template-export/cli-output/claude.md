## Variant 1 — Thin independent slices, engine sets the anchor (surgical)

**Approach:** Treat the bundle as four loosely-coupled slices, each touching the minimum surface. For Task 1+4, the engine's `adopt` path overrides each driven card's `workspace_kind` to a worktree *anchored on `feat/<slug>` at its current tip* (not `main`/`default_workdir`), and serializes driving with a commit barrier between cards — reusing the fact that `_advance_step` already drives cards one at a time, adding a "card committed onto branch tip" gate before the next is promoted; docs+version runs once via the dedicated node. Task 4 is a thin assertion layer that reads the dispatcher's resolved workspace and confirms the per-task linked worktree's base ref and `TERMINAL_CWD` resolve inside the release tree. Task 2 reuses `retryRun`/`run-retry` as-is (CLI `resume` + dashboard button + backend advance-after-retry); Task 3 adds `spec_sha` as a standalone serialize helper, de-binding as a pure TS pass, and one default-model call for the guide. `spec_sha` and resume's drift check stay separate primitives.

**Trade-offs:**
- + Minimal blast radius; each task independently TDD-able and atomically committable
- + Reconciles Task 1+4 *with* the dispatcher: keeps the per-task linked worktree, only re-anchors it from `main` to `feat/<slug>@tip` — no VCS layer, honors "no second engine"
- + Logic stays in the right language: pure TS for `spec_sha`/de-binding/drift, Python engine only orchestrates workspace params + the commit gate
- − Two parallel hashing concepts (full `spec_sha` for template vs node-set fingerprint for drift) — mild conceptual redundancy
- − Commit-barrier serializes card driving (no parallel cards) and adds a new wait condition to the engine
- − If the dispatcher silently ignores the engine-supplied base ref, Task 1 regresses — caught only by Task 4's assertions, so their ordering matters

**Complexity:** medium. **Risk:** low-medium.

---

## Variant 2 — Foundation-first: a shared spec-identity + release-workspace platform

**Approach:** Land one foundational core module before any user-facing task: a spec-identity layer emitting both `spec_sha` (full content hash) and a `structural_fingerprint` (node-set/edge topology hash), plus a provenance/source-snapshot record — consumed by *both* resume's drift guard and template's cache key/`source` block. Then make the shared release branch a first-class run-level concept: `lock-scope` records `feat/<slug>` and its working tree as the run's canonical workspace in a new DB column, and `adopt` drives each card into a worktree stacked on it with an explicit stack order. Task 4 becomes a conformance suite pinning the engine's workspace contract against the dispatcher's #49855/#50348 model.

**Trade-offs:**
- + One tested identity module eliminates duplicated hashing across resume + template
- + Branch-stacking becomes a named, reusable run concept with a clear mental model and strong template provenance
- + Drift detection is robust (topology hash catches reorder/rename, not just add/remove)
- − Slowest to first user-facing value; heavy up-front design
- − Over-generalization risk (YAGNI): resume wants a *structure-only* hash and template wants a *full-content* hash — legitimately different sensitivities, so a unified module may force an abstraction neither fully wants
- − "Release worktree as a run-level concept" is the largest engine change (lock-scope + adopt + migration), more than single-flight/one-run-per-workflow needs

**Complexity:** large. **Risk:** medium.

---

## Variant 3 — Dispatcher-native isolation + post-hoc consolidation (merge train)

**Approach:** Accept the dispatcher's per-card linked-worktree isolation unchanged; resolve Task 1 not by changing where cards run but by adding a consolidation step — each card commits in its own worktree off `feat/<slug>`'s tip-at-dispatch, then a new step (or the docs-version node, run once) rebases/merges the card branches into `feat/<slug>` in dependency order with a single version/CHANGELOG bump. Task 4 validates per-task worktrees read the correct repo context. Task 2+3 are pragmatic: `spec_sha` is the only new primitive, resume relies on `workflow_version` plus a cheap live node-set comparison (no stored fingerprint).

**Trade-offs:**
- + Least friction with upstream #49855/#50348 — works with the dispatcher, not against it
- + Cards keep running in parallel (no commit barrier)
- + Smallest change to the `adopt` driving path itself
- − The consolidation merge train re-introduces exactly the conflict class Task 1 exists to kill: cards still never saw each other's code while implementing
- − Fails the core contract ("card N builds on commits of cards 1..N-1") — only reconciles after the fact, so logical duplication/divergence persists
- − Resume drift via live node-set diff with no persisted fingerprint is the weakest guard (misses renames/reorderings)

**Complexity:** medium. **Risk:** high.

---

## Recommended: Variant 1

It is the only variant that satisfies Task 1's actual correctness contract while respecting every project constraint. The fix is surgical and *with the grain* of the new dispatcher model: the host already materializes a per-task linked worktree, so re-anchoring it from `main` to `feat/<slug>@tip` plus a commit-before-next gate is the smallest change that makes "card N builds on 1..N-1" physically true — Variant 3 abandons that contract to a fragile merge train, and Variant 2 rebuilds the workspace as a run-level concept the single-flight, one-run-per-workflow model does not require.

It honors the two-language split cleanly: the new logic that *is* logic (`spec_sha`, de-binding, drift fingerprint) lands as pure, testable TypeScript in core, while the Python engine only orchestrates native workspace params and a wait condition — no second engine, no VCS layer. The commit barrier is acceptable precisely because `adopt` driving is already sequential under single-flight, so serialization costs little and buys idempotent, resumable progress. Keeping `spec_sha` (full content, for template cache invalidation) separate from the resume drift fingerprint (structure-only, so the *safe* prompt/timeout edits don't trip it) is correct, not redundant — Variant 2's unification would force the safe-edit case to look like drift. Finally, four independent slices map directly onto TDD: each is a failing test, a green implementation, and one atomic conventional commit, and a slip in any one task does not block the release of the others.

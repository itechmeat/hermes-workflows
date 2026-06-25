### Section 1 — Variants

**Variant 1 — Minimal-diff, each fix at its symptom site (no shared abstraction)**

- **Approach**: Each bug is patched where it manifests, with no new shared module. Bug 1 lands a test-only autouse fixture in `conftest.py` that points `cj.CRON_DIR/JOBS_FILE/OUTPUT_DIR` at `tmp_path`; Bug 2 inlines the sentinel scan + `node_outcome` parse directly into `_detached_runner._invoke`; Bug 3 adds a backoff loop inline in both `_detached_runner._invoke` (direct) and the kanban executor, each re-deriving "is this transient?"; Bug 4 reorders `cli_spec_roots` to prepend the project root. The four are independent — they touch four different files and share nothing.
- **Trade-offs**:
  - Pro: smallest blast radius per bug; each commit is a clean atomic TDD unit; nothing couples the four together, so a revert of one is trivial.
  - Pro: Bug 1 stays purely in tests — no risk of touching the production cron-path resolution that caused the live-store leak.
  - Con: violates DRY exactly where it hurts — the transient-vs-deterministic decision (the shared 2&3 contract) is duplicated across the direct and kanban paths and will drift; a sentinel added for one path silently misses the other.
  - Con: Bug 3's retry logic exists twice, doubling the test surface (transient-retry, deterministic-no-retry, bounded-cap) and the chance of divergent caps.
- **Complexity**: medium.
- **Risk**: medium (duplication-driven drift between the two executor paths).

**Variant 2 — Centralised classifier + retry folded into the engine settle-point + production-lazy cron paths**

- **Approach**: A single classification module (`classify(returncode, stdout) -> {outcome, kind: success|transient|deterministic, node_outcome_override}`) becomes the one source of truth for Bugs 2 and 3, consumed by both `_detached_runner` and `bridge/kanban`. The retry/backoff policy lives at the single node-settle-point in `engine.py::_advance_step`, which already folds completions into `node["outcome"]`/`node["seq"]` and so can own attempt-count, backoff, and re-dispatch uniformly for direct and kanban nodes. Bug 1 fixes the root cause — make the bridge cron paths lazy/injectable (resolve `get_hermes_home()` at call time, not import) — backed by the autouse fixture; Bug 4 centralises precedence in `cli_spec_roots` with an explicit reject/warn on a global↔repo-local id collision.
- **Trade-offs**:
  - Pro: maximally DRY/SOLID — one classifier, one retry policy, one precedence rule; sentinels and caps can never diverge between paths.
  - Pro: Bug 1's lazy paths remove the import-time landmine for good, not just for tests; a future non-test caller can't leak either.
  - Con: largest diff, and it concentrates risk on the one path every run flows through — adding re-dispatch/backoff inside `_advance_step` changes settle semantics (seq bumping, single-flight) for both executors at once.
  - Con: making `cj` paths injectable touches the dependency-free bridge's hottest seam; reject-on-collision is a behavior change that could surprise an operator who relied on the old (accidental) global-wins resolution.
- **Complexity**: large.
- **Risk**: high (settle-point retry + bridge cron-path rework both touch load-bearing seams).

**Variant 3 — One pure shared classifier, retry co-located at each executor boundary, test-only Bug 1, reorder Bug 4**

- **Approach**: Extract exactly one pure function — the transient/deterministic/success classifier (no I/O, reads `returncode` + `stdout`, honours the `node_outcome` token) — as the single shared 2&3 contract. Bug 2 is the direct path calling it in `_invoke`; Bug 3 wraps a bounded exponential-backoff loop around each executor's invoke boundary (`_detached_runner._invoke` and the kanban dispatch), but both delegate the *decision* to that one classifier, so the engine settle-point in `_advance_step` stays pure. Bug 1 stays a `conftest.py` autouse sandbox of the `cj` trio plus a regression guard (the leak is a test-isolation defect, so fix it in the test seam, not in production cron resolution); Bug 4 prepends the project root in `cli_spec_roots` so first-match resolution favours repo-local, with the missing `seed_global=True` precedence test.
- **Trade-offs**:
  - Pro: captures the one real DRY win (the classifier) without the cost of re-architecting the settle-point — retry orchestration is duplicated only as a thin loop, while the failure-classification logic that actually drifts is shared.
  - Pro: Bug 1 and Bug 4 are the smallest correct fixes (autouse fixture; one-line roots reorder matching the v0.7.2 #27 repo-local-discovery intent) and keep their commits independent and low-risk.
  - Con: the backoff loop still appears at two call sites (less duplication than V1, but not zero); a future third executor would need to opt in.
  - Con: prepend-reorder silently changes which spec wins on collision without warning the operator — quieter than V2's reject, but also less explicit about the override.
- **Complexity**: medium.
- **Risk**: low-medium.

### Section 2 — Recommendation

`Recommended: Variant 3` — It puts the single DRY boundary exactly where drift is dangerous (one pure, unit-testable classifier as the shared Bug 2/3 contract) while honouring KISS everywhere else: Bug 1 is a test-isolation leak, so the autouse `conftest.py` seam is the proportionate fix rather than reworking the dependency-free bridge's cron-path resolution (V2's lazy-paths change risks the very live-store path that caused the incident); Bug 4 is a first-match precedence bug whose smallest correct fix is reordering `cli_spec_roots` to match the v0.7.2 repo-local-discovery goal. Crucially it keeps the single node-settle-point in `engine.py::_advance_step` pure — V2's appeal of folding retry there is outweighed by concentrating re-dispatch/backoff risk on the one path every run shares — and each of the four fixes remains an independent failing-first TDD commit that clears `bun run validate` on its own.

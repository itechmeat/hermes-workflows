# KNOWN-BUG-SWEEP — design

Scope: a single bug-sweep pull request fixing exactly four LEAF bugs on one
shared branch (`feat/known-bug-fixes`), driven one at a time in dependency
order. This is a bug-fix release; the retry policy (Bug 3) is a behavior
addition, so the combined fixes warrant a **minor** semver bump (0.7.5 → 0.8.0),
dated on merge. Slug: `known-bug-fixes`.

## Problem

Four currently-known bugs, all confirmed in code, with one clean dependency
(`t_b30e4db8` retry depends on `t_1260d235` classification):

1. **t_8179b52f — test isolation leak.** `cron.jobs` resolves
   `HERMES_DIR = get_hermes_home().resolve()` at module import time and derives
   `CRON_DIR / JOBS_FILE / OUTPUT_DIR` from it as module constants. A
   cron-touching test that sets only `HERMES_HOME` (not the trio) writes into
   whatever `get_hermes_home()` resolved at import — i.e. the operator's real
   cron store when `bun run validate` / pytest runs on a live host. A leaked
   job named exactly the tick name then shadowed the real tick and stalled
   auto-advancement of every run.
2. **t_1260d235 — direct-node outcome is exit-code-only.** `_detached_runner._invoke`
   settles `outcome="success"` on any exit 0, but the Hermes agent CLI exits 0
   even when its LLM call exhausts retries on a transient provider error (it
   prints `API call failed after N retries: HTTP 429 …` and returns cleanly).
   The graph then advances on garbage. The structured `node_outcome` override
   exists only on the Kanban path, never on the direct path.
3. **t_b30e4db8 — no node-level retry for transient errors.** A single
   transient provider error (429 / overloaded / 5xx) on one agent node kills an
   entire long release run. No transient-vs-deterministic classification and no
   bounded backoff retry exist today.
4. **t_8d4bee60 — spec-root precedence.** `config.cli_spec_roots()` appends the
   repo-local `<cwd>/.hermes/workflows` LAST; core `SpecStore` takes the FIRST
   match across roots. So a workflow id present in both a global root and the
   repo-local dir resolves to the GLOBAL spec, silently shadowing the
   repo-local copy — contradicting the v0.7.2 (#27) repo-local-discovery goal.
   The precedence collision itself is untested today: the discovery test uses
   `seed_global=False` (no collision), and the one `seed_global=True` test
   (`test_advance_falls_back_to_global_when_stored_spec_is_gone`) deliberately
   *removes* the repo-local spec before asserting global fallback — so no test
   asserts the local-wins resolution when BOTH copies are present.

## Scope

Exactly the four leaf cards above, in this order, on `feat/known-bug-fixes`:

1. t_8179b52f (drive FIRST — restores test isolation so no further job leaks into
   the operator's real cron store during this run),
2. t_1260d235,
3. t_b30e4db8 (depends on 2),
4. t_8d4bee60.

## Out of scope

- Reworking the dependency-free bridge's cron-path resolution to be
  lazy/injectable in production (the leak is a test-isolation defect; the
  proportionate fix is the test seam, not the live cron path — see Risks).
- Folding node-level retry into the engine's single settle-point in
  `engine.py::_advance_step` (concentrates re-dispatch/backoff risk on the one
  path every run shares; retry stays co-located at each executor boundary).
- Any umbrella/meta board cards, dashboard UI work, or release-image work.
- Semver decisions for other scopes.

## Chosen approach (Variant 3)

One pure shared **failure classifier** as the single Bug 2/3 contract, retry
co-located at each executor boundary, Bug 1 fixed in the test seam, Bug 4 a
one-line roots reorder plus the missing precedence test.

The classifier is the only thing that can drift dangerously between the two
executor paths (a sentinel added for one path would silently miss the other),
so it is extracted exactly once and unit-tested in isolation. Everything else
gets its smallest correct fix.

### Per-bug design

**Bug 1 (t_8179b52f) — test-only autouse sandbox + regression guard.**
- Lift the existing `cj.CRON_DIR / cj.JOBS_FILE / cj.OUTPUT_DIR` monkeypatch
  trio (currently duplicated across 8 test files) into a single `autouse=True`
  fixture in `tests/python/conftest.py` that points all three at a fresh
  `tmp_path/cron` dir for every test. No cron-touching test can then write to
  the real store regardless of whether it also sets `HERMES_HOME`.
- The existing per-file fixtures (`cron_env`, `home`, `_repo_local_home`) keep
  their other monkeypatching but stop owning the trio (they become redundant
  with the autouse fixture; remove the duplicates so there is one source of
  truth — DRY).
- Regression guard: a dedicated test that imports `cron.jobs`, asserts the
  sandboxed `cj.JOBS_FILE` resolves UNDER the test's `tmp_path` (not under the
  real `get_hermes_home()`), so a future regression that re-introduces an
  un-sandboxed path fails loudly. Optionally also assert the real jobs file is
  untouched before/after a representative cron-arming test.

**Bug 2 (t_1260d235) — honor classifier + node_outcome token on the direct path.**
- Extract the pure classifier (see shared contract below).
- `_detached_runner._invoke`: on `returncode == 0`, call the classifier instead
  of unconditionally returning `success`. If the classifier says transient
  failure or the agent emitted a `node_outcome: failure` token, settle
  `outcome="failure"` with the matched line in `output`; otherwise `success`.
- A clean direct node (exit 0, no sentinel, no failure token) still settles
  `success`.

**Bug 3 (t_b30e4db8) — bounded backoff retry, classified.** (depends on Bug 2)
- A bounded exponential-backoff retry loop, co-located at each executor
  boundary: `_detached_runner._invoke` (direct) and the kanban dispatch path.
  Both delegate the transient-vs-deterministic decision to the one classifier.
  - Transient (429, overloaded, 502/503/504, connection reset) → retry with
    exponential backoff, capped (e.g. 3 attempts, bounded ceiling).
  - Deterministic (non-zero from real work, validation failure, declared
    `node_outcome: failure`) → fail fast, no retry.
- Each retry is logged to the node telemetry so the dashboard shows the wait,
  not a silent stall.
- After the cap of transient failures the node settles `failure` loudly.
- Applies to both direct and kanban-backed agent nodes. Note: for the direct
  path the retry wraps the single `_invoke`; for the kanban path the retry
  wraps a single card dispatch (re-create/re-drive the card) since the kanban
  dispatcher already owns `max_retries`/`consecutive_failures` semantics — the
  transient-retry policy layers above that, keyed on the classifier.

**Bug 4 (t_8d4bee60) — repo-local precedence + the missing test.**
- In `config.cli_spec_roots()`, **prepend** the repo-local project dir instead
  of appending it, so first-match resolution across `SpecStore` roots favours
  the repo-local copy (matches the v0.7.2 #27 repo-local-discovery intent).
- Add the missing precedence test (`seed_global=True`): a workflow id present in
  BOTH a global root and the repo-local dir resolves to the REPO-LOCAL spec
  path.

### Shared contract: the failure classifier

One pure function, no I/O, in a new small module
(e.g. `hermes_workflows/executor/outcome.py`):

```text
classify(returncode: int, stdout: str, *, node_outcome_token: str | None)
  -> {"outcome": "success"|"failure", "kind": "success"|"transient"|"deterministic"}
```

- Reads `returncode` + `stdout` for provider-error sentinels
  (`API call failed after N retries`, `HTTP 429`, `temporarily overloaded`,
  `503`, `502`, `504`, connection-reset markers).
- Honours the structured `node_outcome` token (same `{"node_outcome":
  "success"|"failure"}` contract as `bridge/kanban._node_outcome_override`), so
  a node that knows it failed can say so regardless of exit code.
- Returns a `kind` so Bug 3's retry loop can decide transient-retry vs
  fail-fast without re-parsing.
- Unit-tested in isolation (clean → success; 429-on-exit-0 → failure/transient;
  declared node_outcome failure → failure/deterministic).

## Design decisions

- **Variant 3 over Variant 1:** V1 inlines the sentinel scan and retry at each
  symptom site, duplicating the one contract (transient-vs-deterministic)
  across both executors — exactly where drift is dangerous (a sentinel added
  for one path silently misses the other). V3 extracts the classifier once.
- **Variant 3 over Variant 2:** V2 also makes the bridge cron paths
  lazy/injectable (production change) and folds retry into the single
  node-settle-point in `engine.py::_advance_step`. Both touch load-bearing
  seams: the lazy-paths change risks the very live-store path that caused the
  Bug 1 incident, and settle-point retry concentrates re-dispatch/backoff risk
  on the one path every run shares. V3 keeps the settle-point pure and fixes
  Bug 1 in the test seam where it belongs.
- **Bug 4 prepend, not reject-on-collision:** the repo-local-discovery goal
  (#27) is an override intent; prepend makes first-match resolution favour
  repo-local with a one-line change. A reject/warn on collision (V2) is a
  behaviour change that could surprise an operator who relied on the old
  global-wins resolution; it remains available later if collisions prove
  confusing in practice. The missing `seed_global=True` test is added either
  way.
- **Semver:** minor bump (0.7.5 → 0.8.0) on merge. The retry policy (Bug 3) is
  a behavior addition (transient failures that previously killed a run now
  self-heal); the other three are bug fixes. Combined → minor.

## File changes

- `tests/python/conftest.py` — add autouse `cj`-trio sandbox fixture; add
  regression-guard helper.
- `tests/python/test_cron_bridge.py`, `test_py_cli.py`, `test_review.py`,
  `test_plugin_command.py`, `test_cli_resume.py`,
  `test_dashboard_schedule_routes.py`, `test_dashboard_run_routes.py`,
  `test_tick_schedule_config.py` — drop the now-redundant trio monkeypatch
  (keep their other setup).
- `tests/python/test_cron_isolation.py` (new) — the regression guard.
- `hermes_workflows/executor/outcome.py` (new) — the pure classifier.
- `hermes_workflows/executor/_detached_runner.py` — use the classifier on exit 0
  (Bug 2); wrap the bounded backoff retry (Bug 3, direct path).
- `hermes_workflows/executor/direct_executor.py` — thread retry/telemetry as
  needed (the runner is the detached child; telemetry of retries flows through
  the completion the engine folds).
- `hermes_workflows/bridge/kanban.py` / `executor/kanban_executor.py` — apply
  the classifier + bounded retry on the kanban dispatch path (Bug 3,
  kanban-backed).
- `hermes_workflows/executor/__init__.py` — export the classifier for reuse.
- `hermes_workflows/config.py` — `cli_spec_roots()` prepend the project dir
  (Bug 4).
- `tests/python/test_resolve.py` (or a new `test_spec_precedence.py`) — the
  `seed_global=True` precedence test (Bug 4).
- `CHANGELOG.md`, `package.json`, `pyproject.toml`, `plugin.yaml`,
  `apps/dashboard/package.json` + `apps/dashboard/build-number.json` — version
  bump to 0.8.0 on the release/merge commit (reset build counter to 0).

## Risks

- **Bug 1 autouse fixture vs per-test `tmp_path`:** an autouse fixture using
  `tmp_path` runs per-test by default; ensure the sandbox is scoped so every
  cron-touching test gets a fresh dir and no cross-test state leaks. Low risk.
- **Bug 2 sentinel false positives:** an agent that legitimately mentions "429"
  in its prose could be misclassified. Mitigation: match the specific exhausted
  retry / API-failure sentinels (`API call failed after N retries`, `temporarily
  overloaded`), not bare numbers. The `node_outcome` token is the authoritative
  override in either direction. Low-medium risk.
- **Bug 3 retry amplifying load:** retrying a 429 with backoff is the intent,
  but an unbounded loop would worsen a provider outage. Mitigation: hard cap
  (3 attempts) and bounded backoff ceiling; deterministic failures never retry.
  Low risk once capped.
- **Bug 3 kanban-path semantics:** the kanban dispatcher already owns
  `max_retries`/`consecutive_failures`; the transient-retry policy must layer
  above it without conflicting. Medium risk — needs care that a transient retry
  re-drives the card cleanly (new idempotency iteration) and does not fight the
  existing stuck-card bound.
- **Bug 4 silent override:** prepending silently changes which spec wins on
  collision. Acceptable (it matches the documented repo-local-discovery intent)
  and covered by the new test; reject-on-collision remains a later option.

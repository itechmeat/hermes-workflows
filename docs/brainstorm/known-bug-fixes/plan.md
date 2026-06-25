# KNOWN-BUG-SWEEP — implementation plan

Drive each task ONE AT A TIME on the shared branch `feat/known-bug-fixes`,
building on the commits the previously-driven cards already landed. Each task is
TDD: write the failing test first, implement to green, commit the atomic unit
as a conventional commit. `bun run validate` must stay green (and at zero
warnings) after every task. Full design: `docs/brainstorm/known-bug-fixes/design.md`.

## Task 1: t_8179b52f — cron-store test isolation (autouse sandbox + guard)

- **Files**: `tests/python/conftest.py` (add autouse `cj`-trio sandbox fixture
  pointing `cj.CRON_DIR`/`cj.JOBS_FILE`/`cj.OUTPUT_DIR` at a fresh
  `tmp_path/cron`; add a regression-guard helper);
  `tests/python/test_cron_bridge.py`, `tests/python/test_py_cli.py`,
  `tests/python/test_review.py`, `tests/python/test_plugin_command.py`,
  `tests/python/test_cli_resume.py`,
  `tests/python/test_dashboard_schedule_routes.py`,
  `tests/python/test_dashboard_run_routes.py`,
  `tests/python/test_tick_schedule_config.py` (drop the now-redundant trio
  monkeypatch from their per-file fixtures; keep their other setup);
  `tests/python/test_cron_isolation.py` (new — the regression guard).
- **Acceptance**: a failing-first regression test that, without the autouse
  sandbox, would resolve `cj.JOBS_FILE` under the REAL `get_hermes_home()`
  passes once the autouse fixture is in place (i.e. the sandboxed `JOBS_FILE`
  resolves under the test's `tmp_path`, and a cron-arming test writes only into
  that tmp dir, never the real store). All existing cron-touching tests still
  pass; `bun run validate` green. Drive this FIRST so no further job leaks into
  the operator's real cron store during this run.
- **Depends on**: none.

## Task 2: t_1260d235 — direct-node outcome (classifier + node_outcome token)

- **Files**: `hermes_workflows/executor/outcome.py` (new — the pure
  `classify(returncode, stdout, *, node_outcome_token)` function returning
  `{outcome, kind}`), `hermes_workflows/executor/__init__.py` (export it),
  `hermes_workflows/executor/_detached_runner.py` (call the classifier on
  `returncode == 0` instead of unconditionally returning `success`; honor the
  structured `node_outcome` token on the direct path, mirroring
  `bridge/kanban._node_outcome_override`);
  `tests/python/test_outcome_classifier.py` (new — unit tests for the pure
  classifier); extend the direct-executor tests
  (`tests/python/test_direct_executor.py`) with the failing-first cases.
- **Acceptance** (failing-first tests pass):
  (a) a direct node whose stubbed agent prints an exhausted-retry / 429 /
  overloaded API error on exit 0 settles `outcome="failure"`, not success (the
  matched line kept in `output`);
  (b) a direct node whose stubbed agent emits the `node_outcome: failure` token
  settles `failure`;
  (c) a clean direct node (exit 0, no sentinel, no failure token) still settles
  `success`;
  (d) regression test reproducing the lock-scope-429 cascade: a stubbed agent
  that prints the 429 string + exits 0 fails its node.
- **Depends on**: none (independent of Task 1, but Task 1 already landed so the
  suite is sandboxed).

## Task 3: t_b30e4db8 — transient node-level retry with backoff

- **Files**: `hermes_workflows/executor/outcome.py` (reuse the classifier's
  `kind`), `hermes_workflows/executor/_detached_runner.py` + the
  `direct_executor.py` boundary (bounded exponential-backoff retry loop around
  the direct invoke), `hermes_workflows/executor/kanban_executor.py` and/or
  `hermes_workflows/bridge/kanban.py` (apply the classifier + bounded retry on
  the kanban dispatch path); `hermes_workflows/telemetry.py` (log each retry so
  the dashboard shows the wait); extend `tests/python/test_direct_executor.py`
  and `tests/python/test_kanban_executor.py` with the failing-first cases.
- **Acceptance** (failing-first tests pass):
  (a) a node whose stubbed agent returns a 429 sentinel on attempt 1 then a
  clean result on attempt 2 settles `success` with no operator intervention,
  and telemetry records one transient retry;
  (b) a node whose agent fails deterministically (declared `node_outcome:
  failure` / validation error) does NOT retry under the transient policy — it
  fails immediately;
  (c) backoff is bounded — after the cap (3) of transient failures the node
  settles `failure` loudly (no infinite loop, no amplified load).
  Applies to both direct and kanban-backed agent nodes.
- **Depends on**: Task 2 (transient errors must be classified as failures
  before they can be retried).

## Task 4: t_8d4bee60 — spec-root precedence (repo-local overrides global)

- **Files**: `hermes_workflows/config.py` (`cli_spec_roots()` — prepend the
  repo-local project dir instead of appending it, so first-match resolution
  across `SpecStore` roots favours repo-local); `tests/python/test_resolve.py`
  (or a new `tests/python/test_spec_precedence.py`) — the missing
  `seed_global=True` precedence test.
- **Acceptance** (failing-first test passes): a workflow id present in BOTH a
  global root and the repo-local dir resolves to the REPO-LOCAL spec path (not
  the global one). Existing repo-local discovery tests still pass.
- **Depends on**: none (independent; can land in any order, driven last here).

## Release (on merge of the combined PR)

- Bump version 0.7.5 → 0.8.0 (minor: the retry policy is a behavior addition;
  the other three are bug fixes). Files: `package.json`, `pyproject.toml`,
  `plugin.yaml`, `apps/dashboard/package.json`; reset
  `apps/dashboard/build-number.json` to 0 and `dashboard:rebuild`. Add the
  `CHANGELOG.md` entry for 0.8.0. Per CLAUDE.md, no release image is required
  unless this is a tagged release; defer image work if the operator does not
  request a public release.
- **Acceptance**: `bun run validate` fully green at zero warnings; CHANGELOG
  dated; version strings consistent across all four files + build counter reset.

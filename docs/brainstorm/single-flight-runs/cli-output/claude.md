### Variant 1: Transactional check-and-insert in the core
- **Approach**: Add a guarded create path in the TS core (`cmdRunCreate` and `cmdRunRetry`) that, inside a single SQLite transaction, counts runs for the workflow whose status is in `ACTIVE_RUN_STATUSES` and aborts before insert if any exist, throwing a new `ActiveRunExistsError` carrying the offending run id. The existing `saveRun` stays the unchanged upsert for tick updates; only the create/revive entry gets the transactional guard. Editor attach adds a cheap `GET /workflows/{id}/active-run` reusing `listRunSummaries(activeOnly)`/`latestRunByWorkflow`, which `useRunPlayback` calls on mount to enter playback.
- **Trade-offs**:
  - Pro: guard lives at the single writer/owner of `runs.db`, so it covers every entry point (route, CLI, cron, retry) for free — they all funnel through core create/retry.
  - Pro: no schema migration; purely additive; `saveRun` semantics for ticks untouched.
  - Pro: error message can name the active run id naturally (it's read in the same transaction).
  - Con: race-safety depends on doing the SELECT+INSERT in one transaction with the right isolation (`BEGIN IMMEDIATE`); a careless implementation could still race.
  - Con: guard logic is imperative and must be remembered/applied consistently at both create and retry sites (DRY pressure).
- **Complexity**: medium
- **Risk**: medium

### Variant 2: Declarative partial unique index
- **Approach**: Add a partial unique index `CREATE UNIQUE INDEX ... ON runs(workflowId) WHERE status IN ('created','running','waiting')`, making "at most one active run per workflow" a DB-enforced invariant. The create/retry insert that would produce a second active run fails with `SQLITE_CONSTRAINT`, which the core catches and re-raises as `ActiveRunExistsError` (looking up the existing active run id for the message). Editor attach queries the same active-status filter on the `runs` table via a new read endpoint.
- **Trade-offs**:
  - Pro: strongest race guarantee — the database itself rejects concurrent second inserts regardless of process; no transaction-discipline reasoning required.
  - Pro: invariant is structural and self-documenting; impossible to bypass from any future entry point.
  - Con: requires a schema migration on `runs.db`, and any pre-existing duplicate active runs would block index creation until reconciled.
  - Con: `saveRun` is a single upsert used for both create and ticks — status transitions (e.g. `running`→`waiting`, or settling) must be verified not to trip the index, and the constraint error must be translated to a friendly 409 with the active run id (a second lookup after the failure).
  - Con: relying on a caught constraint violation as control flow is slightly less explicit than an up-front check.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Dedicated active-run pointer table
- **Approach**: Introduce a small `workflow_active_run(workflowId PRIMARY KEY, runId, ...)` table that the core maintains transactionally: create/retry inserts the pointer (a PK conflict means an active run already exists → `ActiveRunExistsError(runId)`), and settling a run deletes its pointer. Single-flight is enforced by the primary-key conflict; editor attach becomes an O(1) PK lookup exposed as `GET /workflows/{id}/active-run`.
- **Trade-offs**:
  - Pro: single-flight and the editor-attach lookup are served by the same purpose-built structure — attach is the cheapest possible query.
  - Pro: PK conflict gives race-safety at the DB level, like Variant 2, without overloading the `runs` table's upsert semantics.
  - Pro: cleanly separates "which run is active" from run history, so cron/CLI/route all just contend on the pointer.
  - Con: introduces a second source of truth that must stay consistent with `runs.status` — every settle/cancel/timeout path must remember to clear the pointer, or a zombie pointer wrongly blocks new runs (and the constraint says zombies must be blocked explicitly, not auto-cleared, so reconciliation logic is delicate).
  - Con: most new surface area (new table, migration, lifecycle hooks at every terminal transition).
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 1
**Rationale**: It places the guard exactly where the constraints demand — inside the core, the sole writer of `runs.db` — so all four entry points are covered through their shared create/retry path, with no schema migration and no second source of truth to keep consistent (avoiding Variant 3's zombie-pointer hazard and Variant 2's migration/dual-use-`saveRun` friction). Race-safety is achievable and bounded by using one `BEGIN IMMEDIATE` transaction for the count-and-insert, and it matches the existing additive-error-class convention (`ActiveRunExistsError`→409) and the cheap-single-query editor attach the project asks for. If even stricter race guarantees are later wanted, the partial unique index from Variant 2 can be added as a defense-in-depth backstop without reworking this design.

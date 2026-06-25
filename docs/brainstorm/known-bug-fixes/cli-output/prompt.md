# Brainstorm: Hermes Workflows KNOWN-BUG-SWEEP (single PR, 4 leaf bugs)

You are a senior software architect reviewing a bug-sweep scope for the **Hermes
Workflows** project. Produce architectural variants. DO NOT write code. DO NOT
output anything outside the requested sections.

## Project

**Hermes Workflows** — a dashboard plugin for Hermes Agent. A user draws an
automation as a graph (agent tasks, shell steps, branches, review gates, waits)
and it runs on Hermes' own primitives (Kanban cards, Cron jobs, Profiles). Not a
second engine: every node compiles to a native Hermes primitive.

Two languages by design:
- **TypeScript core on Bun** — engine, compiler, schema, CLI (`packages/core`).
- **A thin dependency-free Python bridge** — so Hermes can load the plugin
  in-process (`hermes_workflows/`). Adapts the core to the host and polls the
  board. It imports `cron.jobs as cj` (from the Hermes install) and
  `hermes_cli`.

Runtime: `node_task`/`agent_task` nodes run via a **Kanban executor** (board:
project scope → native Kanban cards driven by a dispatched worker) OR a
**DirectExecutor** (board: false / global scope → invokes the Hermes agent CLI
in oneshot `-z` mode in a DETACHED worker process).

Full gate before any commit: `bun run validate` (typecheck → lint → core tests
→ pytest → dashboard typecheck/tests/build → dist drift guard). TDD
(failing-first). Conventions: SOLID/KISS/DRY, no misleading fallbacks, no
hardcoding, English-only strings, abstract multi-language. Neutral measured
prose.

## Scope: exactly these 4 LEAF bugs, shipped together on ONE branch
(`feat/known-bug-fixes`), driven one at a time, in this dependency order:

### Bug 1 (drive FIRST): t_8179b52f — Python test suite leaks into the real cron store

Running the Python test suite on a LIVE Hermes host leaked a job named exactly
`hermes-workflows-tick` (the tick name) into the PRODUCTION cron store
(`get_hermes_home()/cron/jobs.json`), because `cron.jobs` resolves
`HERMES_DIR = get_hermes_home().resolve()` at MODULE IMPORT TIME, and derives
`CRON_DIR / JOBS_FILE / OUTPUT_DIR` as module constants from it.

The tick-arming tests set `HERMES_HOME` but the already-resolved `cj.CRON_DIR`
etc. are NOT redirected (only some tests monkeypatch the trio; the ones that
only set the env var write into whatever `get_hermes_home()` resolved at import
— i.e. the operator's real store on a live host). The leaked job then shadowed
the real tick and stalled auto-advancement of every workflow run.

Current state: the trio monkeypatch is duplicated across 8 test files
(`test_cron_bridge.py` `cron_env`, `test_py_cli.py` `home` + `_repo_local_home`,
and `test_review.py`, `test_plugin_command.py`, `test_cli_resume.py`,
`test_dashboard_schedule_routes.py`, `test_dashboard_run_routes.py`,
`test_tick_schedule_config.py`). Not all of them necessarily patch the trio
correctly — the leak path is: a cron-touching test that sets `HERMES_HOME` only.

Fix direction (from the card): sandbox `cj.CRON_DIR/JOBS_FILE/OUTPUT_DIR` via a
shared autouse fixture so no cron-touching test can write to the real store;
optionally make the bridge cron paths lazy/injectable; add a regression guard.

### Bug 2: t_1260d235 — Direct-node outcome must not be exit-code-only

In `hermes_workflows/executor/_detached_runner.py::_invoke`, an exit 0 settles
`outcome="success"`:

```python
if proc.returncode == 0:
    return dict(settled=True, outcome="success", output=_clip(stdout))
```

The Hermes agent CLI exits `0` even when its LLM call exhausts retries on a
TRANSIENT provider error (it prints `API call failed after 3 retries: HTTP 429:
The service may be temporarily overloaded` and returns cleanly). So the node is
recorded `success` with the error string as output, and the graph advances on
garbage. Real blast radius: a 429 on `lock-scope` settled success with an empty
scope and silently corrupted a whole release run.

The structured `node_outcome` override (parse `{"node_outcome":
"success"|"failure"}`) exists ONLY on the Kanban path
(`bridge/kanban.py::_node_outcome_override` reads `task_runs.metadata`), never
on the direct path.

Fix (from the card): on `returncode == 0`, scan stdout for provider-error
sentinels (`API call failed after N retries`, `HTTP 429`, `temporarily
overloaded`, `503`) and settle `failure`; AND honor a structured `node_outcome`
token on the direct path too.

### Bug 3 (depends on Bug 2): t_b30e4db8 — node-level retry with backoff for transient provider errors

A single transient provider error (429 / overloaded / 5xx) on one agent node
kills an entire long release run. No node-level retry/backoff for transient
failures today. Run defaults `max_retries: 1`. (And, separately, transient API
errors aren't even surfaced as node failures today — fixed by Bug 2.)

Fix: classify failures — transient (429, overloaded, 502/503/504, connection
reset) → retry with bounded exponential backoff (cap ~3, backoff ceiling);
deterministic (non-zero from real work, validation failure, declared
`node_outcome: failure`) → fail fast, no retry. Log each retry to node
telemetry. Applies to BOTH direct and kanban-backed agent nodes. Engine
settle-point is in `engine.py::_advance_step` where completions fold into the
node outcome (`node["outcome"] = "failure"|"success"`, `node["seq"]`).

### Bug 4: t_8d4bee60 — spec-root precedence: repo-local workflow id is shadowed by the global spec

`config.cli_spec_roots()` appends the repo-local `<cwd>/.hermes/workflows` LAST:

```python
def cli_spec_roots(cwd=None):
    roots = list(spec_roots())          # global + templates
    project = project_workflows_dir(cwd)
    if project is not None:
        roots.append(str(project))      # repo-local appended LAST
    return roots
```

Core spec resolution (`SpecStore.load`/`list-specs`) flattens roots and takes
the FIRST match. So a workflow id present in BOTH a global root and the
repo-local dir resolves to the GLOBAL spec — the repo-local copy is silently
shadowed, contradicting the repo-local discovery goal (v0.7.2 #27). Untested
today (happy-path test uses `seed_global=False`). Note `SpecStore.list()` does
`fileLists.flat()` so order across roots depends on the roots-array order.

## Your output (exact structure, nothing else)

Give exactly three sections.

### Section 1 — Variants

Exactly 3 distinct architectural variants for the COMBINED 4-bug scope (they
share cross-cutting concerns: a shared "failure classification + outcome"
contract used by Bugs 2&3, and a shared "where does the fix live" question).
For each variant:

- **Approach**: 2–3 sentences naming where each of the 4 fixes lives and how the
  four relate under this variant.
- **Trade-offs**: bullets (pro/con), concrete to THIS codebase (module names,
  the settle-point, the autouse-fixture seam, the roots order).
- **Complexity**: small | medium | large.
- **Risk**: low | medium | high.

The 3 variants MUST be genuinely distinct (e.g. one fix-everywhere-in-place, one
centralised-classifier-with-injection, one minimal-diff-each). Keep each fix's
acceptance test shape in mind (Bug 1: autouse sandbox + guard; Bug 2: exit-0
429 → failure + node_outcome token; Bug 3: transient retry-then-success +
deterministic no-retry + bounded cap; Bug 4: repo-local precedence or
reject/warn on collision + the missing test).

### Section 2 — Recommendation

Exactly one line: `Recommended: Variant N` followed by a rationale (a few
sentences) rooted in THIS project's conventions (SOLID/KISS/DRY, the validate
gate, the autouse-fixture seam in conftest.py, the single node-settle-point in
engine.py, the cli_spec_roots order).

### Section 3 — (none)

Do not add a closing section, summary, or "let me know" line.

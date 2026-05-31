# OpenSecondBrain integration

OpenSecondBrain is an optional long-term memory layer. It is never runtime
storage, and it is never a hard dependency: a workflow runs the same whether or
not O2B is present.

## Provider seam

The engine depends only on `WorkflowMemoryProvider`:

```ts
interface WorkflowMemoryProvider {
  isAvailable(): Promise<boolean>
  readContext(req): Promise<WorkflowContext>
  writeEvent(event): Promise<void>
  writeRetrospective(retro): Promise<void>
}
```

Implementations:

- `NoopMemoryProvider` (default) — reports unavailable, returns empty context,
  skips writes.
- `O2BCLIProvider` — uses the `o2b` CLI: availability via `o2b status`
  (configuration present), writes via `o2b brain note`. The CLI runner is
  injectable for testing. Note: `o2b brain doctor` is deliberately not used as
  the probe — it is a strict vault-content health check that fails on
  pre-existing content issues, which is unrelated to whether O2B is connected.

## Fail-open and redaction

`FailOpenMemoryProvider` wraps any provider and is what the engine uses:

- every write payload is passed through `redactSecrets` first (API keys, tokens,
  private keys, and `key: value` secrets are masked),
- all provider errors are swallowed, so a memory problem never fails a run,
- reads degrade to empty context and availability degrades to false.

## What is written

Only useful, low-volume events — never every micro-step. The engine emits these
on lifecycle transitions, idempotent per `(run, event)` via the run's persisted
`notified` markers (so a run that stays terminal across ticks writes once):

- `run_completed` — on a completed run (`write_run_summaries`).
- a post-run `workflow_retrospective` (the main value) — on any terminal run,
  completed or failed (`write_run_summaries`). The retrospective markdown
  (workflow, project, result, What happened / Decisions / Problems / Useful
  signals / Follow-up — the §22.6 structure from the autonomous-loop design
  spec) is built in the core from the run state.
- `node_failed` — one per newly failed node (`write_node_failures`).
- `run_started` — a granular per-run start event, quiet by default
  (`write_node_events`).

## Write path

The Python engine never holds an O2B client. It writes through the core
`memory-event` / `memory-retro` CLI commands, which resolve the provider from
the workflow's `defaults.memory` and write fail-open — so the provider rules and
the retrospective builder stay in one place (the TypeScript core), not
duplicated in the orchestrator.

## Settings (enforced)

The engine honours the `open_second_brain.*` settings:

- `mode` — `auto` / `open_second_brain` enable writes (and pick the provider);
  `none` disables all memory writes.
- `write_run_summaries` — `run_completed` + the retrospective.
- `write_node_failures` — the per-node `node_failed` events.
- `write_node_events` — the granular `run_started` event (off by default).

`fail_open` is the per-workflow provider concern (`defaults.memory.fail_open`),
not an engine knob, so it is not listed as engine-enforced. Reading O2B context
into a run (`readContext`) is out of scope here — this is writes only.

## Detection modes

`disabled` · `auto` (detect via the `o2b` CLI) · explicitly configured. When O2B
is absent the dashboard badge reads "not connected" and the run proceeds
normally. The MCP-based provider is a later addition.

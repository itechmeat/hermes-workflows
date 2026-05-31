/**
 * Resolve a workflow's memory provider from its `defaults.memory` block. This
 * is the single place the provider is chosen, so the engine (via the core CLI)
 * and any direct caller agree on the rules:
 *
 *   - `none`               → a no-op provider; writes are silently dropped.
 *   - `auto` / `open_second_brain` → the Open Second Brain CLI provider.
 *
 * `auto` and `open_second_brain` behave identically at write time: the O2B CLI
 * provider already no-ops cleanly when O2B is absent, and fail-open swallows any
 * error, so probing availability first would add a call without changing the
 * outcome. The distinction matters only for context *reads*, which are out of
 * scope here.
 *
 * Redaction is always applied (a security invariant, independent of fail_open):
 * the base provider is wrapped in {@link RedactingMemoryProvider} before the
 * fail-open decision, so even `fail_open: false` never writes un-redacted
 * payloads. `fail_open` (default true) then additionally wraps it so a memory
 * error never fails a run.
 */

import type { MemoryDefaults } from "../schema/workflow.ts";
import type { WorkflowMemoryProvider } from "./MemoryProvider.ts";
import { NoopMemoryProvider } from "./NoopMemoryProvider.ts";
import { O2BCLIProvider } from "./O2BCLIProvider.ts";
import type { CliRunner } from "./O2BCLIProvider.ts";
import { FailOpenMemoryProvider } from "./FailOpenMemoryProvider.ts";
import { RedactingMemoryProvider } from "./RedactingMemoryProvider.ts";

export function resolveMemoryProvider(
  defaults: MemoryDefaults = {},
  runner?: CliRunner,
): WorkflowMemoryProvider {
  if ((defaults.provider ?? "auto") === "none") return new NoopMemoryProvider();
  // An undefined runner falls back to O2BCLIProvider's default (real `o2b`).
  // Redaction wraps the base unconditionally; fail-open wraps it on top.
  const base = new RedactingMemoryProvider(new O2BCLIProvider(runner));
  return (defaults.fail_open ?? true) ? new FailOpenMemoryProvider(base) : base;
}

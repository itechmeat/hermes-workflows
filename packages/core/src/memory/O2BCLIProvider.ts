/**
 * OpenSecondBrain memory provider over the `o2b` CLI. Availability is probed
 * with `o2b status` (configuration present), not `o2b brain doctor` — the
 * latter is a strict vault-content health check that fails on pre-existing
 * content issues and so is a poor "is O2B connected" signal.
 *
 * Writes go through `o2b brain note <text> [--agent <name>]`, the CLI's
 * one-line milestone verb — its actual contract is a single positional text
 * argument (multi-line collapses to one line), NOT `--kind` / `--title` /
 * `--body` flags. We compose a readable one-line text from the event, and tag
 * the writer identity with `--agent` for provenance. The CLI runner is injected
 * so the provider is testable without a real installation.
 *
 * Reading context is a no-op in the MVP (returns empty); pulling O2B context
 * into prompts is post-MVP.
 */

import type {
  WorkflowMemoryProvider,
  WorkflowContext,
  WorkflowContextRequest,
  WorkflowMemoryEvent,
  WorkflowRetrospective,
} from "./MemoryProvider.ts";

export type CliRunner = (argv: string[]) => Promise<{ exitCode: number; stdout: string }>;

export const defaultRunner: CliRunner = async (argv) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
};

/** Identity tagged on Brain notes this provider writes, for provenance. */
const WRITER_AGENT = "hermes-workflows";

export class O2BCLIProvider implements WorkflowMemoryProvider {
  constructor(
    private readonly run: CliRunner = defaultRunner,
    private readonly bin = "o2b",
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.run([this.bin, "status"]);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async readContext(_request: WorkflowContextRequest): Promise<WorkflowContext> {
    return { entries: {} };
  }

  async writeEvent(event: WorkflowMemoryEvent): Promise<void> {
    const body = event.body.trim();
    const text = `[workflow:${event.kind}] ${event.title}${body ? ` — ${body}` : ""}`;
    await this.note(text);
  }

  async writeRetrospective(retrospective: WorkflowRetrospective): Promise<void> {
    // `brain note` is one-line (it collapses newlines), so the structured
    // markdown is recorded as a single searchable line under the title.
    await this.note(`[workflow:retrospective] ${retrospective.markdown}`);
  }

  /** Append one Brain note via the CLI's actual positional-text contract. */
  private async note(text: string): Promise<void> {
    await this.run([this.bin, "brain", "note", text, "--agent", WRITER_AGENT]);
  }
}

import { describe, expect, test } from "bun:test";

import { O2BCLIProvider } from "../src/index.ts";
import type { CliRunner } from "../src/index.ts";

function recordingRunner(exitCode = 0): { run: CliRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CliRunner = async (argv) => {
    calls.push(argv);
    return { exitCode, stdout: "" };
  };
  return { run, calls };
}

const throwingRunner: CliRunner = async () => {
  throw new Error("o2b not found");
};

describe("O2BCLIProvider", () => {
  test("isAvailable probes `o2b status` and reflects its exit code", async () => {
    const ok = recordingRunner(0);
    expect(await new O2BCLIProvider(ok.run).isAvailable()).toBe(true);
    expect(ok.calls[0]).toEqual(["o2b", "status"]);
    expect(await new O2BCLIProvider(recordingRunner(1).run).isAvailable()).toBe(false);
  });

  test("isAvailable is false when the runner throws", async () => {
    expect(await new O2BCLIProvider(throwingRunner).isAvailable()).toBe(false);
  });

  test("writeRetrospective uses the real `o2b brain note <text>` contract", async () => {
    const { run, calls } = recordingRunner();
    await new O2BCLIProvider(run).writeRetrospective({ title: "Run x", markdown: "# done" });
    // The CLI takes a single positional text arg (not --kind/--title/--body)
    // plus an --agent provenance tag. Passing flags it does not accept made
    // every write a silent no-op against the real CLI.
    expect(calls[0]).toEqual([
      "o2b",
      "brain",
      "note",
      "[workflow:retrospective] # done",
      "--agent",
      "hermes-workflows",
    ]);
  });

  test("writeEvent composes a one-line note carrying kind, title and body", async () => {
    const { run, calls } = recordingRunner();
    await new O2BCLIProvider(run).writeEvent({
      kind: "node_failed",
      title: "build failed",
      body: "boom",
    });
    const argv = calls[0] as string[];
    expect(argv.slice(0, 3)).toEqual(["o2b", "brain", "note"]);
    // No unsupported flags reach the CLI.
    expect(argv).not.toContain("--kind");
    expect(argv).not.toContain("--title");
    expect(argv).not.toContain("--body");
    expect(argv[3]).toBe("[workflow:node_failed] build failed — boom");
    expect(argv).toEqual(expect.arrayContaining(["--agent", "hermes-workflows"]));
  });

  test("writeEvent omits the dash when the body is empty", async () => {
    const { run, calls } = recordingRunner();
    await new O2BCLIProvider(run).writeEvent({
      kind: "run_started",
      title: "wf run x started",
      body: "",
    });
    expect((calls[0] as string[])[3]).toBe("[workflow:run_started] wf run x started");
  });
});

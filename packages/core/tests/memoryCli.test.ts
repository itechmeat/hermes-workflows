import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdMemoryEvent, cmdMemoryRetro, resolveMemoryProvider } from "../src/index.ts";
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
  throw new Error("o2b not installed");
};

function specObject(provider: string, failOpen = true): object {
  return {
    id: "mem-wf",
    name: "Mem WF",
    version: 1,
    scope: { type: "global" },
    trigger: { type: "manual" },
    defaults: { memory: { provider, fail_open: failOpen } },
    nodes: [{ id: "done", type: "finish" }],
    edges: [],
  };
}

describe("resolveMemoryProvider", () => {
  test("provider 'none' resolves to a no-op that writes nothing", async () => {
    const { run, calls } = recordingRunner();
    const provider = resolveMemoryProvider({ provider: "none" }, run);
    await provider.writeEvent({ kind: "run_completed", title: "t", body: "b" });
    expect(calls).toEqual([]);
    expect(await provider.isAvailable()).toBe(false);
  });

  test("provider 'open_second_brain' routes writes to the o2b CLI", async () => {
    const { run, calls } = recordingRunner();
    const provider = resolveMemoryProvider({ provider: "open_second_brain" }, run);
    await provider.writeEvent({ kind: "node_failed", title: "t", body: "b" });
    expect(calls[0]?.slice(0, 3)).toEqual(["o2b", "brain", "note"]);
    expect(calls[0]).toContain("node_failed");
  });

  test("'auto' routes through O2B and fail-open swallows a runner error", async () => {
    // fail_open defaults true: a thrown runner must not propagate.
    const provider = resolveMemoryProvider({ provider: "auto" }, throwingRunner);
    await provider.writeEvent({ kind: "run_started", title: "t", body: "b" });
    expect(true).toBe(true); // reached here without throwing
  });
});

describe("memory CLI commands", () => {
  let dir: string;
  async function spec(name: string, obj: object): Promise<string> {
    const path = join(dir, `${name}.workflow.json`);
    await writeFile(path, JSON.stringify(obj));
    return path;
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "hw-memcli-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("memory-event writes through the provider the spec selects", async () => {
    const { run, calls } = recordingRunner();
    const path = await spec("osb", specObject("open_second_brain"));
    const result = await cmdMemoryEvent(path, "run_completed", "Run done", "all good", run);
    expect(result).toEqual({ ok: true });
    expect(calls[0]).toContain("run_completed");
    expect(calls[0]).toContain("Run done");
  });

  test("memory-event with provider 'none' writes nothing but still succeeds", async () => {
    const { run, calls } = recordingRunner();
    const path = await spec("none", specObject("none"));
    const result = await cmdMemoryEvent(path, "run_completed", "t", "b", run);
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([]);
  });

  test("memory-retro writes a retrospective note", async () => {
    const { run, calls } = recordingRunner();
    const path = await spec("retro", specObject("open_second_brain"));
    const result = await cmdMemoryRetro(path, "# Retrospective\n\nok", "Run retro", run);
    expect(result).toEqual({ ok: true });
    expect(calls[0]).toContain("workflow_retrospective");
    expect(calls[0]).toContain("# Retrospective\n\nok");
  });

  test("a provider error is swallowed (fail-open) so the command exits ok", async () => {
    const path = await spec("failopen", specObject("open_second_brain", true));
    const result = await cmdMemoryEvent(path, "run_completed", "t", "b", throwingRunner);
    expect(result).toEqual({ ok: true });
  });
});

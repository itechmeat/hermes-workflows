import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cmdMemoryEvent,
  cmdMemoryRetro,
  cmdMemoryRetroFromRun,
  createRunState,
  fromObject,
  resolveMemoryProvider,
} from "../src/index.ts";
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
    expect(calls[0]?.[3]).toContain("node_failed");
  });

  test("redacts secrets even when fail_open is false (redaction is unconditional)", async () => {
    const { run, calls } = recordingRunner();
    const provider = resolveMemoryProvider(
      { provider: "open_second_brain", fail_open: false },
      run,
    );
    await provider.writeEvent({
      kind: "node_failed",
      title: "t",
      body: "token: ghp_ABCDEFGHIJKLMNOPQRSTU",
    });
    const text = calls[0]?.[3] ?? ""; // positional note text
    expect(text).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTU");
    expect(text).toContain("[REDACTED]");
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
    const text = calls[0]?.[3] ?? "";
    expect(text).toContain("run_completed");
    expect(text).toContain("Run done");
    expect(text).toContain("all good");
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
    const text = calls[0]?.[3] ?? "";
    expect(text).toContain("[workflow:retrospective]");
    expect(text).toContain("# Retrospective\n\nok");
  });

  test("memory-retro from a run file builds the retrospective and writes it", async () => {
    const { run, calls } = recordingRunner();
    const { workflow } = fromObject({
      ...specObject("open_second_brain"),
      id: "retro-run",
      name: "Retro Run",
    });
    const path = await spec("retro-run", {
      ...specObject("open_second_brain"),
      id: "retro-run",
      name: "Retro Run",
    });
    const runState = createRunState(workflow, "rr-1");
    runState.status = "completed";
    runState.nodes["done"] = { node_id: "done", status: "completed", seq: 1 };

    const result = await cmdMemoryRetroFromRun(path, runState, undefined, run);
    expect(result).toEqual({ ok: true });
    // the note text carries the kind tag and the built retrospective markdown
    const text = calls[0]?.[3] ?? "";
    expect(text).toContain("[workflow:retrospective]");
    expect(text).toContain("rr-1");
    expect(text).toContain("Result");
  });

  test("a provider error is swallowed (fail-open) so the command exits ok", async () => {
    const path = await spec("failopen", specObject("open_second_brain", true));
    const result = await cmdMemoryEvent(path, "run_completed", "t", "b", throwingRunner);
    expect(result).toEqual({ ok: true });
  });
});

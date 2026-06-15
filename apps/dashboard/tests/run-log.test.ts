import { describe, it, expect } from "vitest";
import { deriveRunLogEvents, mergeRunLog } from "../src/run/runLog";
import type { RunState } from "../src/api/types";

function run(over: Partial<RunState> = {}): RunState {
  return {
    run_id: "r1",
    workflow_id: "wf",
    workflow_version: 1,
    status: "running",
    nodes: {},
    ...over,
  };
}

describe("deriveRunLogEvents", () => {
  it("leads with the run start, including the operator input", () => {
    const events = deriveRunLogEvents(run({ input: "take 2 tasks" }));
    expect(events[0]).toEqual({
      key: "run:started",
      label: "Run started with input: take 2 tasks",
    });
  });

  it("logs settled nodes and a resolved gate in completion order", () => {
    const events = deriveRunLogEvents(
      run({
        nodes: {
          plan: { node_id: "plan", status: "completed", outcome: "success", seq: 1 },
          gate: { node_id: "gate", status: "completed", review_decision: "approved", seq: 2 },
          build: { node_id: "build", status: "completed", outcome: "failure", seq: 3 },
        },
      }),
    );
    expect(events.map((e) => e.label)).toEqual([
      "Run started",
      "plan completed",
      'Gate "gate" resolved: approved',
      "build failed",
    ]);
  });

  it("surfaces a waiting gate and the terminal outcome", () => {
    const waiting = deriveRunLogEvents(
      run({
        status: "waiting",
        nodes: { gate: { node_id: "gate", status: "waiting_for_review" } },
      }),
    );
    expect(waiting.some((e) => e.label === 'Waiting for review at "gate"')).toBe(true);

    const done = deriveRunLogEvents(run({ status: "completed" }));
    expect(done.at(-1)).toEqual({ key: "run:completed", label: "Run completed" });
  });

  it("never includes internal/server signals (run state carries none)", () => {
    const labels = deriveRunLogEvents(
      run({ nodes: { a: { node_id: "a", status: "running" } } }),
    ).map((e) => e.label.toLowerCase());
    expect(labels.some((l) => /heartbeat|dispatch|lock|subscription/.test(l))).toBe(false);
  });
});

describe("mergeRunLog", () => {
  it("appends only new events, stamped, keeping prior entries and order", () => {
    const first = mergeRunLog([], [{ key: "run:started", label: "Run started" }], 1000);
    expect(first).toEqual([{ key: "run:started", label: "Run started", at: 1000 }]);

    const second = mergeRunLog(
      first,
      [
        { key: "run:started", label: "Run started" },
        { key: "node:a:success", label: "a completed" },
      ],
      2000,
    );
    expect(second).toEqual([
      { key: "run:started", label: "Run started", at: 1000 },
      { key: "node:a:success", label: "a completed", at: 2000 },
    ]);
  });

  it("returns the same array reference when nothing is new (no re-render churn)", () => {
    const prev = mergeRunLog([], [{ key: "run:started", label: "Run started" }], 1000);
    const again = mergeRunLog(prev, [{ key: "run:started", label: "Run started" }], 5000);
    expect(again).toBe(prev);
  });
});

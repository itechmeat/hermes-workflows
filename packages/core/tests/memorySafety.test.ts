import { describe, expect, test } from "bun:test";

import { redactSecrets, FailOpenMemoryProvider, NoopMemoryProvider } from "../src/index.ts";
import type {
  WorkflowMemoryProvider,
  WorkflowRetrospective,
  WorkflowContextRequest,
} from "../src/index.ts";

describe("redactSecrets", () => {
  test("masks API-key, token, and private-key shapes", () => {
    const text = [
      "openai sk-ABCDEFGHIJKLMNOPQRSTUVWX",
      "github ghp_ABCDEFGHIJKLMNOPQRSTU",
      "aws AKIAIOSFODNN7EXAMPLE",
      "password: hunter2",
      "-----BEGIN PRIVATE KEY-----\nMIIBVg\n-----END PRIVATE KEY-----",
    ].join("\n");
    const out = redactSecrets(text);
    expect(out).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(out).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTU");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("MIIBVg");
    expect(out).toContain("[REDACTED]");
  });

  test("leaves ordinary prose untouched", () => {
    expect(redactSecrets("Implemented the feature and ran tests.")).toBe(
      "Implemented the feature and ran tests.",
    );
  });
});

class ThrowingProvider implements WorkflowMemoryProvider {
  received: WorkflowRetrospective[] = [];
  async isAvailable(): Promise<boolean> {
    throw new Error("down");
  }
  async readContext(_r: WorkflowContextRequest): Promise<never> {
    throw new Error("down");
  }
  async writeEvent(): Promise<void> {
    throw new Error("down");
  }
  async writeRetrospective(): Promise<void> {
    throw new Error("down");
  }
}

class CapturingProvider extends NoopMemoryProvider {
  last?: WorkflowRetrospective;
  override async writeRetrospective(retro: WorkflowRetrospective): Promise<void> {
    this.last = retro;
  }
}

describe("FailOpenMemoryProvider", () => {
  test("swallows provider errors so the run never fails", async () => {
    const provider = new FailOpenMemoryProvider(new ThrowingProvider());
    await provider.writeRetrospective({ title: "t", markdown: "m" });
    await provider.writeEvent({ kind: "run_completed", title: "t", body: "b" });
    expect(await provider.isAvailable()).toBe(false);
    expect(await provider.readContext({ workflow_id: "w" })).toEqual({ entries: {} });
  });

  test("redacts secrets before delegating writes", async () => {
    const inner = new CapturingProvider();
    const provider = new FailOpenMemoryProvider(inner);
    await provider.writeRetrospective({
      title: "Run",
      markdown: "token: ghp_ABCDEFGHIJKLMNOPQRSTU",
    });
    expect(inner.last?.markdown).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTU");
    expect(inner.last?.markdown).toContain("[REDACTED]");
  });
});

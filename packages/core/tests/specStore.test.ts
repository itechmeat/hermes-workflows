import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SpecStore } from "../src/index.ts";

const examplesDir = join(import.meta.dir, "../../../examples");

let root: string;
let store: SpecStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "hw-specs-"));
  await cp(examplesDir, root, { recursive: true });
  store = new SpecStore([root]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("SpecStore", () => {
  test("lists specs found under the root", async () => {
    const ids = (await store.list()).map((s) => s.id).toSorted();
    expect(ids).toEqual(["blog-daily-signals", "feature-development"]);
  });

  test("loads a spec by id", async () => {
    const result = await store.load("feature-development");
    expect(result?.workflow.name).toBe("Feature Development");
  });

  test("summaries carry the enabled flag (absent reads as enabled)", async () => {
    const summary = (await store.list()).find((s) => s.id === "feature-development");
    // The example does not set `enabled`, so a disabled view treats it as on.
    expect(summary?.enabled).not.toBe(false);
  });

  test("returns null for an unknown id", async () => {
    expect(await store.load("nope")).toBeNull();
  });

  test("missing roots yield an empty listing", async () => {
    const empty = new SpecStore([join(root, "does-not-exist")]);
    expect(await empty.list()).toEqual([]);
  });
});

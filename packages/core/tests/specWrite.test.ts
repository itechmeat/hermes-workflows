import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fromObject, SpecStore, SpecValidationError, chooseWriteRoot } from "../src/index.ts";
import type { Workflow, UiLayout } from "../src/index.ts";

function workflow(overrides: Partial<Record<string, unknown>> = {}): Workflow {
  return fromObject({
    id: "saved",
    name: "Saved",
    version: 1,
    scope: { type: "global" },
    trigger: { type: "manual" },
    nodes: [
      { id: "plan", type: "agent_task", prompt: "do it", profile: "p" },
      { id: "done", type: "finish" },
    ],
    edges: [{ from: "plan", to: "done" }],
    ...overrides,
  }).workflow;
}

let globalRoot: string;
let templatesRoot: string;
let store: SpecStore;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "hw-write-"));
  globalRoot = join(base, "global");
  templatesRoot = join(base, "templates");
  store = new SpecStore([globalRoot, templatesRoot]);
});

afterEach(async () => {
  await rm(join(globalRoot, ".."), { recursive: true, force: true });
});

describe("chooseWriteRoot", () => {
  test("global scope -> global root", () => {
    expect(chooseWriteRoot({ type: "global" }, { global: "/g", project: "/p" })).toBe("/g");
  });
  test("project scope with a project root -> project root", () => {
    expect(chooseWriteRoot({ type: "project" }, { global: "/g", project: "/p" })).toBe("/p");
  });
  test("project scope without a project root -> global fallback", () => {
    expect(chooseWriteRoot({ type: "project" }, { global: "/g" })).toBe("/g");
  });
  test("projects scope -> global (no single project root)", () => {
    expect(chooseWriteRoot({ type: "projects" }, { global: "/g", project: "/p" })).toBe("/g");
  });
});

describe("SpecStore write path", () => {
  test("saves a valid workflow and reads it back by id with path and ui", async () => {
    const ui: UiLayout = { xyflow: { viewport: { x: 0, y: 0, zoom: 1 } } };
    const path = await store.saveWorkflow(workflow(), ui, globalRoot);
    expect(path).toBe(join(globalRoot, "saved.workflow.yaml"));

    const got = await store.getById("saved");
    expect(got?.workflow.name).toBe("Saved");
    expect(got?.ui).toEqual(ui);
    expect(got?.path).toBe(path);
  });

  test("rejects an invalid graph and writes nothing", async () => {
    const bad = workflow({
      nodes: [{ id: "done", type: "finish" }],
      edges: [{ from: "done", to: "ghost" }],
    });
    await expect(store.saveWorkflow(bad, undefined, globalRoot)).rejects.toBeInstanceOf(
      SpecValidationError,
    );
    expect(await readdir(globalRoot).catch(() => [])).not.toContain("saved.workflow.yaml");
  });

  test("validation error carries human-readable messages and structured errors", async () => {
    const bad = workflow({
      nodes: [{ id: "done", type: "finish" }],
      edges: [{ from: "done", to: "ghost" }],
    });
    const err = (await store
      .saveWorkflow(bad, undefined, globalRoot)
      .then(() => null)
      .catch((e) => e)) as SpecValidationError;
    expect(err).toBeInstanceOf(SpecValidationError);
    // The message is the operator-facing reason, not just the bare code list:
    // it includes each error's human message so a surfaced 400 is readable.
    expect(err.message).toContain("ghost");
    expect(err.message).not.toMatch(/^workflow failed validation: [a-z_]+(, [a-z_]+)*$/);
    // The structured errors stay available for a UI that renders code + message.
    expect(err.errors.length).toBeGreaterThan(0);
    expect(err.errors[0]).toHaveProperty("code");
    expect(err.errors[0]).toHaveProperty("message");
  });

  test("refuses to save a workflow whose id would escape the storage root", async () => {
    const evil = workflow({ id: "../../evil" });
    await expect(store.saveWorkflow(evil, undefined, globalRoot)).rejects.toBeInstanceOf(
      SpecValidationError,
    );
  });

  test("getById returns null for an unknown id", async () => {
    expect(await store.getById("nope")).toBeNull();
  });

  test("createWorkflow rejects a duplicate id", async () => {
    await store.createWorkflow(workflow(), undefined, globalRoot);
    await expect(store.createWorkflow(workflow(), undefined, globalRoot)).rejects.toThrow();
  });

  test("deleteSpec removes the spec", async () => {
    await store.saveWorkflow(workflow(), undefined, globalRoot);
    expect(await store.deleteSpec("saved")).toBe(true);
    expect(await store.getById("saved")).toBeNull();
    expect(await store.deleteSpec("saved")).toBe(false);
  });

  test("saving the same id into a different root keeps exactly one spec", async () => {
    await store.saveWorkflow(workflow(), undefined, templatesRoot);
    await store.saveWorkflow(workflow(), undefined, globalRoot);
    const all = await store.list();
    expect(all.filter((s) => s.id === "saved")).toHaveLength(1);
    expect((await store.getById("saved"))?.path).toBe(join(globalRoot, "saved.workflow.yaml"));
  });
});

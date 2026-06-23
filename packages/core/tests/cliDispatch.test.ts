import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "../src/cli.ts");
const example = join(import.meta.dir, "../../../examples/feature-development.workflow.yaml");
// The example's feature_request param is required (no default), so run-create
// against it must carry a real value or fail closed.
const featureParams = JSON.stringify({ feature_request: "Add a dark mode toggle" });

async function run(args: string[]): Promise<{ code: number; json: unknown; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, json: out.trim() ? JSON.parse(out) : null, stderr };
}

describe("cli.ts dispatcher", () => {
  test("validate prints a JSON result and exits 0", async () => {
    const { code, json } = await run(["validate", example]);
    expect(code).toBe(0);
    expect((json as { valid: boolean }).valid).toBe(true);
  });

  test("explain prints the workflow summary", async () => {
    const { json } = await run(["explain", example]);
    expect((json as { id: string }).id).toBe("feature-development");
  });

  test("an unknown command exits non-zero", async () => {
    const { code } = await run(["frobnicate"]);
    expect(code).not.toBe(0);
  });

  test("run-load without --db fails instead of silently using a throwaway db", async () => {
    const { code } = await run(["run-load", "--id", "x"]);
    expect(code).not.toBe(0);
  });

  test("run-create --origin persists the chat origin on the run", async () => {
    const base = await mkdtemp(join(tmpdir(), "hw-origin-cli-"));
    const db = join(base, "runs.db");
    const created = await run([
      "run-create",
      "--db",
      db,
      example,
      "--id",
      "ro-1",
      "--origin",
      "telegram:42:7",
      "--params",
      featureParams,
    ]);
    expect(created.code).toBe(0);
    expect((created.json as { origin?: string }).origin).toBe("telegram:42:7");
    const loaded = await run(["run-load", "--db", db, "--id", "ro-1"]);
    expect((loaded.json as { origin?: string }).origin).toBe("telegram:42:7");
    await rm(base, { recursive: true, force: true });
  });

  test("memory-event dispatches and exits 0 for a none-memory spec", async () => {
    const base = await mkdtemp(join(tmpdir(), "hw-mem-cli-"));
    const specFile = join(base, "none.workflow.json");
    await writeFile(
      specFile,
      JSON.stringify({
        id: "mem-none",
        name: "Mem None",
        version: 1,
        scope: { type: "global" },
        trigger: { type: "manual" },
        defaults: { memory: { provider: "none" } },
        nodes: [{ id: "done", type: "finish" }],
        edges: [],
      }),
    );
    const { code, json } = await run([
      "memory-event",
      specFile,
      "--kind",
      "run_completed",
      "--title",
      "t",
      "--body",
      "b",
    ]);
    expect(code).toBe(0);
    expect((json as { ok: boolean }).ok).toBe(true);
    await rm(base, { recursive: true, force: true });
  });

  test("run-create on the example fails closed when the required feature_request is missing", async () => {
    const base = await mkdtemp(join(tmpdir(), "hw-req-cli-"));
    const db = join(base, "runs.db");
    const refused = await run(["run-create", "--db", db, example, "--id", "req-1"]);
    expect(refused.code).not.toBe(0);
    const parsed = JSON.parse(refused.stderr) as { error: { name: string; message: string } };
    expect(parsed.error.name).toBe("ParamFillError");
    expect(parsed.error.message).toBe("missing required value: feature_request (Feature request)");
    await rm(base, { recursive: true, force: true });
  });

  test("run-create maps a duplicate active run to a structured 409-able error", async () => {
    const base = await mkdtemp(join(tmpdir(), "hw-sf-cli-"));
    const db = join(base, "runs.db");
    expect(
      (await run(["run-create", "--db", db, example, "--id", "sf-1", "--params", featureParams]))
        .code,
    ).toBe(0);

    const refused = await run([
      "run-create",
      "--db",
      db,
      example,
      "--id",
      "sf-2",
      "--params",
      featureParams,
    ]);
    expect(refused.code).not.toBe(0);
    // The Python bridge reads {error:{name,message}} from stderr and maps the
    // name to an HTTP status — ActiveRunExistsError must arrive structured.
    const parsed = JSON.parse(refused.stderr) as { error: { name: string; message: string } };
    expect(parsed.error.name).toBe("ActiveRunExistsError");
    expect(parsed.error.message).toContain("sf-1");
    await rm(base, { recursive: true, force: true });
  });

  test("run-list-summary --workflow returns only that workflow's runs", async () => {
    const base = await mkdtemp(join(tmpdir(), "hw-sf-filter-"));
    const db = join(base, "runs.db");
    const other = join(import.meta.dir, "../../../examples/blog-daily-signals.workflow.yaml");
    expect(
      (await run(["run-create", "--db", db, example, "--id", "f-1", "--params", featureParams]))
        .code,
    ).toBe(0);
    expect((await run(["run-create", "--db", db, other, "--id", "b-1"])).code).toBe(0);

    const filtered = await run([
      "run-list-summary",
      "--db",
      db,
      "--active",
      "--workflow",
      "feature-development",
    ]);
    expect(filtered.code).toBe(0);
    const rows = filtered.json as { run_id: string }[];
    expect(rows.map((r) => r.run_id)).toEqual(["f-1"]);
    await rm(base, { recursive: true, force: true });
  });

  test("run-latest maps a workflow to its created run", async () => {
    const base = await mkdtemp(join(tmpdir(), "hw-latest-cli-"));
    const db = join(base, "runs.db");
    const created = await run([
      "run-create",
      "--db",
      db,
      example,
      "--id",
      "rl-1",
      "--params",
      featureParams,
    ]);
    expect(created.code).toBe(0);
    const { code, json } = await run(["run-latest", "--db", db]);
    expect(code).toBe(0);
    expect((json as Record<string, { run_id: string }>)["feature-development"]?.run_id).toBe(
      "rl-1",
    );
    await rm(base, { recursive: true, force: true });
  });
});

describe("cli.ts dispatcher — spec write round trip", () => {
  let base: string;
  let globalRoot: string;
  let specFile: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "hw-dispatch-"));
    globalRoot = join(base, "global");
    specFile = join(base, "spec.json");
    await writeFile(
      specFile,
      JSON.stringify({
        id: "argv-made",
        name: "Argv Made",
        version: 1,
        scope: { type: "global" },
        trigger: { type: "manual" },
        nodes: [{ id: "done", type: "finish" }],
        edges: [],
        ui: { xyflow: { viewport: { x: 0, y: 0, zoom: 1 } } },
      }),
    );
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("spec-save then spec-get round-trips through argv", async () => {
    const saved = await run([
      "spec-save",
      "--roots",
      globalRoot,
      "--global-root",
      globalRoot,
      "--spec-file",
      specFile,
    ]);
    expect(saved.code).toBe(0);
    expect((saved.json as { path: string }).path.endsWith("argv-made.workflow.yaml")).toBe(true);

    const got = await run(["spec-get", "--roots", globalRoot, "--id", "argv-made"]);
    expect((got.json as { workflow: { name: string } }).workflow.name).toBe("Argv Made");
    expect((got.json as { ui: unknown }).ui).toEqual({
      xyflow: { viewport: { x: 0, y: 0, zoom: 1 } },
    });
  });
});

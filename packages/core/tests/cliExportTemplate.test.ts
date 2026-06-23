import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseWorkflow } from "../src/index.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const example = join(import.meta.dir, "../../../examples/feature-development.workflow.yaml");

async function run(args: string[]): Promise<{ code: number; json: any; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, json: out.trim() ? JSON.parse(out) : null, stderr };
}

let root: string;
let specRoot: string;
let outDir: string;
let specPath: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "hw-tpl-cli-"));
  specRoot = join(root, "specs");
  outDir = join(root, "out");
  await mkdir(specRoot, { recursive: true });
  specPath = join(specRoot, "feature-development.workflow.yaml");
  await writeFile(specPath, await readFile(example, "utf8"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const AT = "2026-06-22T12:00:00.000Z";

function exportArgs(extra: string[] = []): string[] {
  return [
    "export-template",
    "--id",
    "feature-development",
    "--roots",
    specRoot,
    "--out-dir",
    outDir,
    "--generated-at",
    AT,
    ...extra,
  ];
}

describe("cli export-template", () => {
  test("writes <id>.template.yaml and <id>.template.md and reports the bundle", async () => {
    const { code, json } = await run(exportArgs());
    expect(code).toBe(0);
    expect(json.cached).toBe(false);
    expect(json.files.yaml).toContain("feature-development.template.yaml");
    expect(json.files.md).toContain("feature-development.template.md");

    const yaml = await readFile(json.files.yaml, "utf8");
    const md = await readFile(json.files.md, "utf8");
    // No concrete bound profile values; placeholders present; still parses.
    expect(yaml).not.toContain("product-tech-lead");
    expect(yaml).toMatch(/\$\{PROFILE:/);
    expect(() => parseWorkflow(yaml)).not.toThrow();
    expect(md).toMatch(/Prerequisites/);
    expect(md).toMatch(/REQUIRED/);
  });

  test("a second export of the same version is served from cache", async () => {
    await run(exportArgs());
    const { json } = await run(exportArgs());
    expect(json.cached).toBe(true);
  });

  test("--probe reports cache status and a generation request without writing", async () => {
    await run(exportArgs());
    const probe = await run(exportArgs(["--probe"]));
    expect(probe.json.cached).toBe(true);
    // A probe never includes a generation request when cached.
    expect(probe.json.generation_request).toBeUndefined();
  });

  test("a spec edit (new spec_sha) regenerates the bundle", async () => {
    // Edit a prompt — same integer version, different spec_sha.
    const text = await readFile(specPath, "utf8");
    await writeFile(specPath, text.replace("merged feature.", "merged feature, carefully."));
    const { json } = await run(exportArgs());
    expect(json.cached).toBe(false);

    // And a probe on the fresh (now-cached) state carries no generation request.
    const probe = await run(exportArgs(["--probe"]));
    expect(probe.json.cached).toBe(true);
  });

  test("accepts AI hints from --hints-file and stamps the model", async () => {
    // Force regeneration by bumping the generator version (changes cache key).
    const hints = join(root, "hints.json");
    await writeFile(
      hints,
      JSON.stringify({
        overview: "Ships a feature end to end.",
        nodes: [{ nodeId: "plan", role: "senior planner", capability: "deep reasoning" }],
      }),
    );
    const { json } = await run(
      exportArgs(["--hints-file", hints, "--model", "some-model@prov", "--generator-version", "2"]),
    );
    expect(json.cached).toBe(false);
    const md = await readFile(json.files.md, "utf8");
    expect(md).toContain("senior planner");
    expect(md).toContain("deep reasoning");
    const yaml = await readFile(json.files.yaml, "utf8");
    expect(yaml).toContain("some-model@prov"); // recorded in the generation block
  });
});

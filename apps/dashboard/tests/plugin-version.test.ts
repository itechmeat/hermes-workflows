import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// apps/dashboard/tests -> sub-app root is one level up, repo root three.
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "../..");

function rootPackageVersion(): string {
  return (
    JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }
  ).version;
}

function manifestVersion(file: string, re: RegExp): string {
  const match = readFileSync(resolve(root, file), "utf8").match(re);
  if (match === null) throw new Error(`no version in ${file}`);
  return match[1]!;
}

describe("dashboard plugin version source", () => {
  test("the plugin manifests share one version", () => {
    // The dashboard header displays the root plugin version (asserted below),
    // so the plugin manifests must agree or the header would misreport.
    const pkg = rootPackageVersion();
    expect(manifestVersion("plugin.yaml", /^version:\s*"?([0-9]+\.[0-9]+\.[0-9]+[^"\s]*)"?/m)).toBe(
      pkg,
    );
    expect(manifestVersion("pyproject.toml", /^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+[^"]*)"/m)).toBe(
      pkg,
    );
  });

  test("the displayed version is resolved from the root manifest, not the sub-app package.json", () => {
    // Regression guard for the bug where the header showed the dashboard
    // sub-app's own semver (e.g. v0.5.1) instead of the installed plugin
    // version. The resolver must read the ROOT package.json, and vite.config
    // must use it rather than inline-reading its own package.json.
    const resolver = readFileSync(resolve(dashboard, "plugin-version.ts"), "utf8");
    expect(resolver).toMatch(/["']\.\.\/\.\.\/package\.json["']/);

    const viteConfig = readFileSync(resolve(dashboard, "vite.config.ts"), "utf8");
    expect(viteConfig).toMatch(/from\s+["']\.\/plugin-version\.ts["']/);
    expect(viteConfig).not.toMatch(/readFileSync\(\s*resolve\(here,\s*["']package\.json["']\)/);

    // The test globals must mirror the build: vitest injects the same version.
    const vitestConfig = readFileSync(resolve(dashboard, "vitest.config.ts"), "utf8");
    expect(vitestConfig).toMatch(/from\s+["']\.\/plugin-version\.ts["']/);
    expect(vitestConfig).not.toMatch(/readFileSync\(\s*resolve\(here,\s*["']package\.json["']\)/);
  });
});

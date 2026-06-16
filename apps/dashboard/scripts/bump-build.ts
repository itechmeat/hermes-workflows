#!/usr/bin/env bun
// Increment the monotonic dashboard build counter by 1.
//
// The counter lives in build-number.json and is baked into the bundle at build
// time (vite.config.ts), shown in the plugin header as `-b<n>`. It is bumped
// here, deliberately, and NOT inside `vite build`: the build must stay
// deterministic so the dist drift guard (`dashboard:check`, a plain
// `git diff --exit-code`) keeps passing when CI rebuilds. Reset to 0 on release;
// the release rebuild then makes it 1 (shown as `-b1`).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const file = resolve(here, "../build-number.json");
const data = JSON.parse(readFileSync(file, "utf8")) as { build: number };
const current = data.build;
// Fail closed on a malformed counter rather than silently resetting to 0, which
// would break the monotonic-counter contract.
if (!Number.isInteger(current) || current < 0) {
  throw new Error(
    `Invalid build counter in ${file}: expected a non-negative integer, got ${String(current)}`,
  );
}
const next = current + 1;
writeFileSync(file, `${JSON.stringify({ build: next }, null, 2)}\n`);
console.log(`dashboard build number -> ${next}`);

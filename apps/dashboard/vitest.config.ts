import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

import { PLUGIN_VERSION } from "./plugin-version.ts";

const here = import.meta.dirname;

// Mirror the build's __PLUGIN_VERSION__ inject (vite.config.ts): the displayed
// version comes from the ROOT plugin manifest (./plugin-version.ts), so
// components that render the header resolve the same value under test as in the
// shipped bundle.
const { build: PLUGIN_BUILD } = JSON.parse(
  readFileSync(resolve(here, "build-number.json"), "utf8"),
) as { build: number };

// Standalone test config. Deliberately does NOT alias `react` to the host shim:
// tests run against the real React from node_modules. The shim only applies in
// the production build (vite.config.ts), which the bundle-load test exercises by
// building and evaluating the artifact, not by importing source through Vitest.
//
// The `@hermes-workflows/core/*` alias lets tests import the core's PURE modules
// (validation, schema, graph helpers) as real runtime values — used to assert a
// seeded spec actually passes the canonical validator rather than a copy of it.
export default defineConfig({
  define: {
    __PLUGIN_VERSION__: JSON.stringify(PLUGIN_VERSION),
    __PLUGIN_BUILD__: JSON.stringify(PLUGIN_BUILD),
  },
  resolve: {
    alias: [
      {
        find: /^@hermes-workflows\/core\/(.*)$/,
        replacement: resolve(here, "../../packages/core/src/$1"),
      },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    // The bundle-load test runs a full `vite build` inside the suite; on a
    // contended machine parallel workers starve and menu-interaction tests blow
    // the default 5s timeout (observed: a different test flaking on every run,
    // all green in isolation). Sequential files plus a generous per-test
    // timeout keep the suite deterministic regardless of host load.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});

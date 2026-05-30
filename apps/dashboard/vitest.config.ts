import { defineConfig } from "vitest/config";

// Standalone test config. Deliberately does NOT alias `react` to the host shim:
// tests run against the real React from node_modules. The shim only applies in
// the production build (vite.config.ts), which the bundle-load test exercises by
// building and evaluating the artifact, not by importing source through Vitest.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});

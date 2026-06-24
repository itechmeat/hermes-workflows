import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_VERSION } from "./plugin-version.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

// The displayed plugin version (`__PLUGIN_VERSION__`) is resolved from the ROOT
// plugin manifest in ./plugin-version.ts, NOT this sub-app's package.json, so
// the dashboard header always tracks the installed plugin version. Inlined at
// build time via `define` so the bundle ships the literal, not a runtime lookup.

// Monotonic build counter, bumped deliberately by `dashboard:bump` (never inside
// this build, which must stay deterministic for the dist drift guard). Baked in
// alongside the version and shown in the header as `vX.Y.Z-bN`.
const { build: PLUGIN_BUILD } = JSON.parse(
  readFileSync(resolve(here, "build-number.json"), "utf8"),
) as { build: number };

// Single self-executing bundle for the Hermes dashboard plugin loader.
//
// The host SPA exposes its own React 19 on `window.__HERMES_PLUGIN_SDK__.React`
// but does NOT expose `react-dom`. So:
//   - `react` is aliased to a shim that re-exports the host React, so the bundle
//     ships no second React instance (hooks/context share the host's one).
//   - `react/jsx-runtime` is left as the real (production, self-contained)
//     module: it creates elements via the global `Symbol.for` element type that
//     the host React renders, pulls in no second React, and — being the
//     production runtime — emits no dev key-validation warnings.
//   - `react-dom` is bundled (pinned to the host's 19.2.x). @xyflow/react imports
//     `createPortal` from it; because the bundled react-dom imports `react`,
//     which is aliased to the same host shim, it binds to the host React.
export default defineConfig({
  resolve: {
    // Exact-match only: `react` → host shim, but leave `react/jsx-runtime` and
    // `react-dom` to resolve normally.
    alias: [{ find: /^react$/, replacement: resolve(here, "src/shims/react.ts") }],
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
    // Use the production JSX runtime (jsx/jsxs from react/jsx-runtime), not the
    // dev runtime (jsxDEV from react/jsx-dev-runtime). With NODE_ENV inlined to
    // production the dev runtime resolves to its prod stub, so emitting jsxDEV
    // calls would break at runtime.
    jsxDev: false,
  },
  // Lib builds do not inline NODE_ENV by default (they assume a downstream
  // bundler). The host loads this file directly, where `process` is undefined,
  // so react / react-dom's `process.env.NODE_ENV` checks would throw a
  // ReferenceError before register() runs. Inline it: removes the runtime
  // `process` reference and dead-code-eliminates the dev builds.
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __PLUGIN_VERSION__: JSON.stringify(PLUGIN_VERSION),
    __PLUGIN_BUILD__: JSON.stringify(PLUGIN_BUILD),
  },
  build: {
    outDir: resolve(here, "../../dashboard/dist"),
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve(here, "src/index.tsx"),
      name: "HermesWorkflowsDashboard",
      formats: ["iife"],
      fileName: () => "index.js",
      cssFileName: "index",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: "index.[ext]",
      },
    },
  },
});

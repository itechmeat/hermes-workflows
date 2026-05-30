import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

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

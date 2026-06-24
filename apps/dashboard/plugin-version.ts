import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// apps/dashboard -> repo root is two levels up.
const here = dirname(fileURLToPath(import.meta.url));

/**
 * The hermes-workflows plugin version shown in the dashboard header, before the
 * `-bN` build counter. Single source of truth is the ROOT plugin manifest
 * (`package.json`, kept in sync with `plugin.yaml` / `pyproject.toml` on
 * release), NOT this sub-app's `apps/dashboard/package.json`. The dashboard
 * ships inside the plugin and is loaded live from the working tree, so the
 * header must always reflect the installed plugin version. Resolved at config
 * load time and inlined into the bundle (vite) / test globals (vitest) via
 * `define`, so the shipped bundle carries the literal rather than a runtime read.
 */
export const PLUGIN_VERSION = (
  JSON.parse(readFileSync(resolve(here, "../../package.json"), "utf8")) as { version: string }
).version;

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as hostReact from "react";
import { render } from "@testing-library/react";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const distDir = resolve(appRoot, "../../dashboard/dist");
const distFile = resolve(distDir, "index.js");

// The T0 acceptance criterion: the editor source builds to a single
// self-executing file that, when loaded against mocked host globals, calls
// register("workflows", …) and mounts an @xyflow/react canvas on the host's
// React instance — proving the bundle shape before any real UI is built.
describe("T0 bundling spike — built plugin bundle", () => {
  let bundleSource = "";

  beforeAll(() => {
    execSync("vite build", { cwd: appRoot, stdio: "inherit" });
    bundleSource = readFileSync(distFile, "utf8");
  }, 180_000);

  it("emits a single self-executing file with no dynamic chunks", () => {
    expect(existsSync(distFile)).toBe(true);
    expect(bundleSource.length).toBeGreaterThan(1000);
    // IIFE/UMD single file — no code-splitting / dynamic import chunks.
    expect(bundleSource).not.toMatch(/\bimport\s*\(/);
  });

  it("contains no `process` reference (would ReferenceError in the browser)", () => {
    // The host loads this file directly; `process` is undefined there. react /
    // react-dom's NODE_ENV checks must be inlined at build time. jsdom defines
    // `process`, so this text guard — not the eval below — is what catches it.
    expect(bundleSource).not.toMatch(/process\.env/);
    expect(bundleSource).not.toMatch(/[^.\w]process[^.\w]/);
  });

  it("emits the xyflow stylesheet alongside the script", () => {
    expect(existsSync(resolve(distDir, "index.css"))).toBe(true);
  });

  it("registers \"workflows\" and mounts the app shell using the host React", () => {
    let reactAccessed = false;
    const registered: Record<string, unknown> = {};

    const sdk: Record<string, unknown> = {
      hooks: {},
      api: {},
      fetchJSON: async () => ({}),
      components: {},
    };
    Object.defineProperty(sdk, "React", {
      configurable: true,
      get() {
        reactAccessed = true;
        return hostReact;
      },
    });

    const win = globalThis as unknown as {
      window: Record<string, unknown>;
      __HERMES_PLUGIN_SDK__?: unknown;
      __HERMES_PLUGINS__?: unknown;
    };
    win.window.__HERMES_PLUGIN_SDK__ = sdk;
    win.window.__HERMES_PLUGINS__ = {
      register(name: string, component: unknown) {
        registered[name] = component;
      },
      registerSlot() {},
    };

    // Evaluate the IIFE bundle in this realm (jsdom window).
    new Function(bundleSource)();

    expect(reactAccessed).toBe(true);
    const App = registered.workflows;
    expect(typeof App).toBe("function");

    const { container } = render(
      hostReact.createElement(App as React.ComponentType),
    );
    // The shell mounts using the host React (the SDK React getter fired above)
    // and renders its chrome — here the Open Second Brain (O2B) indicator.
    expect(container.textContent).toContain("O2B");
  });
});

// Typed access to the Hermes dashboard host globals. The host SPA injects these
// on `window` before loading the plugin bundle.
import type { ComponentType } from "react";
import { createApiClient, type WorkflowsApi } from "./api/client";

export interface HermesPluginSdk {
  React: typeof import("react");
  hooks: Record<string, unknown>;
  api: unknown;
  fetchJSON: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  components: Record<string, ComponentType<Record<string, unknown>>>;
}

export interface HermesPluginRegistry {
  register: (name: string, component: ComponentType) => void;
  registerSlot: (slot: string, component: ComponentType) => void;
}

declare global {
  interface Window {
    __HERMES_PLUGIN_SDK__?: HermesPluginSdk;
    __HERMES_PLUGINS__?: HermesPluginRegistry;
    /** Reverse-proxy path prefix (e.g. `/hermes`), or `""` at root. The host
     *  injects it and its own `fetchJSON` already prepends it to API paths;
     *  we need it only for top-level navigation links we build ourselves. */
    __HERMES_BASE_PATH__?: string;
  }
}

/** The host's reverse-proxy path prefix, normalised to match how the host
 *  resolves it: a leading slash, no trailing slash, and `""` when served at the
 *  origin root. Use it to prefix navigation links the plugin emits directly
 *  (anything going through the host `fetchJSON` is already prefixed). */
export function getBasePath(): string {
  const raw = typeof window !== "undefined" ? (window.__HERMES_BASE_PATH__ ?? "") : "";
  if (!raw) return "";
  return (raw.startsWith("/") ? raw : `/${raw}`).replace(/\/+$/, "");
}

export function getSdk(): HermesPluginSdk {
  const sdk = window.__HERMES_PLUGIN_SDK__;
  if (!sdk) {
    throw new Error("Hermes Workflows: __HERMES_PLUGIN_SDK__ is not available.");
  }
  return sdk;
}

export function getRegistry(): HermesPluginRegistry {
  const registry = window.__HERMES_PLUGINS__;
  if (!registry) {
    throw new Error("Hermes Workflows: __HERMES_PLUGINS__ is not available.");
  }
  return registry;
}

let cachedClient: WorkflowsApi | undefined;

/** Workflows API client bound to the host's `fetchJSON`. Memoised: the client is
 *  pure over `fetchJSON` (stable on the host), and a stable identity matters —
 *  components pass it into effect dependency arrays, so a fresh object per call
 *  would re-fire load/poll effects on every render. */
export function getApiClient(): WorkflowsApi {
  cachedClient ??= createApiClient(getSdk().fetchJSON);
  return cachedClient;
}

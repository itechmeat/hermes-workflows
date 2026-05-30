// Typed access to the Hermes dashboard host globals. The host SPA injects these
// on `window` before loading the plugin bundle.
import type { ComponentType } from "react";

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
  }
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

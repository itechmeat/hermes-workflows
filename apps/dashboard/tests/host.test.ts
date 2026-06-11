import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as hostReact from "react";
import { getApiClient, getBasePath, getRegistry, getSdk } from "../src/host";

describe("host accessors", () => {
  beforeEach(() => {
    (window as unknown as { __HERMES_PLUGIN_SDK__: unknown }).__HERMES_PLUGIN_SDK__ = {
      React: hostReact,
      hooks: {},
      api: {},
      fetchJSON: async () => ({}),
      components: {},
    };
    (window as unknown as { __HERMES_PLUGINS__: unknown }).__HERMES_PLUGINS__ = {
      register() {},
      registerSlot() {},
    };
  });

  it("returns a stable API client across calls", () => {
    // A fresh client per call would re-fire effects every render (it sits in
    // effect dependency arrays), so the identity must be stable.
    expect(getApiClient()).toBe(getApiClient());
  });

  it("exposes the SDK and registry", () => {
    expect(typeof getSdk().fetchJSON).toBe("function");
    expect(typeof getRegistry().register).toBe("function");
  });
});

function setBasePath(value: string | undefined): void {
  (window as unknown as { __HERMES_BASE_PATH__?: string }).__HERMES_BASE_PATH__ = value;
}

describe("getBasePath", () => {
  afterEach(() => {
    delete (window as unknown as { __HERMES_BASE_PATH__?: string }).__HERMES_BASE_PATH__;
  });

  it("returns '' when served at the origin root (unset or empty)", () => {
    setBasePath(undefined);
    expect(getBasePath()).toBe("");
    setBasePath("");
    expect(getBasePath()).toBe("");
  });

  it("normalises a prefix to a leading slash and no trailing slash", () => {
    setBasePath("/hermes");
    expect(getBasePath()).toBe("/hermes");
    setBasePath("hermes");
    expect(getBasePath()).toBe("/hermes");
    setBasePath("/hermes/");
    expect(getBasePath()).toBe("/hermes");
    setBasePath("/mission/hermes//");
    expect(getBasePath()).toBe("/mission/hermes");
  });
});

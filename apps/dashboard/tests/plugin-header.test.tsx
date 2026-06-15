import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PluginHeader } from "../src/ui/PluginHeader";

// The header brand shows the release version AND the monotonic build number,
// formatted as `vX.Y.Z-bN`. Both come from build-time `define` injects
// (__PLUGIN_VERSION__, __PLUGIN_BUILD__) mirrored in vitest.config.ts.
function renderHeader() {
  render(
    <PluginHeader
      nav={[]}
      activeKey=""
      onNavigate={vi.fn()}
      o2bConnected={null}
      o2bInstalled={null}
      o2bBasePath=""
      leftRef={vi.fn()}
      actionsRef={vi.fn()}
    />,
  );
}

describe("PluginHeader", () => {
  it("renders the version with the build number as vX.Y.Z-bN", () => {
    renderHeader();
    const expected = `v${__PLUGIN_VERSION__}-b${__PLUGIN_BUILD__}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("carries the full product name and build in the brand tooltip", () => {
    renderHeader();
    const brand = document.querySelector(".hw-pluginbar__brand");
    expect(brand).toHaveAttribute(
      "title",
      `Hermes Workflows v${__PLUGIN_VERSION__}-b${__PLUGIN_BUILD__}`,
    );
  });
});

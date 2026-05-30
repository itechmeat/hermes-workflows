import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// @xyflow/react measures the canvas via ResizeObserver, which jsdom does not
// implement. Stub it so the editor mounts; tests assert behaviour and API
// wiring, not pixel layout.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

if (!("DOMMatrixReadOnly" in globalThis)) {
  class DOMMatrixReadOnlyStub {
    m22 = 1;
    constructor(transform?: string) {
      const match = transform?.match(/matrix\(([^)]+)\)/);
      if (match?.[1]) {
        const values = match[1].split(",").map((v) => Number.parseFloat(v.trim()));
        this.m22 = values[3] ?? 1;
      }
    }
  }
  (globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly =
    DOMMatrixReadOnlyStub;
}

afterEach(() => {
  cleanup();
});

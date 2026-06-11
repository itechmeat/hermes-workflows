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

// Base UI's portaled popups (Select) touch APIs jsdom does not implement. Stub
// the ones their open/highlight paths use so component tests can drive them;
// these are test-env shims, not product fallbacks.
if (!("matchMedia" in window)) {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener(): void {},
    removeEventListener(): void {},
    addListener(): void {},
    removeListener(): void {},
    dispatchEvent(): boolean {
      return false;
    },
  });
}
// jsdom has no PointerEvent; Base UI's Checkbox/Button dispatch one on click.
if (!("PointerEvent" in window)) {
  class PointerEventStub extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "";
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventStub;
}
const noop = (): void => {};
const returnsFalse = (): boolean => false;
if (typeof Element !== "undefined") {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= noop;
  proto.hasPointerCapture ??= returnsFalse;
  proto.setPointerCapture ??= noop;
  proto.releasePointerCapture ??= noop;
}

afterEach(() => {
  cleanup();
});

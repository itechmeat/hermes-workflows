import { useLayoutEffect, useRef } from "react";

/**
 * Size an element to fill from its top edge to the viewport bottom.
 *
 * The Hermes shell wraps plugin routes in an auto-height block (only chat/docs
 * get full-height flex treatment), so a CSS `height: 100%` collapses to content
 * height. We instead measure the element's offset from the viewport top and
 * publish `--hw-fill-height` (consumed by `.hw-root` in theme.css). Re-measures
 * on window resize and on document layout shifts (sidebar collapse, header
 * wrap, theme density change).
 *
 * `bottomGap` leaves a little breathing room above the viewport edge so the
 * host's own bottom padding still shows.
 */
export function useFillHeight(bottomGap = 8): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (): void => {
      const top = el.getBoundingClientRect().top;
      const height = Math.max(360, Math.round(window.innerHeight - top - bottomGap));
      el.style.setProperty("--hw-fill-height", `${height}px`);
    };
    apply();
    window.addEventListener("resize", apply);
    // ResizeObserver is absent in jsdom; guard so unit tests don't throw.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    ro?.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", apply);
      ro?.disconnect();
    };
  }, [bottomGap]);
  return ref;
}

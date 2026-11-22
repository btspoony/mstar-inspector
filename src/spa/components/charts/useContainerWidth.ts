import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** The designed chart face: default/static/SSR width (fixed geometry pin). */
export const DEFAULT_CHART_WIDTH = 560;

/**
 * Observes `el` and reports its measured content width (whole pixels —
 * recharts width props are integers) through `onWidth`. A zero reading
 * (hidden / detached container) is ignored so the chart never collapses
 * to zero width. No-op with a detach function when ResizeObserver is
 * unavailable (SSR face + old webviews keep the default face).
 */
export function attachWidthObserver(el: HTMLElement | null, onWidth: (width: number) => void): () => void {
  if (typeof ResizeObserver === "undefined" || !el) return () => {};
  const observer = new ResizeObserver((entries) => {
    const next = Math.round(entries[0]?.contentRect.width ?? 0);
    if (next > 0) onWidth(next);
  });
  observer.observe(el);
  return () => observer.disconnect();
}

/**
 * Returns the container ref (attach it to the box the chart should fill)
 * and the measured width — DEFAULT_CHART_WIDTH until the first nonzero
 * measurement. useLayoutEffect + the observer's initial frame keep the
 * default-width flash to the first paint at most. Mount-time capture
 * assumption: the empty-deps effect reads `ref.current` once at mount, so
 * an empty→non-empty transition never re-measures (unreachable in the
 * current composition — the page owns empty states and mounts charts only
 * with data).
 */
export function useContainerWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_CHART_WIDTH);

  useLayoutEffect(() => attachWidthObserver(ref.current, setWidth), []);

  return [ref, width];
}

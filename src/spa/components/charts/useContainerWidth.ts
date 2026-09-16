/**
 * Measured container width for the token-chart pin path (v0.3.4 round,
 * 2026-09-16): charts render at the width they actually occupy so the
 * designed 10px tick text stays true-size — the old fixed-560 svg stretched
 * by the `style={{ width: "100%", height: "auto" }}` wrapper upscaled the
 * viewBox ~1.7× on wide stat cards.
 *
 * This refines, not breaks, the knowledge pin-path
 * (spa-recharts-token-charts.md): the fixed numeric width/height props
 * remain (ResponsiveContainer stays banned); only the number's source
 * changes client-side. Static/SSR render never measures (no effects, and
 * `attachWidthObserver` no-ops when ResizeObserver is unavailable — old
 * webviews included) and keeps the designed DEFAULT_CHART_WIDTH = 560
 * face — the SSR geometry pins hold unchanged.
 */
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
 * default-width flash to the first paint at most.
 */
export function useContainerWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_CHART_WIDTH);

  useLayoutEffect(() => attachWidthObserver(ref.current, setWidth), []);

  return [ref, width];
}

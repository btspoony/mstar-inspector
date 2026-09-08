/**
 * Plan 56 T1 (AD-563): pure chart geometry for the hand-rolled SVG charts —
 * linear + band scales, nice tick selection, week-band layout, x-axis label
 * thinning, label truncation, and localized week formatting.
 *
 * Everything here is DOM-free and deterministic (no text measurement, no
 * Intl, no Date.now / Math.random) so the render components in this
 * directory only position what these functions return, and the pins in
 * tests/spa/charts.test.ts exercise the math directly.
 */
import type { Locale } from "../../../i18n";

/**
 * Linear scale over the domain [0..maxValue] onto [0..range]. An all-zero or
 * negative maxValue collapses to a constant-0 scale — bars render zero-height
 * instead of NaN/Infinity (plan AC2: 全零 series stays a coherent chart).
 */
export function linearScale(maxValue: number, range: number): (value: number) => number {
  if (!(maxValue > 0)) return () => 0;
  return (value: number) => (value / maxValue) * range;
}

/**
 * Nice y-axis ticks covering [0..maxValue]: steps from the 1/2/5×10^k ladder
 * targeting ~4 intervals, always integer steps (every chart here plots
 * counts), always starting at 0 and covering maxValue. maxValue <= 0 → [0]
 * (the honest all-zero axis).
 */
export function niceTicks(maxValue: number, target = 4): number[] {
  if (!(maxValue > 0)) return [0];
  const rawStep = maxValue / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const ladder = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = Math.max(1, ladder * magnitude);
  const top = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  return ticks;
}

/** Plotted fraction of each band slot; the rest is the gutter between weeks. */
export const BAND_RATIO = 0.7;

/**
 * Band scale over [0..count) weekly bands across `range`: returns the x of
 * each band's plot area, inset so consecutive bands keep a gutter
 * (`bandRatio` = the plotted fraction of each slot).
 */
export function bandScale(count: number, range: number, bandRatio = BAND_RATIO): (index: number) => number {
  const slot = range / Math.max(1, count);
  const bandWidth = slot * bandRatio;
  return (index: number) => index * slot + (slot - bandWidth) / 2;
}

/**
 * Within-band grouped-series geometry (AD-562: two rects per week band —
 * reviews + findings): `seriesCount` bars of width
 * `bandWidth * innerRatio / seriesCount`, laid edge to edge as a group
 * centered inside the band — so the band midpoint (the date-label anchor)
 * stays the group's center instead of drifting right by
 * `(1 - innerRatio) / 2` of the band (plan 56 QC F-002: ~37px label offset
 * on the single-week face).
 */
export function groupedBars(
  seriesCount: number,
  bandWidth: number,
  innerRatio = 0.8,
): { width: number; offsets: number[] } {
  const width = (bandWidth * innerRatio) / Math.max(1, seriesCount);
  const start = (bandWidth - width * Math.max(0, seriesCount)) / 2;
  return {
    width,
    offsets: Array.from({ length: Math.max(0, seriesCount) }, (_, series) => start + series * width),
  };
}

/** Vertical positions for horizontal-bar rows: bar `height` centered in each `rowHeight` slot. */
export function barRows(count: number, rowHeight: number, barHeight: number): Array<{ y: number; height: number }> {
  return Array.from({ length: Math.max(0, count) }, (_, row) => ({
    y: row * rowHeight + (rowHeight - barHeight) / 2,
    height: barHeight,
  }));
}

/**
 * X-axis label thinning (AD-562): up to `maxVisible` weeks keep every date
 * label; denser series label every other week (even indices — the first week
 * always stays labeled).
 */
export function thinXLabels(count: number, maxVisible = 8): number[] {
  const all = Array.from({ length: Math.max(0, count) }, (_, index) => index);
  return count > maxVisible ? all.filter((index) => index % 2 === 0) : all;
}

/** Character-count truncation with an ellipsis — deterministic (no text measurement in SSR). */
export function truncateLabel(label: string, maxChars: number): string {
  return label.length <= maxChars ? label : `${label.slice(0, maxChars - 1)}…`;
}

/**
 * Localized week_start axis label from an ISO `YYYY-MM-DD` string —
 * "M/D" (en) / "M月D日" (zh_CN). Parsed manually (no Intl) so bun SSR,
 * workerd, and the browser agree byte for byte; a non-ISO value falls back
 * to the raw string rather than throwing.
 */
export function formatWeekLabel(iso: string, locale: Locale): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return locale === "zh_CN" ? `${month}月${day}日` : `${month}/${day}`;
}

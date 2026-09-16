/**
 * Pinned cross-locale chart date label (2026-09-16 user feedback round):
 * chart axis + tooltip dates render the numeric `M/D` form (no leading
 * zeros) in EVERY locale — the locale-dependent zh date face retired with
 * the locale prop it rode in on. This shared formatter replaces the
 * byte-identical local copies in StackedBarChart (formatBucketDateLabel)
 * and TrendChart (formatWeekLabel), closing that knowledge addendum
 * residual (spa-recharts-token-charts.md).
 *
 * Parsed manually — no Intl — so bun SSR, workerd, and the browser agree
 * byte for byte; a non-ISO value falls back to the raw string rather than
 * throwing (the axis-face escape pin keeps the fallback a React text node).
 */
export function formatDateLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return `${month}/${day}`;
}

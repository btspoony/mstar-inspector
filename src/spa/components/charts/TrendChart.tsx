/**
 * Plan 63 T2 (B2/B3, AD-621): weekly trend chart on recharts — grouped
 * vertical bars (reviews + findings) per week_start bucket; recharts owns
 * the band/grouped-offset/tick geometry that charts/layout.ts used to
 * hand-compute (that module retires with this migration, no compat shims).
 * The public API is unchanged: `{ points, locale, seriesLabels, ariaLabel }`.
 *
 * Series colors (AD-561 dual-series function, AD-601 recalibration — the
 * exact plan-56 pair): reviews=blue-700, findings=amber-700, applied via
 * the shared charts.css fill classes (B3 class discipline — no
 * presentation-attribute var(), no raw hex; the 700 values are ≥3:1 vs the
 * v0.3 card faces in both themes, Δhue ≈ 169°/184°). blue-700 is a
 * data-series tone, not the link/focus duty and never brand expression.
 * The legend row above the chart keeps the plan-56 face (10×10 rounded
 * swatch + weight-500 label); the swatches are HTML spans carrying the
 * charts.css background-color twins of the series fills.
 *
 * Axes (AC1): x = week_start categories formatted by formatWeekLabel per
 * the `locale` prop (the same deterministic M/D · M月D日 formatting plan-56
 * shipped — moved here from the retired layout.ts); more than 8 weeks thin
 * to every-other labels via the axis interval (even indices — the first
 * week always stays labeled, plan-56 semantics). y = integer counts
 * (allowDecimals={false}). Both axis lines ride the gray-alpha-400 token
 * through charts.css.
 *
 * Fixed dimensions (AD-621): numeric width/height props, never
 * ResponsiveContainer. The wrapper box is stretched to the card width with
 * `style={{ width: "100%", height: "auto" }}`, so the viewBox keeps the
 * fluid face of the old h-auto w-full svg. The block keeps the plan-56
 * footprint: 24px legend row + 166px chart = 190px, plot height 142.
 *
 * Numeric coexistence (a11y floor, plan 56): per-week counts are not
 * labeled on the bars — the window totals ride the page-level summary line
 * (InsightsPage `trendSummary`, derived from the same weekly buckets)
 * alongside the y ticks and date labels, so the chart is never the
 * numbers' only carrier (plan 56 T1-PM disposition, unchanged).
 *
 * Tooltip (AC1): recharts default content with token-styled styles
 * (contentStyle/labelStyle/itemStyle — itemStyle overrides the recharts
 * default black text, dark-theme readability); the week label rides
 * labelFormatter → formatWeekLabel, and the series names come from the
 * seriesLabels prop.
 *
 * Localized copy comes in as props (legend labels from the caller's i18n
 * keys, plan 56 T2). Empty state: owned by the page (可读空态文案 per
 * plan) — empty input renders null, never a bare axis.
 */
import type { Locale } from "../../../i18n";
import { Bar as RBar, BarChart as RBarChart, Tooltip, XAxis, YAxis } from "recharts";
import "./charts.css";

export interface TrendPoint {
  week: string;
  reviews: number;
  findings: number;
}

/**
 * Localized week_start axis label from an ISO `YYYY-MM-DD` string —
 * "M/D" (en) / "M月D日" (zh_CN). Parsed manually (no Intl) so bun SSR,
 * workerd, and the browser agree byte for byte; a non-ISO value falls back
 * to the raw string rather than throwing. (Moved here from the retired
 * charts/layout.ts — this chart is its only consumer.)
 */
function formatWeekLabel(iso: string, locale: Locale): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return locale === "zh_CN" ? `${month}月${day}日` : `${month}/${day}`;
}

const WIDTH = 560;
const LEGEND_H = 24;
const CHART_H = 190 - LEGEND_H;
const PAD_TOP = 4;
const PAD_R = 8;
const AXIS_H = 20;
const Y_AXIS_W = 28;
const X_LABEL_MAX_VISIBLE = 8;

export function TrendChart({
  points,
  locale,
  seriesLabels,
  ariaLabel,
}: {
  points: TrendPoint[];
  locale: Locale;
  seriesLabels: { reviews: string; findings: string };
  ariaLabel: string;
}) {
  if (points.length === 0) return null;

  return (
    <>
      <div className="chart-legend">
        <span className="chart-legend-item">
          <span className="chart-legend-swatch chart-swatch-blue-700" aria-hidden="true" />
          <span className="chart-legend-label">{seriesLabels.reviews}</span>
        </span>
        <span className="chart-legend-item">
          <span className="chart-legend-swatch chart-swatch-amber-700" aria-hidden="true" />
          <span className="chart-legend-label">{seriesLabels.findings}</span>
        </span>
      </div>
      <RBarChart
        data={points}
        width={WIDTH}
        height={CHART_H}
        margin={{ top: PAD_TOP, right: PAD_R, bottom: 0, left: 0 }}
        className="chart-frame"
        style={{ width: "100%", height: "auto" }}
        role="img"
        {...{ "aria-label": ariaLabel }}
        title={ariaLabel}
      >
        <XAxis
          dataKey="week"
          interval={points.length > X_LABEL_MAX_VISIBLE ? 1 : 0}
          tickFormatter={(week: string) => formatWeekLabel(week, locale)}
          tickLine={false}
          height={AXIS_H}
        />
        <YAxis width={Y_AXIS_W} allowDecimals={false} tickLine={false} />
        <Tooltip
          cursor={false}
          labelFormatter={(week) => formatWeekLabel(String(week), locale)}
          contentStyle={{
            backgroundColor: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
          }}
          labelStyle={{ color: "var(--gray-1000)", fontWeight: 500 }}
          itemStyle={{ color: "var(--gray-900)" }}
        />
        <RBar dataKey="reviews" name={seriesLabels.reviews} className="chart-fill-blue-700" isAnimationActive={false} />
        <RBar
          dataKey="findings"
          name={seriesLabels.findings}
          className="chart-fill-amber-700"
          isAnimationActive={false}
        />
      </RBarChart>
    </>
  );
}

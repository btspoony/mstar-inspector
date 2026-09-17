/**
 * (AD-621): weekly trend chart on recharts — grouped
 * vertical bars (reviews + findings) per week_start bucket; recharts owns
 * the band/grouped-offset/tick geometry that charts/layout.ts used to
 * hand-compute (that module retires with this migration, no compat shims).
 * The public API is unchanged: `{ points, seriesLabels, ariaLabel }`
 * (the locale prop retired with the pinned M/D date format, 2026-09-16).
 *
 * Series colors (AD-561 dual-series function, AD-601 recalibration — the
 * exact original pair): reviews=blue-700, findings=amber-700, applied via
 * the shared charts.css fill classes (B3 class discipline — no
 * presentation-attribute var(), no raw hex; the 700 values are ≥3:1 vs the
 * v0.3 card faces in both themes, Δhue ≈ 169°/184°). blue-700 is a
 * data-series tone, not the link/focus duty and never brand expression.
 * The legend row above the chart keeps the original face (10×10 rounded
 * swatch + weight-500 label); the swatches are HTML spans carrying the
 * charts.css background-color twins of the series fills.
 *
 * Axes (AC1): x = week_start categories formatted by the shared
 * formatDateLabel (dateLabel.ts) — the pinned numeric `M/D` form in every
 * locale (2026-09-16 user-feedback pin); more than 8 weeks thin
 * to every-other labels via the axis interval (even indices — the first
 * week always stays labeled). y = integer counts
 * (allowDecimals={false}). Both axis lines ride the gray-alpha-400 token
 * through charts.css.
 *
 * Fixed dimensions (AD-621): numeric width/height props, never
 * ResponsiveContainer. The width number comes from useContainerWidth —
 * measured container width client-side, the designed 560 default on the
 * static/SSR face (v0.3.4 round: true-size rendering, no viewBox upscale).
 * The wrapper box keeps the `style={{ width: "100%", height: "auto" }}`
 * fluid face of the old h-auto w-full svg. The block keeps the original
 * footprint: 24px legend row + 166px chart = 190px, plot height 142.
 *
 * Numeric coexistence (a11y floor): per-week counts are not
 * labeled on the bars — the window totals ride the consuming page's
 * summary line (derived from the same weekly buckets the API returns in
 * `weekly_trend`, see the per-App insights face in insights-ui.test.ts)
 * alongside the y ticks and date labels, so the chart is never the
 * numbers' only carrier (unchanged).
 *
 * Tooltip (AC1): recharts default content with token-styled styles
 * (contentStyle/labelStyle/itemStyle — itemStyle overrides the recharts
 * default black text, dark-theme readability); the week label rides
 * labelFormatter → formatDateLabel, and the series names come from the
 * seriesLabels prop.
 *
 * Localized copy comes in as props (legend labels from the caller's i18n
 * keys). Empty state: owned by the page (可读空态文案) — empty input
 * renders null, never a bare axis.
 */
import { Bar as RBar, BarChart as RBarChart, Tooltip, XAxis, YAxis } from "recharts";
import "./charts.css";
import { formatDateLabel } from "./dateLabel";
import { useContainerWidth } from "./useContainerWidth";

export interface TrendPoint {
  week: string;
  reviews: number;
  findings: number;
}

const LEGEND_H = 24;
const CHART_H = 190 - LEGEND_H;
const PAD_TOP = 4;
const PAD_R = 8;
const AXIS_H = 20;
const Y_AXIS_W = 28;
const X_LABEL_MAX_VISIBLE = 8;

export function TrendChart({
  points,
  seriesLabels,
  ariaLabel,
}: {
  points: TrendPoint[];
  seriesLabels: { reviews: string; findings: string };
  ariaLabel: string;
}) {
  // Measured container width — before the empty-state return (Rules of
  // Hooks); the static/SSR face keeps the designed 560 default.
  const [containerRef, width] = useContainerWidth();

  if (points.length === 0) return null;

  return (
    <div ref={containerRef}>
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
        width={width}
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
          tickFormatter={(week: string) => formatDateLabel(week)}
          tickLine={false}
          height={AXIS_H}
        />
        <YAxis width={Y_AXIS_W} allowDecimals={false} tickLine={false} />
        <Tooltip
          cursor={false}
          labelFormatter={(week) => formatDateLabel(String(week))}
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
    </div>
  );
}

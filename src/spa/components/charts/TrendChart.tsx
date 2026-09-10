/**
 * Plan 56 T1 (AD-562/AD-563): weekly trend chart — a single chart with TWO
 * series (reviews + findings) as grouped vertical bars, two rects per week
 * band sharing one linear y scale 0..max(reviews, findings), x = week_start
 * bands. Zero polyline/point-marker math: zero-value weeks fall out as
 * zero-height rects naturally.
 *
 * Geometry (band positions, grouped offsets, tick selection, >8-week
 * every-other-date thinning) lives in ./layout as pure functions; this file
 * only positions what they return. Series colors carry the AD-561
 * dual-series function (reviews ≠ findings visually distinct), recalibrated
 * under AD-601 on the v0.3 palette: reviews→blue-700, findings→amber-700 —
 * the 700 values are v0.2-unchanged and ≥3:1 vs the card faces in both
 * themes, Δhue ≈ 169° (dark) / 184° (light). blue-700 here is a data-series
 * tone, not the link/focus duty and never brand expression (AD-601 records
 * the choice). Colors ride inline
 * `var(--token)` references on the `style` attribute (parsed as CSS
 * declarations, where var() resolves in every engine — never SVG
 * presentation attributes, SVGWG open issue 1031) into the DESIGN.md token
 * layer (src/spa/styles/tokens.css), so dark/light both resolve with zero
 * raw hex; the legend swatches use the same vars, mapping series→color.
 * Legend text carries the v0.3 label face (weight 500) and every numeral
 * (y ticks, date labels) renders tabular figures per the DESIGN.md
 * numerals rule.
 *
 * Numeric coexistence (a11y floor): per-week counts are not labeled on the
 * points — the window totals ride the page-level summary line
 * (InsightsPage `trendSummary`, derived from the same weekly buckets)
 * alongside the y ticks, so the numbers coexist with the graphic and the
 * chart is never their only carrier (plan 56 T1-PM disposition).
 *
 * Localized copy comes in as props (legend labels from the caller's i18n
 * keys, plan 56 T2); x date labels are formatted from week_start by
 * formatWeekLabel per the `locale` prop. Empty state: owned by the page
 * (可读空态文案 per plan) — empty input renders null, never a bare axis.
 */
import type { Locale } from "../../../i18n";
import { BAND_RATIO, bandScale, formatWeekLabel, groupedBars, linearScale, niceTicks, thinXLabels } from "./layout";

export interface TrendPoint {
  week: string;
  reviews: number;
  findings: number;
}

const WIDTH = 560;
const HEIGHT = 190;
const PAD_L = 28;
const PAD_R = 8;
const LEGEND_H = 24;
const AXIS_H = 20;
const PAD_TOP = 4;

const PLOT_X = PAD_L;
const PLOT_W = WIDTH - PAD_L - PAD_R;
const PLOT_Y = PAD_TOP + LEGEND_H;
const PLOT_H = HEIGHT - PLOT_Y - AXIS_H;

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

  const bandWidth = (PLOT_W / points.length) * BAND_RATIO;
  const bandX = bandScale(points.length, PLOT_W);
  const { width: barWidth, offsets } = groupedBars(2, bandWidth);
  const ticks = niceTicks(Math.max(...points.map((point) => Math.max(point.reviews, point.findings))));
  // niceTicks always returns at least [0]; groupedBars(2, …) always yields two offsets.
  const yScale = linearScale(ticks[ticks.length - 1]!, PLOT_H);
  const axisY = PLOT_Y + PLOT_H;

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-auto w-full"
    >
      <rect x={PLOT_X} y={8} width={10} height={10} rx={2} style={{ fill: "var(--blue-700)" }} />
      <text x={PLOT_X + 14} y={13} dominantBaseline="central" fontSize={11} style={{ fill: "var(--gray-900)", fontWeight: 500 }}>
        {seriesLabels.reviews}
      </text>
      <rect x={PLOT_X + 150} y={8} width={10} height={10} rx={2} style={{ fill: "var(--amber-700)" }} />
      <text x={PLOT_X + 164} y={13} dominantBaseline="central" fontSize={11} style={{ fill: "var(--gray-900)", fontWeight: 500 }}>
        {seriesLabels.findings}
      </text>
      <line x1={PLOT_X} y1={PLOT_Y} x2={PLOT_X} y2={axisY} style={{ stroke: "var(--gray-alpha-400)" }} />
      <line x1={PLOT_X} y1={axisY} x2={PLOT_X + PLOT_W} y2={axisY} style={{ stroke: "var(--gray-alpha-400)" }} />
      {ticks.map((tick) => (
        <text
          key={tick}
          x={PLOT_X - 6}
          y={axisY - yScale(tick)}
          dominantBaseline="central"
          textAnchor="end"
          fontSize={10}
          style={{ fill: "var(--gray-900)", fontVariantNumeric: "tabular-nums" }}
        >
          {tick}
        </text>
      ))}
      {points.map((point, index) => {
        const x = PLOT_X + bandX(index);
        return (
          <g key={point.week}>
            <rect
              x={x + offsets[0]!}
              y={axisY - yScale(point.reviews)}
              width={barWidth}
              height={yScale(point.reviews)}
              style={{ fill: "var(--blue-700)" }}
            />
            <rect
              x={x + offsets[1]!}
              y={axisY - yScale(point.findings)}
              width={barWidth}
              height={yScale(point.findings)}
              style={{ fill: "var(--amber-700)" }}
            />
          </g>
        );
      })}
      {thinXLabels(points.length).map((index) => {
        // thinXLabels(length) yields indices < length — defined by construction.
        const point = points[index]!;
        return (
          <text
            key={point.week}
            x={PLOT_X + bandX(index) + bandWidth / 2}
            y={HEIGHT - 6}
            textAnchor="middle"
            fontSize={10}
            style={{ fill: "var(--gray-900)", fontVariantNumeric: "tabular-nums" }}
          >
            {formatWeekLabel(point.week, locale)}
          </text>
        );
      })}
    </svg>
  );
}

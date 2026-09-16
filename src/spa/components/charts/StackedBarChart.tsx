/**
 * (AD-652/653): daily stacked bar chart — one column per
 * time bucket (day buckets for the 7/30-day windows, Monday-anchored week
 * buckets for 90d, from the additive `findings_distribution` API field),
 * each column stacked by the caller's closed `series` vocabulary (severity
 * merge-classes or category slugs). Replaces the retired aggregate
 * BarChart on the two insights stat cards.
 *
 * Component API (the chart discipline): `{ buckets, series,
 * ariaLabel }`. `buckets` = the payload's findings_distribution rows (the
 * page merges the schema-permitted "" category key into "uncategorized"
 * before passing — QC F-004 semantics, one layer down); the
 * component reads each series value as
 * `by_severity[key] ?? by_category[key] ?? 0`, so it stays generic over
 * the two distribution grids. `series` is the closed vocabulary: the PAGE
 * maps semantics → fill classes and unknown keys never enter the array —
 * the component never invents a color. Each entry renders one
 * `<Bar dataKey fillClass stackId>` in array order (first = bottom of the
 * stack = first legend item; legend order = stack order).
 *
 * Render discipline (knowledge
 * best-practices/spa-recharts-token-charts.md): fixed numeric width/height
 * + fluid wrapper (`style={{ width: "100%", height: "auto" }}`),
 * `isAnimationActive={false}` on every Bar, named recharts imports, no
 * ResponsiveContainer. The width number comes from useContainerWidth —
 * the measured container width client-side, the designed 560 default on
 * the static/SSR face (v0.3.4 round: true-size rendering, no viewBox
 * upscale on wide cards). Series colors ride charts.css `.chart-fill-*`
 * class
 * rules only — never presentation-attribute var(), never raw hex. Legend =
 * the HTML legend row (`.chart-legend` + `.chart-swatch-*`
 * background-color twins derived from the series fill classes), NOT
 * recharts `<Legend>` (architect ruling — same face as
 * TrendChart). The tooltip is the recharts default content token-styled
 * via contentStyle/labelStyle/itemStyle (itemStyle mandatory — recharts'
 * default list text is unreadable on the dark card; BarChart.tsx:123-134
 * precedent).
 *
 * A11y floor (carried across the chart rework): role=img + aria-label + svg `<title>`;
 * every bucket stays on the axis (zero-count buckets are honest grid
 * columns — time continuity, AC-C) with deterministic pinned `M/D` date
 * labels (dateLabel.ts, every locale — 2026-09-16 user-feedback pin)
 * (>8 buckets thin to every-other labels, first bucket
 * always labeled — the TrendChart semantics). Bucket totals read off the
 * y ticks and exact series counts ride the tooltip, so the chart is never
 * the numbers' only carrier; the page-level summary lines and empty states
 * are unchanged.
 *
 * Empty state: owned by the page — empty buckets or empty series render
 * null, never a bare axis.
 */
import { Bar as RBar, BarChart as RBarChart, Tooltip, XAxis, YAxis } from "recharts";
import "./charts.css";
import { formatDateLabel } from "./dateLabel";
import { useContainerWidth } from "./useContainerWidth";

/** One closed-vocabulary stacked series: the page-mapped label + fill class. */
export interface StackedSeries {
  /** Distribution grid key (`by_severity` / `by_category`). */
  key: string;
  /** Legend + tooltip name — the raw engine slug or the uncategorized i18n label. */
  label: string;
  /** charts.css fill class (`chart-fill-*`); the swatch twin derives from it. */
  fillClass: string;
}

/**
 * One findings_distribution row (AD-652 wire shape — mirrors the
 * store type and the data.ts wire guard; the dashboard leaf exports no
 * types). `granularity` is wire-required (the B3 row guard rejects a
 * drifted row) but the chart face is identical for day and week buckets.
 */
export interface DistributionBucket {
  bucket_start: string;
  granularity: "day" | "week";
  by_severity: Record<string, number>;
  by_category: Record<string, number>;
}

/** The HTML-legend swatch twin of a series fill class: chart-fill-* → chart-swatch-*. */
function swatchClass(fillClass: string): string {
  return fillClass.replace(/^chart-fill-/, "chart-swatch-");
}

const LEGEND_H = 24;
const CHART_H = 190 - LEGEND_H;
const PAD_TOP = 4;
const PAD_R = 8;
const AXIS_H = 20;
const Y_AXIS_W = 28;
const X_LABEL_MAX_VISIBLE = 8;
const STACK_ID = "findings";

export function StackedBarChart({
  buckets,
  series,
  ariaLabel,
}: {
  buckets: readonly DistributionBucket[];
  series: readonly StackedSeries[];
  ariaLabel: string;
}) {
  // Measured container width (useContainerWidth): the default-560 static/SSR
  // face client-side becomes the real container width, so the viewBox never
  // upscales and the designed 10px ticks stay true-size. Called before the
  // empty-state return (Rules of Hooks).
  const [containerRef, width] = useContainerWidth();

  if (buckets.length === 0 || series.length === 0) return null;

  // Flat rows for recharts: one column per bucket, one numeric field per
  // series key. INVARIANT: a series key lives in exactly ONE grid — the
  // severity merge-class vocabulary and the category slug vocabulary are
  // disjoint (qc fix-1). `by_severity` winning this lookup is only
  // unambiguous under that invariant: a category slug equal to a merge
  // class would silently read the severity count. The page-layer
  // disjointness pin (insights-page.test.ts, "severity and category series
  // vocabularies are disjoint") fails loudly on a constants-level
  // collision; `?? 0` keeps a missing grid cell at an honest zero.
  const data = buckets.map((bucket) => ({
    bucket_start: bucket.bucket_start,
    ...Object.fromEntries(
      series.map((s): [string, number] => [s.key, bucket.by_severity[s.key] ?? bucket.by_category[s.key] ?? 0]),
    ),
  }));

  return (
    <div ref={containerRef}>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.key} className="chart-legend-item">
            <span className={`chart-legend-swatch ${swatchClass(s.fillClass)}`} aria-hidden="true" />
            <span className="chart-legend-label">{s.label}</span>
          </span>
        ))}
      </div>
      <RBarChart
        data={data}
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
          dataKey="bucket_start"
          interval={data.length > X_LABEL_MAX_VISIBLE ? 1 : 0}
          tickFormatter={(bucket: string) => formatDateLabel(bucket)}
          tickLine={false}
          height={AXIS_H}
        />
        <YAxis width={Y_AXIS_W} allowDecimals={false} tickLine={false} />
        <Tooltip
          cursor={false}
          labelFormatter={(bucket) => formatDateLabel(String(bucket))}
          contentStyle={{
            backgroundColor: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
          }}
          labelStyle={{ color: "var(--gray-1000)", fontWeight: 500 }}
          itemStyle={{ color: "var(--gray-900)" }}
        />
        {series.map((s) => (
          <RBar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            className={s.fillClass}
            stackId={STACK_ID}
            isAnimationActive={false}
          />
        ))}
      </RBarChart>
    </div>
  );
}

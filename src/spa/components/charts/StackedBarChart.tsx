/**
 * Plan 65 T2 (B4, AD-652/653): daily stacked bar chart — one column per
 * time bucket (day buckets for the 7/30-day windows, Monday-anchored week
 * buckets for 90d, from the additive `findings_distribution` API field),
 * each column stacked by the caller's closed `series` vocabulary (severity
 * merge-classes or category slugs). Replaces the retired aggregate
 * BarChart on the two insights stat cards.
 *
 * Component API (plan-63 discipline): `{ buckets, series, locale,
 * ariaLabel }`. `buckets` = the payload's findings_distribution rows (the
 * page merges the schema-permitted "" category key into "uncategorized"
 * before passing — plan 56 QC F-004 semantics, one layer down); the
 * component reads each series value as
 * `by_severity[key] ?? by_category[key] ?? 0`, so it stays generic over
 * the two distribution grids. `series` is the closed vocabulary: the PAGE
 * maps semantics → fill classes and unknown keys never enter the array —
 * the component never invents a color. Each entry renders one
 * `<Bar dataKey fillClass stackId>` in array order (first = bottom of the
 * stack = first legend item; legend order = stack order).
 *
 * Render discipline (plan 63, knowledge
 * best-practices/spa-recharts-token-charts.md): fixed numeric width/height
 * + fluid wrapper (`style={{ width: "100%", height: "auto" }}`),
 * `isAnimationActive={false}` on every Bar, named recharts imports, no
 * ResponsiveContainer. Series colors ride charts.css `.chart-fill-*` class
 * rules only — never presentation-attribute var(), never raw hex. Legend =
 * the plan-56 HTML row (`.chart-legend` + `.chart-swatch-*`
 * background-color twins derived from the series fill classes), NOT
 * recharts `<Legend>` (architect ruling, plan 65 — same face as
 * TrendChart). The tooltip is the recharts default content token-styled
 * via contentStyle/labelStyle/itemStyle (itemStyle mandatory — recharts'
 * default list text is unreadable on the dark card; BarChart.tsx:123-134
 * precedent).
 *
 * A11y floor (plan 56 → 65): role=img + aria-label + svg `<title>`;
 * every bucket stays on the axis (zero-count buckets are honest grid
 * columns — time continuity, AC-C) with deterministic M/D · M月D日 date
 * labels per `locale` (>8 buckets thin to every-other labels, first bucket
 * always labeled — the TrendChart semantics). Bucket totals read off the
 * y ticks and exact series counts ride the tooltip, so the chart is never
 * the numbers' only carrier; the page-level summary lines and empty states
 * are unchanged.
 *
 * Empty state: owned by the page — empty buckets or empty series render
 * null, never a bare axis.
 */
import type { Locale } from "../../../i18n";
import { Bar as RBar, BarChart as RBarChart, Tooltip, XAxis, YAxis } from "recharts";
import "./charts.css";

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
 * One findings_distribution row (plan 65, AD-652 wire shape — mirrors the
 * store type; the dashboard leaf exports no types). `granularity` rides
 * the payload but the chart face is identical for day and week buckets.
 */
export interface DistributionBucket {
  bucket_start: string;
  granularity?: "day" | "week";
  by_severity: Record<string, number>;
  by_category: Record<string, number>;
}

/**
 * Localized bucket_start axis/tooltip label from an ISO `YYYY-MM-DD`
 * string — "M/D" (en) / "M月D日" (zh_CN). Parsed manually (no Intl) so bun
 * SSR, workerd, and the browser agree byte for byte; a non-ISO value falls
 * back to the raw string. Same grammar as TrendChart's formatWeekLabel —
 * kept local so TrendChart.tsx stays byte-identical (plan 65 B4).
 */
function formatBucketDateLabel(iso: string, locale: Locale): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return locale === "zh_CN" ? `${month}月${day}日` : `${month}/${day}`;
}

/** The HTML-legend swatch twin of a series fill class: chart-fill-* → chart-swatch-*. */
function swatchClass(fillClass: string): string {
  return fillClass.replace(/^chart-fill-/, "chart-swatch-");
}

const WIDTH = 560;
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
  locale,
  ariaLabel,
}: {
  buckets: readonly DistributionBucket[];
  series: readonly StackedSeries[];
  locale: Locale;
  ariaLabel: string;
}) {
  if (buckets.length === 0 || series.length === 0) return null;

  // Flat rows for recharts: one column per bucket, one numeric field per
  // series key. A key lives in exactly one grid, so `by_severity` wins the
  // lookup; `?? 0` keeps a missing grid cell at an honest zero.
  const data = buckets.map((bucket) => ({
    bucket_start: bucket.bucket_start,
    ...Object.fromEntries(
      series.map((s): [string, number] => [s.key, bucket.by_severity[s.key] ?? bucket.by_category[s.key] ?? 0]),
    ),
  }));

  return (
    <>
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
          dataKey="bucket_start"
          interval={data.length > X_LABEL_MAX_VISIBLE ? 1 : 0}
          tickFormatter={(bucket: string) => formatBucketDateLabel(bucket, locale)}
          tickLine={false}
          height={AXIS_H}
        />
        <YAxis width={Y_AXIS_W} allowDecimals={false} tickLine={false} />
        <Tooltip
          cursor={false}
          labelFormatter={(bucket) => formatBucketDateLabel(String(bucket), locale)}
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
    </>
  );
}

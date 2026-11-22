import { Bar as RBar, BarChart as RBarChart, Tooltip, XAxis, YAxis } from "recharts";
import "./charts.css";
import { chartClasses, type ChartSlot } from "./chartSlots";
import { formatDateLabel } from "./dateLabel";
import { useContainerWidth } from "./useContainerWidth";

/** One closed-vocabulary stacked series: the page-mapped label + chart slot. */
export interface StackedSeries {
  key: string;
  label: string;
  slot: ChartSlot;
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
  const [containerRef, width] = useContainerWidth();

  if (buckets.length === 0 || series.length === 0) return null;

  const data = buckets.map((bucket) => ({
    bucket_start: bucket.bucket_start,
    ...Object.fromEntries(series.map((s): [string, number] => [s.key, bucket.by_severity[s.key] ?? 0])),
  }));

  return (
    <div ref={containerRef}>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.key} className="chart-legend-item">
            <span
              className={`chart-legend-swatch ${chartClasses(s.slot).swatch}`}
              aria-hidden="true"
            />
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
            backgroundColor: "var(--surface-card)",
            border: "1px solid var(--border-default)",
            borderRadius: "6px",
          }}
          labelStyle={{ color: "var(--text-primary)", fontWeight: 500 }}
          itemStyle={{ color: "var(--text-secondary)" }}
        />
        {series.map((s) => (
          <RBar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            className={chartClasses(s.slot).fill}
            stackId={STACK_ID}
            isAnimationActive={false}
          />
        ))}
      </RBarChart>
    </div>
  );
}

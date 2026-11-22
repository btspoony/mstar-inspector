import { Bar as RBar, BarChart as RBarChart, Tooltip, XAxis, YAxis } from "recharts";
import "./charts.css";
import { chartClasses } from "./chartSlots";
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

const REVIEWS = chartClasses(5);
const FINDINGS = chartClasses(3);

export function TrendChart({
  points,
  seriesLabels,
  ariaLabel,
}: {
  points: TrendPoint[];
  seriesLabels: { reviews: string; findings: string };
  ariaLabel: string;
}) {
  const [containerRef, width] = useContainerWidth();

  if (points.length === 0) return null;

  return (
    <div ref={containerRef}>
      <div className="chart-legend">
        <span className="chart-legend-item">
          <span className={`chart-legend-swatch ${REVIEWS.swatch}`} aria-hidden="true" />
          <span className="chart-legend-label">{seriesLabels.reviews}</span>
        </span>
        <span className="chart-legend-item">
          <span className={`chart-legend-swatch ${FINDINGS.swatch}`} aria-hidden="true" />
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
            backgroundColor: "var(--surface-card)",
            border: "1px solid var(--border-default)",
            borderRadius: "6px",
          }}
          labelStyle={{ color: "var(--text-primary)", fontWeight: 500 }}
          itemStyle={{ color: "var(--text-secondary)" }}
        />
        <RBar dataKey="reviews" name={seriesLabels.reviews} className={REVIEWS.fill} isAnimationActive={false} />
        <RBar
          dataKey="findings"
          name={seriesLabels.findings}
          className={FINDINGS.fill}
          isAnimationActive={false}
        />
      </RBarChart>
    </div>
  );
}

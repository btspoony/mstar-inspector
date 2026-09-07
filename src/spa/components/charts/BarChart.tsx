/**
 * Plan 56 T1 (AD-563): horizontal count bar chart — hand-rolled SVG, zero
 * dependencies. One labeled bar per category with the count as text at the
 * bar end and a ticked x axis, so the numbers coexist with the graphic
 * (a11y floor: the chart is never the only information carrier).
 *
 * Color mechanism (AD-561 face): fills are inline `var(--token)` references
 * into the DESIGN.md token layer (`src/spa/styles/tokens.css`, imported
 * globally by main.tsx) — the same CSS-var layer pages.module.css consumes.
 * They ride the `style` attribute (parsed as CSS declarations, where var()
 * resolves in every engine) — never SVG presentation attributes, whose var()
 * handling is engine-ambiguous (SVGWG open issue 1031, documented black-fill
 * fallbacks). The shadcn semantic Tailwind classes (text-muted-foreground et
 * al) have no chart-series face, and the var chain flips with
 * :root[data-theme], so dark/light both resolve with zero raw hex here.
 * Callers pass series colors
 * per item (the severity chart supplies the locked AD-561 mapping
 * must-fix→red-700 / should-fix→amber-700 / nit→gray-700 at the page layer,
 * plan 56 T2); the default is blue-700, the neutral series tone.
 *
 * Legend: the bar-attached colored labels ARE the legend — each bar pairs
 * its color with a visible category label (颜色永非唯一载体), so no separate
 * legend block is rendered (legend is optional for this chart shape; the
 * dual-series TrendChart carries the explicit legend).
 *
 * Empty state: owned by the page (可读空态文案 per plan) — empty input
 * renders null, never a bare axis.
 */
import { barRows, linearScale, niceTicks, truncateLabel } from "./layout";

export interface BarChartItem {
  key: string;
  label: string;
  value: number;
  /** CSS color for the bar fill — pass a `var(--token)` reference (AD-561), never a raw hex. */
  color?: string;
}

const WIDTH = 560;
const LABEL_W = 110;
const LABEL_GAP = 8;
const VALUE_PAD = 40;
const ROW_H = 28;
const BAR_H = 14;
const AXIS_H = 18;
const PAD_TOP = 2;
const LABEL_MAX_CHARS = 14;

export function BarChart({ items, ariaLabel }: { items: BarChartItem[]; ariaLabel: string }) {
  if (items.length === 0) return null;

  const rows = barRows(items.length, ROW_H, BAR_H);
  const barsX = LABEL_W + LABEL_GAP;
  const plotW = WIDTH - barsX - VALUE_PAD;
  const ticks = niceTicks(Math.max(...items.map((item) => item.value)));
  // niceTicks always returns at least [0].
  const xScale = linearScale(ticks[ticks.length - 1]!, plotW);
  const height = PAD_TOP + items.length * ROW_H + AXIS_H;

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${WIDTH} ${height}`}
      className="h-auto w-full"
    >
      {items.map((item, row) => {
        // barRows(items.length) yields exactly one row per item — defined by construction.
        const { y, height: barHeight } = rows[row]!;
        const barY = PAD_TOP + y;
        const barWidth = xScale(item.value);
        return (
          <g key={item.key}>
            <text
              x={LABEL_W}
              y={barY + barHeight / 2}
              textAnchor="end"
              dominantBaseline="central"
              fontSize={11}
              style={{ fill: "var(--gray-1000)" }}
            >
              <title>{item.label}</title>
              {truncateLabel(item.label, LABEL_MAX_CHARS)}
            </text>
            <rect
              x={barsX}
              y={barY}
              width={barWidth}
              height={barHeight}
              style={{ fill: item.color ?? "var(--blue-700)" }}
            />
            <text
              x={barsX + barWidth + 6}
              y={barY + barHeight / 2}
              dominantBaseline="central"
              fontSize={11}
              style={{ fill: "var(--gray-900)" }}
            >
              {item.value}
            </text>
          </g>
        );
      })}
      <line
        x1={barsX}
        y1={PAD_TOP + items.length * ROW_H}
        x2={barsX + plotW}
        y2={PAD_TOP + items.length * ROW_H}
        style={{ stroke: "var(--gray-alpha-400)" }}
      />
      {ticks.map((tick) => (
        <text
          key={tick}
          x={barsX + xScale(tick)}
          y={PAD_TOP + items.length * ROW_H + 13}
          textAnchor="middle"
          fontSize={10}
          style={{ fill: "var(--gray-900)" }}
        >
          {tick}
        </text>
      ))}
    </svg>
  );
}

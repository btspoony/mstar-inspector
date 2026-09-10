/**
 * Plan 63 T2 (B2/B3, AD-621): horizontal count bar chart on recharts
 * (`layout="vertical"`) — recharts owns the band/scale geometry that
 * charts/layout.ts used to hand-compute; that module retires with this
 * migration (no compat shims). The public API is unchanged
 * (`{ items, ariaLabel }`, `BarChartItem` still exported) — the
 * InsightsPage consumer surface gets zero diff.
 *
 * Fixed dimensions (AD-621): numeric width/height props, never
 * ResponsiveContainer — the `renderToStaticMarkup` pin face has no DOM to
 * measure. The recharts wrapper box is stretched back to the card width
 * with `style={{ width: "100%", height: "auto" }}` (recharts merges the
 * prop over its inline box), and the svg's own `width:100%;height:100%`
 * inline styles resolve against the auto-height wrapper as the same fluid
 * face the plan-56 svg had via `h-auto w-full` + viewBox.
 *
 * Color mechanism (B3, AD-621): bar fills are CSS class rules
 * (`charts.css` `.chart-fill-* { fill: var(--token) }`) chosen from the
 * page-layer `color` prop — the same `var(--token)` references as before
 * (AD-561 mapping; AD-601-frozen families: must-fix=red-700 /
 * should-fix=amber-700 / nit=gray-700, neutral default blue-700). CSS
 * class rules are parsed as declarations, so var() resolves in every
 * engine, and they beat the presentation-attribute defaults recharts
 * stamps on its internals. Presentation-attribute var() and raw hex are
 * both banned (knowledge ui-bugs/svg-var-presentation-attributes.md;
 * no-raw-hex pin).
 *
 * A11y floor (plan 56, preserved): role=img + aria-label + `<title>` on
 * the recharts svg, per-bar counts as text (LabelList), category labels as
 * visible tick text — truncated at 14 chars, with the full label readable
 * in the hover tooltip — so the chart is never the only information
 * carrier. The page-level summary lines around the charts are untouched.
 *
 * Tooltip (AC1): recharts default content, token-styled via
 * contentStyle/labelStyle/itemStyle (style attributes = real CSS
 * declarations, where var() is defined). itemStyle is not optional here —
 * recharts' default list style paints entry values black, which would be
 * unreadable in the dark theme. The single
 * series' name is suppressed (empty name + separator): the tooltip label
 * IS the category and the value is its count.
 *
 * Empty state: owned by the page (可读空态文案 per plan) — empty input
 * renders null, never a bare axis.
 */
import { Bar as RBar, BarChart as RBarChart, Cell, LabelList, Tooltip, XAxis, YAxis } from "recharts";
import "./charts.css";

export interface BarChartItem {
  key: string;
  label: string;
  value: number;
  /** CSS color for the bar fill — pass a `var(--token)` reference (AD-561), never a raw hex. */
  color?: string;
}

/** Character-count truncation with an ellipsis — deterministic (no text measurement in SSR). */
function truncateLabel(label: string, maxChars: number): string {
  return label.length <= maxChars ? label : `${label.slice(0, maxChars - 1)}…`;
}

/**
 * `var(--token)` reference → the charts.css fill class. Only the
 * AD-601-frozen 700-step family resolves; anything else (unknown severity
 * vocabulary, future tokens without a rule) falls back to the neutral
 * series tone — the same face the page-level mapping already produces for
 * unknown keys.
 */
const FILL_CLASSES: Record<string, string> = {
  "var(--red-700)": "chart-fill-red-700",
  "var(--amber-700)": "chart-fill-amber-700",
  "var(--gray-700)": "chart-fill-gray-700",
};
const NEUTRAL_FILL_CLASS = "chart-fill-blue-700";

function fillClass(color?: string): string {
  return (color && FILL_CLASSES[color]) || NEUTRAL_FILL_CLASS;
}

const WIDTH = 560;
const LABEL_W = 110;
const VALUE_PAD = 40;
const ROW_H = 28;
const BAR_H = 14;
const PAD_TOP = 2;
const AXIS_H = 18;
const LABEL_MAX_CHARS = 14;

export function BarChart({ items, ariaLabel }: { items: BarChartItem[]; ariaLabel: string }) {
  if (items.length === 0) return null;

  const height = PAD_TOP + items.length * ROW_H + AXIS_H;

  return (
    <RBarChart
      layout="vertical"
      data={items}
      width={WIDTH}
      height={height}
      margin={{ top: PAD_TOP, right: VALUE_PAD, bottom: 0, left: 0 }}
      className="chart-frame"
      style={{ width: "100%", height: "auto" }}
      role="img"
      {...{ "aria-label": ariaLabel }}
      title={ariaLabel}
    >
      <XAxis type="number" allowDecimals={false} tickLine={false} height={AXIS_H} />
      <YAxis
        type="category"
        dataKey="label"
        width={LABEL_W}
        axisLine={false}
        tickLine={false}
        className="chart-category-axis"
        tickFormatter={(label: string) => truncateLabel(label, LABEL_MAX_CHARS)}
      />
      <Tooltip
        cursor={false}
        separator=""
        formatter={(value) => [value, ""]}
        contentStyle={{
          backgroundColor: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: "6px",
        }}
        labelStyle={{ color: "var(--gray-1000)", fontWeight: 500 }}
        itemStyle={{ color: "var(--gray-900)" }}
      />
      <RBar dataKey="value" barSize={BAR_H} isAnimationActive={false}>
        <LabelList dataKey="value" position="right" className="chart-value-label" />
        {items.map((item) => (
          <Cell key={item.key} className={fillClass(item.color)} />
        ))}
      </RBar>
    </RBarChart>
  );
}

/**
 * Metric band (DESIGN.md `composition primitives`; compass D4): the r3 strip
 * under the page title, inside the header plane. Each metric is a quiet key
 * over a tabular figure; the strip is separated from the title block by one
 * hairline and its metrics from each other by one apiece — hairlines are
 * rendered separators, so the count is a markup fact (four metrics, four
 * rules: the header rule plus the three between them), never a trailing edge.
 *
 * No tone prop: a figure that needs an alert face takes it from the copy the
 * page passes in, not from a second status vocabulary beside `StatusBadge`.
 */
import { Fragment, type ReactNode } from "react";
import { Separator } from "@design-system";

export type Metric = {
  /** The metric's name — rendered uppercase in the label step. */
  key: ReactNode;
  /** The figure — tabular, so columns of numbers scan. */
  value: ReactNode;
};

export function MetricBand({ metrics }: { metrics: readonly Metric[] }) {
  if (metrics.length === 0) return null;

  return (
    <div data-slot="metric-band">
      <Separator className="bg-(--border-subtle)" />
      <div className="flex items-stretch">
        {metrics.map((metric, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <Separator
                orientation="vertical"
                className="self-stretch bg-(--border-subtle)"
              />
            ) : null}
            <div
              data-slot="metric"
              className={`flex min-w-0 flex-1 flex-col gap-1 py-(--spacing-3) pr-(--spacing-4) ${
                index > 0 ? "pl-(--spacing-4)" : ""
              }`}
            >
              <span
                data-slot="metric-key"
                className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight) uppercase text-(--text-faint)"
              >
                {metric.key}
              </span>
              <span
                data-slot="metric-value"
                className="text-(length:--typo-heading-20-size) leading-(--typo-heading-20-line) tracking-(--typo-heading-20-tracking) font-semibold tabular-nums"
              >
                {metric.value}
              </span>
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

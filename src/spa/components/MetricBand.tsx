import { Fragment, type ReactNode } from "react";
import { Separator } from "@design-system";

export type Metric = {
  key: ReactNode;
  value: ReactNode;
  tone?: "danger";
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
              className="flex min-w-0 flex-1 flex-col items-center gap-1 px-(--spacing-2) py-(--spacing-3) text-center md:px-(--spacing-6)"
            >
              <span
                data-slot="metric-key"
                className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight) uppercase text-(--text-faint) [overflow-wrap:anywhere]"
              >
                {metric.key}
              </span>
              <span
                data-slot="metric-value"
                data-tone={metric.tone}
                className={`text-(length:--typo-heading-20-size) leading-(--typo-heading-20-line) tracking-(--typo-heading-20-tracking) font-(weight:--typo-heading-20-weight) tabular-nums${
                  metric.tone === "danger" ? " text-(--tone-danger-fg)" : ""
                }`}
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

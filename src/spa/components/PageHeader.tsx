/**
 * Page header band (DESIGN.md `composition primitives`; compass D4): the ONE
 * spelling of the page title face — now on its own plane, the r3 band that
 * separates chrome from content (`surface-shell` + a `border-subtle` rule at
 * the foot), with the two slots pages vary on (a subtitle line and an action
 * cluster) and the wayfinding link above the title. The metric band rides the
 * same plane through the `metrics` slot, so a page composes the whole head
 * instead of stacking two strips.
 *
 * Purely presentational: pages resolve `t()` and own their controls; nothing
 * here reads data.
 */
import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
  backLink,
  metrics,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Beside the title, top-aligned with it. */
  actions?: ReactNode;
  /** Above the title: the page's wayfinding link. */
  backLink?: ReactNode;
  /** The `MetricBand`, on this same plane. */
  metrics?: ReactNode;
}) {
  return (
    <header
      data-slot="page-header"
      className="flex flex-col border-b border-(--border-subtle) bg-(--surface-shell)"
    >
      <div className="flex flex-col gap-3 px-(--spacing-6) pt-(--spacing-6) pb-(--spacing-4)">
        {backLink}
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-start justify-between gap-(--spacing-4)">
            <h1
              data-slot="page-header-title"
              className="font-semibold text-(length:--typo-heading-24-size) leading-(--typo-heading-24-line) tracking-(--typo-heading-24-tracking)"
            >
              {title}
            </h1>
            {actions}
          </div>
          {description ? (
            <p
              data-slot="page-header-subtitle"
              className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight) text-(--text-muted)"
            >
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {metrics}
    </header>
  );
}

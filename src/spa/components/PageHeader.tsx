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
  actions?: ReactNode;
  backLink?: ReactNode;
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

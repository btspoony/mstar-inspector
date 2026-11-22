import type { ReactNode } from "react";

import { cn } from "../cn";

export function FlowSection({
  title,
  subtitle,
  className,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section
      data-slot="flow-section"
      className={cn(
        "flex flex-col gap-3 border-b border-(--border-subtle) pt-4 pb-4 first:pt-1 last:border-b-0 last:pb-0",
        className,
      )}
    >
      <div
        data-slot="flow-section-header"
        className="flex flex-wrap items-baseline justify-between gap-x-3.5 gap-y-1"
      >
        <h2 className="text-(length:--typo-heading-16-size) leading-(--typo-heading-16-line) tracking-(--typo-heading-16-tracking) font-(weight:--typo-heading-16-weight) text-(--text-primary)">
          {title}
        </h2>
        {subtitle ? (
          <p className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight) text-(--text-muted)">
            {subtitle}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The detail-page section flow (r3 baseline § 5): one content plane divided
 * by hairlines, instead of a card per section.
 *
 * A page that stacks section cards gives every block the same frame, so
 * nothing reads as the page's own structure. The flow keeps the plane the page
 * already paints (`surface-page`) and separates sections with the quietest
 * hairline — no fill, no radius, no elevation. A card stays reserved for an
 * object that has to be framed: a table, a code block, an overlay.
 *
 * Sections are direct siblings on that plane; the first and last edges are
 * trimmed so the flow meets the page's own padding without a doubled gap.
 * Purely presentational — the page resolves `t()` and passes the title,
 * subtitle and body in.
 */
import type { ReactNode } from "react";

import { cn } from "../cn";

export function FlowSection({
  title,
  subtitle,
  className,
  children,
}: {
  title: ReactNode;
  /** Optional one-line summary, set on the muted label step. */
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

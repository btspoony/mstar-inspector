/**
 * Page header idiom: the ONE spelling of the page title face (DESIGN.md
 * heading-24 = page title), plus the two slots pages vary on — a description
 * line under the title and an action cluster beside it — and the wayfinding
 * link above it. Purely presentational: pages resolve `t()` and own their
 * controls; nothing here reads data.
 *
 * Both shipped header shapes compose through it unchanged: title + right-side
 * action (Apps) and title + description (Members / Support / Workspace setup).
 */
import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
  backLink,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Beside the title, baseline-aligned with it. */
  actions?: ReactNode;
  /** Above the title: the page's wayfinding link. */
  backLink?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3">
      {backLink}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="font-semibold text-(length:--typo-heading-24-size) leading-(--typo-heading-24-line) tracking-(--typo-heading-24-tracking)">
            {title}
          </h1>
          {actions}
        </div>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
    </header>
  );
}

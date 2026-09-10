/**
 * Composed empty state (plan 57 T4 / AD-582): a guidance view — optional
 * icon chip, title line, description, optional action slot — on the
 * restyled Card surface, replacing the old bordered single-line box.
 * Purely presentational: pages resolve `t()` themselves and pass
 * localized strings/nodes; the icon is a lucide node chosen per consumer.
 * Page-level only — op-outcome notices stay on `PageNotice`.
 */
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card data-slot="empty-state" className="items-center gap-4 px-6 py-12 text-center">
      {icon ? (
        <div
          data-slot="empty-state-icon"
          className="flex size-12 items-center justify-center rounded-full bg-accent text-muted-foreground [&_svg]:size-6"
        >
          {icon}
        </div>
      ) : null}
      <p data-slot="empty-state-title" className="text-lg font-semibold">
        {title}
      </p>
      {description ? (
        <p data-slot="empty-state-description" className="max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? (
        <div data-slot="empty-state-action" className="mt-2">
          {action}
        </div>
      ) : null}
    </Card>
  );
}

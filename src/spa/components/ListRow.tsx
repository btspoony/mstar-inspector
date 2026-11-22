import type { ReactNode } from "react";
import { cn } from "@design-system";

export function ListRowGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="list-row-group"
      className={cn(
        "flex flex-col divide-y divide-(--border-subtle) overflow-hidden rounded-(--radius-control) border border-(--border-default)",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ListRow({
  identity,
  status,
  meta,
  actions,
}: {
  identity: ReactNode;
  status?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      data-slot="list-row"
      className="flex h-(--row-h-compact) items-center gap-3 bg-(--surface-inset) px-3"
    >
      <span
        data-slot="list-row-identity"
        className="min-w-19 font-mono text-(length:--typo-label-14-size) leading-(--typo-label-14-line) tracking-(--typo-label-14-tracking) font-(weight:--typo-label-14-weight)"
      >
        {identity}
      </span>
      {status ? (
        <span data-slot="list-row-status" className="shrink-0">
          {status}
        </span>
      ) : null}
      {meta ? (
        <span
          data-slot="list-row-meta"
          className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight) text-(--text-muted)"
        >
          {meta}
        </span>
      ) : null}
      {actions ? (
        <span data-slot="list-row-actions" className="ml-auto flex items-center gap-(--spacing-2)">
          {actions}
        </span>
      ) : null}
    </div>
  );
}

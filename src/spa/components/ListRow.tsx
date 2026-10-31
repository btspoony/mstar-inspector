/**
 * List rows (DESIGN.md ### list-row): isomorphic rows inside a group card.
 * The container is an in-card inset on the gray-alpha-400 hairline with the
 * micro-corner exception `rounded-sm`; rows sit on gray-200, separated by a
 * 1px gray-alpha-300 hairline. Slot order is fixed identity → status → meta →
 * actions on a 12px column gap, and an omitted optional slot renders nothing.
 *
 * Purely presentational: the status slot is the caller's StatusBadge, the
 * action is the caller's small button — ghost by default, `destructive` for a
 * confirm-gated removal (DESIGN.md ### list-row) — and copy arrives through props.
 */
import type { ReactNode } from "react";
import { cn } from "@design-system";

export function ListRowGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="list-row-group"
      className={cn(
        "flex flex-col divide-y divide-(--gray-alpha-300) overflow-hidden rounded-(--rounded-sm) border border-(--gray-alpha-400)",
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
  /** The caller's StatusBadge — this shell owns no status face of its own. */
  status?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      data-slot="list-row"
      className="flex items-center gap-3 bg-(--gray-200) px-3 py-[9px]"
    >
      <span
        data-slot="list-row-identity"
        className="min-w-[76px] font-mono text-(length:--typo-label-14-size) leading-(--typo-label-14-line) tracking-(--typo-label-14-tracking) font-(weight:--typo-label-14-weight)"
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
          className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight) text-(--gray-700)"
        >
          {meta}
        </span>
      ) : null}
      {actions ? (
        <span data-slot="list-row-actions" className="ml-auto flex items-center">
          {actions}
        </span>
      ) : null}
    </div>
  );
}

import { t, type Locale } from "../../../i18n";
import { cn, Skeleton } from "@design-system";

export type SkeletonKind = "table" | "cards" | "forms";

const DEFAULT_ROWS: Record<SkeletonKind, number> = { table: 5, cards: 3, forms: 4 };

const TABLE_COLS = "grid grid-cols-[2fr_1.5fr_1.5fr_1fr] gap-4";

export function PageSkeleton({
  locale,
  kind,
  rows,
}: {
  locale: Locale;
  kind: SkeletonKind;
  rows?: number;
}) {
  const count = Math.max(0, rows ?? DEFAULT_ROWS[kind]);
  return (
    <div
      data-slot="page-skeleton"
      role="status"
      className="flex flex-col gap-6"
    >
      <span className="sr-only">{t(locale, "common.loading")}</span>
      <div aria-hidden="true" className="contents">
        <Skeleton data-slot="skeleton-heading" className="h-8 w-48" />
        {kind === "table" ? <TableShapes count={count} /> : null}
        {kind === "cards" ? <CardShapes count={count} /> : null}
        {kind === "forms" ? <FormShapes count={count} /> : null}
      </div>
    </div>
  );
}

function TableShapes({ count }: { count: number }) {
  return (
    <div data-slot="skeleton-table" className="rounded-md border border-(--border-default)">
      <div
        data-slot="skeleton-table-header"
        className={cn(TABLE_COLS, "border-b border-(--border-subtle) px-4 py-3")}
      >
        {Array.from({ length: 4 }, (_, cell) => (
          <Skeleton key={cell} className="h-4" />
        ))}
      </div>
      {Array.from({ length: count }, (_, row) => (
        <div
          key={row}
          data-slot="skeleton-table-row"
          className={cn(TABLE_COLS, "border-(--border-subtle) px-4 py-3 [&:not(:last-child)]:border-b")}
        >
          {Array.from({ length: 4 }, (_, cell) => (
            <Skeleton key={cell} className="h-4" />
          ))}
        </div>
      ))}
    </div>
  );
}

function CardShapes({ count }: { count: number }) {
  return (
    <div data-slot="skeleton-cards" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, card) => (
        <div
          key={card}
          data-slot="skeleton-card"
          className="flex flex-col gap-3 rounded-xl border border-(--border-default) p-4"
        >
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

function FormShapes({ count }: { count: number }) {
  return (
    <div data-slot="skeleton-forms" className="flex flex-col gap-5">
      {Array.from({ length: count }, (_, field) => (
        <div key={field} data-slot="skeleton-form-field" className="flex flex-col gap-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-full rounded-sm" />
        </div>
      ))}
    </div>
  );
}

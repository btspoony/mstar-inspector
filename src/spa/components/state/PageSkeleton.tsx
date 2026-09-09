/**
 * Page-level loading skeleton (plan 57 T4 / AD-582): layout-shape-matched
 * placeholder composed from the `ui/skeleton.tsx` primitive. Kind selects
 * the block idiom — a bordered table (header row + N body rows), card
 * shells, or labeled input blocks — so the page keeps its final geometry
 * while loading. Only page-level loading lives here: op-outcome notices and
 * background-reload failures stay on the `PageNotice` channel (plan 38/44).
 *
 * Accessibility: `role="status"` announces politely, and the localized
 * `common.loading` line rides a visually hidden span — the pulse bars are
 * decorative and aria-hidden (the primitive's pulse is the allowed semantic
 * loading indicator, folded under prefers-reduced-motion).
 */
import { t, type Locale } from "../../../i18n";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export type SkeletonKind = "table" | "cards" | "forms";

/** Per-kind defaults match existing page densities (AD-582). */
const DEFAULT_ROWS: Record<SkeletonKind, number> = { table: 5, cards: 3, forms: 4 };

/** Shared column rhythm for the table idiom (identity/status/health/action). */
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
  // Clamp at 0: negative rows would silently render an empty body shape and
  // 0 must stay a legal explicit "no rows" value (QC round 1 F-007).
  const count = Math.max(0, rows ?? DEFAULT_ROWS[kind]);
  return (
    <div
      data-slot="page-skeleton"
      role="status"
      className="flex flex-col gap-6"
    >
      <span className="sr-only">{t(locale, "common.loading")}</span>
      <div aria-hidden="true" className="contents">
        {/* Every dashboard page opens with the h1 heading — placeholder it. */}
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
    <div data-slot="skeleton-table" className="rounded-md border">
      <div
        data-slot="skeleton-table-header"
        className={cn(TABLE_COLS, "border-b px-4 py-3")}
      >
        {Array.from({ length: 4 }, (_, cell) => (
          <Skeleton key={cell} className="h-4" />
        ))}
      </div>
      {Array.from({ length: count }, (_, row) => (
        <div
          key={row}
          data-slot="skeleton-table-row"
          className={cn(TABLE_COLS, "px-4 py-3 [&:not(:last-child)]:border-b")}
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
          className="flex flex-col gap-3 rounded-xl border p-4"
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
          {/* Label bar above a control-height input bar (h-9 rounded-sm,
              matching the restyled ui/input primitive). */}
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-full rounded-sm" />
        </div>
      ))}
    </div>
  );
}

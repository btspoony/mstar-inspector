/**
 * Table idiom (DESIGN.md Table): ONE shell and ONE header face for every
 * dashboard table — container radius + `border-default` hairline on the shell,
 * the `surface-raised` header band at `label-12`, rows on the two named row
 * heights (`row-h-compact` header, `row-h-comfort` body) with a
 * `border-subtle` hairline. Columns and rows are render props, so each page
 * keeps its own cells (links, badges, relative times) and this file owns no
 * data.
 *
 * A cell may be composite: `meta` adds a second, quieter line under the
 * primary content (the Apps list identity cell — name + App id). Without
 * `meta` the cell is exactly `cell(row)`.
 *
 * `empty` is the page's own empty state: when there are no rows the table is
 * replaced by it rather than rendered as a bare header band.
 */
import type { ComponentProps, ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@design-system";

export type DataTableColumn<T> = {
  header: ReactNode;
  /** The primary line — the whole cell when `meta` is absent. */
  cell: (row: T) => ReactNode;
  /** Second line under the primary content (`label-12` in `text-muted`). */
  meta?: (row: T) => ReactNode;
  /** Figure column: header and cells right-align (DESIGN.md Table). */
  align?: "right";
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  rowProps,
}: {
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  /** Per-row passthrough: the page's own row class / click handler. */
  rowProps?: (row: T) => ComponentProps<"tr">;
}) {
  if (rows.length === 0 && empty !== undefined) return <>{empty}</>;

  return (
    // The shell hairline is explicit: a bare `border` carries width only and
    // preflight leaves border-color at currentColor, so the face supplies the
    // `border-default` hairline itself. Row hairlines are the Table primitive's
    // own (`border-subtle`, DESIGN.md Table) — one owner, not two. The row
    // heights are the named tokens — the primitive sets no height of its own.
    <div className="overflow-hidden rounded-md border border-(--border-default)">
      <Table>
        <TableHeader className="bg-(--surface-raised)">
          <TableRow className="h-(--row-h-compact) hover:bg-inherit">
            {columns.map((column, index) => (
              <TableHead
                key={index}
                className={cn(
                  "h-full text-xs tracking-(--typo-label-12-tracking)",
                  column.align === "right" && "text-right",
                )}
              >
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const props = rowProps?.(row) ?? {};
            return (
              // The page's class merges into the row face instead of replacing
              // it, so a `cursor-pointer` row keeps the comfort height.
              <TableRow key={rowKey(row)} {...props} className={cn("h-(--row-h-comfort)", props.className)}>
                {columns.map((column, index) => (
                  <TableCell key={index} className={cn(column.align === "right" && "text-right")}>
                    {column.meta === undefined ? (
                      column.cell(row)
                    ) : (
                      <div data-slot="cell-composite" className="flex flex-col gap-0.5">
                        <span data-slot="cell-primary">{column.cell(row)}</span>
                        <span
                          data-slot="cell-meta"
                          className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight) text-(--text-muted)"
                        >
                          {column.meta(row)}
                        </span>
                      </div>
                    )}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

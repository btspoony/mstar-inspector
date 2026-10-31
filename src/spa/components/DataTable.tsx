/**
 * Table idiom (DESIGN.md Table): ONE shell and ONE header face for every
 * dashboard table — container radius + hairline on the shell, the
 * background-200 header band with label-12 headers, and right alignment for
 * figure columns. Columns and rows are render props, so each page keeps its
 * own cells (links, badges, relative times) and this file owns no data.
 *
 * `empty` is the page's own empty state: when there are no rows the table is
 * replaced by it rather than rendered as a bare header band.
 */
import type { ComponentProps, ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@design-system";

export type DataTableColumn<T> = {
  header: ReactNode;
  cell: (row: T) => ReactNode;
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
    // gray-alpha-400 hairline itself (DESIGN.md Table). The row hairline rides
    // the same token — the primitive's `border-b` sets width only.
    <div className="overflow-hidden rounded-md border border-(--gray-alpha-400) [&_tr]:border-(--gray-alpha-400)">
      <Table>
        <TableHeader className="bg-(--background-200)">
          <TableRow className="hover:bg-inherit">
            {columns.map((column, index) => (
              <TableHead
                key={index}
                className={cn(
                  "text-xs tracking-(--typo-label-12-tracking)",
                  column.align === "right" && "text-right",
                )}
              >
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={rowKey(row)} {...rowProps?.(row)}>
              {columns.map((column, index) => (
                <TableCell key={index} className={cn(column.align === "right" && "text-right")}>
                  {column.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

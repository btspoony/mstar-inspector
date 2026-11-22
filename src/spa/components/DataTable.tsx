import type { ComponentProps, ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@design-system";

export type DataTableColumn<T> = {
  header: ReactNode;
  cell: (row: T) => ReactNode;
  meta?: (row: T) => ReactNode;
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
  rowProps?: (row: T) => ComponentProps<"tr">;
}) {
  if (rows.length === 0 && empty !== undefined) return <>{empty}</>;

  return (
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

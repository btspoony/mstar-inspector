/**
 * DataTable — the one table shell, header face, alignment rule and empty slot.
 *
 * Static render: columns and rows are render props, so the test drives real
 * cells and the page-owned empty state without a DOM runner.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DataTable, type DataTableColumn } from "../../../src/spa/components/DataTable";

type Row = { slug: string; count: number };

const columns: DataTableColumn<Row>[] = [
  { header: "App", cell: (row) => row.slug },
  { header: "Findings", cell: (row) => row.count, align: "right" },
];

const rows: Row[] = [
  { slug: "demo", count: 3 },
  { slug: "other", count: 7 },
];

const render = (props: Parameters<typeof DataTable<Row>>[0]) =>
  renderToStaticMarkup(createElement(DataTable<Row>, props));

/** A header cell's class list, located by its rendered label. */
const headClass = (html: string, label: string) =>
  html.match(new RegExp(`<th [^>]*class="([^"]*)">${label}</th>`))?.[1] ?? "";

/** A body cell's class list, located by its rendered content. */
const cellClass = (html: string, content: string) =>
  html.match(new RegExp(`<td [^>]*class="([^"]*)">${content}</td>`))?.[1] ?? "";

describe("DataTable", () => {
  test("shell carries the container face; header row is the background-200 band", () => {
    const html = render({ columns, rows, rowKey: (row) => row.slug });
    expect(html).toStartWith('<div class="overflow-hidden rounded-md border">');
    expect(html).toContain("bg-(--background-200)");
    // Header band opts out of the primitive's row hover.
    expect(html).toContain("hover:bg-inherit");
  });

  test("headers ride the label-12 step and cells come from the render props", () => {
    const html = render({ columns, rows, rowKey: (row) => row.slug });
    expect(headClass(html, "App")).toContain("text-xs tracking-(--typo-label-12-tracking)");
    expect(html).toContain(">App</th>");
    expect(html).toContain(">Findings</th>");
    expect(html).toContain(">demo<");
    expect(html).toContain(">3<");
    expect(html).toContain(">other<");
    expect(html).toContain(">7<");
  });

  test("a figure column right-aligns its header and its cells", () => {
    const html = render({ columns, rows, rowKey: (row) => row.slug });
    expect(headClass(html, "Findings")).toContain("text-right");
    expect(headClass(html, "App")).not.toContain("text-right");
    expect(cellClass(html, "3")).toContain("text-right");
    expect(cellClass(html, "7")).toContain("text-right");
    expect(cellClass(html, "demo")).not.toContain("text-right");
  });

  test("empty slot replaces the table instead of a bare header band", () => {
    const html = render({
      columns,
      rows: [],
      rowKey: (row) => row.slug,
      empty: createElement("p", null, "No Apps yet"),
    });
    expect(html).toBe("<p>No Apps yet</p>");
  });

  test("without an empty slot the header band still renders and no rows appear", () => {
    const html = render({ columns, rows: [], rowKey: (row) => row.slug });
    expect(html).toContain("<table");
    expect(html).toContain(">App</th>");
    expect(html).not.toContain("<td");
  });

  test("rowProps hands the page its own row face (class and attributes)", () => {
    const html = render({
      columns,
      rows,
      rowKey: (row) => row.slug,
      rowProps: (row) => ({ className: "cursor-pointer", id: `row-${row.slug}` }),
    });
    expect(html).toMatch(/<tr [^>]*class="[^"]*cursor-pointer"/);
    expect(html).toContain('id="row-demo"');
    expect(html).toContain('id="row-other"');
  });
});

/**
 * DataTable — the one table shell, header face, composite cell and empty slot.
 *
 * The assertions name the rendered structure, the slot attributes and the text:
 * the header band, the body rows, the alignment contract and both composite
 * lines. The hairline / row-height vocabulary belongs to the table idiom in
 * `tests/design-system/surface-idioms.test.ts`; nothing here pins a
 * design-token class, so a token rename cannot false-fail a page behaviour.
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

const rowTags = (html: string) => [...html.matchAll(/<tr[^>]*>/g)].map((m) => m[0]);

/** A primitive palette step: `--gray-700`, `--background-200`, `--blue-700`. */
const PRIMITIVE_STEP = /--(?:background|gray|gray-alpha|brand|blue|red|amber|green|purple)-[0-9a-z]+/;

describe("DataTable", () => {
  test("the shell wraps one table with a header band and no palette steps", () => {
    const html = render({ columns, rows, rowKey: (row) => row.slug });
    expect(html).toStartWith("<div ");
    expect(html.match(/<table/g)).toHaveLength(1);
    expect(html).toMatch(/<thead[^>]*>.*>App<\/th>/);
    expect(html).not.toMatch(PRIMITIVE_STEP);
  });

  test("every body row renders its cells, under one header row", () => {
    const html = render({ columns, rows, rowKey: (row) => row.slug });
    const [header, ...body] = rowTags(html);
    expect(header).toBeDefined();
    expect(body).toHaveLength(rows.length);
    const thead = html.slice(html.indexOf("<thead"), html.indexOf("</thead>"));
    expect(thead).toContain("<th");
    expect(html.match(/<td/g)).toHaveLength(rows.length * columns.length);
  });

  test("a page row class merges into the row face", () => {
    const html = render({
      columns,
      rows,
      rowKey: (row) => row.slug,
      rowProps: (row) => ({ className: "cursor-pointer", id: `row-${row.slug}` }),
    });
    const [, firstRow] = rowTags(html);
    expect(firstRow).toContain("cursor-pointer");
    expect(html).toContain('id="row-demo"');
    expect(html).toContain('id="row-other"');
  });

  test("headers and cells come from the render props", () => {
    const html = render({ columns, rows, rowKey: (row) => row.slug });
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

  test("a column with meta renders a composite cell: primary line, then meta line", () => {
    const html = render({
      columns: [
        { header: "App", cell: (row) => row.slug, meta: (row) => `App ${row.count}` },
        { header: "Findings", cell: (row) => row.count, align: "right" },
      ],
      rows,
      rowKey: (row) => row.slug,
    });
    // One composite per row — the plain column stays a bare cell.
    expect((html.match(/data-slot="cell-composite"/g) ?? []).length).toBe(rows.length);
    const primary = html.indexOf('data-slot="cell-primary"');
    const meta = html.indexOf('data-slot="cell-meta"');
    expect(primary).toBeGreaterThan(-1);
    expect(primary).toBeLessThan(meta);
    // Both lines are assertable, in place: the primary content above, the
    // meta line below.
    expect(html.slice(primary, meta)).toContain("demo");
    expect(html.slice(meta)).toContain("App 3");
    expect(html).toContain("App 7");
    expect(html).not.toMatch(PRIMITIVE_STEP);
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
});

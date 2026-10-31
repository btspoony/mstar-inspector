/**
 * DataTable — the one table shell, header face, row heights, composite cell
 * and empty slot.
 *
 * The assertions name the property, not a class: a hairline/band must resolve
 * through the semantic vocabulary (never a primitive palette step), and a row
 * must ride one of the two named row heights. Static render: columns and rows
 * are render props, so the test drives real cells and the page-owned empty
 * state without a DOM runner.
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

const shellClass = (html: string) => html.match(/^<div class="([^"]*)"/)?.[1] ?? "";
const rowTags = (html: string) => [...html.matchAll(/<tr[^>]*>/g)].map((m) => m[0]);

/** A primitive palette step: `--gray-700`, `--background-200`, `--blue-700`. */
const PRIMITIVE_STEP = /--(?:background|gray|gray-alpha|brand|blue|red|amber|green|purple)-[0-9a-z]+/;

describe("DataTable", () => {
  test("the shell is the container face with semantic hairlines, not palette steps", () => {
    const html = render({ columns, rows, rowKey: (row) => row.slug });
    const shell = shellClass(html);
    // Container radius + a semantic hairline on the shell, and row hairlines
    // on the same vocabulary: bare `border` / `border-b` carry width only, so
    // preflight leaves border-color at currentColor (DESIGN.md Table).
    expect(shell).toContain("rounded-md");
    expect(shell).toMatch(/border-\(--border-(?:subtle|default|strong)\)/);
    expect(shell).toContain("[&amp;_tr]:border-(--border-subtle)");
    expect(shell).not.toMatch(PRIMITIVE_STEP);
    // Header band is a semantic surface (DESIGN.md Table: `surface-raised`),
    // and it opts out of the primitive's row hover.
    const thead = html.match(/<thead[^>]*class="([^"]*)"/)?.[1] ?? "";
    expect(thead).toMatch(/bg-\(--(?:surface|tone)-[a-z-]+\)/);
    expect(thead).not.toMatch(PRIMITIVE_STEP);
    expect(html).toContain("hover:bg-inherit");
  });

  test("the header rides row-h-compact and every body row row-h-comfort", () => {
    const html = render({ columns, rows, rowKey: (row) => row.slug });
    const [header, ...body] = rowTags(html);
    expect(header).toContain("h-(--row-h-compact)");
    expect(body).toHaveLength(rows.length);
    for (const row of body) expect(row).toContain("h-(--row-h-comfort)");
  });

  test("a page row class merges into the row face instead of replacing its height", () => {
    const html = render({
      columns,
      rows,
      rowKey: (row) => row.slug,
      rowProps: (row) => ({ className: "cursor-pointer", id: `row-${row.slug}` }),
    });
    const [, firstRow] = rowTags(html);
    expect(firstRow).toContain("h-(--row-h-comfort)");
    expect(firstRow).toContain("cursor-pointer");
    expect(html).toContain('id="row-demo"');
    expect(html).toContain('id="row-other"');
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
    // The meta line is the quieter face: label-12 in a muted text token.
    const metaClass = html.match(/<span data-slot="cell-meta" class="([^"]*)"/)?.[1] ?? "";
    expect(metaClass).toContain("text-(length:--typo-label-12-size)");
    expect(metaClass).toMatch(/text-\(--text-(?:muted|secondary|faint)\)/);
    expect(metaClass).not.toMatch(PRIMITIVE_STEP);
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

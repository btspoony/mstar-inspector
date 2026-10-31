/**
 * ListRow — DESIGN.md `list-row`: isomorphic rows in an in-card inset on the
 * `border-default` hairline at the control radius, rows on `surface-inset` at
 * `row-h-compact`, a `border-subtle` hairline between them, slots fixed as
 * identity → status → meta → actions.
 *
 * Static render: every slot is a prop, so the emitted markup is asserted for
 * the group container, the slot order, the named row height and the semantic
 * token vocabulary (never a primitive palette step).
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ListRow, ListRowGroup } from "../../../src/spa/components/ListRow";
import { StatusBadge } from "../../../src/design-system";

/** A primitive palette step: `--gray-700`, `--background-200`, `--blue-700`. */
const PRIMITIVE_STEP = /--(?:background|gray|gray-alpha|brand|blue|red|amber|green|purple)-[0-9a-z]+/;

const html = renderToStaticMarkup(
  createElement(
    ListRowGroup,
    null,
    createElement(ListRow, {
      identity: "sk-proj-…4f2a",
      status: createElement(StatusBadge, { tone: "success" }, "Active"),
      meta: "Used 3 days ago",
      actions: createElement("button", null, "Revoke"),
    }),
    createElement(ListRow, {
      identity: "sk-live-…91cd",
      meta: "Never used",
    }),
  ),
);

/** Markup between two markers, so a slot's children are checked in place. */
const between = (from: string, to: string) => {
  const start = html.indexOf(from);
  const end = to ? html.indexOf(to) : html.length;
  return html.slice(start, end);
};

describe("ListRowGroup", () => {
  test("container is the in-card inset on the border-default hairline", () => {
    expect(html).toContain('data-slot="list-row-group"');
    expect(html).toContain("border-(--border-default)");
    expect(html).toContain("rounded-(--radius-control)");
    expect(html).not.toMatch(PRIMITIVE_STEP);
  });

  test("rows are separated by the 1px border-subtle hairline", () => {
    expect(html).toContain("divide-y");
    expect(html).toContain("divide-(--border-subtle)");
  });
});

describe("ListRow", () => {
  test("slots render in the fixed identity → status → meta → actions order", () => {
    const identity = html.indexOf('data-slot="list-row-identity"');
    const status = html.indexOf('data-slot="list-row-status"');
    const meta = html.indexOf('data-slot="list-row-meta"');
    const actions = html.indexOf('data-slot="list-row-actions"');
    expect(identity).toBeGreaterThan(-1);
    expect(identity).toBeLessThan(status);
    expect(status).toBeLessThan(meta);
    expect(meta).toBeLessThan(actions);
  });

  test("identity rides label-14 in font-mono over a 76px minimum column", () => {
    const identity = between('data-slot="list-row-identity"', 'data-slot="list-row-status"');
    expect(identity).toContain("font-mono");
    expect(identity).toContain("min-w-[76px]");
    expect(identity).toContain("text-(length:--typo-label-14-size)");
  });

  test("meta rides label-12 in the muted text token", () => {
    const meta = between('data-slot="list-row-meta"', 'data-slot="list-row-actions"');
    expect(meta).toContain("text-(length:--typo-label-12-size)");
    expect(meta).toMatch(/text-\(--text-(?:muted|secondary|faint)\)/);
    expect(meta).toContain("Used 3 days ago");
  });

  test("row fill, row-h-compact height, padding, column gap and trailing action placement", () => {
    const row = between('data-slot="list-row"', 'data-slot="list-row-identity"');
    // The fill is a semantic surface, and the height is the named token — not
    // a hand-derived vertical padding.
    expect(row).toMatch(/bg-\(--(?:surface|tone)-[a-z-]+\)/);
    expect(row).toContain("h-(--row-h-compact)");
    expect(row).not.toContain("py-[9px]");
    expect(row).toContain("px-3");
    expect(row).toContain("gap-3");
    const actions = between('data-slot="list-row-actions"', "</div>");
    expect(actions).toContain("ml-auto");
    expect(actions).toContain("Revoke");
  });

  test("an omitted slot renders no empty node", () => {
    const secondRow = html.slice(html.indexOf("sk-live-…91cd"));
    expect(secondRow).toContain('data-slot="list-row-meta"');
    expect(secondRow).not.toContain('data-slot="list-row-status"');
    expect(secondRow).not.toContain('data-slot="list-row-actions"');
  });

  test("no literal color values", () => {
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toContain("rgb(");
  });
});

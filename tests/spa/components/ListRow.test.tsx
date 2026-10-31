/**
 * ListRow — DESIGN.md v0.4 `list-row`: isomorphic rows in a gray-alpha-400
 * inset container on `rounded-sm`, rows on gray-200, one 1px gray-alpha-300
 * hairline between them, slots fixed as identity → status → meta → actions.
 *
 * Static render: every slot is a prop, so the emitted markup is asserted for
 * the group container, the slot order and the Task 1 token classes.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ListRow, ListRowGroup } from "../../../src/spa/components/ListRow";
import { StatusBadge } from "../../../src/design-system";

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
  test("container is the in-card inset on the gray-alpha-400 hairline", () => {
    expect(html).toContain('data-slot="list-row-group"');
    expect(html).toContain("border-(--gray-alpha-400)");
    expect(html).toContain("rounded-(--rounded-sm)");
  });

  test("rows are separated by the 1px gray-alpha-300 hairline", () => {
    expect(html).toContain("divide-y");
    expect(html).toContain("divide-(--gray-alpha-300)");
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

  test("meta rides label-12 in gray-700", () => {
    const meta = between('data-slot="list-row-meta"', 'data-slot="list-row-actions"');
    expect(meta).toContain("text-(length:--typo-label-12-size)");
    expect(meta).toContain("text-(--gray-700)");
    expect(meta).toContain("Used 3 days ago");
  });

  test("row fill, padding, column gap and trailing action placement", () => {
    const row = between('data-slot="list-row"', 'data-slot="list-row-identity"');
    expect(row).toContain("bg-(--gray-200)");
    expect(row).toContain("px-3");
    expect(row).toContain("py-[9px]");
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

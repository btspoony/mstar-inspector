/**
 * ListRow — DESIGN.md `list-row`: isomorphic rows in an in-card inset with a
 * fixed slot order (identity → status → meta → actions), an omitted optional
 * slot rendering nothing.
 *
 * Static render: every slot is a prop, so the emitted markup is asserted for
 * the slot order, the rendered text and the trailing-action placement — never
 * a design-token class. The inset, hairline and row-height vocabulary lives in
 * `tests/design-system/surface-idioms.test.ts`.
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
  test("container is the in-card inset group", () => {
    expect(html).toContain('data-slot="list-row-group"');
    expect(html).toContain("overflow-hidden");
    expect(html).not.toMatch(PRIMITIVE_STEP);
  });

  test("rows are the group's children, divided from each other", () => {
    const group = between('data-slot="list-row-group"', "");
    expect(group).toContain("divide-y");
    expect(group.match(/data-slot="list-row"/g)).toHaveLength(2);
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

  test("identity renders the caller's id on the mono stack", () => {
    const identity = between('data-slot="list-row-identity"', 'data-slot="list-row-status"');
    expect(identity).toContain("sk-proj-…4f2a");
    expect(identity).toContain("font-mono");
    // The identity column keeps its 76px floor on the legal scale spelling:
    // `min-w-[76px]` is a bracket arbitrary value the extended guard rejects,
    // and 19 × the 0.25rem spacing step is the same 76px.
    expect(identity).toContain("min-w-19");
  });

  test("meta renders the caller's line in its own slot", () => {
    const meta = between('data-slot="list-row-meta"', 'data-slot="list-row-actions"');
    expect(meta).toContain("Used 3 days ago");
  });

  test("row padding, column gap and trailing action placement", () => {
    const row = between('data-slot="list-row"', 'data-slot="list-row-identity"');
    // A hand-derived vertical padding must never replace the row face.
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

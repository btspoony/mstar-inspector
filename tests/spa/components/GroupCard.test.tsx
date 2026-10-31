/**
 * GroupCard — DESIGN.md `group-card`: the ui/card surface with Card's
 * symmetric padding split into a header band (at least one `row-h-comfort`,
 * growing when a summary line is present) and a body (`0 16px 14px`),
 * title + badge, summary and action slots.
 *
 * Static render: every input is a prop, so the emitted markup is asserted for
 * the slot, the header composition and the Task 1 token classes.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GroupCard,
  GroupCardBody,
  GroupCardHeader,
} from "../../../src/spa/components/GroupCard";
import { StatusBadge } from "../../../src/design-system";

const html = renderToStaticMarkup(
  createElement(
    GroupCard,
    null,
    createElement(GroupCardHeader, {
      title: "OpenAI",
      badge: createElement(StatusBadge, { tone: "success" }, "3 keys"),
      summary: "api · api.openai.com · 3 models",
      actions: createElement("button", null, "Add key"),
    }),
    createElement(GroupCardBody, null, "no keys yet"),
  ),
);

/** Markup between two slots, so a slot's children are checked in place. */
const between = (from: string, to: string) => {
  const start = html.indexOf(from);
  const end = to ? html.indexOf(to) : html.length;
  return html.slice(start, end);
};

describe("GroupCard", () => {
  test("root is the card surface under the group-card slot, padding split off", () => {
    expect(html).toContain('data-slot="group-card"');
    expect(html).toContain("bg-card");
    expect(html).toContain("gap-0");
    expect(html).toContain("p-0");
    // The hairline colour is the card primitive's; this wrapper restates no
    // border colour of its own. `tests/design-system/surface-idioms.test.ts`
    // resolves the inherited edge through tokens.css.
  });

  test("header band is at least one named comfort row", () => {
    const header = between('data-slot="card-header"', 'data-slot="card-content"');
    expect(header).toContain("min-h-(--row-h-comfort)");
    expect(header).toContain("px-4");
  });

  test("title and badge share the header title slot", () => {
    const title = between('data-slot="card-title"', 'data-slot="card-description"');
    expect(title).toContain("OpenAI");
    expect(title).toContain("3 keys");
    expect(title).toContain("text-(length:--typo-heading-16-size)");
  });

  test("actions render in the card-action position", () => {
    const action = between('data-slot="card-action"', 'data-slot="card-content"');
    expect(action).toContain("Add key");
  });

  test("summary rides the label-12 step in the muted text token", () => {
    const description = between('data-slot="card-description"', 'data-slot="card-action"');
    expect(description).toContain("text-(length:--typo-label-12-size)");
    expect(description).toMatch(/text-\(--text-(?:muted|secondary|faint)\)/);
  });

  test("body carries the 0 16px 14px padding", () => {
    const body = between('data-slot="card-content"', "");
    expect(body).toContain("px-4");
    expect(body).toContain("pt-0");
    expect(body).toContain("pb-3.5");
    expect(body).toContain("no keys yet");
  });

  test("no literal color values", () => {
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toContain("rgb(");
  });
});

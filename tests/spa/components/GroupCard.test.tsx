/**
 * GroupCard — DESIGN.md `group-card`: the ui/card surface with Card's
 * symmetric padding split into a header band and a body, title + badge,
 * summary and action slots.
 *
 * Static render: every input is a prop, so the emitted markup is asserted for
 * the slot composition, the rendered text and the padding hand-off — never a
 * design-token class. The surface and hairline colour are the Card primitive's
 * contract, asserted in `tests/design-system/surface-idioms.test.ts` where the
 * token vocabulary lives.
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
  test("root is the card surface with its padding handed to the slots", () => {
    expect(html).toContain('data-slot="group-card"');
    expect(html).toContain("gap-0");
    expect(html).toContain("p-0");
  });

  test("the header band carries the title, badge and action", () => {
    const header = between('data-slot="card-header"', 'data-slot="card-content"');
    expect(header).toContain("OpenAI");
    expect(header).toContain("3 keys");
    expect(header).toContain("Add key");
    expect(header).toContain("px-4");
  });

  test("title and badge share the header title slot", () => {
    const title = between('data-slot="card-title"', 'data-slot="card-description"');
    expect(title).toContain("OpenAI");
    expect(title).toContain("3 keys");
  });

  test("actions render in the card-action position", () => {
    const action = between('data-slot="card-action"', 'data-slot="card-content"');
    expect(action).toContain("Add key");
  });

  test("summary rides the description slot after the title", () => {
    const description = between('data-slot="card-description"', 'data-slot="card-action"');
    expect(description).toContain("api · api.openai.com · 3 models");
    expect(html.indexOf('data-slot="card-title"')).toBeLessThan(
      html.indexOf('data-slot="card-description"'),
    );
  });

  test("body carries the card's padding hand-off", () => {
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

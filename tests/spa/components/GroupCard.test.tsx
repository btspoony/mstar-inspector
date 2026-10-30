/**
 * GroupCard — DESIGN.md v0.4 `group-card`: the ui/card surface with Card's
 * symmetric padding split into a header band (`14px 16px`) and a body
 * (`0 16px 14px`), title + badge, summary and action slots.
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
import { StatusBadge } from "../../../src/spa/components/StatusBadge";

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
    expect(html).toContain("gap-0 p-0");
  });

  test("header carries the 14px 16px band padding", () => {
    const header = between('data-slot="card-header"', 'data-slot="card-content"');
    expect(header).toContain("px-4");
    expect(header).toContain("py-3.5");
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

  test("summary rides the label-12 step in gray-700", () => {
    const description = between('data-slot="card-description"', 'data-slot="card-action"');
    expect(description).toContain("text-(length:--typo-label-12-size)");
    expect(description).toContain("text-(--gray-700)");
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

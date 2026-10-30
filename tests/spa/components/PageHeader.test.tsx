/**
 * PageHeader — the single spelling of the page title face.
 *
 * Static render (props-only, no hooks): the heading-24 token trio, the
 * optional description line, and the two slots (actions beside the title,
 * wayfinding link above it). Source-shape assertions are deliberately absent —
 * the rendered markup is the contract pages migrate against.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageHeader } from "../../../src/spa/components/PageHeader";

const render = (props: Parameters<typeof PageHeader>[0]) =>
  renderToStaticMarkup(createElement(PageHeader, props));

describe("PageHeader", () => {
  test("title is the one heading-24 spelling pages compose against", () => {
    const html = render({ title: "Apps" });
    expect(html).toStartWith("<header");
    expect(html).toContain(
      '<h1 class="font-semibold text-(length:--typo-heading-24-size) leading-(--typo-heading-24-line) tracking-(--typo-heading-24-tracking)">Apps</h1>',
    );
  });

  test("description is optional and rides the muted copy line", () => {
    expect(render({ title: "Apps" })).not.toContain("<p");
    expect(render({ title: "Members", description: "Visible to members" })).toContain(
      '<p class="text-sm text-muted-foreground">Visible to members</p>',
    );
  });

  test("actions slot sits beside the title, above the description", () => {
    const html = render({
      title: "Apps",
      actions: createElement("button", { type: "submit" }, "Create App"),
      description: "One per repository",
    });
    // One flex row carries the title and the action cluster; the wrapped
    // action reuses the baseline alignment instead of re-spelling the header.
    expect(html).toContain("flex flex-wrap items-baseline justify-between gap-3");
    expect(html).toContain("<button type=\"submit\">Create App</button>");
    expect(html.indexOf("Create App")).toBeLessThan(html.indexOf("One per repository"));
  });

  test("back-link slot renders above the title", () => {
    const html = render({
      title: "demo",
      backLink: createElement("a", { href: "/dashboard/apps" }, "Back to Apps"),
    });
    expect(html).toContain('<a href="/dashboard/apps">Back to Apps</a>');
    expect(html.indexOf("Back to Apps")).toBeLessThan(html.indexOf("<h1"));
  });

  test("renders no wrapper content of its own — nothing but the header tree", () => {
    const html = render({ title: "Apps" });
    expect(html).not.toContain("<p");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
    // The header is one column: back link, title block.
    expect(html).toContain('<header class="flex flex-col gap-3">');
  });
});

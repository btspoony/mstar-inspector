/**
 * PageHeader — the single spelling of the page header band (compass D4).
 *
 * Static render (props-only, no hooks): the band exposes the title, the
 * optional subtitle line, the action slot, the wayfinding link and the
 * metric strip. Assertions name the rendered structure, the slot attributes
 * and the text — never a design-token class, so a token rename cannot
 * false-fail this file.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageHeader } from "../../../src/spa/components/PageHeader";
import { MetricBand } from "../../../src/spa/components/MetricBand";

const render = (props: Parameters<typeof PageHeader>[0]) =>
  renderToStaticMarkup(createElement(PageHeader, props));

describe("PageHeader", () => {
  test("the title is the band's one heading", () => {
    const html = render({ title: "Apps" });
    expect(html).toStartWith('<header data-slot="page-header"');
    expect(html.match(/<h1 /g)).toHaveLength(1);
    expect(html).toContain('<h1 data-slot="page-header-title"');
    expect(html).toContain(">Apps</h1>");
  });

  test("subtitle is optional and follows the title", () => {
    const bare = render({ title: "Apps" });
    expect(bare).not.toContain('data-slot="page-header-subtitle"');

    const html = render({ title: "Members", description: "Visible to members" });
    expect(html).toContain('data-slot="page-header-subtitle"');
    expect(html).toContain(">Visible to members</p>");
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("Visible to members"));
  });

  test("actions sit beside the title, above the subtitle", () => {
    const html = render({
      title: "Apps",
      actions: createElement("button", { type: "submit" }, "Create App"),
      description: "One per repository",
    });
    expect(html).toContain('<button type="submit">Create App</button>');
    expect(html.indexOf("</h1>")).toBeLessThan(html.indexOf("Create App"));
    // The action and the title share one row; the subtitle is the next line.
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

  test("the metric band rides the same plane, under the title block", () => {
    const html = render({
      title: "Apps",
      description: "Each App serves many repositories",
      metrics: createElement(MetricBand, {
        metrics: [
          { key: "Apps", value: 3 },
          { key: "Enabled", value: 2 },
        ],
      }),
    });
    const band = html.indexOf('data-slot="metric-band"');
    expect(band).toBeGreaterThan(html.indexOf("Each App serves many repositories"));
    expect(band).toBeLessThan(html.lastIndexOf("</header>"));
  });

  test("renders no wrapper content of its own", () => {
    const html = render({ title: "Apps" });
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
    expect(html.match(/<header /g)).toHaveLength(1);
  });
});

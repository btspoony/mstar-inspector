/**
 * The dashboard shell's scroll contract, asserted on the static markup:
 *
 * The provider and inset wrappers pin the viewport (h-svh + overflow-hidden)
 * so the sidebar/navbar chrome never scrolls away, and the page content
 * wrapper is the document's sole vertical scroll container.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpaBoot } from "../../src/spa/boot";
import { Layout } from "../../src/spa/Layout";

const boot: SpaBoot = {
  locale: "en",
  login: "dana",
  name: "Dana",
  workspaceRef: "ws_acme",
  deploymentMode: "self-hosted",
  memberships: [{ id: "ws_acme", slug: "acme", name: "Acme", role: "owner", plan: "Free" }],
};

const tagOf = (html: string, slot: string, element: "div" | "main" = "div"): string => {
  const match = html.match(new RegExp(`<${element}[^>]*data-slot="${slot}"[^>]*>`));
  expect(match, `a <${element}> carrying data-slot="${slot}" renders`).not.toBeNull();
  return match![0];
};

const html = renderToStaticMarkup(
  createElement(
    Layout,
    { boot, pathname: "/dashboard", flash: null, children: createElement("p", null, "Page") },
  ),
);

describe("dashboard shell scroll contract (SSR)", () => {
  test("provider and inset wrappers pin the viewport with hidden overflow", () => {
    const wrapper = tagOf(html, "sidebar-wrapper");
    expect(wrapper).toContain("h-svh");
    expect(wrapper).toContain("overflow-hidden");
    const inset = tagOf(html, "sidebar-inset", "main");
    expect(inset).toContain("h-svh");
    expect(inset).toContain("overflow-hidden");
  });

  test("the content wrapper is the sole vertical scroll container", () => {
    const scrollers = [...html.matchAll(/class="([^"]*overflow-y-auto[^"]*)"/g)].map((m) => m[1]);
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0]).toContain("flex-1");
    expect(scrollers[0]).toContain("min-h-0");
    // The chrome layers never scroll.
    expect(tagOf(html, "sidebar-wrapper")).not.toContain("overflow-y-auto");
    expect(tagOf(html, "sidebar-inset", "main")).not.toContain("overflow-y-auto");
  });

  test("provider and inset unwrap for print", () => {
    expect(tagOf(html, "sidebar-wrapper")).toContain("print:h-auto");
    expect(tagOf(html, "sidebar-wrapper")).toContain("print:overflow-visible");
    expect(tagOf(html, "sidebar-inset", "main")).toContain("print:h-auto");
    expect(tagOf(html, "sidebar-inset", "main")).toContain("print:overflow-visible");
  });

  test("the content wrapper stops clipping when printed", () => {
    const scrollers = [...html.matchAll(/class="([^"]*overflow-y-auto[^"]*)"/g)].map((m) => m[1]);
    expect(scrollers[0]).toContain("print:overflow-visible");
  });

  test("the sidebar column stays in flow, height-ridden on the wrapper", () => {
    const sidebar = tagOf(html, "sidebar");
    expect(sidebar).toContain("h-full");
    expect(sidebar).not.toContain("h-svh");
    // In-flow column order: the sidebar renders before the inset, and the
    // fixed-position variants (rail/gap machinery) are absent.
    expect(html.indexOf('data-slot="sidebar"')).toBeLessThan(html.indexOf('data-slot="sidebar-inset"'));
    expect(html).not.toContain('data-slot="sidebar-container"');
  });
});

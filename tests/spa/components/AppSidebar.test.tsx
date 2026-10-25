/**
 * AppSidebar — the platform-console footer entry (plan 116 Task 7).
 *
 * Static render with the real SidebarProvider: the link exists only when the
 * model carries it, and it is a plain document link (the console is not a SPA
 * route, so no client router click handler).
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppSidebar } from "../../../src/spa/components/AppSidebar";
import { SidebarProvider } from "../../../src/spa/components/ui/sidebar";
import type { SidebarModel } from "../../../src/spa/shell";

const model: SidebarModel = { brand: "Brand", brandHref: "/dashboard", navLabel: "Nav", items: [] };

const render = (sidebar: SidebarModel) =>
  renderToStaticMarkup(
    createElement(SidebarProvider, { defaultOpen: true }, createElement(AppSidebar, { model: sidebar })),
  );

describe("AppSidebar platform-operations entry", () => {
  test("renders the footer link when the model carries one", () => {
    const html = render({
      ...model,
      operatorLink: { href: "/_internal_admin", label: "Platform operations" },
    });
    expect(html).toContain('data-slot="sidebar-footer"');
    expect(html).toContain('href="/_internal_admin"');
    expect(html).toContain("Platform operations");
  });

  test("renders no console link when the model has none", () => {
    expect(render(model)).not.toContain("/_internal_admin");
  });
});

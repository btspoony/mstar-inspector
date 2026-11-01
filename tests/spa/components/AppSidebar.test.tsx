/**
 * AppSidebar — the platform-console footer entry, and the product nav's
 * containment (I-000253).
 *
 * The nav is three product items and nothing else: the flat three-item list is
 * the product decision (compass D5), so this suite pins that the operator entry
 * stays a footer child rather than drifting back into the product menu, and
 * that no group label appears anywhere. Rendered against the real sidebar
 * primitives, so the assertion is the containment the browser computes
 * (`contains`), not a class or slot spelling.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarProvider } from "@design-system";
import { AppSidebar } from "../../../src/spa/components/AppSidebar";
import { buildSidebarModel, type SidebarModel } from "../../../src/spa/shell";
import { t } from "../../../src/i18n";
import { installDom } from "../dom";

const model: SidebarModel = { brand: "Brand", brandHref: "/dashboard", navLabel: "Nav", items: [] };

const render = (sidebar: SidebarModel) =>
  renderToStaticMarkup(
    createElement(SidebarProvider, { defaultOpen: true }, createElement(AppSidebar, { model: sidebar })),
  );

/** The shell's own model for an operator on a workspace-scoped Apps page. */
const operatorModel = buildSidebarModel(
  {
    locale: "en",
    login: "mallory",
    name: null,
    isOperator: true,
    memberships: [{ id: "acme", slug: "acme", name: "Acme", role: "owner", plan: "Free" }],
  },
  "/dashboard/acme/apps",
);

/** One rendered sidebar in a live DOM, so containment is a computed fact. */
async function mountSidebar(sidebar: SidebarModel): Promise<{ container: Element; cleanup: () => Promise<void> }> {
  const { win, cleanup } = installDom("http://localhost/dashboard/acme/apps");
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(
      createElement(SidebarProvider, { defaultOpen: true }, createElement(AppSidebar, { model: sidebar })),
    );
  });
  return {
    container: container as unknown as Element,
    cleanup: async () => {
      await act(async () => root.unmount());
      cleanup();
    },
  };
}

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

describe("product nav containment (I-000253)", () => {
  test("the nav is the three product items, with no group label of any kind", async () => {
    const { container, cleanup } = await mountSidebar(operatorModel);
    try {
      // Scoped to the product menu: the footer's own menu holds the operator
      // entry and must not be counted as a product item.
      const labels = [...container.querySelectorAll('[data-slot="sidebar-content"] [data-slot="sidebar-menu-button"]')].map(
        (button) => button.textContent,
      );
      expect(labels).toEqual([t("en", "nav.apps"), t("en", "nav.members"), t("en", "nav.settings")]);
      // No group heading, whichever slot a future one would take.
      expect(container.querySelectorAll('[data-slot="sidebar-group-label"]')).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("the operator entry renders under the footer, outside the product menu", async () => {
    const { container, cleanup } = await mountSidebar(operatorModel);
    try {
      const footer = container.querySelector('[data-slot="sidebar-footer"]');
      const productMenu = container.querySelector('[data-slot="sidebar-content"] [data-slot="sidebar-menu"]');
      const entry = container.querySelector('a[href="/_internal_admin"]');
      expect(entry).not.toBeNull();
      expect(footer?.contains(entry ?? null)).toBe(true);
      expect(productMenu?.contains(entry ?? null)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("without an operator entry the product list markup is unchanged", async () => {
    const list = async (sidebar: SidebarModel): Promise<string> => {
      const { container, cleanup } = await mountSidebar(sidebar);
      try {
        return container.querySelector('[data-slot="sidebar-content"]')?.innerHTML ?? "";
      } finally {
        await cleanup();
      }
    };
    expect(await list({ ...operatorModel, operatorLink: undefined })).toBe(await list(operatorModel));
  });
});

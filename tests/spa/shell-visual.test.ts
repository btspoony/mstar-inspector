import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import { WorkspaceSwitcher } from "../../src/spa/components/WorkspaceSwitcher";
import { buildWorkspaceSwitcherModel } from "../../src/spa/shell";
import { installDom } from "./dom";

const primitivesDir = join(import.meta.dir, "../../src/design-system/primitives");
const spaRoot = join(import.meta.dir, "../../src/spa");

const sources: Record<string, string> = {
  sidebar: readFileSync(join(primitivesDir, "sidebar.tsx"), "utf8"),
  sheet: readFileSync(join(primitivesDir, "sheet.tsx"), "utf8"),
  toggle: readFileSync(join(primitivesDir, "toggle.tsx"), "utf8"),
};

const themeCSS = readFileSync(join(spaRoot, "styles/shadcn-theme.css"), "utf8");
const tokensCSS = readFileSync(join(spaRoot, "styles/tokens.css"), "utf8");

const THEME_COLOURS = new Set(
  [...themeCSS.matchAll(/^\s*--color-([\w-]+):/gm)].map((match) => match[1] ?? ""),
);
const DECLARED_TOKENS = new Set(
  [...tokensCSS.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1] ?? ""),
);
const DURATION = new RegExp(
  `duration-\\(--duration-(?:${[
    ...new Set([...tokensCSS.matchAll(/--duration-([\w-]+)\s*:/g)].map((match) => match[1] ?? "")),
  ].join("|")})\\)`,
);

function expectSemanticFill(fill: string, where: string): void {
  const name = fill.replace(/\/\d+$/, "");
  const token = /^\((--[\w-]+)\)$/.exec(name)?.[1];
  const known = token === undefined ? THEME_COLOURS.has(name) : DECLARED_TOKENS.has(token);
  expect(known, `${where}: ${fill} names neither a theme colour nor a declared token`).toBe(true);
}

function transitionFaces(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .filter((line) => /\btransition\b|transition-\[|transition-transform|transition-opacity|transition-colors/.test(line));
}

describe("motion token sweep (routed from QC)", () => {
  for (const [name, source] of Object.entries(sources)) {
    test(`${name}.tsx carries no raw duration or easing literals`, () => {
      expect(source).not.toMatch(/duration-\d{2,4}\b/);
      expect(source).not.toMatch(/duration-\[[^\]]+\]/);
      expect(source).not.toMatch(/\bease-linear\b/);
      expect(source).not.toMatch(/cubic-bezier\(/);
    });

    test(`${name}.tsx: every transition face consumes duration + ease tokens`, () => {
      const faces = transitionFaces(source);
      expect(faces.length).toBeGreaterThan(0);
      for (const face of faces) {
        const durations = [...face.matchAll(/duration-\(([^)]*)\)/g)].map(
          (match) => `duration-(${match[1] ?? ""})`,
        );
        expect(durations.length, `${face} declares no duration`).toBeGreaterThan(0);
        for (const duration of durations) expect(duration, face).toMatch(DURATION);
        expect(face).toMatch(/ease-\(--ease-/);
      }
    });
  }

  test("sidebar collapse faces (gap + container) ride the same token clock", () => {
    expect(sources.sidebar).toContain("transition-[width]");
    expect(sources.sidebar).toContain("transition-[left,right,width]");
  });

  test("menu button collapse transition (width,height,padding) is tokenized", () => {
    expect(sources.sidebar).toContain("transition-[width,height,padding]");
  });

  test("sheet overlay and its close button keep their transition faces", () => {
    expect(sources.sheet).toMatch(new RegExp(`transition ${DURATION.source}`));
    expect(sources.sheet).toMatch(new RegExp(`transition-opacity ${DURATION.source}`));
  });

  test("toggle interaction face is tokenized", () => {
    expect(sources.toggle).toContain("transition-[color,box-shadow]");
  });

  test("reduced-motion fold still collapses every duration token to 1ms", () => {
    const fold = tokensCSS.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/);
    expect(fold).not.toBeNull();
    expect(fold?.[0]).toContain("--duration-fast: 1ms");
    expect(fold?.[0]).toContain("--duration-base: 1ms");
    expect(fold?.[0]).toContain("--duration-slow: 1ms");
  });
});

describe("shell brand surfaces (A1/A2)", () => {
  const sidebar = readFileSync(join(spaRoot, "components/AppSidebar.tsx"), "utf8");
  const layout = readFileSync(join(spaRoot, "Layout.tsx"), "utf8");

  test("sidebar active fill wears the brand tint via the sanctioned --sidebar-primary bridge (brand stays off alert semantics)", () => {
    const tintLine = sources.sidebar
      ?.split("\n")
      .find((line) => line.includes("data-[active=true]:"));
    expect(tintLine).toBeDefined();
    expect(tintLine).toContain("data-[active=true]:");
    expect(tintLine).not.toMatch(/var\(--brand-|#[0-9a-fA-F]{3,8}\b/);
    expect(sources.sidebar).not.toMatch(/inset_\d+px_0_0_0_var\(--sidebar-primary\)/);
    expect(sidebar).not.toMatch(/inset_\d+px_0_0_0_var\(--sidebar-primary\)/);
    expect(sidebar).not.toContain("ACTIVE_BRAND_EDGE");
    expect(themeCSS).toMatch(/--color-sidebar-primary:\s*var\(--sidebar-primary\)/);
  });

  test("sidebar brand block is a typographic wordmark (no image/logo assets) on token classes", () => {
    expect(sidebar).toContain("tracking-tight");
    expect(sidebar).not.toMatch(/<img\b|url\(/);
    expect(sidebar).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("navbar sits on a shell chrome token, zero raw hex", () => {
    expect(layout).toMatch(/<header[^>]*bg-\(--[a-z0-9-]+\)/);
    expect(layout).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("sidebar hover hierarchy recipe (AD-622)", () => {
  const appSidebar = readFileSync(join(spaRoot, "components/AppSidebar.tsx"), "utf8");
  const menuButtonBlock = sources.sidebar?.match(
    /const sidebarMenuButtonVariants = cva\([\s\S]*?\n\)\n/,
  )?.[0];
  const hoverMotion = /hover:-?(translate|scale|shadow|ring|border)\b/;

  test("menu-button cva block is locatable (pin integrity)", () => {
    expect(menuButtonBlock).toBeDefined();
    expect(menuButtonBlock).toContain("hover:bg-");
  });

  test("menu-button hover faces dim to the /40 accent tint (base + state-open + variants)", () => {
    const hoverFills = [...(menuButtonBlock ?? "").matchAll(/hover:bg-([^\s"]+)/g)].map(
      (match) => match[1] ?? "",
    );
    expect(hoverFills.length).toBeGreaterThan(0);
    for (const fill of hoverFills) {
      expect(fill).toMatch(/\/40$/);
      expectSemanticFill(fill, "menu-button hover");
    }
    const openFill = /data-\[state=open\]:hover:bg-([^\s"]+)/.exec(menuButtonBlock ?? "")?.[1] ?? "";
    expect(openFill, "no open-state hover fill").not.toBe("");
    expect(openFill).toMatch(/\/40$/);
    expectSemanticFill(openFill, "open-state hover");
    expect(menuButtonBlock).toMatch(/hover:text-[^\s"]+/);
    expect(menuButtonBlock).not.toMatch(/hover:bg-[^\s"/]+(?=[\s"])/);
  });

  test("menu-button press face keeps its full-strength fill; the active face wears the brand tint (AD-622 untouched list)", () => {
    expect(menuButtonBlock).toMatch(/active:text-[^\s"]+/);
    const activeFill = /data-\[active=true\]:bg-([^\s"]+)/.exec(menuButtonBlock ?? "")?.[1] ?? "";
    const pressFill = /active:bg-([^\s"]+)/.exec(menuButtonBlock ?? "")?.[1] ?? "";
    expect(pressFill, "no press fill").not.toBe("");
    expect(activeFill, "no active fill").not.toBe("");
    expectSemanticFill(pressFill, "press face");
    expectSemanticFill(activeFill, "active face");
    expect(activeFill).not.toBe(pressFill);
    expect(menuButtonBlock).toContain("data-[active=true]:font-medium");
  });

  test("outline variant: resting hairline stays, the hover ring retires with the recipe", () => {
    expect(menuButtonBlock).toContain("shadow-[0_0_0_1px_var(--sidebar-border)]");
    expect(menuButtonBlock).not.toContain("hover:shadow-[0_0_0_1px_var(--sidebar-accent)]");
  });

  test("menu-button cva block carries no motion classes on its hover faces (AD-622)", () => {
    expect(menuButtonBlock).not.toMatch(hoverMotion);
  });

  test("brand wordmark link rides the same tint recipe as the menu rows", () => {
    const wordmarkFills = [...appSidebar.matchAll(/hover:bg-([^\s"]+)/g)].map(
      (match) => match[1] ?? "",
    );
    expect(wordmarkFills.length).toBeGreaterThan(0);
    for (const fill of wordmarkFills) {
      expect(fill).toMatch(/\/40$/);
      expectSemanticFill(fill, "wordmark hover");
    }
    expect(appSidebar).toMatch(/hover:text-[^\s"]+/);
    expect(appSidebar).not.toMatch(hoverMotion);
  });
});

describe("top-bar workspace switcher (mounted)", () => {
  const boot: SpaBoot = {
    locale: "en",
    login: "octocat",
    name: "The Octocat",
    workspaceRef: "acme",
    deploymentMode: "saas",
    canCreateWorkspace: true,
    createWorkspaceBlockedReason: null,
    memberships: [
      { id: "ws_acme", slug: "acme", name: "Acme", role: "owner", plan: "Free" },
      { id: "ws_7d41", slug: "ws_7d41", name: "Side project", role: "member", plan: "Unlimited" },
    ],
  };

  async function openMenu(pathname: string, overrides: Partial<typeof boot> = {}) {
    const { win, cleanup: closeDom } = installDom(`http://localhost${pathname}`);
    const live = { ...boot, ...overrides };
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () =>
      root.render(
        createElement(WorkspaceSwitcher, { model: buildWorkspaceSwitcherModel(live, pathname), boot: live }),
      ),
    );
    const trigger = container.querySelector('[data-slot="dropdown-menu-trigger"]');
    await act(async () => {
      trigger?.dispatchEvent(
        new win.PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }),
      );
    });
    const body = win.document.body;
    return {
      trigger,
      body,
      radios: [...body.querySelectorAll('[data-slot="dropdown-menu-radio-item"]')],
      newWorkspaceItem: body.querySelector('[data-slot="dropdown-menu-item"]'),
      cleanup: async () => {
        await act(async () => root.unmount());
        closeDom();
      },
    };
  }

  test("the menu lists every membership, marks the current row, and ends with the new-workspace item", async () => {
    const { radios, newWorkspaceItem, body, cleanup } = await openMenu("/dashboard/acme/apps");
    try {
      expect(radios.map((row) => row.textContent)).toEqual(["Acme", "Side project"]);
      expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
      expect(radios[1]?.getAttribute("aria-checked")).toBe("false");
      expect(newWorkspaceItem?.textContent).toBe("New workspace");
      expect(newWorkspaceItem?.getAttribute("aria-disabled")).toBeNull();
      expect(body.textContent).toContain("Free");
    } finally {
      await cleanup();
    }
  });

  test("a path naming an unlisted ref marks NO row — never a stand-in", async () => {
    const { radios, trigger, cleanup } = await openMenu("/dashboard/gone/apps");
    try {
      expect(radios.map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "false"]);
      expect(trigger?.textContent).not.toContain("Acme");
      expect(trigger?.textContent).toContain("Workspace");
    } finally {
      await cleanup();
    }
  });

  test("at the free-slot cap the new-workspace item is DISABLED and states the reason", async () => {
    const { newWorkspaceItem, cleanup } = await openMenu("/dashboard/acme/apps", {
      canCreateWorkspace: false,
      createWorkspaceBlockedReason: "free_slot",
    });
    try {
      expect(newWorkspaceItem?.getAttribute("aria-disabled")).toBe("true");
      expect(newWorkspaceItem?.getAttribute("data-disabled")).not.toBeNull();
      expect(newWorkspaceItem?.textContent).toContain("New workspace");
      expect(newWorkspaceItem?.textContent).toContain(t("en", "nav.newWorkspaceBlockedFreeSlot"));
    } finally {
      await cleanup();
    }
  });
});

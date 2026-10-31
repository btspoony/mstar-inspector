/**
 * shell visual-discipline pins.
 *
 * 1. Motion-token sweep (routed from QC, binding): the shell
 *    primitive faces (ui/sidebar.tsx, ui/sheet.tsx, ui/toggle.tsx) must
 *    express every transition through the duration/ease tokens (duration-
 *    and ease- namespaces) — no raw ms/cubic-bezier literals, no silent
 *    library-default timing. Transition properties stay untouched
 *    (functional collapse faces keep their width/left/right/margin
 *    properties); only duration/easing moved to tokens. The tokens.css
 *    reduce fold (all durations → 1ms) covers every var consumer, so the
 *    faces need no per-component media query.
 * 2. Shell brand surfaces (A1/A2): the sidebar active fill wears the
 * v0.3.2 brand tint through the sanctioned --sidebar-primary bridge
 * (AD-641 retires the left edge line) and the navbar sits on the
 *    background-200 chrome token — zero raw hex in the shell sources.
 * 3. Sidebar hover hierarchy (AD-622): every menu-button hover
 *    face dims to the /40 accent tint + text brighten while the press fill
 *    stays full strength (the open state has no dedicated fill face) and
 * the active face wears the 12%-alpha brand tint (AD-641) —
 *    hover stays lighter than the full-strength press, hue apart from
 *    active.
 */
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

/** Live `transition*` class carriers — comment prose is not a motion face. */
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
      // Arbitrary-value forms are raw literals too (F-58-3) — the
      // token consumers use the paren shorthand, never `duration-[...]`.
      expect(source).not.toMatch(/duration-\[[^\]]+\]/);
      expect(source).not.toMatch(/\bease-linear\b/);
      expect(source).not.toMatch(/cubic-bezier\(/);
    });

    test(`${name}.tsx: every transition face consumes duration + ease tokens`, () => {
      const faces = transitionFaces(source);
      expect(faces.length).toBeGreaterThan(0);
      for (const face of faces) {
        expect(face).toMatch(/duration-\(--duration-/);
        expect(face).toMatch(/ease-\(--ease-/);
      }
    });
  }

  test("sidebar collapse faces (gap + container) ride the same token clock", () => {
    expect(sources.sidebar).toContain(
      "transition-[width] duration-(--duration-base) ease-(--ease-in-out)",
    );
    expect(sources.sidebar).toContain(
      "transition-[left,right,width] duration-(--duration-base) ease-(--ease-in-out)",
    );
  });

  test("menu button collapse transition (width,height,padding) is tokenized", () => {
    expect(sources.sidebar).toContain(
      "transition-[width,height,padding] duration-(--duration-base) ease-(--ease-in-out)",
    );
  });

  test("sheet overlay rides --duration-slow; its close button rides --duration-base", () => {
    expect(sources.sheet).toContain("transition duration-(--duration-slow) ease-(--ease-in-out)");
    expect(sources.sheet).toContain(
      "transition-opacity duration-(--duration-base) ease-(--ease-in-out)",
    );
  });

  test("toggle interaction face is tokenized", () => {
    expect(sources.toggle).toContain(
      "transition-[color,box-shadow] duration-(--duration-base) ease-(--ease-in-out)",
    );
  });

  test("reduced-motion fold still collapses every duration token to 1ms", () => {
    const tokens = readFileSync(join(spaRoot, "styles/tokens.css"), "utf8");
    const fold = tokens.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/);
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
    // (AD-641) supersedes the edge line: the active fill is
    // the low-alpha brand tint on the menu-button variant string.
    const tintLine = sources.sidebar
      ?.split("\n")
      .find((line) => line.includes("data-[active=true]:bg-sidebar-primary/12"));
    expect(tintLine).toBeDefined();
    expect(tintLine).toContain(
      "data-[active=true]:bg-sidebar-primary/12 data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground",
    );
    // The tint rides the bridge, not a raw palette var or hex value.
    expect(tintLine).not.toMatch(/var\(--brand-|#[0-9a-fA-F]{3,8}\b/);
    // The retired edge leaves no inset-shadow face in either sidebar source
    // and no ACTIVE_BRAND_EDGE compat layer behind.
    expect(sources.sidebar).not.toMatch(/inset_\d+px_0_0_0_var\(--sidebar-primary\)/);
    expect(sidebar).not.toMatch(/inset_\d+px_0_0_0_var\(--sidebar-primary\)/);
    expect(sidebar).not.toContain("ACTIVE_BRAND_EDGE");
    // Trap-① discipline (knowledge ui-bugs/tailwind4-compiled-css-traps): the
    // named tint utility only compiles because the `@theme inline` block maps
    // the key — pin the mapping layer, not the compiled hex.
    const theme = readFileSync(join(spaRoot, "styles/shadcn-theme.css"), "utf8");
    expect(theme).toMatch(/--color-sidebar-primary:\s*var\(--sidebar-primary\)/);
  });

  test("sidebar brand block is a typographic wordmark (no image/logo assets) on token classes", () => {
    expect(sidebar).toContain("tracking-tight");
    expect(sidebar).not.toMatch(/<img\b|url\(/);
    expect(sidebar).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("navbar sits on the background-200 chrome token, zero raw hex", () => {
    expect(layout).toContain("bg-(--background-200)");
    expect(layout).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("sidebar hover hierarchy recipe (AD-622)", () => {
  const appSidebar = readFileSync(join(spaRoot, "components/AppSidebar.tsx"), "utf8");
  // The menu-button cva block only — sidebar.tsx carries out-of-scope hover
  // faces (menu-action, menu-badge, menu-sub) that the AD-622 rework does not touch.
  const menuButtonBlock = sources.sidebar?.match(
    /const sidebarMenuButtonVariants = cva\([\s\S]*?\n\)\n/,
  )?.[0];
  // AD-622 no-motion surface (qc round 1, qc1-F-003 + qc2-F-003): a hover
  // face may only tint + brighten — no translate/-translate, scale, shadow,
  // ring or border motion class may join it.
  const hoverMotion = /hover:-?(translate|scale|shadow|ring|border)\b/;

  test("menu-button cva block is locatable (pin integrity)", () => {
    expect(menuButtonBlock).toBeDefined();
    expect(menuButtonBlock).toContain("hover:bg-sidebar-accent");
  });

  test("menu-button hover faces dim to the /40 accent tint (base + state-open + variants)", () => {
    // Base string hover face…
    expect(menuButtonBlock).toContain(
      "hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground",
    );
    // …the open-state hover face…
    expect(menuButtonBlock).toContain(
      "data-[state=open]:hover:bg-sidebar-accent/40 data-[state=open]:hover:text-sidebar-accent-foreground",
    );
    // …and no full-strength hover fill survives anywhere in the recipe
    // (base, default, outline) — hover must stay lighter than active.
    expect(menuButtonBlock).not.toMatch(/hover:bg-sidebar-accent(?!\/)/);
  });

  test("menu-button press face keeps its full-strength fill; the active face wears the brand tint (AD-622 untouched list)", () => {
    // AD-622's untouched list covers the press face; the v0.3.2 tint rework (AD-641)
    // supersedes the active-route face — text brighten + font-medium stay.
    expect(menuButtonBlock).toContain(
      "active:bg-sidebar-accent active:text-sidebar-accent-foreground",
    );
    expect(menuButtonBlock).toContain(
      "data-[active=true]:bg-sidebar-primary/12 data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground",
    );
  });

  test("outline variant: resting hairline stays, the hover ring retires with the recipe", () => {
    expect(menuButtonBlock).toContain("shadow-[0_0_0_1px_var(--sidebar-border)]");
    expect(menuButtonBlock).not.toContain("hover:shadow-[0_0_0_1px_var(--sidebar-accent)]");
  });

  test("menu-button cva block carries no motion classes on its hover faces (AD-622)", () => {
    // The tint recipe above is scoped to this exact block, so the no-motion
    // half of AD-622 covers it too — not just the wordmark scan below.
    expect(menuButtonBlock).not.toMatch(hoverMotion);
  });

  test("brand wordmark link rides the same tint recipe as the menu rows", () => {
    expect(appSidebar).toContain(
      "hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground",
    );
    // No translate / scale / shadow / ring / border on hover (AD-622): no
    // motion class may join the wordmark's hover face.
    expect(appSidebar).not.toMatch(hoverMotion);
  });
});

/**
 * 4. Top-bar workspace switcher: the control left the sidebar header
 *    for the navbar's left cluster. Its ROWS live in a Radix portal, so the
 *    current-row mark and the disabled item's stated reason are only observable
 *    on a mounted render — hence happy-dom here rather than a source pin.
 *
 *    The switcher module is imported after the browser globals exist: Radix (and
 *    react-dom's client entry) capture DOM availability at module-evaluation
 *    time, so a static import would leave the menu permanently closed. Static
 *    imports cannot express that ordering — this is the support-notice pattern.
 */
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

  /** Mount the control and open its menu (Radix portals the rows). */
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
    // Radix opens on the primary-button pointerdown the trigger listens for.
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
      // A radio group: the current workspace is a CHOSEN row.
      expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
      expect(radios[1]?.getAttribute("aria-checked")).toBe("false");
      expect(newWorkspaceItem?.textContent).toBe("New workspace");
      expect(newWorkspaceItem?.getAttribute("aria-disabled")).toBeNull();
      // The plan chip rides the trigger beside the workspace name.
      expect(body.textContent).toContain("Free");
    } finally {
      await cleanup();
    }
  });

  test("a path naming an unlisted ref marks NO row — never a stand-in", async () => {
    const { radios, trigger, cleanup } = await openMenu("/dashboard/gone/apps");
    try {
      expect(radios.map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "false"]);
      // The trigger names no workspace the URL does not name.
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
      // Disabled, not hidden: the user needs to know why, and the rule itself.
      expect(newWorkspaceItem?.getAttribute("aria-disabled")).toBe("true");
      expect(newWorkspaceItem?.getAttribute("data-disabled")).not.toBeNull();
      expect(newWorkspaceItem?.textContent).toContain("New workspace");
      expect(newWorkspaceItem?.textContent).toContain(t("en", "nav.newWorkspaceBlockedFreeSlot"));
    } finally {
      await cleanup();
    }
  });
});

/**
 * Plan 58 T1: shell visual-discipline pins.
 *
 * 1. Motion-token sweep (routed from plan 57 QC, binding): the shell
 *    primitive faces (ui/sidebar.tsx, ui/sheet.tsx, ui/toggle.tsx) must
 *    express every transition through the duration/ease tokens (duration-
 *    and ease- namespaces) — no raw ms/cubic-bezier literals, no silent
 *    library-default timing. Transition properties stay untouched
 *    (functional collapse faces keep their width/left/right/margin
 *    properties); only duration/easing moved to tokens. The tokens.css
 *    reduce fold (all durations → 1ms) covers every var consumer, so the
 *    faces need no per-component media query.
 * 2. Shell brand surfaces (A1/A2): the sidebar active fill wears the plan-64
 *    brand tint through the sanctioned --sidebar-primary bridge (plan 64
 *    AD-641 retires the plan-58 left edge line) and the navbar sits on the
 *    background-200 chrome token — zero raw hex in the shell sources.
 * 3. Sidebar hover hierarchy (plan 62 T1, AD-622): every menu-button hover
 *    face dims to the /40 accent tint + text brighten while the press fill
 *    stays full strength (the open state has no dedicated fill face) and
 *    the active face wears the plan-64 /12 brand tint (plan 64 AD-641) —
 *    hover stays lighter than the full-strength press, hue apart from
 *    active.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const uiDir = join(import.meta.dir, "../../src/spa/components/ui");
const spaRoot = join(import.meta.dir, "../../src/spa");

const sources: Record<string, string> = {
  sidebar: readFileSync(join(uiDir, "sidebar.tsx"), "utf8"),
  sheet: readFileSync(join(uiDir, "sheet.tsx"), "utf8"),
  toggle: readFileSync(join(uiDir, "toggle.tsx"), "utf8"),
};

/** Live `transition*` class carriers — comment prose is not a motion face. */
function transitionFaces(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .filter((line) => /\btransition\b|transition-\[|transition-transform|transition-opacity|transition-colors/.test(line));
}

describe("motion token sweep (plan 58 T1, routed from plan 57 QC)", () => {
  for (const [name, source] of Object.entries(sources)) {
    test(`${name}.tsx carries no raw duration or easing literals`, () => {
      expect(source).not.toMatch(/duration-\d{2,4}\b/);
      // Arbitrary-value forms are raw literals too (plan 58 F-58-3) — the
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

describe("shell brand surfaces (plan 58 T1, A1/A2)", () => {
  const sidebar = readFileSync(join(spaRoot, "components/AppSidebar.tsx"), "utf8");
  const layout = readFileSync(join(spaRoot, "Layout.tsx"), "utf8");

  test("sidebar active fill wears the plan-64 brand tint via the sanctioned --sidebar-primary bridge (brand stays off alert semantics)", () => {
    // Plan 64 (AD-641) supersedes the plan-58 edge line: the active fill is
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

describe("sidebar hover hierarchy recipe (plan 62 T1, AD-622)", () => {
  const appSidebar = readFileSync(join(spaRoot, "components/AppSidebar.tsx"), "utf8");
  // The menu-button cva block only — sidebar.tsx carries out-of-scope hover
  // faces (menu-action, menu-badge, menu-sub) that plan 62 does not touch.
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

  test("menu-button press face keeps its full-strength fill; the active face wears the plan-64 brand tint (AD-622 untouched list)", () => {
    // AD-622's untouched list covers the press face; plan 64 (AD-641)
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

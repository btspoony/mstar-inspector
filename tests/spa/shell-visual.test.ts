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
 * 2. Shell brand surfaces (A1/A2): the sidebar active edge consumes the
 *    sanctioned --sidebar-primary bridge and the navbar sits on the
 *    background-200 chrome token — zero raw hex in the shell sources.
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

  test("sidebar active edge consumes the sanctioned --sidebar-primary bridge (brand stays off alert semantics)", () => {
    const edgeLine = sidebar
      .split("\n")
      .find((line) => line.includes("ACTIVE_BRAND_EDGE ="));
    expect(edgeLine).toBeDefined();
    expect(edgeLine).toContain("data-[active=true]:shadow-[inset_2px_0_0_0_var(--sidebar-primary)]");
    // The edge rides the bridge, not a raw palette var or hex value.
    expect(edgeLine).not.toMatch(/var\(--brand-|#[0-9a-fA-F]{3,8}\b/);
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

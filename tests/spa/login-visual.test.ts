/**
 * Plan 58 T2: login surface visual-discipline pins (A3, clarify-locked
 * centered-card reinforced form).
 *
 * 1. SPA face (src/spa/pages/LoginPage.tsx): behavior face (POST + signed-in
 *    redirect) untouched, wordmark echo + heading-32 token scale on the
 *    centered card, zero raw hex. The entrance rides the motion tokens with
 *    an explicit prefers-reduced-motion fold.
 * 2. SSR face sync (src/dashboard/views.ts): the no-chrome auth-journey
 *    faces (denied / removed / forbidden / OAuth error) share the same
 *    centered-card language, and the STYLE --shadow-card values stay synced
 *    with tokens.css (three-site covenant — the hex-only parity pin in
 *    tokens.test.ts cannot see a multi-stop shadow value, same gap the
 *    plan-57 QC F-002 reference-level pin covered for --brand-700).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const spaRoot = join(import.meta.dir, "../../src/spa");
const loginPage = readFileSync(join(spaRoot, "pages/LoginPage.tsx"), "utf8");
const pagesCss = readFileSync(join(spaRoot, "pages.module.css"), "utf8");
const sidebar = readFileSync(join(spaRoot, "components/AppSidebar.tsx"), "utf8");

describe("login SPA face (plan 58 T2, A3)", () => {
  test("behavior face is unchanged: signed-in redirect + GitHub form POST", () => {
    expect(loginPage).toContain('if (boot.login) window.location.replace("/dashboard")');
    expect(loginPage).toContain('<form method="post" action="/dashboard/login">');
    expect(loginPage).toContain("<GitHubMark />");
    expect(loginPage).toContain('{t(locale, "login.signIn")}');
    expect(loginPage).toContain('{t(locale, "login.description")}');
    expect(loginPage).toContain('{t(locale, "login.inviteOnly")}');
  });

  test("centered-card reinforced form: wordmark echo + concise heading card", () => {
    // Wordmark echo of the T1 sidebar wordmark — imports the same Logo
    // silhouette and renders nav.brand (the concise heading no longer
    // carries the brand name).
    expect(loginPage).toContain('import { Logo } from "../components/AppSidebar"');
    expect(loginPage).toContain('{t(locale, "nav.brand")}');
    // Centered on the themed canvas; the card is the form surface.
    expect(loginPage).toContain("min-h-svh flex-col items-center justify-center");
    expect(loginPage).toContain("max-w-sm");
  });

  test("card title rides the DESIGN.md heading-32 token step (login wordmark-scale titles)", () => {
    expect(loginPage).toContain("text-(length:--typo-heading-32-size)");
    expect(loginPage).toContain("leading-(--typo-heading-32-line)");
    expect(loginPage).toContain("tracking-(--typo-heading-32-tracking)");
    // The old off-shelf scale utility is retired from the title.
    expect(loginPage).not.toContain("text-xl");
  });

  test("zero raw hex in the login page source", () => {
    expect(loginPage).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("entrance motion: token clock, transform/opacity only, reduced-motion fold", () => {
    const block = pagesCss.match(/\.loginEnter \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block?.[0]).toContain("animation: login-enter var(--duration-slow) var(--ease-out)");
    const keyframes = pagesCss.match(/@keyframes login-enter \{[\s\S]*?\n\}/);
    expect(keyframes).not.toBeNull();
    expect(keyframes?.[0]).toContain("opacity");
    expect(keyframes?.[0]).toContain("transform");
    expect(keyframes?.[0]).not.toMatch(/width|height|margin|padding|color|background|border|shadow/);
    const fold = pagesCss.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/);
    expect(fold?.[0]).toContain(".loginEnter");
    expect(fold?.[0]).toContain("animation: none");
  });
});

describe("login SSR face sync (plan 58 T2, A3 dual-track)", () => {
  const views = readFileSync(join(import.meta.dir, "../../src/dashboard/views.ts"), "utf8");
  const tokens = readFileSync(join(spaRoot, "styles/tokens.css"), "utf8");

  function declarations(block: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
      out[m[1]!] = m[2]!.trim();
    }
    return out;
  }

  function balancedBlock(source: string, open: string): string {
    const at = source.indexOf(open);
    expect(at, open).toBeGreaterThan(-1);
    const bodyStart = at + open.length;
    let depth = 1;
    for (let i = bodyStart; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) return source.slice(bodyStart, i);
      }
    }
    throw new Error(`unbalanced block: ${open}`);
  }

  test("STYLE --shadow-card is value-synced with tokens.css on every theme branch", () => {
    const styleStart = views.indexOf("const STYLE = `<style>");
    const style = views.slice(styleStart, views.indexOf("`;", styleStart));

    const ssrRoot = declarations(balancedBlock(style, ":root {"));
    const ssrStoredLight = declarations(balancedBlock(style, ':root[data-theme="light"] {'));
    const ssrOsLight = declarations(balancedBlock(style, ':root:not([data-theme="dark"]) {'));

    const cssRoot = declarations(balancedBlock(tokens, ":root {"));
    const cssLight = declarations(balancedBlock(tokens, ':root[data-theme="light"] {'));

    expect(ssrRoot["shadow-card"]).toBe(cssRoot["shadow-card"]);
    expect(ssrStoredLight["shadow-card"]).toBe(cssLight["shadow-card"]);
    expect(ssrOsLight["shadow-card"]).toBe(cssLight["shadow-card"]);
  });

  test("auth-journey faces render the centered-card language with the alert role intact", async () => {
    const { deniedPage, removedPage, forbiddenPage, errorPage } = await import(
      "../../src/dashboard/views"
    );
    const faces: [string, string][] = [
      ["denied", deniedPage("octocat")],
      ["removed", removedPage("octocat")],
      ["forbidden", forbiddenPage("octocat")],
      ["error", errorPage("boom")],
    ];
    for (const [name, html] of faces) {
      expect(html, name).toContain('<main class="auth">');
      expect(html, name).toContain('class="auth-card"');
      expect(html, name).toContain('class="auth-brand"');
      expect(html, name).toContain(">Morning Star Inspector</span>");
      expect(html, name).toContain('<div class="banner" role="alert">');
    }
    // The manifest flow keeps its own face (channel boundary, not login family).
    expect(views).toContain("export function manifestErrorPage");
  });

  test("auth faces consume the card/elevation tokens, not raw hex", () => {
    const authCss = views.slice(views.indexOf("main.auth {"), views.indexOf(".sections {"));
    expect(authCss).toContain("var(--card-bg)");
    expect(authCss).toContain("var(--card-border)");
    expect(authCss).toContain("var(--card-radius)");
    expect(authCss).toContain("var(--shadow-card)");
    expect(authCss).toContain("var(--brand-700)");
    expect(authCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("the brand mark silhouette stays single-source with the sidebar Logo", () => {
    // LoginPage imports the exported AppSidebar Logo instead of copying the
    // star-in-circle silhouette (the GitHub mark is a different shape).
    expect(sidebar).toContain("export function Logo()");
    expect(loginPage).not.toContain('circle cx="12"');
  });
});

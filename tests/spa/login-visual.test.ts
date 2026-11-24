import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const spaRoot = join(import.meta.dir, "../../src/spa");
const loginPage = readFileSync(join(spaRoot, "pages/LoginPage.tsx"), "utf8");
const pagesCss = readFileSync(join(spaRoot, "pages.module.css"), "utf8");

describe("login SPA face (A3)", () => {
  test("behavior face is unchanged: signed-in redirect + GitHub form POST", () => {
    expect(loginPage).toContain('if (boot.login) window.location.replace("/dashboard")');
    expect(loginPage).toContain('<form method="post" action="/dashboard/login">');
    expect(loginPage).toContain("<GitHubMark />");
    expect(loginPage).toContain('{t(locale, "login.signIn")}');
    expect(loginPage).toContain('{t(locale, "login.description")}');
    expect(loginPage).toContain('{t(locale, "login.openAccess")}');
  });

  test("centered-card reinforced form: wordmark echo + concise heading card", () => {
    expect(loginPage).toContain('import { Logo } from "../components/AppSidebar"');
    expect(loginPage).toContain('{t(locale, "nav.brand")}');
    expect(loginPage).toContain("min-h-svh flex-col items-center justify-center");
    expect(loginPage).toContain("max-w-sm");
  });

  test("the card title is the page's one hero heading, off the off-shelf scale", () => {
    expect(loginPage.match(/<CardTitle/g)).toHaveLength(1);
    expect(loginPage).toContain('{t(locale, "login.heading")}');
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

describe("login SSR face sync (A3 dual-track)", () => {
  const tokens = readFileSync(join(spaRoot, "styles/tokens.css"), "utf8");

  async function ssrStyle(): Promise<string> {
    const { errorPage } = await import("../../src/dashboard/views");
    const html = errorPage("boom");
    return html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  }

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

  test("the rendered STYLE --shadow-card matches tokens.css on every theme branch", async () => {
    const style = await ssrStyle();

    const ssrRoot = declarations(balancedBlock(style, ":root {"));
    const ssrStoredLight = declarations(balancedBlock(style, ':root[data-theme="light"] {'));

    const cssRoot = declarations(balancedBlock(tokens, ":root {"));
    const cssLight = declarations(balancedBlock(tokens, ':root[data-theme="light"] {'));

    expect(ssrRoot["shadow-card"]).toBe(cssRoot["shadow-card"]);
    expect(ssrStoredLight["shadow-card"]).toBe(cssLight["shadow-card"]);
  });

  test("auth-journey faces render the centered-card language with the alert role intact", async () => {
    const { removedPage, forbiddenPage, errorPage } = await import(
      "../../src/dashboard/views"
    );
    const faces: [string, string][] = [
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
  });

  test("auth faces consume the card/elevation tokens, not raw hex", async () => {
    const style = await ssrStyle();
    const authCss = style.slice(style.indexOf("main.auth {"), style.indexOf("section {"));
    expect(authCss).toContain("var(--card-bg)");
    expect(authCss).toContain("var(--card-border)");
    expect(authCss).toContain("var(--card-radius)");
    expect(authCss).toContain("var(--shadow-card)");
    expect(authCss).toContain("var(--tone-accent-fg)");
    expect(authCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

});

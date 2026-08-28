/**
 * Zero-build SSR HTML for /dashboard (plan 08, architect decision Q8): TS
 * template strings + a single inline <style> block. The CSS custom
 * properties below are a static mapping of the repo-root DESIGN.md
 * frontmatter tokens (colors / typography / spacing / rounded / sm+lg
 * breakpoints) — DESIGN.md is the SSOT; update both when tokens change.
 * No client JS, no build chain, no new dependencies.
 */

/** Escape GitHub-sourced user data before HTML interpolation (XSS guard). */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `<style>
:root {
  /* DESIGN.md frontmatter (SSOT) → CSS custom properties */
  --background-100: #ffffff;
  --background-200: #f4f4f5;
  --gray-1000: #111111;
  --gray-900: #3d3d3d;
  --blue-700: #0066cc;
  --red-700: #b91c1c;
  --amber-700: #b45309;
  --rounded-sm: 6px;
  --font-sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--background-100);
  color: var(--gray-1000);
  font-family: var(--font-sans);
  font-size: 16px; /* copy-16 */
  line-height: 1.6;
}
header {
  display: flex;
  align-items: baseline;
  gap: 16px; /* spacing-4 */
  padding: 24px; /* spacing-6 page gutter */
  border-bottom: 1px solid var(--background-200);
}
h1 {
  margin: 0;
  font-size: 24px; /* heading-24 */
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
}
header .user { margin-left: auto; color: var(--gray-900); font-size: 14px; } /* copy-14 */
header a, .banner a { color: var(--blue-700); }
main { max-width: 960px; margin: 0 auto; padding: 24px; } /* spacing-6 */
.sections { display: grid; grid-template-columns: 1fr; gap: 32px; } /* spacing-8 between sections */
@media (min-width: 900px) { /* breakpoint lg */
  .sections { grid-template-columns: repeat(3, 1fr); }
}
section {
  background: var(--background-200); /* placeholder disabled fill */
  border-radius: var(--rounded-sm);
  padding: 24px; /* spacing-6 card padding */
}
section h2 { margin: 0 0 8px; font-size: 16px; font-weight: 600; line-height: 1.4; } /* heading-16 */
section p { margin: 0 0 8px; }
.status { color: var(--gray-900); font-size: 14px; line-height: 1.55; } /* copy-14 */
.note { color: var(--amber-700); font-size: 14px; }
/* Placeholders must never read as a clickable primary action: no blue-700,
   no pointer cursor (DESIGN.md § State legibility). */
button[disabled] {
  appearance: none;
  border: 1px solid var(--gray-900);
  border-radius: var(--rounded-sm);
  background: transparent;
  color: var(--gray-900);
  padding: 8px 12px; /* spacing-2 / spacing-3 control rhythm */
  font: inherit;
  cursor: default;
}
.banner {
  border: 1px solid var(--red-700);
  border-radius: var(--rounded-sm);
  color: var(--red-700);
  padding: 16px; /* spacing-4 */
}
</style>`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — mstar-inspector</title>
${STYLE}
</head>
<body>${body}</body>
</html>`;
}

function placeholderSection(title: string, description: string, action: string, extra = ""): string {
  return `<section aria-disabled="true">
    <h2>${title}</h2>
    <p>${description}</p>
    <p class="status">Not in B0 — this iteration ships the login shell only.</p>
    ${extra}
    <button type="button" disabled aria-disabled="true">${action}</button>
  </section>`;
}

/** Logged-in shell: header + the three B0 placeholder sections (IA spec). */
export function dashboardPage(user: { login: string; name?: string }): string {
  const display = user.name ? `${user.name} (${user.login})` : user.login;
  return page(
    "Dashboard",
    `<header>
    <h1>mstar-inspector</h1>
    <span class="user">Signed in as ${escapeHtml(display)} · <a href="/dashboard/logout">Logout</a></span>
  </header>
  <main>
    <div class="sections">
      ${placeholderSection("GitHub App", "Create a review GitHub App in your account via Manifest.", "Create GitHub App")}
      ${placeholderSection("Model keys", "Store a model provider key without local wrangler secret put.", "Add model key")}
      ${placeholderSection(
        "Review",
        "Turn cloud reviews on or off (REVIEW_ENABLED).",
        "Enable reviews",
        '<p class="note">Reviews stay fail-closed in production until enabled here (B3).</p>',
      )}
    </div>
  </main>`,
  );
}

/** OAuth failure surface: red-700 banner + what-to-do-next (DESIGN.md § State legibility). */
export function errorPage(message: string): string {
  return page(
    "Sign-in error",
    `<main>
    <div class="banner" role="alert">
      <strong>Sign-in failed.</strong> ${escapeHtml(message)}
      No session was created. Return to <a href="/dashboard/login">/dashboard/login</a> to try again.
    </div>
  </main>`,
  );
}

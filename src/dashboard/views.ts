/**
 * Zero-build SSR HTML for /dashboard (plan 08, architect decision Q8): TS
 * template strings + a single inline <style> block. Plan 29 T5 ports the
 * DESIGN.md L2 token subset from src/spa/styles/tokens.css into STYLE
 * (dark default + prefers-color-scheme light). Manifest flow pages stay
 * zero-JS SSR. No client JS, no build chain, no new dependencies.
 */
import { t, type Locale } from "../i18n";

/** Escape GitHub-sourced user data before HTML interpolation (XSS guard). */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `<style>
/* Token subset ported from src/spa/styles/tokens.css (DESIGN.md L2 SSOT).
   Dark is the console default; light follows prefers-color-scheme.
   Do not diverge hex values from tokens.css — update both together. */
:root {
  color-scheme: dark;
  --background-100: #09090b;
  --background-200: #18181b;
  --background-300: #27272a;
  --gray-100: #18181b;
  --gray-400: #3f3f46;
  --gray-700: #8b8b94;
  --gray-900: #b0b0b8;
  --gray-1000: #f4f4f5;
  --gray-alpha-400: #ffffff2e;
  --blue-700: #4ea1ff;
  --red-100: #2a1215;
  --red-400: #7f1d1d;
  --red-700: #f87171;
  --red-900: #fecaca;
  --amber-100: #27190a;
  --amber-400: #78350f;
  --amber-700: #fbbf24;
  --amber-800: #fcd34d;
  --amber-900: #fde68a;
  --font-sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --typo-heading-24-size: 24px;
  --typo-heading-24-weight: 600;
  --typo-heading-24-line: 1.25;
  --typo-heading-24-tracking: -0.01em;
  --typo-heading-16-size: 16px;
  --typo-heading-16-weight: 600;
  --typo-heading-16-line: 1.4;
  --typo-copy-16-size: 16px;
  --typo-copy-16-line: 1.6;
  --typo-copy-14-size: 14px;
  --typo-copy-14-line: 1.55;
  --typo-button-14-size: 14px;
  --typo-button-14-weight: 500;
  --typo-button-14-line: 1.4;
  --typo-button-12-size: 12px;
  --typo-button-12-weight: 500;
  --typo-label-12-size: 12px;
  --typo-label-12-weight: 500;
  --spacing-1: 4px;
  --spacing-2: 8px;
  --spacing-3: 12px;
  --spacing-4: 16px;
  --spacing-6: 24px;
  --spacing-8: 32px;
  --rounded-sm: 6px;
  --rounded-md: 12px;
  --button-primary-bg: var(--blue-700);
  --button-primary-fg: var(--background-100);
  --button-primary-height: 40px;
  --button-primary-padding: 0 12px;
  --button-primary-radius: var(--rounded-sm);
  --button-secondary-bg: var(--background-200);
  --button-secondary-fg: var(--gray-1000);
  --button-secondary-border: var(--gray-400);
  --button-danger-bg: var(--red-700);
  --button-danger-fg: var(--background-100);
  --button-disabled-bg: var(--gray-100);
  --button-disabled-fg: var(--gray-700);
  --button-disabled-border: var(--gray-400);
  --button-small-height: 32px;
  --button-small-padding: 0 8px;
  --button-small-radius: var(--rounded-sm);
  --card-bg: var(--background-200);
  --card-fg: var(--gray-1000);
  --card-border: var(--gray-alpha-400);
  --card-radius: var(--rounded-md);
  --card-padding: 24px;
  --notice-error-bg: var(--red-100);
  --notice-error-fg: var(--red-900);
  --notice-error-border: var(--red-400);
  --notice-warn-bg: var(--amber-100);
  --notice-warn-fg: var(--amber-900);
  --notice-warn-border: var(--amber-400);
  --sidebar-active-bg: var(--background-300);
  --focus-ring: 0 0 0 2px var(--background-100), 0 0 0 4px var(--blue-700);
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --background-100: #ffffff;
    --background-200: #f4f4f5;
    --background-300: #e4e4e7;
    --gray-100: #fafafa;
    --gray-400: #d4d4d8;
    --gray-700: #52525b;
    --gray-900: #3d3d3d;
    --gray-1000: #111111;
    --gray-alpha-400: #00000024;
    --blue-700: #0066cc;
    --red-100: #fef2f2;
    --red-400: #fca5a5;
    --red-700: #b91c1c;
    --red-900: #7f1d1d;
    --amber-100: #fffbeb;
    --amber-400: #fcd34d;
    --amber-700: #b45309;
    --amber-800: #92400e;
    --amber-900: #78350f;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--background-100);
  color: var(--gray-1000);
  font-family: var(--font-sans);
  font-size: var(--typo-copy-16-size);
  line-height: var(--typo-copy-16-line);
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-4);
  min-height: 56px;
  padding: 0 var(--spacing-4);
  background: var(--background-200);
  border-bottom: 1px solid var(--gray-alpha-400);
}
header h1 {
  margin: 0;
  font-size: var(--typo-heading-16-size);
  font-weight: var(--typo-heading-16-weight);
  line-height: var(--typo-heading-16-line);
  white-space: nowrap;
}
header h1 a {
  color: var(--gray-1000);
  text-decoration: none;
}
header h1 a:focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: var(--rounded-sm); }
header .user {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--spacing-1);
  margin-left: auto;
  color: var(--gray-900);
  font-size: var(--typo-label-12-size);
  font-weight: var(--typo-label-12-weight);
}
header .user a {
  display: inline-flex;
  align-items: center;
  height: var(--button-small-height);
  padding: var(--button-small-padding);
  border-radius: var(--button-small-radius);
  color: var(--gray-1000);
  text-decoration: none;
  font-size: var(--typo-button-12-size);
  font-weight: var(--typo-button-12-weight);
}
header .user a:hover { background: var(--sidebar-active-bg); }
header .user a:focus-visible { outline: none; box-shadow: var(--focus-ring); }
header .user span { padding: 0 var(--spacing-2); color: var(--gray-900); white-space: nowrap; }
.banner a { color: inherit; }
h1 {
  margin: 0;
  font-size: var(--typo-heading-24-size);
  font-weight: var(--typo-heading-24-weight);
  line-height: var(--typo-heading-24-line);
  letter-spacing: var(--typo-heading-24-tracking);
}
main { max-width: 960px; margin: 0 auto; padding: var(--spacing-6) var(--spacing-4); }
.sections { display: grid; grid-template-columns: 1fr; gap: var(--spacing-8); }
@media (min-width: 900px) {
  .sections { grid-template-columns: repeat(3, 1fr); }
}
section {
  background: var(--card-bg);
  color: var(--card-fg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
  padding: var(--card-padding);
}
section.enabled { background: var(--card-bg); border: 1px solid var(--card-border); }
section form { margin-top: var(--spacing-4); }
section h2 {
  margin: 0 0 var(--spacing-2);
  font-size: var(--typo-heading-16-size);
  font-weight: var(--typo-heading-16-weight);
  line-height: var(--typo-heading-16-line);
}
section p { margin: 0 0 var(--spacing-2); }
.status { color: var(--gray-900); font-size: var(--typo-copy-14-size); line-height: var(--typo-copy-14-line); }
.note { color: var(--amber-800); font-size: var(--typo-copy-14-size); }
button[disabled] {
  appearance: none;
  border: 1px solid var(--button-disabled-border);
  border-radius: var(--button-primary-radius);
  background: var(--button-disabled-bg);
  color: var(--button-disabled-fg);
  height: var(--button-primary-height);
  padding: var(--button-primary-padding);
  font: inherit;
  font-size: var(--typo-button-14-size);
  font-weight: var(--typo-button-14-weight);
  cursor: default;
}
.banner {
  border: 1px solid var(--notice-error-border);
  border-radius: var(--rounded-sm);
  background: var(--notice-error-bg);
  color: var(--notice-error-fg);
  padding: var(--spacing-4);
}
.banner.warn {
  border-color: var(--notice-warn-border);
  background: var(--notice-warn-bg);
  color: var(--notice-warn-fg);
}
button.primary, button.danger, button.secondary {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--button-primary-radius);
  height: var(--button-primary-height);
  padding: var(--button-primary-padding);
  font-family: var(--font-sans);
  font-size: var(--typo-button-14-size);
  font-weight: var(--typo-button-14-weight);
  line-height: var(--typo-button-14-line);
  cursor: pointer;
}
button.primary:focus-visible, button.danger:focus-visible, button.secondary:focus-visible, a.cancel:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
button.primary { background: var(--button-primary-bg); border-color: var(--button-primary-bg); color: var(--button-primary-fg); }
button.danger { background: var(--button-danger-bg); border-color: var(--button-danger-bg); color: var(--button-danger-fg); }
label.checkbox { display: block; margin: var(--spacing-4) 0; }
.id { font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
a.cancel { color: var(--gray-1000); margin-left: var(--spacing-3); }
.members { list-style: none; margin: var(--spacing-4) 0 0; padding: 0; }
.members li {
  display: flex;
  align-items: center;
  gap: var(--spacing-3);
  padding: var(--spacing-2) 0;
  border-top: 1px solid var(--gray-alpha-400);
}
.members .meta, .members .you { color: var(--gray-900); font-size: var(--typo-copy-14-size); }
.members .you { margin-left: auto; }
.members form { margin: 0 0 0 auto; }
.apps { list-style: none; margin: var(--spacing-4) 0 0; padding: 0; }
.apps li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-3);
  padding: var(--spacing-2) 0;
  border-top: 1px solid var(--gray-alpha-400);
}
.apps .meta { color: var(--gray-900); font-size: var(--typo-copy-14-size); }
.apps .controls { margin-left: auto; display: flex; gap: var(--spacing-2); }
.apps form { margin: 0; }
.apps .empty { margin-top: var(--spacing-4); }
.keys { list-style: none; margin: var(--spacing-4) 0 0; padding: 0; }
.keys li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-3);
  padding: var(--spacing-2) 0;
  border-top: 1px solid var(--gray-alpha-400);
}
.keys .meta { color: var(--gray-900); font-size: var(--typo-copy-14-size); }
.keys form { margin: 0 0 0 auto; }
button.secondary {
  background: var(--button-secondary-bg);
  border-color: var(--button-secondary-border);
  color: var(--button-secondary-fg);
}
label.field { display: block; margin: var(--spacing-4) 0 var(--spacing-2); }
label.field input, label.field select {
  display: block;
  margin-top: var(--spacing-2);
  border: 1px solid var(--gray-400);
  border-radius: var(--rounded-sm);
  padding: var(--spacing-2) var(--spacing-3);
  font: inherit;
  background: var(--background-100);
  color: var(--gray-1000);
}
main > section + section { margin-top: var(--spacing-8); }
</style>`;

function htmlLang(locale: Locale): string {
  return locale === "zh_CN" ? "zh-CN" : "en";
}

function wrapPhraseAsLink(text: string, phrase: string, href: string): string {
  const i = text.indexOf(phrase);
  if (i === -1) return text;
  return `${text.slice(0, i)}<a href="${href}">${phrase}</a>${text.slice(i + phrase.length)}`;
}

function page(title: string, body: string, locale: Locale = "en"): string {
  return `<!doctype html>
<html lang="${htmlLang(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t(locale, "common.pageTitle", { page: title, brand: t(locale, "nav.brand") }))}</title>
${STYLE}
</head>
<body>${body}</body>
</html>`;
}

function placeholderSection(
  title: string,
  description: string,
  status: string,
  action: string,
  extra = "",
): string {
  return `<section aria-disabled="true">
    <h2>${title}</h2>
    <p>${description}</p>
    <p class="status">${status}</p>
    ${extra}
    <button type="button" disabled aria-disabled="true">${action}</button>
  </section>`;
}

/**
 * Flow-page chrome: product name + GitHub identity + Logout, restyled to
 * the SPA navbar tokens. Manifest pages never pass `adminNav` (Members
 * stays on the dashboard shell only). No language toggle — current IA.
 */
function shellHeader(
  user: { login: string; name?: string },
  adminNav = false,
  locale: Locale = "en",
): string {
  const display = user.name ? `${user.name} (${user.login})` : user.login;
  const members = adminNav
    ? `<a href="/dashboard/members">${escapeHtml(t(locale, "nav.members"))}</a>`
    : "";
  return `<header>
    <h1><a href="/dashboard">${escapeHtml(t(locale, "nav.brand"))}</a></h1>
    <span class="user">
      <a href="/dashboard/apps">${escapeHtml(t(locale, "nav.apps"))}</a>
      <a href="/dashboard/insights">${escapeHtml(t(locale, "nav.insights"))}</a>
      ${members}
      <span>${escapeHtml(t(locale, "nav.signedInAs", { name: display }))}</span>
      <a href="/dashboard/logout">${escapeHtml(t(locale, "nav.logout"))}</a>
    </span>
  </header>`;
}

/** B1: GitHub App section is live — primary constructive action (blue-700). */
function githubAppSection(): string {
  return `<section class="enabled">
    <h2>GitHub App</h2>
    <p>Create the review GitHub App in your GitHub account via the Manifest flow — no local wrangler secret put.</p>
    <form method="post" action="/dashboard/manifest/start">
      <button type="submit" class="primary">Create GitHub App</button>
    </form>
  </section>`;
}

/**
 * B2 delivered: Model keys are per-App, so this shell card is an entry point,
 * not a placeholder — the copy states keys/models are configured per App and
 * links to the Apps list, where members reach Settings on the Apps they
 * manage.
 */
function modelKeysSection(): string {
  return `<section class="enabled">
    <h2>Model keys</h2>
    <p>Provider keys and model chains are configured per App — each App's Settings manages its own keys; an App without the keys its chain needs fails closed (per-App only, no deployment-level fallback — plan 24).</p>
    <p><a href="/dashboard/apps">Open the Apps list</a> to reach Settings on an App you manage.</p>
  </section>`;
}

/**
 * Logged-in shell: header + sections (B1: GitHub App live; B2: per-App
 * Model keys entry point; Review stays a placeholder). T5 removes the
 * REVIEW_ENABLED sentence — per-App pause is the only switch named.
 */
export function dashboardPage(user: { login: string; name?: string }, isAdmin = false): string {
  return page(
    "Dashboard",
    `${shellHeader(user, isAdmin)}
  <main>
    <div class="sections">
      ${githubAppSection()}
      ${modelKeysSection()}
      ${placeholderSection(
        "Review",
        "Reviews are controlled per App — pause an App to stop its reviews.",
        "Not in this iteration (B3).",
        "Enable reviews",
        '<p class="note">Pause an App from its Settings to stop reviews for that App.</p>',
      )}
    </div>
  </main>`,
  );
}

/**
 * Manifest start interstitial (B1 Task 1): zero-JS form POST to GitHub
 * carrying the manifest JSON; `state` rides the form-action query (GitHub
 * echoes it into the redirect_url next to `code`). Nothing is created until
 * the operator confirms on GitHub.
 */
export function manifestStartPage(
  user: { login: string; name?: string },
  appName: string,
  manifestJson: string,
  createUrl: string,
  locale: Locale = "en",
): string {
  return page(
    t(locale, "manifest.title"),
    `${shellHeader(user, false, locale)}
  <main>
    <section class="enabled">
      <h2>${escapeHtml(t(locale, "manifest.start.heading"))}</h2>
      <p>${t(locale, "manifest.start.body", { appName: `<strong>${escapeHtml(appName)}</strong>` })}</p>
      <form method="post" action="${escapeHtml(createUrl)}">
        <input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}">
        <button type="submit" class="primary">${escapeHtml(t(locale, "manifest.start.continue"))}</button>
        <a class="cancel" href="/dashboard">${escapeHtml(t(locale, "manifest.start.cancel"))}</a>
      </form>
    </section>
  </main>`,
    locale,
  );
}

/**
 * App summary confirm gate (B5 T3, spec § Multi-App 契约 — the B1
 * overwrite-confirm semantics are GONE: nothing shared is overwritten, the
 * commit writes a NEW github_apps row). Single column, read-only summary
 * (name, numeric id, slug, webhook URL), amber note, primary submit.
 * PEM / webhook_secret NEVER appear here.
 */
export function manifestConfirmPage(
  user: { login: string; name?: string },
  app: { id: number; name: string; slug: string; webhookUrl: string },
  locale: Locale = "en",
): string {
  const ready = t(locale, "manifest.confirm.ready", {
    appName: `<strong>${escapeHtml(app.name)}</strong>`,
    id: `<span class="id">${app.id}</span>`,
  });
  const slugWebhook = t(locale, "manifest.confirm.slugWebhook", {
    slug: `<strong>${escapeHtml(app.slug)}</strong>`,
    webhookUrl: `<strong>${escapeHtml(app.webhookUrl)}</strong>`,
  });
  return page(
    t(locale, "manifest.title"),
    `${shellHeader(user, false, locale)}
  <main>
    <section class="enabled">
      <h2>${escapeHtml(t(locale, "manifest.confirm.heading"))}</h2>
      <p>${ready}</p>
      <p>${escapeHtml(t(locale, "manifest.confirm.registeredAs"))}</p>
      <p class="status">${slugWebhook}</p>
      <p class="note">${escapeHtml(t(locale, "manifest.confirm.note"))}</p>
      <form method="post" action="/dashboard/manifest/commit">
        <button type="submit" class="primary">${escapeHtml(t(locale, "manifest.confirm.create"))}</button>
        <a class="cancel" href="/dashboard">${escapeHtml(t(locale, "manifest.confirm.cancel"))}</a>
      </form>
    </section>
  </main>`,
    locale,
  );
}

/**
 * App summary success surface (B5 T3, spec § User-visible behavior 3):
 * slug, webhook URL, numeric App id — tabular-nums id, NO success green.
 * PEM / webhook_secret NEVER appear here.
 */
export function manifestSuccessPage(
  user: { login: string; name?: string },
  app: { id: number; name: string; slug: string; webhookUrl: string },
  locale: Locale = "en",
): string {
  const stored = t(locale, "manifest.success.stored", {
    appName: `<strong>${escapeHtml(app.name)}</strong>`,
    id: `<span class="id">${app.id}</span>`,
  });
  return page(
    t(locale, "manifest.success.title"),
    `${shellHeader(user, false, locale)}
  <main>
    <section class="enabled">
      <h2>${escapeHtml(t(locale, "manifest.success.heading"))}</h2>
      <p>${stored}</p>
      <p class="status">${escapeHtml(t(locale, "manifest.success.slug", { slug: app.slug }))}<br>${escapeHtml(t(locale, "manifest.success.webhookUrl", { webhookUrl: app.webhookUrl }))}</p>
      <p class="status">${escapeHtml(t(locale, "manifest.success.reviewsNote"))}</p>
      <p><a href="/dashboard/apps">${escapeHtml(t(locale, "manifest.success.viewApps"))}</a> · <a href="/dashboard">${escapeHtml(t(locale, "manifest.success.backToDashboard"))}</a></p>
    </section>
  </main>`,
    locale,
  );
}

/** Manifest failure surface: error notice + what-to-do-next, never secrets. No chrome (current IA). */
export function manifestErrorPage(message: string, resumable = false, locale: Locale = "en"): string {
  // Resumable failures (retryable commit outcomes: 400/500/502) keep the
  // hold cookie, so the what-to-do-next link goes back to the confirm gate,
  // not a shell with no confirm form.
  const next = resumable
    ? wrapPhraseAsLink(
        t(locale, "manifest.error.resumable"),
        t(locale, "manifest.error.confirmPage"),
        "/dashboard/manifest/confirm",
      )
    : wrapPhraseAsLink(t(locale, "manifest.error.retry"), "/dashboard", "/dashboard");
  return page(
    t(locale, "manifest.error.title"),
    `<main>
    <div class="banner" role="alert">
      <strong>${escapeHtml(t(locale, "manifest.error.failedHeading"))}</strong> ${escapeHtml(message)}
      ${escapeHtml(t(locale, "manifest.error.secretsUnchanged"))} ${next}
    </div>
  </main>`,
    locale,
  );
}

/**
 * Invite-only denial (plan 12 B4 T1, spec § User-visible behavior 1) —
 * locked English copy with the GitHub-verified login interpolated
 * (escaped). The callback deny path renders this at 403 with ZERO
 * Set-Cookie: no session, no state expiry, nothing. Red-700 banner, no
 * login link back (an unknown user has nothing to return to).
 */
export function deniedPage(login: string, locale: Locale = "en"): string {
  return page(
    t(locale, "common.error.deniedTitle"),
    `<main>
    <div class="banner" role="alert">${t(locale, "common.error.deniedBody", { login: escapeHtml(login) })}</div>
  </main>`,
    locale,
  );
}

/**
 * Removed-member denial (plan 12 B4 T2, per-request guard) — distinct from
 * deniedPage: this visitor's cookie verified but has no users row (access
 * removed after the session was minted; removal = row delete, no status
 * column). Red-700 banner, no login link back — re-authenticating lands on
 * the OAuth callback bootstrap deny until an admin re-invites the login.
 */
export function removedPage(login: string, locale: Locale = "en"): string {
  return page(
    t(locale, "common.error.removedTitle"),
    `<main>
    <div class="banner" role="alert">${t(locale, "common.error.removedBody", { login: escapeHtml(login) })}</div>
  </main>`,
    locale,
  );
}

/**
 * Non-admin denial for admin-only surfaces (plan 12 B4 T3): the visitor IS a
 * member — the per-request guard passed — but has no `admin` row. Distinct
 * from deniedPage / removedPage: access exists, this page does not. Red-700
 * banner with a way back to the shell.
 */
export function forbiddenPage(login: string, locale: Locale = "en"): string {
  const body = t(locale, "common.error.forbiddenBody", { login: escapeHtml(login) }).replace(
    "/dashboard",
    '<a href="/dashboard">/dashboard</a>',
  );
  return page(
    t(locale, "common.error.forbiddenTitle"),
    `<main>
    <div class="banner" role="alert">${body}</div>
  </main>`,
    locale,
  );
}

/** OAuth failure surface: red-700 banner + what-to-do-next (DESIGN.md § State legibility). */
export function errorPage(message: string, locale: Locale = "en"): string {
  const body = t(locale, "common.error.signInErrorBody", { message: escapeHtml(message) }).replace(
    "/dashboard/login",
    '<a href="/dashboard/login">/dashboard/login</a>',
  );
  return page(
    t(locale, "common.error.signInErrorTitle"),
    `<main>
    <div class="banner" role="alert">${body}</div>
  </main>`,
    locale,
  );
}

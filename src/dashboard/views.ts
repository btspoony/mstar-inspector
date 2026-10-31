/**
 * Zero-build SSR HTML for /dashboard (architect decision Q8): TS
 * template strings + a single inline <style> block.
 *
 * The stylesheet paints from the semantic and component layers only. Its
 * values are the generated table in `ssr-tokens.generated.ts` — emitted from
 * the design system's token source by `scripts/build-tokens.ts` — because this
 * face cannot import the design system (module boundary, no DOM) and must not
 * keep a third hand copy of the palette. `SSR_TOKENS` below names the
 * vocabulary the rules use; a name it lists but the source does not declare is
 * a build error, not a blank declaration.
 *
 * Dark is the deterministic default (no OS fallback, v0.3.4): `:root` carries
 * the dark values, `:root[data-theme="light"]` re-declares the differing ones,
 * and page() inlines the pre-paint theme bootstrap so the stored
 * localStorage["mstar.dashboard.theme"] choice is honored before first paint.
 * Manifest pages stay zero client runtime — pre-paint bootstrap snippet only;
 * no bundle, no build chain, no new dependencies.
 */
import { t, type Locale } from "../i18n";
import type { SsrTheme } from "./ssr-tokens.generated";
import { ssrTokenValues } from "./ssr-tokens.generated";

/**
 * Every token this face paints with, by name. The values live in the generated
 * table, so this list is a vocabulary choice — never a second copy of a design
 * decision, and never a palette step.
 */
const SSR_TOKENS = [
  "font-sans",
  "font-mono",
  "surface-page",
  "surface-raised",
  "surface-overlay",
  "text-primary",
  "text-secondary",
  "border-default",
  "tone-accent-fg",
  "tone-danger-bg",
  "tone-danger-border",
  "tone-danger-fg",
  "tone-warn-fg",
  "focus-ring",
  "shadow-card",
  "radius-control",
  "spacing-1",
  "spacing-2",
  "spacing-3",
  "spacing-4",
  "spacing-6",
  "spacing-8",
  "card-bg",
  "card-fg",
  "card-border",
  "card-radius",
  "card-padding",
  "button-primary-bg",
  "button-primary-fg",
  "button-primary-border",
  "button-height-md",
  "button-padding-md",
  "button-height-sm",
  "button-padding-sm",
  "button-radius",
  "typo-heading-24-size",
  "typo-heading-24-weight",
  "typo-heading-24-line",
  "typo-heading-24-tracking",
  "typo-heading-16-size",
  "typo-heading-16-weight",
  "typo-heading-16-line",
  "typo-copy-16-size",
  "typo-copy-16-line",
  "typo-copy-14-size",
  "typo-copy-14-line",
  "typo-label-12-size",
  "typo-label-12-weight",
  "typo-button-14-size",
  "typo-button-14-weight",
  "typo-button-14-line",
  "typo-button-12-size",
  "typo-button-12-weight",
] as const;

type SsrToken = (typeof SSR_TOKENS)[number];

/** One theme's value for a name this face declares. A missing name fails loudly here, at import. */
const tokenValue = (theme: SsrTheme, name: SsrToken): string => {
  const value = ssrTokenValues[theme][name];
  if (value === undefined) throw new Error(`src/dashboard/views.ts names an undeclared token --${name}`);
  return value;
};

const declarations = (theme: SsrTheme, names: readonly SsrToken[]): string =>
  names.map((name) => `  --${name}: ${tokenValue(theme, name)};`).join("\n");

/** The dark face declares the whole vocabulary; light re-declares only what differs. */
const DARK_DECLARATIONS = declarations("dark", SSR_TOKENS);
const LIGHT_DECLARATIONS = declarations(
  "light",
  SSR_TOKENS.filter((name) => tokenValue("light", name) !== tokenValue("dark", name)),
);


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
/* The SSR face's token block. The values are the generated semantic/component
   layer (src/dashboard/ssr-tokens.generated.ts), so these pages paint exactly
   what the SPA paints in the same theme; nothing here names a palette step.
   Dark is the console default and the deterministic fallback: the pre-paint
   bootstrap in page() applies a stored light/dark choice, which wins; unset
   stays dark in every browser (no OS fallback, v0.3.4). */
:root {
  color-scheme: dark;
${DARK_DECLARATIONS}
  /* The two-layer focus halo: the page plane inside, the focus duty outside. */
  --focus-halo: 0 0 0 2px var(--surface-page), 0 0 0 4px var(--focus-ring);
}
/* Stored manual choice — the only light face (the theme mechanism, applied
   pre-paint by the bootstrap in page()). Only the differing names re-declare;
   everything else follows through the token the dark block already set. */
:root[data-theme="light"] {
  color-scheme: light;
${LIGHT_DECLARATIONS}
}
/* Stored manual dark — dark is already the :root default, so the explicit
   attribute is a documented no-op (every stored choice maps to a branch). */
:root[data-theme="dark"] {}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--surface-page);
  color: var(--text-primary);
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
  background: var(--surface-raised);
  border-bottom: 1px solid var(--border-default);
}
header h1 {
  margin: 0;
  font-size: var(--typo-heading-16-size);
  font-weight: var(--typo-heading-16-weight);
  line-height: var(--typo-heading-16-line);
  white-space: nowrap;
}
header h1 a {
  color: var(--text-primary);
  text-decoration: none;
}
header h1 a:focus-visible { outline: none; box-shadow: var(--focus-halo); border-radius: var(--radius-control); }
header .user {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--spacing-1);
  margin-left: auto;
  color: var(--text-secondary);
  font-size: var(--typo-label-12-size);
  font-weight: var(--typo-label-12-weight);
}
header .user a {
  display: inline-flex;
  align-items: center;
  height: var(--button-height-sm);
  padding: var(--button-padding-sm);
  border-radius: var(--button-radius);
  color: var(--text-primary);
  text-decoration: none;
  font-size: var(--typo-button-12-size);
  font-weight: var(--typo-button-12-weight);
}
header .user a:hover { background: var(--surface-overlay); }
header .user a:focus-visible { outline: none; box-shadow: var(--focus-halo); }
header .user span { padding: 0 var(--spacing-2); color: var(--text-secondary); white-space: nowrap; }
.banner a { color: inherit; }
h1 {
  margin: 0;
  font-size: var(--typo-heading-24-size);
  font-weight: var(--typo-heading-24-weight);
  line-height: var(--typo-heading-24-line);
  letter-spacing: var(--typo-heading-24-tracking);
}
main { max-width: 960px; margin: 0 auto; padding: var(--spacing-6) var(--spacing-4); }
/* Auth-journey faces (SSR sync): the no-chrome auth surfaces
   (denied / removed / forbidden / OAuth error) share the SPA login face's
   centered-card language — brand wordmark echo + card on the themed canvas.
   Values ride the semantic and component layers, so the face follows the
   active theme exactly as the SPA login card does; the manifest flow pages
   stay on the plain main/banner face. */
main.auth {
  display: grid;
  place-items: center;
  min-height: 100vh;
  max-width: none;
  padding: var(--spacing-6) var(--spacing-4);
}
.auth-card {
  width: 100%;
  max-width: 384px;
  background: var(--card-bg);
  color: var(--card-fg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
  box-shadow: var(--shadow-card);
  padding: var(--card-padding);
}
.auth-brand {
  display: flex;
  align-items: center;
  gap: var(--spacing-2);
  margin: 0 0 var(--spacing-4);
  /* The SPA sidebar wordmark's face, verbatim (14/600, tight tracking). */
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.025em;
}
.auth-brand svg {
  width: 24px;
  height: 24px;
  flex: none;
  color: var(--tone-accent-fg);
}
section {
  background: var(--card-bg);
  color: var(--card-fg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
  padding: var(--card-padding);
}
section form { margin-top: var(--spacing-4); }
section h2 {
  margin: 0 0 var(--spacing-2);
  font-size: var(--typo-heading-16-size);
  font-weight: var(--typo-heading-16-weight);
  line-height: var(--typo-heading-16-line);
}
section p { margin: 0 0 var(--spacing-2); }
.status { color: var(--text-secondary); font-size: var(--typo-copy-14-size); line-height: var(--typo-copy-14-line); }
.note { color: var(--tone-warn-fg); font-size: var(--typo-copy-14-size); }
.banner {
  border: 1px solid var(--tone-danger-border);
  border-radius: var(--radius-control);
  background: var(--tone-danger-bg);
  color: var(--tone-danger-fg);
  padding: var(--spacing-4);
}
a.primary, button.primary {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--button-primary-border);
  border-radius: var(--button-radius);
  height: var(--button-height-md);
  padding: var(--button-padding-md);
  font-family: var(--font-sans);
  font-size: var(--typo-button-14-size);
  font-weight: var(--typo-button-14-weight);
  line-height: var(--typo-button-14-line);
  cursor: pointer;
  text-decoration: none;
}
a.primary:focus-visible, button.primary:focus-visible, a.cancel:focus-visible {
  outline: none;
  box-shadow: var(--focus-halo);
}
a.primary, button.primary {
  background: var(--button-primary-bg);
  border-color: var(--button-primary-bg);
  color: var(--button-primary-fg);
}
.id { font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
a.cancel { color: var(--text-primary); margin-left: var(--spacing-3); }
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

/**
 * Brand mark for the auth-journey faces (SSR sync) — the same
 * inline silhouette as the SPA AppSidebar Logo (zero image assets; the
 * mark colors via `currentColor`, see `.auth-brand svg` in STYLE).
 */
const AUTH_MARK =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"></circle><path d="M12 4 L13.2 10.2 L20 12 L13.2 13.8 L12 20 L10.8 13.8 L4 12 L10.8 10.2 Z" fill="currentColor"></path></svg>';

/**
 * No-chrome auth-journey face (SSR sync): the login-family
 * surfaces (denied / removed / forbidden / OAuth error) render the SPA
 * login face's centered-card language — wordmark echo + card on the themed
 * canvas. `bannerHtml` must arrive pre-escaped by the caller: dynamic values
 * are escapeHtml-ed before `t()` interpolation, and links are composed by
 * string replace on the already-escaped output (wrapPhraseAsLink belongs to
 * the manifest error pages, not this face); the alert keeps role="alert"
 * (WCAG 4.1.3, unchanged from the banner contract).
 */
function authFace(title: string, bannerHtml: string, locale: Locale = "en"): string {
  return page(
    title,
    `<main class="auth">
    <section class="auth-card">
      <div class="auth-brand">${AUTH_MARK}<span>${escapeHtml(t(locale, "nav.brand"))}</span></div>
      <div class="banner" role="alert">${bannerHtml}</div>
    </section>
  </main>`,
    locale,
  );
}

function page(title: string, body: string, locale: Locale = "en"): string {
  return `<!doctype html>
<html lang="${htmlLang(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t(locale, "common.pageTitle", { page: title, brand: t(locale, "nav.brand") }))}</title>
<script>
// Pre-paint theme bootstrap (the theme mechanism, SSR face):
// apply the stored manual theme before first paint. Whitelist — unreadable
// or invalid values stay unset and render dark (deterministic default).
try {
  const theme = localStorage.getItem("mstar.dashboard.theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {}
</script>
${STYLE}
</head>
<body>${body}</body>
</html>`;
}

/**
 * Flow-page chrome: product name + GitHub identity + Logout, restyled to
 * the SPA navbar tokens. Manifest pages never pass `adminNav` (Members
 * stays on the dashboard shell only). No language toggle — current IA.
 * Apps points at the workbench itself (`/dashboard` — the
 * legacy `/dashboard/apps` page is a 301 alias).
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
      <a href="/dashboard">${escapeHtml(t(locale, "nav.apps"))}</a>
      ${members}
      <span>${escapeHtml(t(locale, "nav.signedInAs", { name: display }))}</span>
      <a href="/dashboard/logout">${escapeHtml(t(locale, "nav.logout"))}</a>
    </span>
  </header>`;
}

/**
 * Manifest start interstitial: zero-JS form POST to GitHub
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
 * App summary confirm gate (spec § Multi-App 契约 — the manifest
 * overwrite-confirm semantics are GONE: nothing shared is overwritten, the
 * commit writes a NEW github_apps row). Single column, read-only summary
 * (name, numeric id, GitHub slug, webhook URL), amber note, primary submit.
 * PEM / webhook_secret NEVER appear here.
 */
export function manifestConfirmPage(
  user: { login: string; name?: string },
  app: { id: number; name: string; slug: string | null; webhookUrl: string },
  locale: Locale = "en",
): string {
  const ready = t(locale, "manifest.confirm.ready", {
    appName: `<strong>${escapeHtml(app.name)}</strong>`,
    id: `<span class="id">${app.id}</span>`,
  });
  // Before the first metadata sync GitHub's slug is unknown; the App id is the
  // honest stand-in, and it carries the App ID label rather than pretending to
  // be a GitHub slug.
  const slugWebhook = app.slug
    ? t(locale, "manifest.confirm.slugWebhook", {
        slug: `<strong>${escapeHtml(app.slug)}</strong>`,
        webhookUrl: `<strong>${escapeHtml(app.webhookUrl)}</strong>`,
      })
    : t(locale, "manifest.confirm.appIdWebhook", {
        id: `<strong>${app.id}</strong>`,
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
 * App onboarding surface (AC4b) — the post-commit landing page:
 * App name, numeric id, GitHub slug, webhook URL, and the provider-first
 * next-step CTA into Settings. Same summary discipline as the confirm gate:
 * tabular id, no success green. PEM / webhook_secret NEVER appear here.
 * The GitHub slug is what GitHub actually shows and can rename, so before the
 * first metadata sync the page shows the numeric App id under an **App ID**
 * label instead of inventing a slug; the Settings link addresses the App by
 * that same immutable id.
 */
export function manifestOnboardingPage(
  user: { login: string; name?: string },
  app: { id: number; name: string; slug: string | null; webhookUrl: string },
  locale: Locale = "en",
  /** Workspace ref (id or slug) under `strict`; null renders today's legacy targets. */
  workspaceRef: string | null = null,
): string {
  const connected = t(locale, "manifest.onboarding.connected", {
    appName: `<strong>${escapeHtml(app.name)}</strong>`,
    id: `<span class="id">${app.id}</span>`,
  });
  // The legacy App family answers 404 under `strict`, so the primary CTA
  // follows the workspace the page was reached through. The secondary link
  // stays `/dashboard`: under `strict` the root now redirects into the
  // workspace Apps page (`signedInLanding`).
  const settingsBase =
    workspaceRef === null
      ? "/dashboard/apps"
      : `/dashboard/${escapeHtml(workspaceRef)}/apps`;
  return page(
    t(locale, "manifest.onboarding.title"),
    `${shellHeader(user, false, locale)}
  <main>
    <section class="enabled">
      <h2>${escapeHtml(t(locale, "manifest.onboarding.heading"))}</h2>
      <p>${connected}</p>
      <p class="status">${escapeHtml(app.slug ? t(locale, "manifest.onboarding.slug", { slug: app.slug }) : t(locale, "manifest.onboarding.appId", { id: app.id }))}<br>${escapeHtml(t(locale, "manifest.onboarding.webhookUrl", { webhookUrl: app.webhookUrl }))}</p>
      <p class="note">${escapeHtml(t(locale, "manifest.onboarding.nextStep"))}</p>
      <p><a class="primary" href="${settingsBase}/${app.id}/settings">${escapeHtml(t(locale, "manifest.onboarding.openSettings"))}</a> · <a href="/dashboard">${escapeHtml(t(locale, "manifest.onboarding.dashboard"))}</a></p>
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
 * Removed-member denial — the per-request guard's face, and the OAuth
 * callback's only deny branch (a recorded removal; membership rules make sign-in
 * otherwise unconditional). Removal = row delete, no status column. Red-700
 * banner, no login link back — signing in again lands on this same page until
 * the login is re-admitted.
 */
export function removedPage(login: string, locale: Locale = "en"): string {
  return authFace(
    t(locale, "common.error.removedTitle"),
    t(locale, "common.error.removedBody", { login: escapeHtml(login) }),
    locale,
  );
}

/**
 * Non-admin denial for admin-only surfaces: the visitor IS a
 * member — the per-request guard passed — but has no `admin` row. Distinct
 * from removedPage: access exists, this page does not. Red-700
 * banner with a way back to the shell.
 */
export function forbiddenPage(login: string, locale: Locale = "en"): string {
  const body = t(locale, "common.error.forbiddenBody", { login: escapeHtml(login) }).replace(
    "/dashboard",
    '<a href="/dashboard">/dashboard</a>',
  );
  return authFace(t(locale, "common.error.forbiddenTitle"), body, locale);
}

/**
 * Tenant-invisible App: the workspace-scoped 404 surface. A cross-workspace or
 * unknown App answers a REAL 404 on HTML navigation too — the legacy
 * pinned-POST redirect would bounce the operator into a shell the request has
 * no access to.
 */
export function notFoundPage(locale: Locale = "en"): string {
  const body = t(locale, "common.error.notFoundBody").replace(
    "/dashboard",
    '<a href="/dashboard">/dashboard</a>',
  );
  return authFace(t(locale, "common.error.notFoundTitle"), body, locale);
}

/** OAuth failure surface: red-700 banner + what-to-do-next (DESIGN.md § State legibility). */
export function errorPage(message: string, locale: Locale = "en"): string {
  const body = t(locale, "common.error.signInErrorBody", { message: escapeHtml(message) }).replace(
    "/dashboard/login",
    '<a href="/dashboard/login">/dashboard/login</a>',
  );
  return authFace(t(locale, "common.error.signInErrorTitle"), body, locale);
}

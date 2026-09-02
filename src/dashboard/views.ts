/**
 * Zero-build SSR HTML for /dashboard (plan 08, architect decision Q8): TS
 * template strings + a single inline <style> block. Plan 29 T5 ports the
 * DESIGN.md L2 token subset from src/spa/styles/tokens.css into STYLE
 * (dark default + prefers-color-scheme light). Manifest flow pages stay
 * zero-JS SSR. No client JS, no build chain, no new dependencies.
 */
import {
  CUSTOM_PROVIDER_API_IDS,
  MODEL_ROLE_IDS,
  PROVIDER_IDS,
  type AppCustomProvider,
  type MaskedProviderKey,
} from "./app-config-store";
import type {
  AppInstallationRow,
  DeliveryOutcome,
  DeliverySummary,
  WebhookDeliveryRow,
} from "./apps-store";
import type { DashboardUserRow } from "./users";
import type { Insights } from "./insights-store";
import { t, type Locale } from "../i18n";

/** Escape GitHub-sourced user data before HTML interpolation (XSS guard). */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Relative time for store-generated SQLite datetime('now') stamps (UTC
 * "YYYY-MM-DD HH:MM:SS" — the reviews.reviewed_at convention), plan 16
 * install-health panel: coarse buckets only (just now / N minutes / N hours
 * / N days ago — each spelled exactly once per bucket size). NULL = "never"
 * (the github_apps.last_webhook_at sentinel); unparseable input degrades to
 * "unknown" rather than guessing. Output is always a constant phrase — the
 * raw (escaped-elsewhere) timestamp never renders.
 */
function relativeTime(value: string | null): string {
  if (value === null) return "never";
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!m) return "unknown";
  const then = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  const diffMs = Date.now() - then;
  if (diffMs < 60_000) return "just now"; // clock skew into the future reads as just now
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(diffMs / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
/**
 * Delivery-outcome badge (plan 20 Task 2, AL-20-2): the producer vocabulary
 * is ok | paused | ignored | rejected — rejected is the ONLY attention
 * state (amber-700 .note token, the same token the list uses for the
 * disabled/paused badges); ok, paused, and ignored are healthy (gray
 * .status). The outcome text is escaped — it is a stored string, and the
 * brief pins escapeHtml on every user-influenced string.
 */
function deliveryOutcomeBadge(outcome: DeliveryOutcome): string {
  return outcome === "rejected"
    ? `<span class="note">${escapeHtml(outcome)}</span>`
    : `<span class="status">${escapeHtml(outcome)}</span>`;
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
<title>${escapeHtml(t(locale, "common.pageTitle", { page: title }))}</title>
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

/** Notice slot for membersPage / appsPage: existing classes only, no new tokens. */
export type PageNotice = { kind: "success" | "warn" | "error"; message: string };

function pageNoticeHtml(notice?: PageNotice): string {
  if (!notice) return "";
  if (notice.kind === "error") {
    return `<div class="banner" role="alert">${escapeHtml(notice.message)}</div>`;
  }
  return `<p class="${notice.kind === "warn" ? "note" : "status"}">${escapeHtml(notice.message)}</p>`;
}

/**
 * Members management (plan 12 B4 T3, admin-only): single column (same rule
 * as the B1 confirm page), masked list — login + role + created_at only; no
 * row ids, no invited_by. Remove is red-700 and is NOT offered on the
 * acting admin's own row ("you") — the route refuses self-removal, so the
 * UI never presents a control that can only fail. Invite is the blue-700
 * constructive primary.
 */
export function membersPage(
  user: { login: string; name?: string },
  members: DashboardUserRow[],
  notice?: PageNotice,
): string {
  const rows = members
    .map((m) => {
      const self = m.github_login.toLowerCase() === user.login.toLowerCase();
      const control = self
        ? '<span class="you">you</span>'
        : `<form method="post" action="/dashboard/members/remove">
          <input type="hidden" name="userId" value="${escapeHtml(m.id)}">
          <button type="submit" class="danger">Remove</button>
        </form>`;
      return `<li>
        <strong>${escapeHtml(m.github_login)}</strong>
        <span class="meta">${escapeHtml(m.role)} · <span class="id">${escapeHtml(m.created_at)}</span></span>
        ${control}
      </li>`;
    })
    .join("\n");
  return page(
    "Members",
    `${shellHeader(user)}
  <main>
    <section class="enabled">
      <h2>Members</h2>
      ${pageNoticeHtml(notice)}
      <ul class="members">
      ${rows}
      </ul>
      <form method="post" action="/dashboard/members/invite">
        <label class="field">Invite by GitHub login
          <input type="text" name="login" placeholder="e.g. octocat">
        </label>
        <button type="submit" class="primary">Invite member</button>
      </form>
    </section>
  </main>`,
  );
}

/**
 * Apps list (plan 13 B5 T3, spec § IA): member-visible list of non-deleted
 * Apps — slug, numeric App id, status (gray for active / amber for
 * disabled; plan 16 adds the amber `paused` badge for an active row with
 * review_enabled=0), creator. Disable/enable + delete controls render ONLY
 * where the viewer may manage (admin, or the App's creator — Clarify #6);
 * the route enforces the same rule, so the UI never offers a control that
 * can only 403. The Settings entry (plan 14 B2 T2) rides the same manage
 * rule — it links to the per-App BYOK page for exactly the rows the viewer
 * could edit there. Plan 16 adds the pause/resume list actions on the same
 * manage rule — both the settings-page Review switch and these actions POST
 * to the pinned /pause · /resume routes (spec § IA). Delete is red-700
 * (soft-delete is irreversible from the UI); disable/enable and pause/
 * resume are reversible (secondary gray). Create GitHub App is the blue-700
 * primary. Encrypted columns and row ids never render.
 */
export function appsPage(
  user: { login: string; name?: string },
  apps: Array<{
    slug: string;
    github_app_id: number;
    status: string;
    /** Per-App pause switch (migration 0008): 0 on an active row = paused. */
    review_enabled: number;
    created_by: string;
    /**
     * Plan 20 health column data (AL-20-2): the App's LATEST
     * webhook_deliveries row + the 24h rejected count — assembled by the
     * route from deliverySummary, NOT the github_apps.last_webhook_at
     * column (that stays the L5 "last verified delivery" stamp).
     */
    health: DeliverySummary;
  }>,
  viewer: { login: string; role: "admin" | "member" },
  notice?: PageNotice,
): string {
  const rows = apps
    .map((app) => {
      const manageable = viewer.role === "admin" || app.created_by.toLowerCase() === viewer.login.toLowerCase();
      const badge =
        app.status === "disabled"
          ? '<span class="note">disabled</span>'
          : app.review_enabled === 0
            ? '<span class="note">paused</span>'
            : `<span class="status">${escapeHtml(app.status)}</span>`;
      // Plan 20 health column (AL-20-2, display-only — no computed health):
      // relative time of the latest delivery row + its outcome badge + the
      // 24h rejected count badge (rendered only when > 0 — absence is the
      // healthy state). No rows → "delivery never", no badges.
      const latest = app.health.latest;
      const healthCell = `<span class="meta">delivery ${relativeTime(latest?.created_at ?? null)}${
        latest ? ` ${deliveryOutcomeBadge(latest.outcome)}` : ""
      }${app.health.rejected24h > 0 ? ` <span class="note">${app.health.rejected24h} rejected in 24h</span>` : ""}</span>`;
      // Zero-JS action-path POSTs (spec § IA — architect-pinned route
      // shapes; HTML forms cannot emit a DELETE verb). The pause toggle is
      // only offered on active rows — a disabled App is disconnected
      // (webhook 404), so pausing it is meaningless.
      const controls = manageable
        ? `<span class="controls"><a href="/dashboard/apps/${escapeHtml(app.slug)}/settings">Settings</a>${
            app.status === "active"
              ? app.review_enabled === 0
                ? `<form method="post" action="/dashboard/apps/${escapeHtml(app.slug)}/resume"><button type="submit" class="secondary">Resume</button></form>`
                : `<form method="post" action="/dashboard/apps/${escapeHtml(app.slug)}/pause"><button type="submit" class="secondary">Pause</button></form>`
              : ""
          }
          ${
            app.status === "active"
              ? `<form method="post" action="/dashboard/apps/${escapeHtml(app.slug)}/disable"><button type="submit" class="secondary">Disable</button></form>`
              : `<form method="post" action="/dashboard/apps/${escapeHtml(app.slug)}/enable"><button type="submit" class="secondary">Enable</button></form>`
          }
          <form method="post" action="/dashboard/apps/${escapeHtml(app.slug)}/delete"><button type="submit" class="danger">Delete</button></form>
        </span>`
        : "";
      return `<li>
        <strong>${escapeHtml(app.slug)}</strong>
        <span class="meta">App id <span class="id">${app.github_app_id}</span> · by ${escapeHtml(app.created_by)}</span>
        ${badge}
        ${healthCell}
        ${controls}
      </li>`;
    })
    .join("\n");
  const empty = apps.length === 0 ? '<p class="status empty">No Apps yet — create one below.</p>' : "";
  return page(
    "Apps",
    `${shellHeader(user)}
  <main>
    <section class="enabled">
      <h2>Apps</h2>
      ${pageNoticeHtml(notice)}
      <ul class="apps">
      ${rows}
      </ul>
      ${empty}
      <form method="post" action="/dashboard/manifest/start">
        <button type="submit" class="primary">Create GitHub App</button>
      </form>
    </section>
  </main>`,
  );
}

/**
 * One-line seat hint per MODEL_ROLE_IDS entry (UI copy only — the vocabulary
 * SSOT stays MODEL_ROLE_IDS in app-config-store; the parity lock in
 * tests/worker pins it to exactly these 4 seats). `mstar-review-seat` is the
 * quick/default Bun-fan-out seat; the other three are the deep-session seats
 * dispatched by agent name (plan 17 spec § 调研结论).
 */
const MODEL_ROLE_HINTS: Record<string, string> = {
  "mstar-review-seat": "quick + default review seats",
  "code-reviewer": "deep review seat",
  "fullstack-dev": "deep review seat",
  "frontend-dev": "deep review seat",
};

/**
 * Per-App AI settings (plan 14 B2 T2, spec § Per-App BYOK + § DESIGN.md
 * 意图): single column; masked key list — provider + last-4 ONLY (key_enc and
 * any full key material never render); add-key = provider select bound to the
 * PROVIDER_IDS allowlist (the UI can never drift from the route's 400
 * validation), led by an empty disabled placeholder — a forgetful submit
 * 400s on the empty provider — + password input (`autocomplete="new-password"`:
 * pasted API keys are new secrets, never a saved login), blue-700 primary;
 * per-key Remove = red-700
 * destructive; model chain editor with the empty = deployment-default
 * fallback spelled out (a whitespace-only save clears with a success notice —
 * the copy says so). The hint copy is replace-aware ("replaces its stored
 * key") because the store upserts and bumps the row timestamp on re-set —
 * storage recency is never labeled "created". Plan 23: each masked row also
 * shows its last-update time (migration 0012) — a pre-existing row (NULL)
 * renders an em dash until the key is re-set. Status/hints reuse the gray
 * (.status) / amber-700 (.note) tokens — no new tokens, no Level 2. Every
 * user-controlled string (slug, provider, masked tail, chain) is escaped.
 *
 * Plan 16 additions (spec § IA + § DESIGN.md 意图), appended after the
 * config sections: the Review switch — pause/resume POSTs to the pinned
 * `/pause` · `/resume` action paths (both directions blue-700 primary,
 * confirm-free and reversible; the paused state shows the amber-700 badge) —
 * and the read-only install-health panel: the App's installations as a
 * `.keys`-rhythm list (account_login + last-seen, newest first, empty state
 * "No installations yet.") plus the App-level "Last webhook" line (relative
 * time, or "never" for a NULL last_webhook_at — connection health is
 * decoupled from the pause switch). Panel data renders read-only; GitHub
 * logins are escaped (they arrive from webhook payloads). A disabled App
 * renders a gray "disconnected" line instead of the switch (Phase 5 fix,
 * PR #7 review — mirror of the list's status-gated pause toggle); the
 * install-health panel still renders.
 *
 * Plan 17 addition (spec § IA + § DESIGN.md 意图), after the Model chain
 * section: the Role models editor — one text row per audit seat (iterating
 * the MODEL_ROLE_IDS vocabulary, prefilled from the App's stored role map;
 * an unmapped role is a blank input), a single blue-700 save, and the
 * empty = App-model-chain fallback spelled out in the copy. Selectors are
 * configuration, not secrets (plain text inputs), but they ARE user input —
 * escaped in attribute context on the way out. Input names carry the
 * `role_` prefix (role_<role>) so the POST route can tell a role field from
 * any other form field and 400 a tampered role name.
 */
export function appSettingsPage(
  user: { login: string; name?: string },
  app: { slug: string; status: string; reviewEnabled: boolean; lastWebhookAt: string | null },
  maskedKeys: MaskedProviderKey[],
  modelChain: string | null,
  modelRoles: Record<string, string>,
  installations: AppInstallationRow[],
  notice?: PageNotice,
  /**
   * Plan 20 recent-deliveries panel data (AL-20-2): the App's last N
   * webhook_deliveries rows, newest first (the route reads
   * listRecentDeliveries(appId, 5)). C-1 merge reconcile (v0.8): plan 20 and
   * plan 23 both appended at this position on their branches — the reconciled
   * signature carries BOTH (deliveries, then customProviders).
   */
  deliveries: WebhookDeliveryRow[] = [],
  // Plan 23 T2: per-App custom provider declarations for the settings section.
  customProviders: AppCustomProvider[] = [],
): string {
  const base = `/dashboard/apps/${escapeHtml(app.slug)}/settings`;
  const rows = maskedKeys
    .map((k) => {
      const tail = k.last4
        ? `key ending <code class="id">${escapeHtml(k.last4)}</code>`
        : "key too short to show a tail";
      // Plan 23 T1 (migration 0012): each masked row shows its last-update
      // time. NULL (a row written before 0012) reads as an em dash until the
      // key is re-set; relativeTime turns any other value into a constant
      // phrase, so no raw timestamp can ever reach the HTML.
      const updated = k.updated_at === null ? "&mdash;" : relativeTime(k.updated_at);
      return `<li>
        <strong>${escapeHtml(k.provider)}</strong>
        <span class="meta">${tail} · updated ${updated}</span>
        <form method="post" action="${base}/key/delete">
          <input type="hidden" name="provider" value="${escapeHtml(k.provider)}">
          <button type="submit" class="danger">Remove</button>
        </form>
      </li>`;
    })
    .join("\n");
  const emptyList =
    maskedKeys.length === 0
      ? `<p class="status">No provider keys stored for this App — reviews fail closed until keys are configured (per-App BYOK only, plan 24).</p>`
      : `<ul class="keys">
      ${rows}
      </ul>`;
  // Empty disabled first option = the preselected placeholder: a forgetful
  // submit sends provider="" and hits the route's 400 re-render instead of
  // silently picking the first allowlist id.
  const options = ['<option value="" disabled selected>Select a provider…</option>']
    .concat(PROVIDER_IDS.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`))
    .join("");
  // Plan 16 Review switch: pause ≠ disable — the webhook stays connected
  // (2xx) while paused; the copy says so. Both directions are blue-700
  // primary (spec § DESIGN.md 意图), confirm-free and reversible. A DISABLED
  // App is disconnected (webhook 404 — the list withholds the pause toggle
  // on disabled rows for the same reason), so the switch and its paused/
  // resumes copy are replaced by a gray status line (Phase 5 fix, PR #7
  // review); the install-health panel below renders regardless.
  const reviewSection =
    app.status !== "active"
      ? `<section class="enabled">
      <h2>Review</h2>
      <p class="status">This App is disconnected — enable it to review.</p>
    </section>`
      : app.reviewEnabled
        ? `<section class="enabled">
      <h2>Review</h2>
      <p class="status">Reviews are on for this App&apos;s pull requests.</p>
      <form method="post" action="/dashboard/apps/${escapeHtml(app.slug)}/pause">
        <button type="submit" class="primary">Pause reviews</button>
      </form>
    </section>`
        : `<section class="enabled">
      <h2>Review</h2>
      <p><span class="note">paused</span></p>
      <p class="status">Webhooks stay connected — deliveries are answered and ignored, and nothing is reviewed until you resume.</p>
      <form method="post" action="/dashboard/apps/${escapeHtml(app.slug)}/resume">
        <button type="submit" class="primary">Resume reviews</button>
      </form>
    </section>`;
  // Install-health panel (read-only, plan 16): the App's installations,
  // newest seen first (the store face orders seen_at DESC), plus the App's
  // last verified webhook delivery. A NULL login (never observed) renders
  // as "unknown"; every login is escaped — it arrives from webhook payloads.
  const installRows = installations
    .map(
      (inst) => `<li>
        <strong>${escapeHtml(inst.account_login ?? "unknown")}</strong>
        <span class="meta">installation <span class="id">${inst.installation_id}</span> · last seen ${relativeTime(inst.seen_at)}</span>
      </li>`,
    )
    .join("\n");
  const installList =
    installations.length === 0
      ? `<p class="status">No installations yet.</p>`
      : `<ul class="keys">
      ${installRows}
      </ul>`;
  const installSection = `<section class="enabled">
      <h2>Install health</h2>
      <p class="status">Last webhook: ${relativeTime(app.lastWebhookAt)}</p>
      ${installList}
    </section>`;
  // Recent-deliveries panel (plan 20 Task 2, AL-20-2): the App's last 5
  // webhook_deliveries rows, newest first — time / event name / outcome /
  // status_code per row, reusing the .keys list rhythm (no new tokens, no
  // JS). Event names are the x-github-event header (user-influenced) →
  // escaped; a NULL event name renders the "unknown event" placeholder;
  // status_code goes through escapeHtml too (SQLite INTEGER affinity can
  // store a non-numeric TEXT from a future caller); a NULL status_code
  // (every non-rejected outcome stores NULL) renders "—".
  const deliveryRows = deliveries
    .map(
      (d) => `<li>
        <strong>${escapeHtml(d.event_name ?? "unknown event")}</strong>
        <span class="meta">${relativeTime(d.created_at)} · ${deliveryOutcomeBadge(d.outcome)} · status <span class="id">${escapeHtml(d.status_code === null ? "—" : String(d.status_code))}</span></span>
      </li>`,
    )
    .join("\n");
  const deliveryList =
    deliveries.length === 0
      ? `<p class="status">No deliveries yet.</p>`
      : `<ul class="keys">
      ${deliveryRows}
      </ul>`;
  const deliveriesSection = `<section class="enabled">
      <h2>Recent deliveries</h2>
      <p class="status">The last 5 webhook deliveries for this App — newest first.</p>
      ${deliveryList}
    </section>`;
  // Role models editor (plan 17, spec § IA + § DESIGN.md 意图): one text row
  // per audit seat in MODEL_ROLE_IDS order, prefilled from the stored role
  // map (unmapped = blank), a SINGLE blue-700 save, and the empty =
  // App-model-chain fallback stated in the copy. Selectors are plain text
  // (configuration, not secrets) but user input — the value is escaped in
  // attribute context. Inputs are named role_<role>; role names themselves
  // are the frozen vocabulary constant, not user data.
  const roleRows = MODEL_ROLE_IDS.map((role) => {
    const hint = MODEL_ROLE_HINTS[role];
    return `<label class="field">${role}${hint ? ` — ${hint}` : ""}
          <input type="text" name="role_${role}" value="${escapeHtml(modelRoles[role] ?? "")}" placeholder="e.g. openai/gpt-5:high">
        </label>`;
  }).join("\n");
  const roleSection = `<section class="enabled">
      <h2>Role models</h2>
      <p>Optional per-seat model overrides for this App&apos;s reviews — each audit role runs on its own comma-separated selector chain (a <code>:thinking</code> suffix passes through).</p>
      <p class="note">Empty = use the App model chain.</p>
      <form method="post" action="${base}">
        <input type="hidden" name="op" value="save-roles">
        ${roleRows}
        <button type="submit" class="primary">Save role models</button>
      </form>
    </section>`;
  // Custom providers (plan 23 T2, AL-23-1): per-App declarations of
  // NON-built-in model providers. The key is stored encrypted and injected
  // into the review runner by ENVIRONMENT VARIABLE NAME (CUSTOM_<ID>_API_KEY)
  // — never as a literal — so the declaration list shows no key material at
  // all. Every user-controlled string (provider_id, base_url, model_ids) is
  // escaped; the api select is bound to the frozen three-form enum.
  const customRows = customProviders
    .map(
      (p) => `<li>
        <strong>${escapeHtml(p.provider_id)}</strong>
        <span class="meta">${escapeHtml(p.base_url)} · ${escapeHtml(p.api)} · ${escapeHtml(p.model_ids.join(", "))}</span>
        <form method="post" action="${base}">
          <input type="hidden" name="op" value="remove-custom-provider">
          <input type="hidden" name="provider_id" value="${escapeHtml(p.provider_id)}">
          <button type="submit" class="danger">Remove</button>
        </form>
      </li>`,
    )
    .join("\n");
  const customEmpty =
    customProviders.length === 0
      ? `<p class="status">No custom providers declared for this App — its reviews use the built-in providers.</p>`
      : `<ul class="keys">
      ${customRows}
      </ul>`;
  // Empty disabled first option = the preselected placeholder: a forgetful
  // submit sends api="" and hits the route's 400 re-render instead of
  // silently picking the first enum value (the provider-select discipline).
  const apiOptions = ['<option value="" disabled selected>Select an API…</option>']
    .concat(CUSTOM_PROVIDER_API_IDS.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`))
    .join("");
  const customSection = `<section class="enabled">
      <h2>Custom providers</h2>
      <p>Declare a non-built-in model provider for this App&apos;s reviews — the API key is stored encrypted and injected into the review runner by environment variable name, never as a literal.</p>
      ${customEmpty}
      <form method="post" action="${base}">
        <input type="hidden" name="op" value="add-custom-provider">
        <label class="field">Provider id
          <input type="text" name="provider_id" placeholder="e.g. ark" pattern="[a-z0-9][a-z0-9-]{0,63}">
        </label>
        <label class="field">Base URL
          <input type="text" name="base_url" placeholder="https://api.example.com/v1">
        </label>
        <label class="field">API
          <select name="api">${apiOptions}</select>
        </label>
        <label class="field">Model ids
          <input type="text" name="model_ids" placeholder="e.g. deepseek-v4-flash, deepseek-r1">
        </label>
        <label class="field">API key
          <input type="password" name="key" autocomplete="new-password" placeholder="Paste the provider API key">
        </label>
        <button type="submit" class="primary">Add custom provider</button>
      </form>
    </section>`;
  return page(
    "App settings",
    `${shellHeader(user)}
  <main>
    <section class="enabled">
      <h2>Provider keys</h2>
      ${pageNoticeHtml(notice)}
      <p class="status">Keys for App <strong>${escapeHtml(app.slug)}</strong> are stored encrypted and shown masked — the last 4 characters only. Re-adding a provider replaces its stored key.</p>
      ${emptyList}
      <form method="post" action="${base}">
        <input type="hidden" name="op" value="add-key">
        <label class="field">Provider
          <select name="provider">${options}</select>
        </label>
        <label class="field">API key
          <input type="password" name="key" autocomplete="new-password" placeholder="Paste the provider API key">
        </label>
        <button type="submit" class="primary">Add key</button>
      </form>
    </section>
    <section class="enabled">
      <h2>Model chain</h2>
      <p>Comma-separated model selectors for this App&apos;s reviews — the deployment&apos;s global chain knob was retired; this App&apos;s chain is the only chain its reviews use.</p>
      <p class="note">Saving an empty chain clears it — reviews then fail closed with <code>per-App config incomplete: app &lt;id&gt;: missing model chain</code> (or <code>provider &lt;id&gt; has no configured key</code>) until the chain and the required provider keys are configured — the BYOK/chain status above is the fail-closed visibility entry, and failing reviews record <code>stage='pipeline'</code> rows in the <code>review_failures</code> table.</p>
      <form method="post" action="${base}">
        <input type="hidden" name="op" value="save-chain">
        <label class="field">Model chain
          <input type="text" name="model_chain" value="${escapeHtml(modelChain ?? "")}" placeholder="e.g. ark-plan/deepseek-v4-flash, openai/gpt-5:thinking">
        </label>
        <button type="submit" class="primary">Save model chain</button>
      </form>
    </section>
    ${customSection}
    ${roleSection}
    ${reviewSection}
    ${installSection}
    ${deliveriesSection}
  </main>`,
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
/**
 * Input-validation 400 surface (plan 22 QC W-B): a minimal notice page for
 * malformed query params on authenticated member pages — deliberately NOT
 * the OAuth errorPage (no "Sign-in failed" / "Sign-in error" copy; the
 * visitor here IS signed in, they just typed a bad ?window= / ?repo=).
 */
export function badRequestPage(message: string, locale: Locale = "en"): string {
  return page(
    t(locale, "common.error.badRequestTitle"),
    `<main>
    <div class="banner" role="alert">
      ${t(locale, "common.error.badRequestBody", { message: escapeHtml(message) })}
    </div>
  </main>`,
    locale,
  );
}

/**
 * Review Health insights panel (plan 22 Task 3, spec § M4b + § DESIGN.md
 * 意图): the member-visible HTML face of the SAME store aggregation as the
 * JSON API (GET /dashboard/api/insights/summary — one store call, two
 * faces). Five cards: window/repo summary (reviews total + verdict
 * distribution), findings by severity (horizontal bars), findings by
 * category, weekly trend (Monday-anchored weeks), and the recurring-top
 * list (title + count + repos — the fingerprint technical id NEVER
 * renders). Existing Level 1 tokens only (.status/.note/.meta/.keys/.id/
 * .enabled rhythm); the severity bars are inline-styled spans reusing the
 * CSS custom properties (no new classes, no new DESIGN tokens). Zero JS.
 * Every user-controlled string (title_sample, repo) is escaped. Empty
 * state: zero reviews in the window → the summary card carries the note
 * and the data cards are omitted; a non-empty window with no recurrences
 * shows the recurring card's own empty line.
 */
export function insightsPage(
  user: { login: string; name?: string },
  insights: Insights,
  opts: { windowDays: number; repo?: string },
): string {
  const {
    reviewsTotal,
    findingsBySeverity,
    findingsByCategory,
    verdictDistribution,
    weeklyTrend,
    recurringTop,
  } = insights;
  const windowLabel = `last ${opts.windowDays} day${opts.windowDays === 1 ? "" : "s"}`;
  const repoLabel = opts.repo ? ` · repo ${escapeHtml(opts.repo)}` : "";

  const verdictLine = verdictDistribution
    .map((v) => `${escapeHtml(v.verdict)} <span class="id">${v.count}</span>`)
    .join(" · ");

  // Severity bars: width relative to the top bucket; inline styles reuse
  // the existing CSS custom properties (no new classes, no new tokens).
  const maxSeverity = Math.max(1, ...findingsBySeverity.map((s) => s.count));
  const severityRows = findingsBySeverity
    .map((s) => {
      const pct = Math.round((s.count / maxSeverity) * 100);
      return `<li>
        <strong>${escapeHtml(s.severity)}</strong>
        <span class="meta"><span class="id">${s.count}</span> finding${s.count === 1 ? "" : "s"}</span>
        <span style="display:block;height:8px;border-radius:var(--rounded-sm);background:var(--blue-700);width:${pct}%"></span>
      </li>`;
    })
    .join("\n");

  const categoryRows = findingsByCategory
    .map(
      (c) => `<li>
        <strong>${escapeHtml(c.category ?? "uncategorized")}</strong>
        <span class="meta"><span class="id">${c.count}</span> finding${c.count === 1 ? "" : "s"}</span>
      </li>`,
    )
    .join("\n");

  const trendRows = weeklyTrend
    .map(
      (w) => `<li>
        <strong>${escapeHtml(w.week_start)}</strong>
        <span class="meta"><span class="id">${w.reviews}</span> review${w.reviews === 1 ? "" : "s"} · <span class="id">${w.findings}</span> finding${w.findings === 1 ? "" : "s"}</span>
      </li>`,
    )
    .join("\n");

  const recurringRows = recurringTop
    .map(
      (r) => `<li>
        <strong>${escapeHtml(r.title_sample)}</strong>
        <span class="meta"><span class="id">${r.count}</span> review${r.count === 1 ? "" : "s"} · ${r.repos.map(escapeHtml).join(", ")}</span>
      </li>`,
    )
    .join("\n");

  const empty = reviewsTotal === 0;
  const summaryCard = `<section class="enabled">
      <h2>Review health</h2>
      <p class="status">Window: ${windowLabel}${repoLabel}</p>
      <p class="status">Reviews: <span class="id">${reviewsTotal}</span></p>
      ${
        empty
          ? '<p class="note">No reviews in this window.</p>'
          : `<p class="status">Verdicts: ${verdictLine}</p>`
      }
    </section>`;

  const dataCards = empty
    ? ""
    : `<section class="enabled">
      <h2>Findings by severity</h2>
      ${
        severityRows === ""
          ? '<p class="status">No findings in this window.</p>'
          : `<ul class="keys">
      ${severityRows}
      </ul>`
      }
    </section>
    <section class="enabled">
      <h2>Findings by category</h2>
      ${
        categoryRows === ""
          ? '<p class="status">No findings in this window.</p>'
          : `<ul class="keys">
      ${categoryRows}
      </ul>`
      }
    </section>
    <section class="enabled">
      <h2>Weekly trend</h2>
      ${
        trendRows === ""
          ? '<p class="status">No reviews in this window.</p>'
          : `<ul class="keys">
      ${trendRows}
      </ul>`
      }
    </section>
    <section class="enabled">
      <h2>Recurring findings</h2>
      ${
        recurringRows === ""
          ? '<p class="status">No recurring findings in this window.</p>'
          : `<ul class="keys">
      ${recurringRows}
      </ul>`
      }
    </section>`;

  return page(
    "Review health",
    `${shellHeader(user)}
  <main>
    ${summaryCard}
    ${dataCards}
  </main>`,
  );
}

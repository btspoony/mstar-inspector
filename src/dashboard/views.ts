/**
 * Zero-build SSR HTML for /dashboard (plan 08, architect decision Q8): TS
 * template strings + a single inline <style> block. The CSS custom
 * properties below are a static mapping of the repo-root DESIGN.md
 * frontmatter tokens (colors / typography / spacing / rounded / sm+lg
 * breakpoints) — DESIGN.md is the SSOT; update both when tokens change.
 * No client JS, no build chain, no new dependencies.
 */
import { PROVIDER_IDS, type MaskedProviderKey } from "./app-config-store";
import type { DashboardUserRow } from "./users";

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
/* Enabled section (B1 GitHub App): background-100 fill + gray-900 1px border,
   explicitly NOT aria-disabled (spec dashboard-b1-manifest.md § DESIGN intent). */
section.enabled {
  background: var(--background-100);
  border: 1px solid var(--gray-900);
}
section form { margin-top: 16px; } /* spacing-4 */
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
.banner.warn {
  border-color: var(--amber-700);
  color: var(--amber-700);
}
/* Constructive primary (Login / Create GitHub App) = blue-700; destructive
   submits (member Remove, App Delete) = red-700; reversible per-row App
   actions = secondary gray. Native buttons, no client JS. */
button.primary, button.danger {
  appearance: none;
  border: 1px solid transparent;
  border-radius: var(--rounded-sm);
  color: var(--background-100);
  padding: 8px 12px; /* spacing-2 / spacing-3 control rhythm */
  font: inherit;
  cursor: pointer;
}
button.primary { background: var(--blue-700); border-color: var(--blue-700); }
button.danger { background: var(--red-700); border-color: var(--red-700); }
label.checkbox { display: block; margin: 16px 0; } /* spacing-4 */
.id { font-variant-numeric: tabular-nums; }
a.cancel { color: var(--gray-1000); margin-left: 12px; } /* spacing-3 */
/* Members page (plan 12 B4 T3): single column, masked list (login + role +
   created_at only), invite primary (blue-700), remove danger (red-700). */
.members { list-style: none; margin: 16px 0 0; padding: 0; } /* spacing-4 */
.members li {
  display: flex;
  align-items: center;
  gap: 12px; /* spacing-3 */
  padding: 8px 0; /* spacing-2 */
  border-top: 1px solid var(--background-200);
}
.members .meta, .members .you { color: var(--gray-900); font-size: 14px; } /* copy-14 */
.members .you { margin-left: auto; }
.members form { margin: 0 0 0 auto; } /* inline remove control overrides the section form rhythm */
/* Apps list (plan 13 B5 T3): same single-column rhythm as members; status
   badge reuses the gray (.status) / amber (.note) tokens; per-row manage
   controls sit right-aligned. button.secondary reuses the existing gray
   border token for reversible actions (no new design token). */
.apps { list-style: none; margin: 16px 0 0; padding: 0; } /* spacing-4 */
.apps li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px; /* spacing-3 */
  padding: 8px 0; /* spacing-2 */
  border-top: 1px solid var(--background-200);
}
.apps .meta { color: var(--gray-900); font-size: 14px; } /* copy-14 */
.apps .controls { margin-left: auto; display: flex; gap: 8px; } /* spacing-2 */
.apps form { margin: 0; }
.apps .empty { margin-top: 16px; } /* spacing-4 */
/* App settings key list (plan 14 B2 T2): the members/apps masked-list rhythm —
   provider + masked tail only, per-row destructive Remove (red-700). Existing
   tokens only (gray-900 meta, background-200 hairline) — no new tokens. */
.keys { list-style: none; margin: 16px 0 0; padding: 0; } /* spacing-4 */
.keys li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px; /* spacing-3 */
  padding: 8px 0; /* spacing-2 */
  border-top: 1px solid var(--background-200);
}
.keys .meta { color: var(--gray-900); font-size: 14px; } /* copy-14 */
.keys form { margin: 0 0 0 auto; } /* right-aligned remove control, same as .members */
button.secondary {
  appearance: none;
  border: 1px solid var(--gray-900);
  border-radius: var(--rounded-sm);
  background: transparent;
  color: var(--gray-1000);
  padding: 8px 12px; /* spacing-2 / spacing-3 control rhythm */
  font: inherit;
  cursor: pointer;
}
label.field { display: block; margin: 16px 0 8px; } /* spacing-4 / spacing-2 */
label.field input, label.field select {
  display: block;
  margin-top: 8px; /* spacing-2 */
  border: 1px solid var(--gray-900);
  border-radius: var(--rounded-sm);
  padding: 8px 12px; /* spacing-2 / spacing-3 control rhythm */
  font: inherit;
  background: var(--background-100);
  color: var(--gray-1000);
}
/* Stacked single-column pages (App settings = two sections): the shell grid's
   between-sections rhythm applies outside .sections too. */
main > section + section { margin-top: 32px; } /* spacing-8 */
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
 * Page header (IA: product name, GitHub identity, Logout — unchanged).
 * `adminNav` adds the admin-only Members entry (qc1/qc2 F-001 — spec § IA
 * row 1 / plan Target State "Admin sees Members section"). The Apps entry is
 * member-visible (spec § Multi-App 契约: Apps 列表全员可见), so it renders
 * for everyone ahead of the Members link; only the shell passes `adminNav`,
 * so the link never appears mid-flow on manifest/members/apps pages.
 */
function shellHeader(user: { login: string; name?: string }, adminNav = false): string {
  const display = user.name ? `${user.name} (${user.login})` : user.login;
  const members = adminNav ? ` · <a href="/dashboard/members">Members</a>` : "";
  return `<header>
    <h1>mstar-inspector</h1>
    <span class="user">Signed in as ${escapeHtml(display)} · <a href="/dashboard/apps">Apps</a>${members} · <a href="/dashboard/logout">Logout</a></span>
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
 * Logged-in shell: header + sections (B1: GitHub App live; BYOK/Review
 * placeholders). `isAdmin` renders the Members entry in the header — plain
 * Level 1 link (existing `header a` token), no new CSS (qc1/qc2 F-001).
 */
export function dashboardPage(user: { login: string; name?: string }, isAdmin = false): string {
  return page(
    "Dashboard",
    `${shellHeader(user, isAdmin)}
  <main>
    <div class="sections">
      ${githubAppSection()}
      ${placeholderSection(
        "Model keys",
        "Store a model provider key without local wrangler secret put.",
        "Not in this iteration (B2).",
        "Add model key",
      )}
      ${placeholderSection(
        "Review",
        "Turn cloud reviews on or off (REVIEW_ENABLED).",
        "Not in this iteration (B3).",
        "Enable reviews",
        '<p class="note">Reviews stay fail-closed in production until enabled here (B3).</p>',
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
): string {
  return page(
    "Create GitHub App",
    `${shellHeader(user)}
  <main>
    <section class="enabled">
      <h2>Create GitHub App</h2>
      <p>Continue to GitHub to register <strong>${escapeHtml(appName)}</strong>
      with the review permissions and webhook for this Worker. GitHub shows the requested
      permissions first — nothing is created until you confirm there.</p>
      <form method="post" action="${escapeHtml(createUrl)}">
        <input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}">
        <button type="submit" class="primary">Continue on GitHub</button>
        <a class="cancel" href="/dashboard">Cancel</a>
      </form>
    </section>
  </main>`,
  );
}

/**
 * App summary confirm gate (B5 T3, spec § Multi-App 契约 — the B1
 * overwrite-confirm semantics are GONE: nothing shared is overwritten, the
 * commit writes a NEW github_apps row). Single column, read-only summary
 * (name, numeric id, slug, webhook URL), amber-700 note, blue-700 primary
 * submit. PEM / webhook_secret NEVER appear here.
 */
export function manifestConfirmPage(
  user: { login: string; name?: string },
  app: { id: number; name: string; slug: string; webhookUrl: string },
): string {
  return page(
    "Create GitHub App",
    `${shellHeader(user)}
  <main>
    <section class="enabled">
      <h2>Create GitHub App</h2>
      <p>GitHub App <strong>${escapeHtml(app.name)}</strong> (id <span class="id">${app.id}</span>) is ready to connect.</p>
      <p>It will be registered for this deployment as:</p>
      <p class="status">Slug <strong>${escapeHtml(app.slug)}</strong> · webhook URL <strong>${escapeHtml(app.webhookUrl)}</strong></p>
      <p class="note">Connecting delivers this App's pull_request and issue_comment webhooks to this Worker. Reviews stay fail-closed until the deployment's REVIEW_ENABLED kill-switch is turned on.</p>
      <form method="post" action="/dashboard/manifest/commit">
        <button type="submit" class="primary">Create App</button>
        <a class="cancel" href="/dashboard">Cancel</a>
      </form>
    </section>
  </main>`,
  );
}

/**
 * App summary success surface (B5 T3, spec § User-visible behavior 3):
 * slug, webhook URL, numeric App id — gray-1000 + copy-16, tabular-nums id,
 * NO success green (spec § DESIGN.md 意图). PEM / webhook_secret NEVER
 * appear here; the displayed webhook URL is the row's own route.
 */
export function manifestSuccessPage(
  user: { login: string; name?: string },
  app: { id: number; name: string; slug: string; webhookUrl: string },
): string {
  return page(
    "GitHub App connected",
    `${shellHeader(user)}
  <main>
    <section class="enabled">
      <h2>GitHub App connected</h2>
      <p>GitHub App <strong>${escapeHtml(app.name)}</strong> (id <span class="id">${app.id}</span>) is stored for this deployment.</p>
      <p class="status">Slug: ${escapeHtml(app.slug)}<br>Webhook URL: ${escapeHtml(app.webhookUrl)}</p>
      <p class="status">Pull requests in repos where this App is installed are reviewed by this Worker once REVIEW_ENABLED is on.</p>
      <p><a href="/dashboard/apps">View Apps</a> · <a href="/dashboard">Back to /dashboard</a></p>
    </section>
  </main>`,
  );
}

/** Manifest failure surface: red-700 banner + what-to-do-next, never secrets. */
export function manifestErrorPage(message: string, resumable = false): string {
  // Resumable failures (retryable commit outcomes: 400/500/502) keep the
  // hold cookie, so the what-to-do-next link goes back to the confirm gate,
  // not a shell with no confirm form.
  const next = resumable
    ? `Your GitHub App is still held for retry — return to the <a href="/dashboard/manifest/confirm">confirmation page</a> to resubmit.`
    : `Return to <a href="/dashboard">/dashboard</a> to try again.`;
  return page(
    "GitHub App setup",
    `<main>
    <div class="banner" role="alert">
      <strong>GitHub App setup failed.</strong> ${escapeHtml(message)}
      No Worker secrets were changed. ${next}
    </div>
  </main>`,
  );
}

/**
 * Invite-only denial (plan 12 B4 T1, spec § User-visible behavior 1) —
 * locked English copy with the GitHub-verified login interpolated
 * (escaped). The callback deny path renders this at 403 with ZERO
 * Set-Cookie: no session, no state expiry, nothing. Red-700 banner, no
 * login link back (an unknown user has nothing to return to).
 */
export function deniedPage(login: string): string {
  return page(
    "Access denied",
    `<main>
    <div class="banner" role="alert">This deployment is invite-only. Ask an admin to add ${escapeHtml(login)}.</div>
  </main>`,
  );
}

/**
 * Removed-member denial (plan 12 B4 T2, per-request guard) — distinct from
 * deniedPage: this visitor's cookie verified but has no users row (access
 * removed after the session was minted; removal = row delete, no status
 * column). Red-700 banner, no login link back — re-authenticating lands on
 * the OAuth callback bootstrap deny until an admin re-invites the login.
 */
export function removedPage(login: string): string {
  return page(
    "Access removed",
    `<main>
    <div class="banner" role="alert">Your dashboard access was removed. Ask an admin to re-invite ${escapeHtml(login)}.</div>
  </main>`,
  );
}

/**
 * Non-admin denial for admin-only surfaces (plan 12 B4 T3): the visitor IS a
 * member — the per-request guard passed — but has no `admin` row. Distinct
 * from deniedPage / removedPage: access exists, this page does not. Red-700
 * banner with a way back to the shell.
 */
export function forbiddenPage(login: string): string {
  return page(
    "Forbidden",
    `<main>
    <div class="banner" role="alert">This page is restricted to dashboard admins. You are signed in as ${escapeHtml(login)} — back to <a href="/dashboard">/dashboard</a>.</div>
  </main>`,
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
 * disabled), creator. Disable/enable + delete controls render ONLY where
 * the viewer may manage (admin, or the App's creator — Clarify #6); the
 * route enforces the same rule, so the UI never offers a control that can
 * only 403. The Settings entry (plan 14 B2 T2) rides the same manage rule —
 * it links to the per-App BYOK page for exactly the rows the viewer could
 * edit there. Delete is red-700 (soft-delete is irreversible from the UI);
 * disable/enable are reversible (secondary gray). Create GitHub App is the
 * blue-700 primary. Encrypted columns and row ids never render.
 */
export function appsPage(
  user: { login: string; name?: string },
  apps: Array<{
    slug: string;
    github_app_id: number;
    status: string;
    created_by: string;
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
          : `<span class="status">${escapeHtml(app.status)}</span>`;
      // Zero-JS action-path POSTs (spec § IA — architect-pinned route
      // shapes; HTML forms cannot emit a DELETE verb).
      const controls = manageable
        ? `<span class="controls"><a href="/dashboard/apps/${escapeHtml(app.slug)}/settings">Settings</a>${
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
 * Per-App AI settings (plan 14 B2 T2, spec § Per-App BYOK + § DESIGN.md
 * 意图): single column; masked key list — provider + last-4 ONLY (key_enc and
 * any full key material never render); add-key = provider select bound to the
 * PROVIDER_IDS allowlist (the UI can never drift from the route's 400
 * validation) + password input, blue-700 primary; per-key Remove = red-700
 * destructive; model chain editor with the empty = deployment-default
 * fallback spelled out (a whitespace-only save clears with a success notice —
 * the copy says so). The hint copy is replace-aware ("replaces its stored
 * key") because the store upserts and bumps the row timestamp on re-set —
 * storage recency is never labeled "created". Status/hints reuse the gray
 * (.status) / amber-700 (.note) tokens — no new tokens, no Level 2. Every
 * user-controlled string (slug, provider, masked tail, chain) is escaped.
 */
export function appSettingsPage(
  user: { login: string; name?: string },
  app: { slug: string },
  maskedKeys: MaskedProviderKey[],
  modelChain: string | null,
  notice?: PageNotice,
): string {
  const base = `/dashboard/apps/${escapeHtml(app.slug)}/settings`;
  const rows = maskedKeys
    .map((k) => {
      const tail = k.last4
        ? `key ending <code class="id">${escapeHtml(k.last4)}</code>`
        : "key too short to show a tail";
      return `<li>
        <strong>${escapeHtml(k.provider)}</strong>
        <span class="meta">${tail}</span>
        <form method="post" action="${base}/key/delete">
          <input type="hidden" name="provider" value="${escapeHtml(k.provider)}">
          <button type="submit" class="danger">Remove</button>
        </form>
      </li>`;
    })
    .join("\n");
  const emptyList =
    maskedKeys.length === 0
      ? `<p class="status">No provider keys stored for this App — its reviews fall back to the deployment&apos;s global keys.</p>`
      : `<ul class="keys">
      ${rows}
      </ul>`;
  const options = PROVIDER_IDS.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("");
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
          <input type="password" name="key" placeholder="Paste the provider API key">
        </label>
        <button type="submit" class="primary">Add key</button>
      </form>
    </section>
    <section class="enabled">
      <h2>Model chain</h2>
      <p>Comma-separated model selectors for this App&apos;s reviews — same syntax as the deployment&apos;s OMP_REVIEW_MODEL.</p>
      <p class="note">Saving an empty chain clears it — reviews fall back to the deployment default (the global OMP_REVIEW_MODEL).</p>
      <form method="post" action="${base}">
        <input type="hidden" name="op" value="save-chain">
        <label class="field">Model chain
          <input type="text" name="model_chain" value="${escapeHtml(modelChain ?? "")}" placeholder="e.g. ark-plan/deepseek-v4-flash, openai/gpt-5:thinking">
        </label>
        <button type="submit" class="primary">Save model chain</button>
      </form>
    </section>
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

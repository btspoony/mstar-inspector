/**
 * Zero-build SSR HTML for /dashboard (plan 08, architect decision Q8): TS
 * template strings + a single inline <style> block. The CSS custom
 * properties below are a static mapping of the repo-root DESIGN.md
 * frontmatter tokens (colors / typography / spacing / rounded / sm+lg
 * breakpoints) — DESIGN.md is the SSOT; update both when tokens change.
 * No client JS, no build chain, no new dependencies.
 */
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
   submit (Overwrite secrets) = red-700. Native buttons, no client JS. */
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
label.field { display: block; margin: 16px 0 8px; } /* spacing-4 / spacing-2 */
label.field input {
  display: block;
  margin-top: 8px; /* spacing-2 */
  border: 1px solid var(--gray-900);
  border-radius: var(--rounded-sm);
  padding: 8px 12px; /* spacing-2 / spacing-3 control rhythm */
  font: inherit;
  background: var(--background-100);
  color: var(--gray-1000);
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
 * row 1 / plan Target State "Admin sees Members section"); only the shell
 * passes it, so the link never appears mid-flow on manifest/members pages.
 */
function shellHeader(user: { login: string; name?: string }, adminNav = false): string {
  const display = user.name ? `${user.name} (${user.login})` : user.login;
  const members = adminNav ? ` · <a href="/dashboard/members">Members</a>` : "";
  return `<header>
    <h1>mstar-inspector</h1>
    <span class="user">Signed in as ${escapeHtml(display)}${members} · <a href="/dashboard/logout">Logout</a></span>
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
 * Overwrite confirm gate (B1, spec § 确认页文案 — locked copy): single
 * column, amber-700 warning, read-only summary, confirm checkbox, red-700
 * destructive submit. PEM / webhook_secret NEVER appear here.
 */
export function manifestConfirmPage(
  user: { login: string; name?: string },
  app: { id: number; name: string },
): string {
  return page(
    "Confirm secret overwrite",
    `${shellHeader(user)}
  <main>
    <section class="enabled">
      <h2>Store GitHub App credentials</h2>
      <div class="banner warn" role="alert">This will overwrite the existing APP_ID, PRIVATE_KEY, and WEBHOOK_SECRET secrets on this Worker. Incoming webhooks will be verified with the new WEBHOOK_SECRET.</div>
      <p>GitHub App <strong>${escapeHtml(app.name)}</strong> (id <span class="id">${app.id}</span>) is ready.
      Review the warning above before storing its credentials on this Worker.</p>
      <form method="post" action="/dashboard/manifest/commit">
        <label class="checkbox"><input type="checkbox" name="confirm" value="overwrite"> I understand that APP_ID, PRIVATE_KEY, and WEBHOOK_SECRET on this Worker will be overwritten.</label>
        <button type="submit" class="danger">Overwrite secrets</button>
        <a class="cancel" href="/dashboard">Cancel</a>
      </form>
    </section>
  </main>`,
  );
}

/**
 * Manifest success surface (B1 Task 2, spec § 确认页文案 — locked copy):
 * gray-1000 + copy-16, tabular-nums App id, NO success green (spec §
 * DESIGN.md 意图). PEM / webhook_secret NEVER appear here.
 */
export function manifestSuccessPage(
  user: { login: string; name?: string },
  app: { id: number },
): string {
  return page(
    "GitHub App credentials stored",
    `${shellHeader(user)}
  <main>
    <section class="enabled">
      <h2>GitHub App setup complete</h2>
      <p>GitHub App <span class="id">${app.id}</span> credentials stored.</p>
      <p class="status">Credentials take effect as the new Worker version rolls out — deployed automatically, no manual redeploy step.</p>
      <p><a href="/dashboard">Back to /dashboard</a></p>
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

/** Notice slot for membersPage: existing classes only, no new tokens. */
export type MembersNotice = { kind: "success" | "warn" | "error"; message: string };

function membersNoticeHtml(notice?: MembersNotice): string {
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
  notice?: MembersNotice,
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
      ${membersNoticeHtml(notice)}
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

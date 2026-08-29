/**
 * /dashboard Hono sub-app: GitHub OAuth login + signed-cookie session (08 B0)
 * + GitHub App Manifest start/callback/commit (11 B1 T1/T2) behind a
 * per-request membership guard (12 B4 T2) + admin-only members management
 * (12 B4 T3). Mounted by src/worker/index.ts as
 * `app.route("/dashboard", dashboardApp)`.
 *
 * Route isolation (architect decision Q2): this module MUST NOT import
 * pipeline/store/review code. Fail-closed everywhere: missing OAuth secrets
 * → 5xx; bad CSRF state → 4xx and the session cookie is never set.
 */
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../worker/env";
import { buildAuthorizeUrl, exchangeCodeForToken, fetchGitHubUser, logOAuthFailure } from "./oauth";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_MAX_AGE_SEC,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  createSessionValue,
  createStateValue,
  expireCookie,
  readSessionValue,
  serializeCookie,
  verifyStateValue,
  type SessionPayload,
} from "./session";
import {
  MANIFEST_HOLD_COOKIE,
  MANIFEST_HOLD_MAX_AGE_SEC,
  MANIFEST_STATE_COOKIE,
  MANIFEST_STATE_MAX_AGE_SEC,
  buildManifest,
  buildManifestCreateUrl,
  createHoldValue,
  exchangeManifestCode,
  logManifestFailure,
  readHoldValue,
  writeWorkerSecrets,
} from "./manifest";
import {
  bootstrapDashboardAccess,
  countAdmins,
  createUser,
  deleteUser,
  getUserByLogin,
  listUsers,
  type DashboardD1,
  type DashboardUserRow,
} from "./users";
import {
  dashboardPage,
  deniedPage,
  errorPage,
  forbiddenPage,
  manifestConfirmPage,
  manifestErrorPage,
  manifestStartPage,
  manifestSuccessPage,
  membersPage,
  removedPage,
} from "./views";

export const dashboardApp = new Hono<{ Bindings: Env }>();

function dashboardSecrets(env: Env) {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET;
  const sessionSecret = env.DASHBOARD_SESSION_SECRET;
  return clientId && clientSecret && sessionSecret ? { clientId, clientSecret, sessionSecret } : null;
}

/**
 * D1 membership store binding (plan 12 B4). Runtime-real via wrangler.jsonc
 * `d1_databases` (binding DB), but the fetch-face Env deliberately does not
 * declare it (src/worker/env.ts stays ADMIN_LOGINS-only this plan) — read
 * through this local intersection and fail closed when unbound, like every
 * missing dashboard dependency.
 */
function dashboardD1(env: Env): DashboardD1 | null {
  const db = (env as Env & { DB?: DashboardD1 }).DB;
  return db ?? null;
}

// --- Plan 12 B4 T2: per-request allowlist guard (spec § AuthZ, lock L5) ---
//
// ONE middleware mount before every route definition auto-covers all
// /dashboard routes (B1 manifest trio + the POST "*" catch-all today, plan
// 13/14 routes tomorrow) — no per-route guard copies. Membership is the
// users row: removal = row delete, so a removed member's stateless cookie
// fails here on every request. Exempt set is EXACTLY the two pre-session
// routes — a guard on /dashboard/login would loop the login page, and
// /dashboard/oauth/callback is the request that establishes the session.
// /logout stays guarded (L5, strictest AC-B4-guard reading): a removed
// member re-authenticates via OAuth instead, where the callback bootstrap
// denies with zero cookies. Per-route readSessionValue handling (incl. B1
// hold/state cookies) stays as-is below — the guard only ADDS the D1
// membership check. Paths are the full mount-pinned form: dashboardApp is
// mounted once at /dashboard (src/worker/index.ts, L5 code-verified).
const GUARD_EXEMPT_PATHS = new Set(["/dashboard/login", "/dashboard/oauth/callback"]);

dashboardApp.use("*", async (c, next) => {
  if (GUARD_EXEMPT_PATHS.has(c.req.path)) return next();
  const sessionSecret = c.env.DASHBOARD_SESSION_SECRET;
  if (!sessionSecret) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), sessionSecret);
  // No session → the pre-guard behavior: 302 into the OAuth flow.
  if (!session) return c.redirect("/dashboard/login", 302);
  // Logged in → the only new check: an active user row (spec § AuthZ).
  // Fail closed on an unbound store, like every missing dashboard dependency.
  const db = dashboardD1(c.env);
  if (!db) return c.text("dashboard storage is not configured", 500);
  const user = await getUserByLogin(db, session.login);
  if (!user) {
    // Same structured-log convention as logOAuthFailure / logManifestFailure;
    // the login is public identity (it renders on the denial page).
    console.warn(
      JSON.stringify({
        event: "dashboard_access",
        stage: "guard",
        reason: "not_a_member",
        login: session.login,
      }),
    );
    return c.html(removedPage(session.login), 403);
  }
  return next();
});

dashboardApp.get("/login", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  // Already signed in → bounce back to the shell (IA routing table).
  if (await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret)) {
    return c.redirect("/dashboard", 302);
  }
  const state = await createStateValue(secrets.sessionSecret);
  c.header("Set-Cookie", serializeCookie(OAUTH_STATE_COOKIE, state, OAUTH_STATE_MAX_AGE_SEC));
  const callbackUri = `${new URL(c.req.url).origin}/dashboard/oauth/callback`;
  return c.redirect(buildAuthorizeUrl(secrets.clientId, callbackUri, state), 302);
});

dashboardApp.get("/oauth/callback", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  // The state cookie is single-use: invalidated on every callback outcome.
  c.header("Set-Cookie", expireCookie(OAUTH_STATE_COOKIE));
  const stateOk = await verifyStateValue(
    getCookie(c, OAUTH_STATE_COOKIE),
    c.req.query("state"),
    secrets.sessionSecret,
  );
  if (!stateOk) {
    logOAuthFailure("state_verify", "state_mismatch");
    return c.html(errorPage("Sign-in could not be verified (bad or expired state)."), 400);
  }
  const code = c.req.query("code");
  if (!code) {
    logOAuthFailure("callback", "missing_code");
    return c.html(errorPage("GitHub did not return an authorization code."), 400);
  }
  const callbackUri = `${new URL(c.req.url).origin}/dashboard/oauth/callback`;
  const token = await exchangeCodeForToken(code, secrets.clientId, secrets.clientSecret, callbackUri);
  if (!token) {
    return c.html(errorPage("GitHub rejected the authorization code."), 502);
  }
  const user = await fetchGitHubUser(token);
  if (!user) {
    return c.html(errorPage("Could not read your GitHub profile."), 502);
  }
  // Plan 12 B4 T1: invite-only bootstrap decision (spec § AuthZ precedence:
  // row → ADMIN_LOGINS → empty-table fallback → deny) BEFORE any session is
  // minted. Deny = 403 page with ZERO Set-Cookie (spec: 零 cookie、零写入) —
  // the single-use state-expiry header set above is withdrawn here — and
  // zero D1 writes (the deny branch never inserts).
  const db = dashboardD1(c.env);
  if (!db) return c.text("dashboard storage is not configured", 500);
  const decision = await bootstrapDashboardAccess(db, user.login, c.env.ADMIN_LOGINS);
  if (decision.outcome === "deny") {
    logOAuthFailure("bootstrap", "not_invited", { login: user.login });
    c.header("Set-Cookie", undefined);
    return c.html(deniedPage(user.login), 403);
  }
  const session = await createSessionValue(user.login, user.name, secrets.sessionSecret);
  c.header("Set-Cookie", serializeCookie(SESSION_COOKIE, session, SESSION_MAX_AGE_SEC), {
    append: true,
  });
  return c.redirect("/dashboard", 302);
});

dashboardApp.get("/logout", (c) => {
  c.header("Set-Cookie", expireCookie(SESSION_COOKIE));
  // Any parked manifest credentials die with the session (spec L7).
  c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE), { append: true });
  c.header("Set-Cookie", expireCookie(MANIFEST_STATE_COOKIE), { append: true });
  return c.redirect("/dashboard/login", 302);
});

// --- B1 Task 1: GitHub App Manifest start + callback (no secret write) ---

// Start: logged-in only. Mints the single-use CSRF state cookie and renders
// the zero-JS form POST to https://github.com/settings/apps/new (state rides
// the form-action query). Logged out → 302 to login (IA routing table).
dashboardApp.post("/manifest/start", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  const state = await createStateValue(secrets.sessionSecret);
  c.header("Set-Cookie", serializeCookie(MANIFEST_STATE_COOKIE, state, MANIFEST_STATE_MAX_AGE_SEC));
  const manifest = buildManifest(new URL(c.req.url).origin, session.login);
  return c.html(manifestStartPage(session, manifest.name, JSON.stringify(manifest), buildManifestCreateUrl(state)));
});

// Callback: GitHub redirects here with ?code=…&state=…. Bad/missing state →
// 4xx with ZERO secret-API calls (the conversion fetch never runs). On
// success the code is exchanged and the credentials are parked in the
// encrypted, single-use hold cookie for the T2 confirm gate — the response
// HTML carries the App id/name only, never PEM or webhook_secret.
dashboardApp.get("/manifest/callback", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  // The state cookie is single-use: invalidated on every callback outcome.
  c.header("Set-Cookie", expireCookie(MANIFEST_STATE_COOKIE));
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  const stateOk = await verifyStateValue(
    getCookie(c, MANIFEST_STATE_COOKIE),
    c.req.query("state"),
    secrets.sessionSecret,
  );
  if (!stateOk) {
    logManifestFailure("state_verify", "state_mismatch");
    return c.html(
      manifestErrorPage("The app-creation flow could not be verified (bad or expired state)."),
      400,
    );
  }
  const code = c.req.query("code");
  if (!code) {
    logManifestFailure("callback", "missing_code");
    return c.html(manifestErrorPage("GitHub did not return an app-manifest code."), 400);
  }
  const conversion = await exchangeManifestCode(code);
  if (!conversion) {
    return c.html(manifestErrorPage("GitHub rejected the app-manifest code."), 502);
  }
  const hold = await createHoldValue(conversion, session.login, secrets.sessionSecret);
  c.header("Set-Cookie", serializeCookie(MANIFEST_HOLD_COOKIE, hold, MANIFEST_HOLD_MAX_AGE_SEC), {
    append: true,
  });
  return c.html(manifestConfirmPage(session, { id: conversion.id, name: conversion.name }));
});

// Commit (B1 Task 2, spec § L6/L7/L8): the confirm gate. Without
// `confirm=overwrite` → 400 with ZERO Cloudflare requests. The hold cookie
// is bound to the committing session (`hold.login === session.login`, else
// 403, zero writes) and survives RETRYABLE outcomes (400 missing confirm,
// 500 missing Cloudflare config, 502 CF/network) so the operator can retry
// without creating a second GitHub App; it is expired on success, login
// mismatch, undecryptable/expired hold, and logout. Missing/undecryptable/
// expired hold = flow expired → 302 back to the start, zero writes. On
// confirm, ONE secrets-bulk PATCH writes exactly APP_ID / PRIVATE_KEY /
// WEBHOOK_SECRET (PEM PKCS#8-normalized) — never REVIEW_ENABLED or model
// keys. Missing Cloudflare config → 5xx, zero writes.
dashboardApp.post("/manifest/commit", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  const form = await c.req.parseBody();
  if (form.confirm !== "overwrite") {
    // Retryable: keep the hold so the operator can re-tick and resubmit.
    logManifestFailure("commit", "confirm_missing");
    return c.html(
      manifestErrorPage("The overwrite was not confirmed — tick the checkbox to proceed.", true),
      400,
    );
  }
  const hold = await readHoldValue(getCookie(c, MANIFEST_HOLD_COOKIE), secrets.sessionSecret);
  if (!hold) {
    logManifestFailure("commit", "hold_missing_or_expired");
    // Bad hold: burn the cookie so no stale credential lingers.
    c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
    return c.redirect("/dashboard", 302);
  }
  if (hold.login !== session.login) {
    // The hold is bound to the login that ran the callback: a different
    // operator must restart the flow (zero writes, hold burned).
    logManifestFailure("commit", "login_mismatch");
    c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
    return c.html(
      manifestErrorPage(
        "This confirmation belongs to a different GitHub login — sign back in and restart the app-creation flow.",
      ),
      403,
    );
  }
  const result = await writeWorkerSecrets(c.env, hold);
  if (result === "missing_config") {
    // Retryable: keep the hold; fix the Worker env and resubmit.
    logManifestFailure("commit", "cloudflare_not_configured");
    return c.html(
      manifestErrorPage(
        "Cloudflare API access is not configured on this Worker (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID).",
        true,
      ),
      500,
    );
  }
  if (result === "upstream_error") {
    // Retryable: keep the hold; a CF/network failure must not burn it.
    return c.html(
      manifestErrorPage("Cloudflare rejected the secret write (check the API token permissions).", true),
      502,
    );
  }
  // Success: the hold is single-success — burned now that secrets are stored.
  c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
  return c.html(manifestSuccessPage(session, { id: hold.id }));
});

// Confirm resume (Bugbot: the hold survives retryable commit outcomes, so a
// refresh / error-page link must re-render the confirm gate, not a dead
// shell). Hold decrypts + hold.login === session.login → confirm page with
// id/name only (PEM/webhook_secret never render); anything else → 302 shell.
dashboardApp.get("/manifest/confirm", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  const hold = await readHoldValue(getCookie(c, MANIFEST_HOLD_COOKIE), secrets.sessionSecret);
  if (!hold || hold.login !== session.login) return c.redirect("/dashboard", 302);
  return c.html(manifestConfirmPage(session, { id: hold.id, name: hold.name }));
});

// --- Plan 12 B4 T3: admin-only members management (spec § AuthZ) ---
//
// The per-request guard above has already verified membership on every route
// below; the admin gate re-resolves the acting row per request (same
// route-local read pattern as the manifest routes) and 403s non-admins
// BEFORE any membership read or write — zero mutations on the deny path.
// POSTs ride the existing session cookie (same discipline as
// manifest/commit) — no new token scheme.

type AdminGate =
  | { ok: true; session: SessionPayload; db: DashboardD1; admin: DashboardUserRow }
  | { ok: false; response: Response };

/** Route-local admin gate shared by the three /dashboard/members routes. */
async function requireAdmin(c: Context<{ Bindings: Env }>): Promise<AdminGate> {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return { ok: false, response: c.text("dashboard OAuth is not configured", 500) };
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return { ok: false, response: c.redirect("/dashboard/login", 302) };
  const db = dashboardD1(c.env);
  if (!db) return { ok: false, response: c.text("dashboard storage is not configured", 500) };
  const admin = await getUserByLogin(db, session.login);
  // Fail closed: no row (removed between guard and here) or a plain member
  // is equally non-admin — the 403 view carries zero membership data.
  if (!admin || admin.role !== "admin") {
    return { ok: false, response: c.html(forbiddenPage(session.login), 403) };
  }
  return { ok: true, session, db, admin };
}

dashboardApp.get("/members", async (c) => {
  const gate = await requireAdmin(c);
  if (!gate.ok) return gate.response;
  return c.html(membersPage(gate.session, await listUsers(gate.db)));
});

dashboardApp.post("/members/invite", async (c) => {
  const gate = await requireAdmin(c);
  if (!gate.ok) return gate.response;
  const form = await c.req.parseBody();
  const login = typeof form.login === "string" ? form.login.trim() : "";
  if (login.length === 0) {
    return c.html(
      membersPage(gate.session, await listUsers(gate.db), {
        kind: "error",
        message: "Enter a GitHub login to invite.",
      }),
      400,
    );
  }
  // T1 review pin (Minor 2): resolve the login case-insensitively BEFORE any
  // createUser call — the DDL UNIQUE is BINARY-collated, so ON CONFLICT alone
  // misses case variants ("OctoCat" vs "octocat") and would mint a second row.
  if (await getUserByLogin(gate.db, login)) {
    return c.html(
      membersPage(gate.session, await listUsers(gate.db), {
        kind: "warn",
        message: `${login} is already a member — nothing changed.`,
      }),
    );
  }
  await createUser(gate.db, { login, role: "member", invitedBy: gate.admin.github_login });
  return c.html(
    membersPage(gate.session, await listUsers(gate.db), {
      kind: "success",
      message: `Invited ${login} — they can sign in with GitHub now.`,
    }),
  );
});

dashboardApp.post("/members/remove", async (c) => {
  const gate = await requireAdmin(c);
  if (!gate.ok) return gate.response;
  const form = await c.req.parseBody();
  const userId = typeof form.userId === "string" ? form.userId : "";
  const members = await listUsers(gate.db);
  const target = members.find((m) => m.id === userId);
  if (!target) {
    return c.html(
      membersPage(gate.session, members, {
        kind: "error",
        message: "Unknown member — nothing was removed, try again.",
      }),
      400,
    );
  }
  // Refuse self-removal: an admin must not be able to lock themselves out.
  if (target.github_login.toLowerCase() === gate.admin.github_login.toLowerCase()) {
    return c.html(
      membersPage(gate.session, members, { kind: "error", message: "You cannot remove yourself." }),
      400,
    );
  }
  // Refuse removing an admin while they are the last one (removal = row
  // delete, so this is the deployment's only admin-lockout guard).
  if (target.role === "admin" && (await countAdmins(gate.db)) === 1) {
    return c.html(
      membersPage(gate.session, members, {
        kind: "error",
        message: "The last admin cannot be removed.",
      }),
      400,
    );
  }
  await deleteUser(gate.db, target.id);
  return c.html(
    membersPage(gate.session, await listUsers(gate.db), {
      kind: "success",
      message: `Removed ${target.github_login}.`,
    }),
  );
});

dashboardApp.get("/", async (c) => {
  const sessionSecret = c.env.DASHBOARD_SESSION_SECRET;
  if (!sessionSecret) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  // A parked manifest hold resumes the confirm gate in place of the shell
  // (same rule as GET /dashboard/manifest/confirm).
  const hold = await readHoldValue(getCookie(c, MANIFEST_HOLD_COOKIE), sessionSecret);
  if (hold && hold.login === session.login) {
    return c.html(manifestConfirmPage(session, { id: hold.id, name: hold.name }));
  }
  return c.html(dashboardPage(session));
});

// Placeholder actions (IA routing table): every POST under /dashboard that is
// not a wired route above is a placeholder submit and must never succeed —
// logged out → 302 to login; logged in → 405 (the shell exists, the method
// does not). Zero secret writes, zero REVIEW_ENABLED changes on this path.
dashboardApp.post("*", async (c) => {
  const sessionSecret = c.env.DASHBOARD_SESSION_SECRET;
  if (!sessionSecret) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  return c.text("placeholder actions are not implemented", 405);
});

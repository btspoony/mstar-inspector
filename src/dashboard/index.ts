/**
 * /dashboard Hono sub-app: GitHub OAuth login + signed-cookie session (08 B0)
 * + GitHub App Manifest start/callback/commit (11 B1 T1/T2; 13 B5 T3 — the
 * commit writes the encrypted github_apps D1 row, the Cloudflare secrets-bulk
 * path is retired) + per-App management UI (13 B5 T3: /dashboard/apps list,
 * POST …/disable|enable|delete — creator-or-admin) + per-App review
 * pause/resume (16 T2: POST …/pause|/resume — same gate, plan-13 action
 * pattern) + per-App AI config settings (14 B2 T1 routes + T2 view: GET/POST
 * /dashboard/apps/:slug/settings — BYOK provider keys, masked, + model chain
 * — and POST …/settings/key/delete, creator-or-admin; 16 T2 adds the
 * settings Review switch and the read-only install-health panel; 17 T3 adds
 * the Role models editor on the same op-discriminated POST) behind a
 * per-request membership guard (12 B4 T2) + admin-only members management
 * (12 B4 T3). Mounted by src/worker/index.ts as
 * `app.route("/dashboard", dashboardApp)`.
 *
 * Route isolation (architect decision Q2): this module MUST NOT import
 * pipeline/store/review code. Fail-closed everywhere: missing OAuth secrets
 * → 5xx; bad CSRF state → 4xx and the session cookie is never set; missing
 * DASHBOARD_ENCRYPTION_KEY → the encryption-dependent commit and settings
 * routes 5xx with the hold kept / nothing stored (spec § Crypto envelope).
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
  buildAppSlug,
  buildManifest,
  buildManifestCreateUrl,
  createHoldValue,
  createManifestStateValue,
  exchangeManifestCode,
  logManifestFailure,
  randomSlugSuffix,
  readHoldValue,
  readManifestStateValue,
} from "./manifest";
import { createAppsStore, type GithubAppRow } from "./apps-store";
import { SecretboxKeyError, createSecretbox } from "./secretbox";
import {
  MAX_PROVIDER_KEY_LENGTH,
  MODEL_ROLE_IDS,
  PROVIDER_IDS,
  createAppConfigStore,
  parseModelChain,
  type AppConfigBatchFace,
  type AppConfigStore,
} from "./app-config-store";
import {
  bootstrapDashboardAccess,
  countAdmins,
  createUser,
  deleteUserUnlessLastAdmin,
  getUserByLogin,
  listUsers,
  type DashboardD1,
  type DashboardUserRow,
} from "./users";
import {
  appSettingsPage,
  appsPage,
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
  type PageNotice,
} from "./views";
import { clampWindow, createInsightsStore } from "./insights-store";

export const dashboardApp = new Hono<{ Bindings: Env }>();

function dashboardSecrets(env: Env) {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET;
  const sessionSecret = env.DASHBOARD_SESSION_SECRET;
  return clientId && clientSecret && sessionSecret ? { clientId, clientSecret, sessionSecret } : null;
}

/**
 * The dashboard D1 binding's face: the users-store narrow face PLUS D1
 * `batch` (Phase 5 fix, PR #7 review) — the settings routes hand this
 * binding to the App-config store, whose setModelRoles full-map save is ONE
 * atomic batch. Truthful for the runtime binding (a real D1Database) and
 * the bun:sqlite test double, which both implement batch; the DashboardD1
 * face alone (a single-row store's view) just doesn't declare it.
 */
type DashboardDb = DashboardD1 & AppConfigBatchFace;

/**
 * D1 membership store binding (plan 12 B4). Runtime-real via wrangler.jsonc
 * `d1_databases` (binding DB), but the fetch-face Env deliberately does not
 * declare it (src/worker/env.ts stays ADMIN_LOGINS-only this plan) — read
 * through this local intersection and fail closed when unbound, like every
 * missing dashboard dependency.
 */
function dashboardD1(env: Env): DashboardDb | null {
  const db = (env as Env & { DB?: DashboardDb }).DB;
  return db ?? null;
}

// --- Plan 13 B5 T3: webhook slug resolution + manifest commit helpers ---

/** Bounded suffix attempts before the INSERT's own UNIQUE error surfaces. */
const SLUG_SUFFIX_ATTEMPTS = 6;

function errorTypeName(err: unknown): string {
  return err instanceof Error ? err.name : String(err);
}

/** The sqlite UNIQUE violation for one github_apps column (slug retries). */
function isAppsUniqueViolation(err: unknown, column: "slug" | "github_app_id"): boolean {
  return err instanceof Error && err.message.includes(`github_apps.${column}`);
}

/**
 * First slug in `[base, base-<suffix>…]` not present in github_apps
 * (soft-deleted rows count — their UNIQUE slug still owns the namespace).
 * Minted at start and carried through the signed state — the first line of
 * defense against collisions. A commit-time race does NOT remap (the
 * manifest already registered the slug's webhook URL with GitHub): the hold
 * is burned with a 409 instead.
 */
async function resolveAvailableSlug(db: DashboardD1, base: string): Promise<string> {
  const apps = createAppsStore(db);
  let slug = base;
  for (let attempt = 0; attempt <= SLUG_SUFFIX_ATTEMPTS; attempt++) {
    if ((await apps.getAppBySlug(slug)) === null) return slug;
    slug = `${base}-${randomSlugSuffix()}`;
  }
  return slug;
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
// /logout stays guarded (L5 — NOT in the exempt set) but is SESSION-gated,
// not membership-gated (qc2 F-002): the owner of a valid-but-stale cookie
// (removed member) must be able to burn it, so a row-less session reaches
// the logout route; without a session it still 302s into the OAuth flow.
// Per-route readSessionValue handling (incl. B1 hold/state cookies) stays
// as-is below — the guard only ADDS the D1 membership check. Paths are the
// full mount-pinned form: dashboardApp is mounted once at /dashboard
// (src/worker/index.ts, L5 code-verified).
const GUARD_EXEMPT_PATHS = new Set(["/dashboard/login", "/dashboard/oauth/callback"]);

dashboardApp.use("*", async (c, next) => {
  if (GUARD_EXEMPT_PATHS.has(c.req.path)) return next();
  const sessionSecret = c.env.DASHBOARD_SESSION_SECRET;
  if (!sessionSecret) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), sessionSecret);
  // No session → the pre-guard behavior: 302 into the OAuth flow.
  if (!session) return c.redirect("/dashboard/login", 302);
  // Logout needs no membership row (qc2 F-002): any VALID session may burn
  // its own cookies. The route itself touches no membership data, so this
  // sits before the D1 check — storage misconfiguration cannot trap a
  // stale cookie on the browser either.
  if (c.req.path === "/dashboard/logout") return next();
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
// --- B5 Task 3: per-App slug mints here and rides the signed state ---

// Start: logged-in only. Mints the webhook slug (login-derived, DB
// pre-resolved against existing slugs), the single-use CSRF state cookie
// CARRYING it (createManifestStateValue — same createStateValue HMAC
// discipline), and renders the zero-JS form POST to
// https://github.com/settings/apps/new (state rides the form-action query).
// The manifest's webhook URL is the App's own route /webhook/{slug}.
// Logged out → 302 to login (IA routing table).
dashboardApp.post("/manifest/start", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  const db = dashboardD1(c.env);
  if (!db) return c.text("dashboard storage is not configured", 500);
  const slug = await resolveAvailableSlug(db, buildAppSlug(session.login));
  const state = await createManifestStateValue(secrets.sessionSecret, slug);
  c.header("Set-Cookie", serializeCookie(MANIFEST_STATE_COOKIE, state, MANIFEST_STATE_MAX_AGE_SEC));
  const manifest = buildManifest(new URL(c.req.url).origin, session.login, slug);
  return c.html(manifestStartPage(session, manifest.name, JSON.stringify(manifest), buildManifestCreateUrl(state)));
});

// Callback: GitHub redirects here with ?code=…&state=…. Bad/missing state →
// 4xx with ZERO secret-API calls (the conversion fetch never runs). On
// success the code is exchanged and the credentials plus the state-carried
// slug are parked in the encrypted, single-use hold cookie for the T3
// commit gate — the response HTML carries the App id/name/slug/webhook URL
// only, never PEM or webhook_secret.
dashboardApp.get("/manifest/callback", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  // The state cookie is single-use: invalidated on every callback outcome.
  c.header("Set-Cookie", expireCookie(MANIFEST_STATE_COOKIE));
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  const state = await readManifestStateValue(
    getCookie(c, MANIFEST_STATE_COOKIE),
    c.req.query("state"),
    secrets.sessionSecret,
  );
  if (!state) {
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
  const hold = await createHoldValue(conversion, session.login, secrets.sessionSecret, state.slug);
  c.header("Set-Cookie", serializeCookie(MANIFEST_HOLD_COOKIE, hold, MANIFEST_HOLD_MAX_AGE_SEC), {
    append: true,
  });
  const origin = new URL(c.req.url).origin;
  return c.html(
    manifestConfirmPage(session, {
      id: conversion.id,
      name: conversion.name,
      slug: state.slug,
      webhookUrl: `${origin}/webhook/${state.slug}`,
    }),
  );
});

// Commit (B5 Task 3, spec § Multi-App 契约 — replaces the B1 Cloudflare
// secrets-bulk write; `confirm=overwrite` is gone because nothing shared is
// overwritten). The hold cookie is bound to the committing session
// (`hold.login === session.login`, else 403, zero writes) and survives
// RETRYABLE outcomes (500 encrypt/DB failures, 502 conversion retries) so
// the operator can retry without creating a second GitHub App; it is burned
// on success, login mismatch, undecryptable/expired hold, the non-retryable
// already-connected conflict, and the non-retryable slug-conflict race (the
// manifest already registered the webhook URL — remapping would desync it).
// Missing/undecryptable/expired hold = flow expired → 302 back to the start,
// zero writes. On submit, the PEM and webhook secret are encrypted with the
// DASHBOARD_ENCRYPTION_KEY
// master key (AAD rowKey = the row PK — caller-supplied id, T1 review pin)
// and ONE github_apps row is written. Missing/malformed key → 500
// fail-closed, hold kept (spec § Crypto envelope). Zero Cloudflare API
// calls from this route.
dashboardApp.post("/manifest/commit", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
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
  const db = dashboardD1(c.env);
  if (!db) return c.text("dashboard storage is not configured", 500);
  // T1 review pin: the row id exists BEFORE encryption so the secretbox AAD
  // rowKey (github_apps.<column>:<id>) equals the row's primary key.
  const appId = crypto.randomUUID();
  let privateKeyEnc: string;
  let webhookSecretEnc: string;
  try {
    const box = createSecretbox(c.env.DASHBOARD_ENCRYPTION_KEY);
    privateKeyEnc = await box.encryptSecret(hold.pem, `github_apps.private_key_enc:${appId}`);
    webhookSecretEnc = await box.encryptSecret(
      hold.webhook_secret,
      `github_apps.webhook_secret_enc:${appId}`,
    );
  } catch (err) {
    // SecretboxKeyError (missing/malformed DASHBOARD_ENCRYPTION_KEY) and any
    // other encrypt failure are equally fail-closed: 500, zero writes, hold
    // KEPT — fixing the env makes the retry succeed.
    logManifestFailure("commit", "encrypt_failed", {
      error_type: errorTypeName(err),
      key_error: err instanceof SecretboxKeyError,
    });
    return c.html(
      manifestErrorPage(
        "This deployment has no valid DASHBOARD_ENCRYPTION_KEY to store App credentials with — ask the operator to configure it, then resubmit.",
        true,
      ),
      500,
    );
  }
  // Slug: pre-resolved at start and carried through the hold. A commit-time
  // UNIQUE conflict means the slug was taken between start and commit — the
  // manifest already registered {origin}/webhook/{hold.slug} with GitHub, so
  // remapping the row to a fresh suffix would desync the webhook URL (the
  // App would look connected yet never receive events, Bugbot F-1). The hold
  // is burned instead: zero rows written, 409, and the operator restarts the
  // flow with a fresh slug.
  const apps = createAppsStore(db);
  try {
    const row = await apps.createApp({
      id: appId,
      slug: hold.slug,
      githubAppId: hold.id,
      name: hold.name,
      privateKeyEnc,
      webhookSecretEnc,
      createdBy: session.login,
    });
    // Success: the hold is single-success — burned now that the row exists.
    c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
    return c.html(
      manifestSuccessPage(session, {
        id: row.github_app_id,
        name: row.name,
        slug: row.slug,
        webhookUrl: `${new URL(c.req.url).origin}/webhook/${row.slug}`,
      }),
    );
  } catch (err) {
    if (isAppsUniqueViolation(err, "slug")) {
      // The GitHub App WAS created on GitHub, but its webhook slug was
      // claimed before the row could land. Storing the row under any other
      // slug would advertise a URL GitHub never posts to — burn the hold
      // and make the operator start a fresh creation flow.
      logManifestFailure("commit", "slug_conflict", { slug: hold.slug });
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
      return c.html(
        manifestErrorPage(
          "Another App claimed this App's webhook slug while setup was in progress, so the GitHub App was created on GitHub but not connected to this deployment — no Worker data was stored. A manifest-created App cannot be connected twice: delete the just-created App on GitHub, then run a new app-creation flow from the dashboard.",
        ),
        409,
      );
    }
    if (isAppsUniqueViolation(err, "github_app_id")) {
      // The same GitHub App is already connected — retrying cannot help.
      logManifestFailure("commit", "github_app_id_conflict", { github_app_id: hold.id });
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
      return c.html(
        manifestErrorPage(
          "This GitHub App is already connected on this deployment — no changes were made.",
        ),
        409,
      );
    }
    // Retryable (missing migrations, transient D1 failure, …): hold kept.
    logManifestFailure("commit", "db_error", { error_type: errorTypeName(err) });
    return c.html(
      manifestErrorPage(
        "The App could not be stored — the dashboard database rejected the write. You can resubmit.",
        true,
      ),
      500,
    );
  }
});

// Confirm resume (Bugbot: the hold survives retryable commit outcomes, so a
// refresh / error-page link must re-render the confirm gate, not a dead
// shell). Hold decrypts + hold.login === session.login → summary page with
// id/name/slug/webhook URL (PEM/webhook_secret never render); anything else
// → 302 shell.
dashboardApp.get("/manifest/confirm", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  const hold = await readHoldValue(getCookie(c, MANIFEST_HOLD_COOKIE), secrets.sessionSecret);
  if (!hold || hold.login !== session.login) return c.redirect("/dashboard", 302);
  return c.html(
    manifestConfirmPage(session, {
      id: hold.id,
      name: hold.name,
      slug: hold.slug,
      webhookUrl: `${new URL(c.req.url).origin}/webhook/${hold.slug}`,
    }),
  );
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

// GitHub login syntax (qc1/qc2 F-003): letters, digits, hyphens — 1–39
// chars. Anything else can never match a real GitHub login and would sit in
// the table as a dead row an admin cannot fix by re-inviting.
const GITHUB_LOGIN_PATTERN = /^[a-zA-Z0-9-]{1,39}$/;

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
  // F-003: reject values outside the GitHub login syntax before any read or
  // write — they would persist as rows that no real login can ever claim.
  if (!GITHUB_LOGIN_PATTERN.test(login)) {
    return c.html(
      membersPage(gate.session, await listUsers(gate.db), {
        kind: "error",
        message: `${login} is not a valid GitHub login — use 1–39 letters, digits, or hyphens.`,
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
  // delete, so this is the deployment's only admin-lockout guard). This
  // pre-check only shapes the message; the ENFORCEMENT is the single
  // conditional DELETE below, which closes the read-check-delete TOCTOU
  // (qc1): two concurrent removes of the last two admins cannot both land.
  if (target.role === "admin" && (await countAdmins(gate.db)) === 1) {
    return c.html(
      membersPage(gate.session, members, {
        kind: "error",
        message: "The last admin cannot be removed.",
      }),
      400,
    );
  }
  if (!(await deleteUserUnlessLastAdmin(gate.db, target.id))) {
    // Lost a race (the row vanished or just became the last admin between
    // the reads above and this delete): re-render with a retry notice —
    // zero partial state either way.
    return c.html(
      membersPage(gate.session, await listUsers(gate.db), {
        kind: "error",
        message: `Could not remove ${target.github_login} — the member list just changed, try again.`,
      }),
      400,
    );
  }
  return c.html(
    membersPage(gate.session, await listUsers(gate.db), {
      kind: "success",
      message: `Removed ${target.github_login}.`,
    }),
  );
});

// --- Plan 13 B5 T3: Apps list + per-App management (spec § Multi-App 契约,
// Clarify #6, architect-pinned POST action paths) ---
//
// The per-request guard above has already verified membership on every route
// here; the route-local gate re-resolves the acting row per request (same
// pattern as the members routes). List = every member; disable/enable/
// soft-delete = the App creator or any admin (invite-only team trust model).
// POSTs ride the existing session cookie (same discipline as the members
// routes) — no new token scheme. Routes are the pinned action-path POSTs:
// the zero-JS `<form method="post">` convention cannot emit a DELETE verb.

/** Route-local member gate shared by the /dashboard/apps routes. */
async function requireMember(c: Context<{ Bindings: Env }>): Promise<
  | { ok: true; session: SessionPayload; db: DashboardDb; user: DashboardUserRow }
  | { ok: false; response: Response }
> {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return { ok: false, response: c.text("dashboard OAuth is not configured", 500) };
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return { ok: false, response: c.redirect("/dashboard/login", 302) };
  const db = dashboardD1(c.env);
  if (!db) return { ok: false, response: c.text("dashboard storage is not configured", 500) };
  const user = await getUserByLogin(db, session.login);
  // Fail closed: no row (removed between guard and here) → 403, the 403 view
  // carries zero membership data.
  if (!user) return { ok: false, response: c.html(forbiddenPage(session.login), 403) };
  return { ok: true, session, db, user };
}

/** Clarify #6: manage = any admin, or the App's creator (case-insensitive). */
function canManageApp(user: DashboardUserRow, app: GithubAppRow): boolean {
  return user.role === "admin" || app.created_by.toLowerCase() === user.github_login.toLowerCase();
}

dashboardApp.get("/apps", async (c) => {
  const gate = await requireMember(c);
  if (!gate.ok) return gate.response;
  const apps = await createAppsStore(gate.db).listApps();
  return c.html(appsPage(gate.session, apps, { login: gate.user.github_login, role: gate.user.role }));
});

/**
 * One handler for the three pinned action routes. Unknown and soft-deleted
 * apps are equally invisible (the list never shows them) → 404, zero writes.
 * A lost race (the row vanished between the read and the write) re-renders
 * the list with a warn notice — zero partial state.
 */
async function appStatusAction(
  c: Context<{ Bindings: Env }>,
  action: "disable" | "enable" | "delete",
): Promise<Response> {
  const gate = await requireMember(c);
  if (!gate.ok) return gate.response;
  const apps = createAppsStore(gate.db);
  const app = await apps.getAppBySlug(c.req.param("slug") ?? "");
  if (!app || app.deleted_at !== null) return c.text("unknown app", 404);
  if (!canManageApp(gate.user, app)) return c.html(forbiddenPage(gate.session.login), 403);
  const changed =
    action === "delete" ? await apps.softDeleteApp(app.id) : await apps.setAppStatus(app.id, action === "disable" ? "disabled" : "active");
  const verb = action === "delete" ? "Deleted" : action === "disable" ? "Disabled" : "Enabled";
  const notice: PageNotice = changed
    ? { kind: "success", message: `${verb} ${app.slug}.` }
    : { kind: "warn", message: `${app.slug} was already ${action === "enable" ? "enabled" : `${action}d`} — nothing changed.` };
  return c.html(appsPage(gate.session, await apps.listApps(), { login: gate.user.github_login, role: gate.user.role }, notice));
}

dashboardApp.post("/apps/:slug/disable", (c) => appStatusAction(c, "disable"));
dashboardApp.post("/apps/:slug/enable", (c) => appStatusAction(c, "enable"));
dashboardApp.post("/apps/:slug/delete", (c) => appStatusAction(c, "delete"));

// --- Plan 16 B3 T2: per-App review pause/resume (spec § IA, pinned action
// paths) ---
//
// The per-App pause switch (migration 0008 review_enabled) surfaced on the
// pinned zero-JS action paths — both the settings-page Review switch and the
// Apps-list actions POST here (spec § IA). Gate/order mirror appStatusAction
// exactly: the per-request guard has verified membership, then unknown and
// soft-deleted apps are equally invisible (→ 404, zero writes), then
// creator-or-admin (→ 403 forbiddenPage, zero writes). Confirm-free and
// reversible (pause ≠ disable — the webhook face stays healthy while
// paused); the response re-renders the Apps list with a notice, so the
// state change is visible immediately (the settings page reads the row
// fresh on every GET).

/**
 * One handler for the two pinned review-action routes. The idempotent no-op
 * case is short-circuited BEFORE the store write — pausing a paused App /
 * resuming an active one re-renders with a warn notice and never touches
 * the row (setReviewEnabled would count a same-value UPDATE as changed and
 * would churn updated_at, the operator-mutation timestamp). Grammar pinned:
 * "already paused" / "already active".
 */
async function appReviewAction(
  c: Context<{ Bindings: Env }>,
  action: "pause" | "resume",
): Promise<Response> {
  const gate = await requireMember(c);
  if (!gate.ok) return gate.response;
  const apps = createAppsStore(gate.db);
  const app = await apps.getAppBySlug(c.req.param("slug") ?? "");
  if (!app || app.deleted_at !== null) return c.text("unknown app", 404);
  if (!canManageApp(gate.user, app)) return c.html(forbiddenPage(gate.session.login), 403);
  const paused = app.review_enabled === 0;
  let notice: PageNotice;
  if (action === "pause" ? paused : !paused) {
    notice = {
      kind: "warn",
      message: `${app.slug} was already ${paused ? "paused" : "active"} — nothing changed.`,
    };
  } else if (await apps.setReviewEnabled(app.id, action === "resume")) {
    notice = {
      kind: "success",
      message: `${action === "pause" ? "Paused" : "Resumed"} ${app.slug}.`,
    };
  } else {
    // Lost a race: the row was soft-deleted between the read and the write.
    notice = { kind: "warn", message: `${app.slug} was just removed — nothing changed.` };
  }
  return c.html(
    appsPage(gate.session, await apps.listApps(), { login: gate.user.github_login, role: gate.user.role }, notice),
  );
}

dashboardApp.post("/apps/:slug/pause", (c) => appReviewAction(c, "pause"));
dashboardApp.post("/apps/:slug/resume", (c) => appReviewAction(c, "resume"));

// --- Plan 14 B2 T1: per-App AI configuration settings (spec § Per-App BYOK) ---
//
// The settings family for one App: provider API keys (BYOK, masked list) and
// the model chain. Authorization = the same canManageApp rule as the status
// actions above (owner-or-admin, Clarify #6); unknown/soft-deleted App → 404;
// the per-request guard has already verified membership. POSTs ride the
// session cookie (same discipline as the members and apps action routes — no
// new token scheme). Route shapes per the plan brief: GET/POST
// /dashboard/apps/:slug/settings — the POST carries an explicit `op`
// discriminator (add-key | save-chain | save-roles) because the zero-JS page
// has three forms on one action path — and the delete-key action path
// …/settings/key/delete (the HTML-form convention cannot emit a DELETE verb).
//
// Encryption-dependent reads AND writes: masking needs plaintext (the last-4
// tail), so a missing/malformed DASHBOARD_ENCRYPTION_KEY fails the whole
// family closed with 5xx (spec § Crypto envelope) — never a partial page,
// never a stored key. Rendering = the DESIGN-token appSettingsPage view in
// src/dashboard/views.ts (plan 14 T2 — single column, masked list, no new
// tokens); the T1 temporary placeholder render is gone.

type AppSettingsGate =
  | { ok: true; session: SessionPayload; db: DashboardDb; app: GithubAppRow }
  | { ok: false; response: Response };

/** Route-local owner-or-admin gate shared by the settings route family. */
async function requireAppSettings(c: Context<{ Bindings: Env }>): Promise<AppSettingsGate> {
  const member = await requireMember(c);
  if (!member.ok) return member;
  const app = await createAppsStore(member.db).getAppBySlug(c.req.param("slug") ?? "");
  if (!app || app.deleted_at !== null) return { ok: false, response: c.text("unknown app", 404) };
  if (!canManageApp(member.user, app)) {
    return { ok: false, response: c.html(forbiddenPage(member.session.login), 403) };
  }
  // The settings family is encryption-dependent end to end (masking needs
  // plaintext, adding a key encrypts): a missing master key fails EVERY
  // settings route closed with 5xx — the plan Global Constraint — rather
  // than serving a page that could not round-trip key material. A key that
  // is set but malformed surfaces the same way through the decrypt/encrypt
  // failure paths below.
  if (!c.env.DASHBOARD_ENCRYPTION_KEY) {
    return {
      ok: false,
      response: c.text("the app settings need a configured DASHBOARD_ENCRYPTION_KEY", 500),
    };
  }
  return { ok: true, session: member.session, db: member.db, app };
}

/** Same structured-log convention as logOAuthFailure / logManifestFailure. */
function logSettingsFailure(stage: string, appId: string, err: unknown): void {
  console.warn(
    JSON.stringify({
      event: "dashboard_settings",
      stage,
      app_id: appId,
      error_type: errorTypeName(err),
      key_error: err instanceof SecretboxKeyError,
    }),
  );
}

/** 500 fail-closed notice: key misconfiguration vs storage rejection (commit-route copy style). */
function settingsFailureNotice(err: unknown): PageNotice {
  return err instanceof SecretboxKeyError
    ? {
        kind: "error",
        message:
          "This deployment has no valid DASHBOARD_ENCRYPTION_KEY for its stored keys — ask the operator to configure it, then resubmit.",
      }
    : {
        kind: "error",
        message: "The dashboard database rejected the change — nothing was stored. You can resubmit.",
      };
}

/**
 * Re-read the settings state and render the DESIGN-token view (plan 14 T2:
 * src/dashboard/views.ts appSettingsPage) — every route's response body. The
 * masked key list is the only key face, so no route here can leak key
 * material into HTML; a decrypt failure on re-read is the 500 fail-closed.
 * Plan 16: the install-health panel data (installations, review_enabled,
 * last_webhook_at) is read fresh on every render too, so every re-render —
 * including POST re-renders — reflects the current pause/health state.
 * Plan 17: the role map (app_model_roles) rides the same fresh read for the
 * Role models editor — a 400 re-render shows the STORED map (an invalid
 * submission is never echoed back as if it had been kept).
 */
async function settingsResponse(
  c: Context<{ Bindings: Env }>,
  session: SessionPayload,
  store: AppConfigStore,
  apps: ReturnType<typeof createAppsStore>,
  app: GithubAppRow,
  notice?: PageNotice,
  status: 200 | 400 | 500 = 200,
): Promise<Response> {
  try {
    const maskedKeys = await store.listProviderKeys(app.id);
    const modelChain = await store.getModelChain(app.id);
    const modelRoles = await store.getAppModelRoles(app.id);
    const installations = await apps.listInstallations(app.id);
    return c.html(
      appSettingsPage(
        session,
        {
          slug: app.slug,
          status: app.status,
          reviewEnabled: app.review_enabled !== 0,
          lastWebhookAt: app.last_webhook_at ?? null,
        },
        maskedKeys,
        modelChain,
        modelRoles,
        installations,
        notice,
      ),
      status,
    );
  } catch (err) {
    logSettingsFailure("render", app.id, err);
    return c.text("the app settings could not be read from encrypted storage", 500);
  }
}

dashboardApp.get("/apps/:slug/settings", async (c) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  const apps = createAppsStore(gate.db);
  return settingsResponse(c, gate.session, store, apps, gate.app);
});

/**
 * The settings POST: three operations on the pinned action path, discriminated
 * by the forms' hidden `op` field. add-key = provider allowlist (400 on any
 * other id — the allowlist is the plan's Global Constraint) + non-empty key
 * of at most MAX_PROVIDER_KEY_LENGTH characters (plan 15 input bounds — an
 * oversized key is a 400 re-render with zero writes; the store guard beneath
 * is the backstop), then the store encrypts inside. save-chain = empty →
 * clear (global fallback), otherwise ≥1 comma-separated selector required and
 * the chain is stored VERBATIM (a `:thinking`-style suffix is legal omp
 * syntax; full selector validation stays omp-side). save-roles (plan 17 T3)
 * = the Role models editor's full map — one `role_<role>` field per audit
 * seat, blanks = cleared, saved through the validate-all-first setModelRoles
 * (zero partial writes on any validation failure). Validation failures
 * re-render the page at 400 with zero writes — never a plain-text body (the
 * plan-14 T1 review lesson).
 */
dashboardApp.post("/apps/:slug/settings", async (c) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  const form = await c.req.parseBody();
  const op = typeof form.op === "string" ? form.op : "";
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  const apps = createAppsStore(gate.db);
  if (op === "add-key") {
    const provider = typeof form.provider === "string" ? form.provider.trim() : "";
    const plainKey = typeof form.key === "string" ? form.key.trim() : "";
    if (!PROVIDER_IDS.includes(provider)) {
      return settingsResponse(
        c,
        gate.session,
        store,
        apps,
        gate.app,
        {
          kind: "error",
          message:
            provider === ""
              ? "Pick a provider for the key."
              : `${provider} is not a supported provider — pick one from the list.`,
        },
        400,
      );
    }
    if (plainKey === "") {
      return settingsResponse(
        c,
        gate.session,
        store,
        apps,
        gate.app,
        { kind: "error", message: "Enter an API key to store." },
        400,
      );
    }
    if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
      return settingsResponse(
        c,
        gate.session,
        store,
        apps,
        gate.app,
        {
          kind: "error",
          message: `That API key is too long (${plainKey.length} characters) — keys are limited to ${MAX_PROVIDER_KEY_LENGTH} characters. Nothing was stored.`,
        },
        400,
      );
    }
    try {
      await store.setProviderKey(gate.app.id, provider, plainKey);
    } catch (err) {
      logSettingsFailure("add_key", gate.app.id, err);
      return settingsResponse(c, gate.session, store, apps, gate.app, settingsFailureNotice(err), 500);
    }
    return settingsResponse(c, gate.session, store, apps, gate.app, {
      kind: "success",
      message: `Stored the ${provider} key for ${gate.app.slug} — it is only ever shown masked.`,
    });
  }
  if (op === "save-chain") {
    const raw = typeof form.model_chain === "string" ? form.model_chain : "";
    try {
      if (raw.trim() === "") {
        await store.setModelChain(gate.app.id, null);
        return settingsResponse(c, gate.session, store, apps, gate.app, {
          kind: "success",
          message: `Cleared the model chain for ${gate.app.slug} — reviews fall back to the deployment default.`,
        });
      }
      if (parseModelChain(raw).length === 0) {
        return settingsResponse(
          c,
          gate.session,
          store,
          apps,
          gate.app,
          { kind: "error", message: "Enter at least one comma-separated model selector." },
          400,
        );
      }
      await store.setModelChain(gate.app.id, raw);
    } catch (err) {
      logSettingsFailure("save_chain", gate.app.id, err);
      return settingsResponse(c, gate.session, store, apps, gate.app, settingsFailureNotice(err), 500);
    }
    return settingsResponse(c, gate.session, store, apps, gate.app, {
      kind: "success",
      message: `Saved the model chain for ${gate.app.slug}.`,
    });
  }
  if (op === "save-roles") {
    // Plan 17 T3: the Role models editor posts one `role_<role>` field per
    // audit seat (the page always renders all four rows, blank inputs
    // included), so the submitted map is FULL — blanks = cleared (the
    // setModelRole 空 = 清除 convention), content = verbatim upsert, all
    // through the validate-all-first setModelRoles bulk face. Any
    // `role_`-prefixed field naming a role outside MODEL_ROLE_IDS is client
    // tampering → 400 re-render, zero writes; a save with NO role fields at
    // all is equally malformed (it could not come from this page, and an
    // empty map must never masquerade as a successful save).
    const selectors: Record<string, string> = {};
    for (const [field, value] of Object.entries(form)) {
      if (!field.startsWith("role_") || typeof value !== "string") continue;
      const role = field.slice("role_".length);
      if (!MODEL_ROLE_IDS.includes(role)) {
        return settingsResponse(
          c,
          gate.session,
          store,
          apps,
          gate.app,
          { kind: "error", message: `${role} is not a known review role — nothing was saved.` },
          400,
        );
      }
      selectors[role] = value;
    }
    if (Object.keys(selectors).length === 0) {
      return settingsResponse(
        c,
        gate.session,
        store,
        apps,
        gate.app,
        { kind: "error", message: "No role selectors were submitted — resubmit the Role models form." },
        400,
      );
    }
    // Selector grammar, role-named for the 4-row form (the same parseModelChain
    // mirror the save-chain op 400s against); blank stays legal = clear.
    for (const [role, selector] of Object.entries(selectors)) {
      if (selector.trim() !== "" && parseModelChain(selector).length === 0) {
        return settingsResponse(
          c,
          gate.session,
          store,
          apps,
          gate.app,
          {
            kind: "error",
            message: `The ${role} selector needs at least one comma-separated model selector — or leave it empty to use the App model chain. Nothing was saved.`,
          },
          400,
        );
      }
    }
    try {
      await store.setModelRoles(gate.app.id, selectors);
    } catch (err) {
      logSettingsFailure("save_roles", gate.app.id, err);
      return settingsResponse(c, gate.session, store, apps, gate.app, settingsFailureNotice(err), 500);
    }
    return settingsResponse(c, gate.session, store, apps, gate.app, {
      kind: "success",
      message: `Saved the role models for ${gate.app.slug}.`,
    });
  }
  // T2 review fold (T1 minor): an unknown op is a validation failure like any
  // other — re-render the HTML page at 400 instead of a plain-text body.
  return settingsResponse(
    c,
    gate.session,
    store,
    apps,
    gate.app,
    { kind: "error", message: "Unknown settings operation — resubmit one of this page's forms." },
    400,
  );
});

dashboardApp.post("/apps/:slug/settings/key/delete", async (c) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  const form = await c.req.parseBody();
  const provider = typeof form.provider === "string" ? form.provider.trim() : "";
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  const apps = createAppsStore(gate.db);
  let removed: boolean;
  try {
    removed = await store.removeProviderKey(gate.app.id, provider);
  } catch (err) {
    logSettingsFailure("remove_key", gate.app.id, err);
    return settingsResponse(c, gate.session, store, apps, gate.app, settingsFailureNotice(err), 500);
  }
  // Tolerant no-op (the allowlist already bounds what can ever be stored):
  // an unknown provider simply has no row — a warn, not a 400.
  const notice: PageNotice = removed
    ? { kind: "success", message: `Removed the stored ${provider} key for ${gate.app.slug}.` }
    : {
        kind: "warn",
        message: `No stored ${provider === "" ? "(unspecified)" : provider} key on ${gate.app.slug} — nothing changed.`,
      };
  return settingsResponse(c, gate.session, store, apps, gate.app, notice);
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
    return c.html(
      manifestConfirmPage(session, {
        id: hold.id,
        name: hold.name,
        slug: hold.slug,
        webhookUrl: `${new URL(c.req.url).origin}/webhook/${hold.slug}`,
      }),
    );
  }
  // Members entry is admin-aware (qc1/qc2 F-001): the guard already resolved
  // the row; re-read it here (same route-local read pattern as the manifest
  // routes) to learn the role. A row removed between guard and render simply
  // renders without the entry — the next request 403s at the guard.
  const db = dashboardD1(c.env);
  const member = db ? await getUserByLogin(db, session.login) : null;
  return c.html(dashboardPage(session, member?.role === "admin"));
});
// --- Plan 22 T2: Review Health insights summary API -------------------------
//
// JSON read face for the insights aggregation (src/dashboard/insights-store.ts
// — the T1 module-boundary leaf, zero store/pipeline/review imports, AL-22-1
// candidate A). The mount-level guard above has already verified membership
// on every /dashboard route, so this handler adds ZERO auth code (AL-22-1):
// it only parses the two query params and serializes the store result.
//   - window: pure integer days, default 30. Non-integer (incl. negative and
//     empty) → 400 (AL-22-1: malformed 400). Values > 90 are NOT rejected —
//     the single clamp point caps them at 90, and the response echoes the
//     EFFECTIVE window so clients see what the aggregation actually used.
//   - repo: optional owner/repo filter, malformed → 400.
// Response = the store return plus the two echoed params (snake_case keys).
const INSIGHTS_REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

dashboardApp.get("/api/insights/summary", async (c) => {
  const db = dashboardD1(c.env);
  if (!db) return c.text("dashboard storage is not configured", 500);

  let windowDays = 30;
  const rawWindow = c.req.query("window");
  if (rawWindow !== undefined) {
    if (!/^\d+$/.test(rawWindow)) {
      return c.json({ error: "window must be a non-negative integer number of days" }, 400);
    }
    windowDays = Number(rawWindow);
  }

  let repoFilter: { owner: string; repo: string } | undefined;
  const rawRepo = c.req.query("repo");
  if (rawRepo !== undefined) {
    if (!INSIGHTS_REPO_PATTERN.test(rawRepo)) {
      return c.json({ error: "repo must be owner/repo" }, 400);
    }
    const slash = rawRepo.indexOf("/");
    repoFilter = { owner: rawRepo.slice(0, slash), repo: rawRepo.slice(slash + 1) };
  }

  const insights = await createInsightsStore(db, { windowDays, repo: repoFilter });
  return c.json({
    window_days: clampWindow(windowDays),
    ...(repoFilter !== undefined ? { repo: rawRepo } : {}),
    reviews_total: insights.reviewsTotal,
    findings_by_severity: insights.findingsBySeverity,
    findings_by_category: insights.findingsByCategory,
    verdict_distribution: insights.verdictDistribution,
    weekly_trend: insights.weeklyTrend,
    recurring_top: insights.recurringTop,
  });
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

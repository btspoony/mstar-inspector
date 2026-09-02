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
import { createAppsStore, type DeliverySummary, type GithubAppRow } from "./apps-store";
import { SecretboxKeyError, createSecretbox } from "./secretbox";
import {
  CUSTOM_PROVIDER_API_IDS,
  CUSTOM_PROVIDER_ID_PATTERN,
  InvalidCustomProviderError,
  IN_IMAGE_BASE_PROVIDER_IDS,
  isValidCustomProviderBaseUrl,
  MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH,
  MAX_CUSTOM_PROVIDER_COUNT,
  MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH,
  MAX_CUSTOM_PROVIDER_MODEL_IDS,
  MAX_MODEL_SELECTOR_LENGTH,
  MAX_PROVIDER_KEY_LENGTH,
  MODEL_ROLE_IDS,
  PROVIDER_IDS,
  createAppConfigStore,
  parseModelChain,
  type AppConfigBatchFace,
  type AppConfigStore,
} from "./app-config-store";
import { composeModelOptions, findFailingSelector } from "./model-membership";
import { verifyProviderKey, type VerifyFailureReason } from "./provider-verify";
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
  deniedPage,
  errorPage,
  forbiddenPage,
  manifestConfirmPage,
  manifestErrorPage,
  manifestStartPage,
  manifestSuccessPage,
  removedPage,
} from "./views";
import { clampWindow, createInsightsStore } from "./insights-store";
import { isLocale, resolveLocale, serializeLocaleCookie, t, type Locale } from "../i18n";
import { wantsHtml } from "../spa/routes";
import { SPA_POST_FORM_HEADER, SPA_POST_FORM_VALUE } from "../spa/post-form-headers";

export const dashboardApp = new Hono<{ Bindings: Env }>();

/** SPA shell entry for members/apps list mutations (plan 29 QC W-2). */
const DASHBOARD_SHELL_REDIRECT = "/dashboard";

function isSpaFetchPost(c: Context<{ Bindings: Env }>): boolean {
  return c.req.header(SPA_POST_FORM_HEADER) === SPA_POST_FORM_VALUE;
}

/** Native `<form method="post">` navigation — not the SPA's fetch `postForm`. */
function wantsHtmlFormNavigation(c: Context<{ Bindings: Env }>): boolean {
  return wantsHtml(c.req.header("Accept") ?? null) && !isSpaFetchPost(c);
}

function pinnedPostMutationResponse(
  c: Context<{ Bindings: Env }>,
  redirectTo: string,
  message: string,
  status: 200 | 400 | 404 | 500 = 200,
): Response {
  if (wantsHtmlFormNavigation(c)) {
    return c.redirect(redirectTo, 302);
  }
  return c.text(message, status);
}

function requestLocale(c: Context<{ Bindings: Env }>): Locale {
  return resolveLocale(c.req.raw);
}


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
  // POST /dashboard/locale is session-optional (plan 29 T4): the login-page
  // language toggle must set mstar_locale without membership. Locale is not
  // a privileged action — the route writes only the language cookie.
  if (!session) {
    if (c.req.path === "/dashboard/locale") return next();
    return c.redirect("/dashboard/login", 302);
  }
  // Logout needs no membership row (qc2 F-002): any VALID session may burn
  // its own cookies. The route itself touches no membership data, so this
  // sits before the D1 check — storage misconfiguration cannot trap a
  // stale cookie on the browser either.
  // Locale follows the same L5 session-level exemption: a row-less (removed)
  // session may still set language preference.
  if (c.req.path === "/dashboard/logout" || c.req.path === "/dashboard/locale") return next();
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
    return c.html(removedPage(session.login, requestLocale(c)), 403);
  }
  return next();
});

async function startOAuthLogin(c: Context<{ Bindings: Env }>): Promise<Response> {
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
}

// GET starts OAuth for non-HTML clients. SPA login (Accept: text/html) is
// served by spa-dispatch; its "Sign in with GitHub" form POSTs here so the
// browser does not loop on the SPA GET.
dashboardApp.get("/login", startOAuthLogin);
dashboardApp.post("/login", startOAuthLogin);

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
    return c.html(errorPage(t(requestLocale(c), "common.oauth.stateInvalid"), requestLocale(c)), 400);
  }
  const code = c.req.query("code");
  if (!code) {
    logOAuthFailure("callback", "missing_code");
    return c.html(errorPage(t(requestLocale(c), "common.oauth.missingCode"), requestLocale(c)), 400);
  }
  const callbackUri = `${new URL(c.req.url).origin}/dashboard/oauth/callback`;
  const token = await exchangeCodeForToken(code, secrets.clientId, secrets.clientSecret, callbackUri);
  if (!token) {
    return c.html(errorPage(t(requestLocale(c), "common.oauth.codeRejected"), requestLocale(c)), 502);
  }
  const user = await fetchGitHubUser(token);
  if (!user) {
    return c.html(errorPage(t(requestLocale(c), "common.oauth.profileFailed"), requestLocale(c)), 502);
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
    return c.html(deniedPage(user.login, requestLocale(c)), 403);
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

// --- Plan 29 T2: locale preference (i18n) ---
//
// POST /dashboard/locale — the navbar [EN/中文] toggle target. Body is
// JSON or form-encoded `{ locale }`; valid ids are the two Locale values.
// Writes the mstar_locale cookie (HttpOnly, SameSite=Lax, Path=/dashboard
// — the session.ts attribute set scoped to the dashboard) and 302s back to
// a Referer-derived target sanitized by safeLocaleRedirect (anything
// off-origin, protocol-relative, empty, or missing → /dashboard). Invalid
// locale → 400, no cookie.
// Plan 29 T4: the mount-level guard treats POST /dashboard/locale as
// session-optional and membership-exempt (same L5 family as logout). A
// logged-out login-page toggle and a row-less session may both set the
// cookie. Every other /dashboard route stays membership-enforcing.

/**
 * Safe 302 target for the locale toggle. The Referer header is
 * attacker-influenced (open-redirect surface): EVERY non-empty value is
 * parsed with `new URL(referer, origin)` — never echoed raw — and accepted
 * only when the resolved origin equals the request origin AND the resulting
 * pathname+search starts with `/` without a `//` prefix (a `//` pathname is
 * protocol-relative, e.g. `https://origin/\evil.example` normalizes to
 * `//evil.example`). Missing/empty Referer, off-origin URLs, protocol-
 * relative `//host`, backslash-authority tricks (`/\evil.example` parses as
 * `https://evil.example/`), and unparseable junk all fall back to
 * /dashboard. Never echoes an absolute or protocol-relative URL.
 */
function safeLocaleRedirect(referer: string | null | undefined, origin: string): string {
  if (!referer) return "/dashboard";
  try {
    const url = new URL(referer, origin);
    if (url.origin === origin) {
      const path = `${url.pathname}${url.search}`;
      if (path.startsWith("/") && !path.startsWith("//")) return path;
    }
  } catch {
    // unparseable referer → /dashboard
  }
  return "/dashboard";
}

/** JSON or form body `{ locale }` → valid Locale, or null (invalid/malformed). */
async function readLocaleFromBody(c: Context<{ Bindings: Env }>): Promise<Locale | null> {
  const contentType = c.req.header("Content-Type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await c.req.json()) as { locale?: unknown };
      return isLocale(body.locale) ? body.locale : null;
    }
    const form = await c.req.parseBody();
    return isLocale(form.locale) ? form.locale : null;
  } catch {
    return null;
  }
}

dashboardApp.post("/locale", async (c) => {
  const locale = await readLocaleFromBody(c);
  if (!locale) return c.text("invalid locale", 400);
  c.header("Set-Cookie", serializeLocaleCookie(locale));
  const location = safeLocaleRedirect(c.req.header("Referer"), new URL(c.req.raw.url).origin);
  return c.redirect(location, 302);
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
  return c.html(
    manifestStartPage(session, manifest.name, JSON.stringify(manifest), buildManifestCreateUrl(state), requestLocale(c)),
  );
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
      manifestErrorPage(t(requestLocale(c), "manifest.error.stateMismatch"), false, requestLocale(c)),
      400,
    );
  }
  const code = c.req.query("code");
  if (!code) {
    logManifestFailure("callback", "missing_code");
    return c.html(manifestErrorPage(t(requestLocale(c), "manifest.error.missingCode"), false, requestLocale(c)), 400);
  }
  const conversion = await exchangeManifestCode(code);
  if (!conversion) {
    return c.html(manifestErrorPage(t(requestLocale(c), "manifest.error.codeRejected"), false, requestLocale(c)), 502);
  }
  const hold = await createHoldValue(conversion, session.login, secrets.sessionSecret, state.slug);
  c.header("Set-Cookie", serializeCookie(MANIFEST_HOLD_COOKIE, hold, MANIFEST_HOLD_MAX_AGE_SEC), {
    append: true,
  });
  const origin = new URL(c.req.url).origin;
  return c.html(
    manifestConfirmPage(
      session,
      {
        id: conversion.id,
        name: conversion.name,
        slug: state.slug,
        webhookUrl: `${origin}/webhook/${state.slug}`,
      },
      requestLocale(c),
    ),
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
      manifestErrorPage(t(requestLocale(c), "manifest.error.loginMismatch"), false, requestLocale(c)),
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
      manifestErrorPage(t(requestLocale(c), "manifest.error.noEncryptionKey"), true, requestLocale(c)),
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
      manifestSuccessPage(
        session,
        {
          id: row.github_app_id,
          name: row.name,
          slug: row.slug,
          webhookUrl: `${new URL(c.req.url).origin}/webhook/${row.slug}`,
        },
        requestLocale(c),
      ),
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
        manifestErrorPage(t(requestLocale(c), "manifest.error.slugConflict"), false, requestLocale(c)),
        409,
      );
    }
    if (isAppsUniqueViolation(err, "github_app_id")) {
      // The same GitHub App is already connected — retrying cannot help.
      logManifestFailure("commit", "github_app_id_conflict", { github_app_id: hold.id });
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
      return c.html(
        manifestErrorPage(t(requestLocale(c), "manifest.error.alreadyConnected"), false, requestLocale(c)),
        409,
      );
    }
    // Retryable (missing migrations, transient D1 failure, …): hold kept.
    logManifestFailure("commit", "db_error", { error_type: errorTypeName(err) });
    return c.html(
      manifestErrorPage(t(requestLocale(c), "manifest.error.dbRejected"), true, requestLocale(c)),
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
    manifestConfirmPage(
      session,
      {
        id: hold.id,
        name: hold.name,
        slug: hold.slug,
        webhookUrl: `${new URL(c.req.url).origin}/webhook/${hold.slug}`,
      },
      requestLocale(c),
    ),
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
    return { ok: false, response: c.html(forbiddenPage(session.login, requestLocale(c)), 403) };
  }
  return { ok: true, session, db, admin };
}

/** SPA JSON face — same requireAdmin gate and listUsers assembly as the retired GET /members. */
dashboardApp.get("/api/members", async (c) => {
  const gate = await requireAdmin(c);
  if (!gate.ok) return gate.response;
  const members = await listUsers(gate.db);
  return c.json({
    members: members.map((m) => ({
      id: m.id,
      github_login: m.github_login,
      role: m.role,
      created_at: m.created_at,
    })),
  });
});

// Plan 29 T6: the members page is SPA-owned; these pinned POSTs answer the
// SPA's postForm (2xx → refetch + client notice; 4xx → client error notice)
// with plain-text bodies — the re-rendered HTML page is retired.
dashboardApp.post("/members/invite", async (c) => {
  const gate = await requireAdmin(c);
  if (!gate.ok) return gate.response;
  const form = await c.req.parseBody();
  const login = typeof form.login === "string" ? form.login.trim() : "";
  if (login.length === 0) {
    return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "Enter a GitHub login to invite.", 400);
  }
  // F-003: reject values outside the GitHub login syntax before any read or
  // write — they would persist as rows that no real login can ever claim.
  if (!GITHUB_LOGIN_PATTERN.test(login)) {
    return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, `${login} is not a valid GitHub login — use 1–39 letters, digits, or hyphens.`, 400);
  }
  // T1 review pin (Minor 2): resolve the login case-insensitively BEFORE any
  // createUser call — the DDL UNIQUE is BINARY-collated, so ON CONFLICT alone
  // misses case variants ("OctoCat" vs "octocat") and would mint a second row.
  if (await getUserByLogin(gate.db, login)) {
    return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "ok"); // already a member — idempotent no-op
  }
  await createUser(gate.db, { login, role: "member", invitedBy: gate.admin.github_login });
  return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "ok");
});

dashboardApp.post("/members/remove", async (c) => {
  const gate = await requireAdmin(c);
  if (!gate.ok) return gate.response;
  const form = await c.req.parseBody();
  const userId = typeof form.userId === "string" ? form.userId : "";
  const members = await listUsers(gate.db);
  const target = members.find((m) => m.id === userId);
  if (!target) {
    return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "Unknown member — nothing was removed, try again.", 400);
  }
  // Refuse self-removal: an admin must not be able to lock themselves out.
  if (target.github_login.toLowerCase() === gate.admin.github_login.toLowerCase()) {
    return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "You cannot remove yourself.", 400);
  }
  // Refuse removing an admin while they are the last one (removal = row
  // delete, so this is the deployment's only admin-lockout guard). This
  // pre-check only shapes the message; the ENFORCEMENT is the single
  // conditional DELETE below, which closes the read-check-delete TOCTOU
  // (qc1): two concurrent removes of the last two admins cannot both land.
  if (target.role === "admin" && (await countAdmins(gate.db)) === 1) {
    return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "The last admin cannot be removed.", 400);
  }
  if (!(await deleteUserUnlessLastAdmin(gate.db, target.id))) {
    // Lost a race (the row vanished or just became the last admin between
    // the reads above and this delete): 400 with a retry message —
    // zero partial state either way.
    return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, `Could not remove ${target.github_login} — the member list just changed, try again.`, 400);
  }
  return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "ok");
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
  if (!user) return { ok: false, response: c.html(forbiddenPage(session.login, requestLocale(c)), 403) };
  return { ok: true, session, db, user };
}

/** Clarify #6: manage = any admin, or the App's creator (case-insensitive). */
function canManageApp(user: DashboardUserRow, app: GithubAppRow): boolean {
  return user.role === "admin" || app.created_by.toLowerCase() === user.github_login.toLowerCase();
}

/**
 * The Apps list with the plan-20 health column data (AL-20-2): every row
 * carries its deliverySummary (the App's LATEST webhook_deliveries row +
 * the 24h rejected count). The health column reads webhook_deliveries —
 * NOT the github_apps.last_webhook_at column, which stays the L5 "last
 * verified delivery" stamp (display-only, no computed health).
 *
 * The summaries come from the store's BATCHED deliverySummaries face
 * (plan 20 QC wave 1, W-1): exactly TWO D1 statements for any N instead
 * of the per-App 2N fan-out — this helper runs on GET /api/apps (the SPA
 * JSON face), so the statement count must not scale with the App count.
 */
async function appsListWithHealth(
  db: DashboardDb,
): Promise<Array<GithubAppRow & { health: DeliverySummary }>> {
  const apps = createAppsStore(db);
  const rows = await apps.listApps();
  const summaries = await apps.deliverySummaries(rows.map((app) => app.id));
  return rows.map((app) => ({ ...app, health: summaries[app.id]! }));
}

/** SPA JSON face — same requireMember gate and appsListWithHealth assembly as the retired GET /apps. Encrypted columns and row PKs stay off the payload. */
dashboardApp.get("/api/apps", async (c) => {
  const gate = await requireMember(c);
  if (!gate.ok) return gate.response;
  const rows = await appsListWithHealth(gate.db);
  return c.json({
    viewer: { login: gate.user.github_login, role: gate.user.role },
    apps: rows.map((app) => ({
      slug: app.slug,
      github_app_id: app.github_app_id,
      status: app.status,
      review_enabled: app.review_enabled,
      created_by: app.created_by,
      health: {
        latest: app.health.latest
          ? {
              event_name: app.health.latest.event_name,
              outcome: app.health.latest.outcome,
              status_code: app.health.latest.status_code,
              created_at: app.health.latest.created_at,
            }
          : null,
        rejected24h: app.health.rejected24h,
      },
    })),
  });
});

/**
 * One handler for the three pinned action routes. Unknown and soft-deleted
 * apps are equally invisible (the list never shows them) → 404, zero writes.
 * Plan 29 T6: the Apps list is SPA-owned, so the response is a plain 2xx the
 * SPA's postForm treats as success (it refetches the JSON face); the
 * re-rendered HTML page is retired. The store write still happens exactly
 * once; the `changed` result only shaped the retired notice copy.
 */
async function appStatusAction(
  c: Context<{ Bindings: Env }>,
  action: "disable" | "enable" | "delete",
): Promise<Response> {
  const gate = await requireMember(c);
  if (!gate.ok) return gate.response;
  const apps = createAppsStore(gate.db);
  const app = await apps.getAppBySlug(c.req.param("slug") ?? "");
  if (!app || app.deleted_at !== null) return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "unknown app", 404);
  if (!canManageApp(gate.user, app)) return c.html(forbiddenPage(gate.session.login, requestLocale(c)), 403);
  if (action === "delete") {
    await apps.softDeleteApp(app.id);
  } else {
    await apps.setAppStatus(app.id, action === "disable" ? "disabled" : "active");
  }
  return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "ok");
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
// paused). Plan 29 T6: the response is plain 200 "ok"; the SPA refetches
// the JSON face rather than re-rendering HTML.

/**
 * HTML-nav 302 target for pause/resume. Settings is the only native-form
 * caller (`<form method="post">` on the Review card); Apps-list uses fetch
 * `postForm`. Origin is a sanitized Referer pathname — never echoed as
 * Location. Settings-origin → `/dashboard/apps/:slug/settings` (DB slug);
 * anything else (apps list, missing/off-origin Referer) → `/dashboard`.
 */
function reviewActionRedirect(c: Context<{ Bindings: Env }>, slug: string): string {
  const settingsPath = `/dashboard/apps/${slug}/settings`;
  const origin = new URL(c.req.raw.url).origin;
  const refererPath = new URL(safeLocaleRedirect(c.req.header("Referer"), origin), origin).pathname;
  return refererPath === settingsPath ? settingsPath : DASHBOARD_SHELL_REDIRECT;
}

/**
 * One handler for the two pinned review-action routes. The idempotent no-op
 * case is short-circuited BEFORE the store write — pausing a paused App /
 * resuming an active one never touches the row (setReviewEnabled would
 * count a same-value UPDATE as changed and would churn updated_at, the
 * operator-mutation timestamp). Plan 29 T6: the response is a plain 2xx the
 * SPA's postForm treats as success (it refetches the JSON face); the
 * re-rendered HTML page is retired. Plan 29 QC round 2: HTML-nav 302 target
 * depends on origin (settings vs apps list); fetch is unchanged.
 */
async function appReviewAction(
  c: Context<{ Bindings: Env }>,
  action: "pause" | "resume",
): Promise<Response> {
  const gate = await requireMember(c);
  if (!gate.ok) return gate.response;
  const apps = createAppsStore(gate.db);
  const app = await apps.getAppBySlug(c.req.param("slug") ?? "");
  if (!app || app.deleted_at !== null) return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "unknown app", 404);
  if (!canManageApp(gate.user, app)) return c.html(forbiddenPage(gate.session.login, requestLocale(c)), 403);
  const htmlRedirect = reviewActionRedirect(c, app.slug);
  const paused = app.review_enabled === 0;
  if (action === "pause" ? paused : !paused) return pinnedPostMutationResponse(c, htmlRedirect, "ok"); // idempotent no-op — never touch the row
  await apps.setReviewEnabled(app.id, action === "resume");
  return pinnedPostMutationResponse(c, htmlRedirect, "ok");
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
// never a stored key. Plan 29 T6: the settings page is SPA-owned (the JSON
// face below serves the SPA); the DESIGN-token appSettingsPage view in
// src/dashboard/views.ts is retired.

type AppSettingsGate =
  | { ok: true; session: SessionPayload; db: DashboardDb; app: GithubAppRow }
  | { ok: false; response: Response };

/** Route-local owner-or-admin gate shared by the settings route family. */
async function requireAppSettings(c: Context<{ Bindings: Env }>): Promise<AppSettingsGate> {
  const member = await requireMember(c);
  if (!member.ok) return member;
  const app = await createAppsStore(member.db).getAppBySlug(c.req.param("slug") ?? "");
  if (!app || app.deleted_at !== null) return { ok: false, response: pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "unknown app", 404) };
  if (!canManageApp(member.user, app)) {
    return { ok: false, response: c.html(forbiddenPage(member.session.login, requestLocale(c)), 403) };
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

/** 500 fail-closed message: key misconfiguration vs storage rejection (commit-route copy style). */
function settingsFailureNotice(err: unknown): string {
  return err instanceof SecretboxKeyError
    ? "This deployment has no valid DASHBOARD_ENCRYPTION_KEY for its stored keys — ask the operator to configure it, then resubmit."
    : "The dashboard database rejected the change — nothing was stored. You can resubmit.";
}

/**
 * Plain-text settings POST response (plan 29 T6: the settings page is
 * SPA-owned and read-only today — plan 31 wires the forms; the pinned POST
 * paths keep their full validation and mutation, and answer the SPA's
 * postForm contract: 2xx → refetch the JSON face, 4xx/5xx → client error).
 */
function settingsPostResponse(
  c: Context<{ Bindings: Env }>,
  slug: string,
  message: string,
  status: 200 | 400 | 500 = 200,
): Response {
  return pinnedPostMutationResponse(c, `/dashboard/apps/${slug}/settings`, message, status);
}

function mapVerifyReason(reason: VerifyFailureReason): "invalid_key" | "unreachable" | "unexpected" {
  if (reason === "invalid_key" || reason === "unreachable") return reason;
  return "unexpected";
}

function verifyFailCopy(reason: ReturnType<typeof mapVerifyReason>): string {
  if (reason === "invalid_key") return "That API key was rejected by the provider — nothing was stored.";
  if (reason === "unreachable") return "The provider could not be reached — nothing was stored.";
  return "The provider returned an unexpected response — nothing was stored.";
}

function membershipFailCopy(selector: string): string {
  return `Selector ${selector} is not in this App's verified models.`;
}

/** SPA JSON face — same requireAppSettings gate and the settings reads the retired HTML GET used. */
dashboardApp.get("/api/apps/:slug/settings", async (c) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  const apps = createAppsStore(gate.db);
  try {
    const maskedKeys = await store.listProviderKeys(gate.app.id);
    const modelChain = await store.getModelChain(gate.app.id);
    const modelRoles = await store.getAppModelRoles(gate.app.id);
    const customProviders = await store.listCustomProviders(gate.app.id);
    const installations = await apps.listInstallations(gate.app.id);
    const deliveries = await apps.listRecentDeliveries(gate.app.id, 5);
    const deliverySummary = await apps.deliverySummary(gate.app.id);
    return c.json({
      app: {
        slug: gate.app.slug,
        status: gate.app.status,
        review_enabled: gate.app.review_enabled !== 0,
        last_webhook_at: gate.app.last_webhook_at ?? null,
      },
      keys: maskedKeys,
      model_chain: modelChain,
      model_roles: modelRoles,
      custom_providers: customProviders,
      installations,
      deliveries: deliveries.map((d) => ({
        event_name: d.event_name,
        outcome: d.outcome,
        status_code: d.status_code,
        created_at: d.created_at,
      })),
      delivery_summary: {
        latest: deliverySummary.latest
          ? {
              event_name: deliverySummary.latest.event_name,
              outcome: deliverySummary.latest.outcome,
              status_code: deliverySummary.latest.status_code,
              created_at: deliverySummary.latest.created_at,
            }
          : null,
        rejected24h: deliverySummary.rejected24h,
      },
      provider_ids: PROVIDER_IDS,
      model_role_ids: MODEL_ROLE_IDS,
      custom_provider_api_ids: CUSTOM_PROVIDER_API_IDS,
    });
  } catch (err) {
    logSettingsFailure("api_render", gate.app.id, err);
    return c.text("the app settings could not be read from encrypted storage", 500);
  }
});

dashboardApp.get("/api/apps/:slug/models", async (c) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  try {
    const verified = await store.getVerifiedModels(gate.app.id);
    const custom = await store.listCustomProviders(gate.app.id);
    return c.json({ groups: composeModelOptions(verified, custom) });
  } catch (err) {
    logSettingsFailure("api_models", gate.app.id, err);
    return c.text("the app models could not be read", 500);
  }
});

/**
 * SPA add-key path (plan 31 T4): verify the as-typed key, then store. Failure
 * is 400 JSON with a structured reason (invalid_key / unreachable / unexpected)
 * and ZERO writes. The key is never logged or returned.
 */
dashboardApp.post("/api/apps/:slug/keys/verify", async (c) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  const form = await c.req.parseBody();
  const provider = typeof form.provider === "string" ? form.provider.trim() : "";
  const plainKey = typeof form.key === "string" ? form.key.trim() : "";
  if (!PROVIDER_IDS.includes(provider) || plainKey === "" || plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
    return c.json({ ok: false, reason: "unexpected" as const }, 400);
  }
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  try {
    const verified = await verifyProviderKey({ fetch: globalThis.fetch }, provider, plainKey);
    if (!verified.ok) {
      return c.json({ ok: false, reason: mapVerifyReason(verified.reason) }, 400);
    }
    await store.saveVerifiedKey(gate.app.id, provider, plainKey, verified.models);
    return c.json({ ok: true, provider, models: verified.models });
  } catch (err) {
    logSettingsFailure("verify_key", gate.app.id, err);
    return c.json({ ok: false, reason: "unexpected" as const }, 500);
  }
});

/**
 * The settings POST: three operations on the pinned action path, discriminated
 * by the forms' hidden `op` field. add-key = provider allowlist (400 on any
 * other id — the allowlist is the plan's Global Constraint) + non-empty key
 * of at most MAX_PROVIDER_KEY_LENGTH characters (plan 15 input bounds — an
 * oversized key is a 400 with zero writes; the store guard beneath
 * is the backstop), then the store encrypts inside. save-chain = empty →
 * clear the chain (an unconfigured chain fails that App's reviews closed in
 * the consumer — plan 24 Task 6 / AL-24-5: no deployment-level chain exists
 * to fall back to), otherwise ≥1 comma-separated selector required and the
 * chain is stored VERBATIM (a `:thinking`-style suffix is legal omp syntax;
 * full selector validation stays omp-side). save-roles (plan 17 T3) = the
 * Role models editor's full map — one `role_<role>` field per audit
 * seat, blanks = cleared, saved through the validate-all-first setModelRoles
 * (zero partial writes on any validation failure). add-custom-provider /
 * remove-custom-provider (plan 23 T2) = the custom-provider declarations
 * section: every AL-23-1/AL-23-2 bound (id grammar, https-only baseUrl,
 * three-form api enum, model_ids 1..32 × ≤128, key required ≤4096) is a 400
 * with zero writes; the key is encrypted inside the store and
 * never echoed. Plan 29 T6: the settings page is SPA-owned, so every
 * response is plain text (settingsPostResponse) — 2xx = the SPA refetches
 * the JSON face, 4xx/5xx = the reason; the re-rendered HTML page is retired.
 */
dashboardApp.post("/apps/:slug/settings", async (c) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  // AL-23-2 (save-roles duplicate fields): parseBody({ all: true }) makes
  // duplicate keys VISIBLE as string[] (Hono 4.13.4 aggregates; the default
  // all=false silently last-wins) — the save-roles branch rejects any
  // array-valued role_* field with 400, and single-value fields keep their
  // exact current behavior.
  const form = await c.req.parseBody({ all: true });
  const op = typeof form.op === "string" ? form.op : "";
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  if (op === "add-key") {
    const provider = typeof form.provider === "string" ? form.provider.trim() : "";
    const plainKey = typeof form.key === "string" ? form.key.trim() : "";
    if (!PROVIDER_IDS.includes(provider)) {
      return settingsPostResponse(
        c,
        gate.app.slug,
        provider === ""
          ? "Pick a provider for the key."
          : `${provider} is not a supported provider — pick one from the list.`,
        400,
      );
    }
    if (plainKey === "") {
      return settingsPostResponse(c, gate.app.slug, "Enter an API key to store.", 400);
    }
    if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
      return settingsPostResponse(c, gate.app.slug, `That API key is too long (${plainKey.length} characters) — keys are limited to ${MAX_PROVIDER_KEY_LENGTH} characters. Nothing was stored.`,
        400,
      );
    }
    try {
      const verified = await verifyProviderKey({ fetch: globalThis.fetch }, provider, plainKey);
      if (!verified.ok) {
        return settingsPostResponse(c, gate.app.slug, verifyFailCopy(mapVerifyReason(verified.reason)), 400);
      }
      await store.saveVerifiedKey(gate.app.id, provider, plainKey, verified.models);
    } catch (err) {
      logSettingsFailure("add_key", gate.app.id, err);
      return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, gate.app.slug, `Stored the ${provider} key for ${gate.app.slug} — it is only ever shown masked.`,
    );
  }
  if (op === "save-chain") {
    // AL-23-2: a duplicate model_chain field (parseBody all:true aggregates
    // it into an array) must be rejected — never treated as the empty-clear
    // path, which would silently wipe the stored chain.
    if (Array.isArray(form.model_chain)) {
      return settingsPostResponse(c, gate.app.slug, "The model chain field was submitted more than once — resubmit the form. Nothing was saved.",
        400,
      );
    }
    const raw = typeof form.model_chain === "string" ? form.model_chain : "";
    try {
      if (raw.trim() === "") {
        await store.setModelChain(gate.app.id, null);
        return settingsPostResponse(c, gate.app.slug, `Cleared the model chain for ${gate.app.slug} — reviews fail closed until a chain + provider keys are configured (per-App only, plan 24).`,
        );
      }
      if (raw.length > MAX_MODEL_SELECTOR_LENGTH) {
        return settingsPostResponse(c, gate.app.slug, `That model chain is too long (${raw.length} characters) — limited to ${MAX_MODEL_SELECTOR_LENGTH}. Nothing was saved.`,
          400,
        );
      }
      const selectors = parseModelChain(raw);
      if (selectors.length === 0) {
        return settingsPostResponse(c, gate.app.slug, "Enter at least one comma-separated model selector.", 400);
      }
      const failing = findFailingSelector(
        selectors,
        await store.getVerifiedModels(gate.app.id),
        await store.listCustomProviders(gate.app.id),
      );
      if (failing) {
        return settingsPostResponse(c, gate.app.slug, membershipFailCopy(failing), 400);
      }
      await store.setModelChain(gate.app.id, raw);
    } catch (err) {
      logSettingsFailure("save_chain", gate.app.id, err);
      return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, gate.app.slug, `Saved the model chain for ${gate.app.slug}.`);
  }
  if (op === "save-roles") {
    // Plan 17 T3: the Role models editor posts one `role_<role>` field per
    // audit seat (the page always renders all four rows, blank inputs
    // included), so the submitted map is FULL — blanks = cleared (the
    // setModelRole 空 = 清除 convention), content = verbatim upsert, all
    // through the validate-all-first setModelRoles bulk face. Any
    // `role_`-prefixed field naming a role outside MODEL_ROLE_IDS is client
    // tampering → 400, zero writes; a save with NO role fields at
    // all is equally malformed (it could not come from this page, and an
    // empty map must never masquerade as a successful save).
    const selectors: Record<string, string> = {};
    for (const [field, value] of Object.entries(form)) {
      if (!field.startsWith("role_")) continue;
      // AL-23-2: with parseBody({ all: true }) a duplicate role_* field
      // arrives as an ARRAY — explicit 400 rejection (zero
      // writes), never the silent last-wins the default parseBody had.
      if (Array.isArray(value)) {
        return settingsPostResponse(c, gate.app.slug, `The ${field} field was submitted more than once — resubmit the Role models form with one value per role. Nothing was saved.`,
          400,
        );
      }
      if (typeof value !== "string") continue;
      const role = field.slice("role_".length);
      if (!MODEL_ROLE_IDS.includes(role)) {
        return settingsPostResponse(c, gate.app.slug, `${role} is not a known review role — nothing was saved.`, 400);
      }
      selectors[role] = value;
    }
    if (Object.keys(selectors).length === 0) {
      return settingsPostResponse(c, gate.app.slug, "No role selectors were submitted — resubmit the Role models form.", 400);
    }
    // Selector grammar, role-named for the 4-row form (the same parseModelChain
    // mirror the save-chain op 400s against); blank stays legal = clear.
    for (const [role, selector] of Object.entries(selectors)) {
      if (selector.length > MAX_MODEL_SELECTOR_LENGTH) {
        return settingsPostResponse(c, gate.app.slug, `The ${role} selector is too long (${selector.length} characters) — limited to ${MAX_MODEL_SELECTOR_LENGTH}. Nothing was saved.`,
          400,
        );
      }
      if (selector.trim() !== "" && parseModelChain(selector).length === 0) {
        return settingsPostResponse(c, gate.app.slug, `The ${role} selector needs at least one comma-separated model selector — or leave it empty to use the App model chain. Nothing was saved.`,
          400,
        );
      }
    }
    try {
      const verified = await store.getVerifiedModels(gate.app.id);
      const custom = await store.listCustomProviders(gate.app.id);
      for (const selector of Object.values(selectors)) {
        if (selector.trim() === "") continue;
        const failing = findFailingSelector(parseModelChain(selector), verified, custom);
        if (failing) {
          return settingsPostResponse(c, gate.app.slug, membershipFailCopy(failing), 400);
        }
      }
      await store.setModelRoles(gate.app.id, selectors);
    } catch (err) {
      logSettingsFailure("save_roles", gate.app.id, err);
      return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, gate.app.slug, `Saved the role models for ${gate.app.slug}.`);
  }
  if (op === "add-custom-provider") {
    // Plan 23 T2: declare a NON-built-in model provider for the App. Every
    // AL-23-1/AL-23-2 bound is checked here (400, zero writes —
    // the store re-validates as the backstop): provider id grammar
    // `[a-z0-9][a-z0-9-]{0,63}` (the env-name mapping the Task 3 consumer
    // injects), no collision with a built-in OR in-image base provider id
    // (QC wave-1 W-1 — ark-plan would be silently dead at synthesis), at
    // most MAX_CUSTOM_PROVIDER_COUNT declarations per App (QC wave-1 W-2,
    // growth-only — updating an existing id always proceeds), baseUrl
    // https-only ≤2048, api one of the three-form enum, model_ids 1..32
    // entries × ≤128 chars, key required and ≤ the existing 4096 cap. The
    // key is encrypted inside the store and never echoed back.
    const providerId = typeof form.provider_id === "string" ? form.provider_id.trim() : "";
    const baseUrl = typeof form.base_url === "string" ? form.base_url.trim() : "";
    const api = typeof form.api === "string" ? form.api.trim() : "";
    const modelIds = parseModelChain(typeof form.model_ids === "string" ? form.model_ids : "");
    const plainKey = typeof form.key === "string" ? form.key.trim() : "";
    if (providerId === "") {
      return settingsPostResponse(c, gate.app.slug, "Enter a provider id for the custom provider.", 400);
    }
    if (!CUSTOM_PROVIDER_ID_PATTERN.test(providerId)) {
      return settingsPostResponse(c, gate.app.slug, "Provider ids are lowercase letters, digits, and hyphens — 1 to 64 characters, starting with a letter or digit. Nothing was stored.",
        400,
      );
    }
    if (PROVIDER_IDS.includes(providerId)) {
      return settingsPostResponse(c, gate.app.slug, `${providerId} is a built-in provider — custom providers must use a new id. Nothing was stored.`,
        400,
      );
    }
    // QC wave-1 W-1: the in-image base models.yml (sandbox-image/omp-models.yml)
    // already declares this id — the base-wins merge would skip the custom
    // block on every review while its key still got injected, so the
    // declaration is refused up front (mirror of IN_IMAGE_BASE_PROVIDER_IDS).
    if (IN_IMAGE_BASE_PROVIDER_IDS.includes(providerId)) {
      return settingsPostResponse(c, gate.app.slug, `${providerId} is already provided by the review environment's base configuration — custom providers must use a new id. Nothing was stored.`,
        400,
      );
    }
    // QC wave-1 W-2: declarations per App are capped (growth-only — an
    // update of an already-declared id never counts against the cap). The
    // store re-checks the same bound as its backstop.
    const declaredCustomProviders = await store.listCustomProviders(gate.app.id);
    if (
      !declaredCustomProviders.some((p) => p.provider_id === providerId) &&
      declaredCustomProviders.length >= MAX_CUSTOM_PROVIDER_COUNT
    ) {
      return settingsPostResponse(c, gate.app.slug, `This App already has the maximum of ${MAX_CUSTOM_PROVIDER_COUNT} custom providers — remove one before declaring another (updating an existing declaration is always allowed). Nothing was stored.`,
        400,
      );
    }
    if (baseUrl === "") {
      return settingsPostResponse(c, gate.app.slug, "Enter the provider's base URL.", 400);
    }
    if (!isValidCustomProviderBaseUrl(baseUrl)) {
      return settingsPostResponse(c, gate.app.slug, "The base URL must be a valid https URL with a host — nothing was stored.", 400);
    }
    if (baseUrl.length > MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH) {
      return settingsPostResponse(c, gate.app.slug, `That base URL is too long (${baseUrl.length} characters) — limited to ${MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH}. Nothing was stored.`,
        400,
      );
    }
    if (api === "") {
      return settingsPostResponse(c, gate.app.slug, "Pick an API protocol for the custom provider.", 400);
    }
    if (!CUSTOM_PROVIDER_API_IDS.includes(api as (typeof CUSTOM_PROVIDER_API_IDS)[number])) {
      return settingsPostResponse(c, gate.app.slug, `${api} is not a supported API protocol — pick one from the list. Nothing was stored.`,
        400,
      );
    }
    if (modelIds.length === 0) {
      return settingsPostResponse(c, gate.app.slug, "Enter at least one model id for the custom provider.", 400);
    }
    if (modelIds.length > MAX_CUSTOM_PROVIDER_MODEL_IDS) {
      return settingsPostResponse(c, gate.app.slug, `Too many model ids (${modelIds.length}) — at most ${MAX_CUSTOM_PROVIDER_MODEL_IDS}. Nothing was stored.`,
        400,
      );
    }
    if (modelIds.some((id) => id.length > MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH)) {
      return settingsPostResponse(c, gate.app.slug, `Model ids are limited to ${MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH} characters each. Nothing was stored.`,
        400,
      );
    }
    if (plainKey === "") {
      return settingsPostResponse(c, gate.app.slug, "Enter an API key to store.", 400);
    }
    if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
      return settingsPostResponse(c, gate.app.slug, `That API key is too long (${plainKey.length} characters) — keys are limited to ${MAX_PROVIDER_KEY_LENGTH} characters. Nothing was stored.`,
        400,
      );
    }
    try {
      const verified = await verifyProviderKey(
        { fetch: globalThis.fetch },
        providerId,
        plainKey,
        {
          baseUrl,
          api: api as (typeof CUSTOM_PROVIDER_API_IDS)[number],
          modelIds,
        },
      );
      if (!verified.ok) {
        return settingsPostResponse(c, gate.app.slug, verifyFailCopy(mapVerifyReason(verified.reason)), 400);
      }
      await store.upsertCustomProvider(
        gate.app.id,
        { provider_id: providerId, base_url: baseUrl, api: api as (typeof CUSTOM_PROVIDER_API_IDS)[number], model_ids: modelIds },
        plainKey,
      );
    } catch (err) {
      logSettingsFailure("add_custom_provider", gate.app.id, err);
      // PR #10 cap-race fix: the store's atomic cap check can legitimately
      // throw InvalidCustomProviderError AFTER the route pre-check passed
      // (a concurrent save won the last slot) — that is a 400, not a 500.
      if (err instanceof InvalidCustomProviderError) {
        return settingsPostResponse(c, gate.app.slug, err.message, 400);
      }
      return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, gate.app.slug, `Declared custom provider ${providerId} for ${gate.app.slug} — its key is stored encrypted and injected by environment variable name.`,
    );
  }
  if (op === "remove-custom-provider") {
    const providerId = typeof form.provider_id === "string" ? form.provider_id.trim() : "";
    let removed: boolean;
    try {
      removed = await store.removeCustomProvider(gate.app.id, providerId);
    } catch (err) {
      logSettingsFailure("remove_custom_provider", gate.app.id, err);
      return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
    }
    // Tolerant no-op (the id grammar already bounds what can ever be
    // stored): an unknown provider id simply has no row — a 2xx, not a 400.
    return settingsPostResponse(
      c,
      gate.app.slug,
      removed
        ? `Removed the custom provider ${providerId} from ${gate.app.slug}.`
        : `No custom provider ${providerId === "" ? "(unspecified)" : providerId} on ${gate.app.slug} — nothing changed.`,
    );
  }
  // T2 review fold (T1 minor): an unknown op is a validation failure like any
  // other — 400 with the reason.
  return settingsPostResponse(c, gate.app.slug, "Unknown settings operation — resubmit one of this page's forms.", 400);
});

dashboardApp.post("/apps/:slug/settings/key/delete", async (c) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  const form = await c.req.parseBody();
  const provider = typeof form.provider === "string" ? form.provider.trim() : "";
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  let removed: boolean;
  try {
    removed = await store.removeProviderKey(gate.app.id, provider);
  } catch (err) {
    logSettingsFailure("remove_key", gate.app.id, err);
    return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
  }
  // Tolerant no-op (the allowlist already bounds what can ever be stored):
  // an unknown provider simply has no row — a 2xx, not a 400.
  return settingsPostResponse(
    c,
    gate.app.slug,
    removed
      ? `Removed the stored ${provider} key for ${gate.app.slug}.`
      : `No stored ${provider === "" ? "(unspecified)" : provider} key on ${gate.app.slug} — nothing changed.`,
  );
});

// Plan 30 T4: the legacy SSR home (`dashboardApp.get("/")` →
// dashboardPage) is retired. GET /dashboard — every Accept variant — is the
// SPA workbench, served by spa-dispatch before this app is reached. The
// manifest-hold resume gate lives on its dedicated route
// /dashboard/manifest/confirm (the retryable-error page links there).
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

/**
 * Query-param parse for the insights JSON face (QC W-C): window (integer
 * days, default 30) + optional repo owner/repo filter. Returns the parsed
 * values or the 400 reason; the route answers 400 with a JSON error body
 * (the HTML notice page retired with GET /insights in plan 29 T6). The
 * >90 clamp stays in the store — the single clamp point — and the route
 * echoes the EFFECTIVE window.
 */
type InsightsParams =
  | { ok: true; windowDays: number; repoFilter?: { owner: string; repo: string }; rawRepo?: string }
  | { ok: false; reason: string };

function parseInsightsParams(query: { window?: string; repo?: string }): InsightsParams {
  let windowDays = 30;
  const rawWindow = query.window;
  if (rawWindow !== undefined) {
    if (!/^\d+$/.test(rawWindow)) {
      return { ok: false, reason: "window must be a non-negative integer number of days" };
    }
    windowDays = Number(rawWindow);
  }

  let repoFilter: { owner: string; repo: string } | undefined;
  let rawRepo: string | undefined;
  const rawRepoParam = query.repo;
  if (rawRepoParam !== undefined) {
    if (!INSIGHTS_REPO_PATTERN.test(rawRepoParam)) {
      return { ok: false, reason: "repo must be owner/repo" };
    }
    rawRepo = rawRepoParam;
    const slash = rawRepoParam.indexOf("/");
    repoFilter = { owner: rawRepoParam.slice(0, slash), repo: rawRepoParam.slice(slash + 1) };
  }

  return { ok: true, windowDays, repoFilter, rawRepo };
}

dashboardApp.get("/api/insights/summary", async (c) => {
  const db = dashboardD1(c.env);
  if (!db) return c.text("dashboard storage is not configured", 500);

  const params = parseInsightsParams({ window: c.req.query("window"), repo: c.req.query("repo") });
  if (!params.ok) return c.json({ error: params.reason }, 400);

  const insights = await createInsightsStore(db, { windowDays: params.windowDays, repo: params.repoFilter });
  return c.json({
    window_days: clampWindow(params.windowDays),
    ...(params.repoFilter !== undefined ? { repo: params.rawRepo } : {}),
    reviews_total: insights.reviewsTotal,
    findings_by_severity: insights.findingsBySeverity,
    findings_by_category: insights.findingsByCategory,
    verdict_distribution: insights.verdictDistribution,
    weekly_trend: insights.weeklyTrend,
    recurring_top: insights.recurringTop,
  });
});

// Plan 29 T6: the insights HTML panel is retired — /dashboard/insights is
// SPA-owned (spa-dispatch serves the shell; the SPA reads the JSON face
// above). The legacy GET handler is gone.

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

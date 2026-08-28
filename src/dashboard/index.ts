/**
 * /dashboard Hono sub-app: GitHub OAuth login + signed-cookie session (08 B0)
 * + GitHub App Manifest start/callback (11 B1 T1). Mounted by
 * src/worker/index.ts as `app.route("/dashboard", dashboardApp)`.
 *
 * Route isolation (architect decision Q2): this module MUST NOT import
 * pipeline/store/review code. Fail-closed everywhere: missing OAuth secrets
 * → 5xx; bad CSRF state → 4xx and the session cookie is never set.
 */
import { Hono } from "hono";
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
} from "./manifest";
import { dashboardPage, errorPage, manifestConfirmPage, manifestErrorPage, manifestStartPage } from "./views";

export const dashboardApp = new Hono<{ Bindings: Env }>();

function dashboardSecrets(env: Env) {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET;
  const sessionSecret = env.DASHBOARD_SESSION_SECRET;
  return clientId && clientSecret && sessionSecret ? { clientId, clientSecret, sessionSecret } : null;
}

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
  const session = await createSessionValue(user.login, user.name, secrets.sessionSecret);
  c.header("Set-Cookie", serializeCookie(SESSION_COOKIE, session, SESSION_MAX_AGE_SEC), {
    append: true,
  });
  return c.redirect("/dashboard", 302);
});

dashboardApp.get("/logout", (c) => {
  c.header("Set-Cookie", expireCookie(SESSION_COOKIE));
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
  return c.html(manifestStartPage(session, JSON.stringify(manifest), buildManifestCreateUrl(state)));
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

dashboardApp.get("/", async (c) => {
  const sessionSecret = c.env.DASHBOARD_SESSION_SECRET;
  if (!sessionSecret) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
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
  return c.text("placeholder actions are not implemented in B0", 405);
});

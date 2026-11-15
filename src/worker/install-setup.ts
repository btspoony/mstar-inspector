/**
 * `/bot/setup` — the Setup URL GitHub redirects to after an App installation
 * (contract § 8.6/§ 8.7). GitHub contributes exactly two query parameters
 * (`installation_id`, `setup_action`) and NO `state`, so this route treats the
 * signed-in session as the identity: the target page already recorded a
 * short-lived `install_claims` row, and the claim is the only carrier of
 * intent.
 *
 * Three rules shape the handler and are not negotiable:
 *
 *   - Validation comes first and writes nothing: a malformed installation id
 *     or an unknown `setup_action` is `400 bad setup request` before any read.
 *   - `GET` binds ONLY when the session holds exactly one live claim. Zero
 *     claims explain themselves; more than one is listed for an explicit
 *     `POST`, because guessing among targets is exactly what the absence of
 *     `state` forbids and a prefetch must never choose.
 *   - The route holds no SQL: `install-claims-store` owns the claim lifecycle
 *     and the one bind batch, so this file only validates, identifies and maps
 *     outcomes to the frozen status/body pairs.
 *
 * It mounts on `app` (not `dashboardApp`, not `APP_ROUTES`): a callback has no
 * `:workspaceRef`, and an `APP_ROUTES` entry would widen the operator-read
 * ceiling for workspace routes. The GitHub App's Setup URL is configuration,
 * not code — it must be `{origin}/bot/setup`.
 */
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "./env";
import { readSessionValue, SESSION_COOKIE } from "../dashboard/session";
import { getUserByLogin, type DashboardD1 } from "../dashboard/users";
import {
  createInstallClaimsStore,
  type InstallBindOutcome,
  type InstallClaim,
} from "../dashboard/install-claims-store";

type SetupContext = Context<{ Bindings: Env }>;

/** GitHub appends the installation id as digits; anything else is not ours. */
function parseInstallationId(raw: string | undefined): number | null {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The claim ids are server-minted UUIDs, but the pages are HTML: escape anyway. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Server-rendered answer; nothing here is cacheable or a SPA document. */
function htmlPage(c: SetupContext, status: 200 | 401, title: string, body: string): Response {
  c.header("Cache-Control", "private, no-store");
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`,
    status,
  );
}

type SetupIdentity = { ok: true; db: DashboardD1; userId: string } | { ok: false; response: Response };

/**
 * Session identity, resolved to `users.id` (§ 9.1). Absent secret, absent DB
 * binding, an unverifiable cookie and a login with no `users` row all stop
 * here — the claim store is never reached. The unauthenticated page
 * deliberately does not stash the installation id: the claim row survives, so
 * signing in and pressing install again converges.
 */
async function setupIdentity(c: SetupContext): Promise<SetupIdentity> {
  const secret = c.env.DASHBOARD_SESSION_SECRET;
  if (!secret) return { ok: false, response: c.text("dashboard OAuth is not configured", 500) };
  const db = c.env.DB;
  if (db === undefined) return { ok: false, response: c.text("db binding missing", 500) };
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secret);
  const user = session === null ? null : await getUserByLogin(db, session.login);
  if (user === null) {
    return {
      ok: false,
      response: htmlPage(
        c,
        401,
        "unauthenticated",
        `<h1>unauthenticated</h1>
         <p>Sign in to the dashboard, then start the installation from the target's page again.</p>
         <p><a href="/dashboard/login">Sign in</a></p>`,
      ),
    };
  }
  return { ok: true, db, userId: user.id };
}

/** The frozen refusals of the bind batch (§ 9.4). */
function refusalResponse(c: SetupContext, outcome: Exclude<InstallBindOutcome, { outcome: "bound" }>): Response {
  switch (outcome.outcome) {
    case "claim_not_found":
      return c.text("claim not found", 404);
    case "target_not_bindable":
      return c.text("target not bindable", 409);
    case "bot_not_shared":
      return c.text("bot is not shared", 409);
    case "installation_already_bound":
      return c.text("installation already bound", 409);
  }
}

function noLiveClaimPage(c: SetupContext): Response {
  return htmlPage(
    c,
    200,
    "no_live_claim",
    `<h1>no_live_claim</h1>
     <p>No live installation claim for your account. Open the review target's page and press install again.</p>
     <p><a href="/dashboard">Back to the dashboard</a></p>`,
  );
}

/**
 * N claims: every one gets its own form, and nothing is written. The page
 * lists the target, its workspace and when the claim was made, so the user can
 * tell the attempts apart.
 */
function confirmPage(c: SetupContext, installationId: number, claims: InstallClaim[]): Response {
  const forms = claims
    .map(
      (claim) => `<li>
        <p>target <code>${escapeHtml(claim.target_id)}</code> in workspace
           <code>${escapeHtml(claim.workspace_id)}</code>, claimed ${escapeHtml(claim.created_at)}</p>
        <form method="post" action="/bot/setup">
          <input type="hidden" name="claim_id" value="${escapeHtml(claim.id)}">
          <input type="hidden" name="installation_id" value="${installationId}">
          <button type="submit">Bind this target</button>
        </form>
      </li>`,
    )
    .join("");
  return htmlPage(
    c,
    200,
    "confirm_required",
    `<h1>confirm_required</h1>
     <p>Your account holds more than one live claim. Choose the target this installation reviews.</p>
     <ul>${forms}</ul>`,
  );
}

function boundPage(c: SetupContext, installationId: number, targetId: string): Response {
  return htmlPage(
    c,
    200,
    "bound",
    `<h1>bound</h1>
     <p>Installation <code>${installationId}</code> now reviews target <code>${escapeHtml(targetId)}</code>.</p>`,
  );
}

/** One bind outcome → its answer; the 200 case is the `bound` page. */
function bindResponse(c: SetupContext, outcome: InstallBindOutcome, installationId: number): Response {
  if (outcome.outcome !== "bound") return refusalResponse(c, outcome);
  return boundPage(c, installationId, outcome.targetId);
}

/**
 * The confirming `POST`'s refusal envelope: the contract freezes
 * `404 {"error":"claim not found"}` as JSON for this programmatic action (the
 * SPA's claim flow and any scripted retry read it), while the bind refusals
 * keep § 9.4's text bodies. The `GET` pages and their text refusals are
 * unchanged — a browser navigation reads those.
 */
function postRefusalResponse(
  c: SetupContext,
  outcome: Exclude<InstallBindOutcome, { outcome: "bound" }>,
): Response {
  if (outcome.outcome === "claim_not_found") return c.json({ error: "claim not found" }, 404);
  return refusalResponse(c, outcome);
}

/**
 * `GET /bot/setup?installation_id=<n>&setup_action=install|update`.
 * Validation order is frozen: malformed id, then the action, then the secret,
 * then the session. Binds only in the one-claim case.
 */
export async function handleSetupGet(c: SetupContext): Promise<Response> {
  const installationId = parseInstallationId(c.req.query("installation_id"));
  if (installationId === null) return c.text("bad setup request", 400);
  const setupAction = c.req.query("setup_action");
  if (setupAction !== "install" && setupAction !== "update") return c.text("bad setup request", 400);

  const identity = await setupIdentity(c);
  if (!identity.ok) return identity.response;

  const store = createInstallClaimsStore(identity.db);
  const now = new Date().toISOString();
  const claims = await store.listLiveClaims(identity.userId, now);
  if (claims.length === 0) return noLiveClaimPage(c);
  if (claims.length > 1) return confirmPage(c, installationId, claims);

  const outcome = await store.consumeAndBind({
    claimId: claims[0]!.id,
    userId: identity.userId,
    installationId,
    now,
  });
  return bindResponse(c, outcome, installationId);
}

/**
 * `POST /bot/setup` — the confirming action. Same validation and identity as
 * the GET; `setup_action` is not required here because the form does not carry
 * it. A cross-user or non-live claim is `404 claim not found`: another
 * session's claim is indistinguishable from a missing one.
 */
export async function handleSetupPost(c: SetupContext): Promise<Response> {
  const form = await c.req.parseBody();
  const rawInstallationId = typeof form.installation_id === "string" ? form.installation_id : undefined;
  const installationId = parseInstallationId(rawInstallationId);
  if (installationId === null) return c.text("bad setup request", 400);
  const claimId = typeof form.claim_id === "string" ? form.claim_id : "";
  if (claimId === "") return c.text("bad setup request", 400);

  const identity = await setupIdentity(c);
  if (!identity.ok) return identity.response;

  const outcome = await createInstallClaimsStore(identity.db).consumeAndBind({
    claimId,
    userId: identity.userId,
    installationId,
    now: new Date().toISOString(),
  });
  if (outcome.outcome !== "bound") return postRefusalResponse(c, outcome);
  return boundPage(c, installationId, outcome.targetId);
}

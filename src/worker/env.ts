/**
 * Worker fetch-face environment (compass contracts B).
 * `DB` (plan 13 T4 — folded from the T2 local `WebhookFaceEnv` intersection)
 * is declared optional: the deployed Worker binds it on every face
 * (wrangler.jsonc 05), but this shared type also covers the dashboard
 * module, whose unbound-D1 premises fail closed — the per-App webhook route
 * guards it the same way (500 fail-closed when unbound).
 */
import type { D1Database, KVNamespace, Queue } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../contracts/review-job";

export type Env = {
  REVIEW_QUEUE: Queue<ReviewJobPayload>;
  IDEMPOTENCY_KV: KVNamespace;
  /**
   * D1 binding (plan 13 T4): the per-App webhook face (`POST
   * /webhook/:appSlug`) reads the `github_apps` row for its slug and touches
   * `app_installations` through src/dashboard/apps-store.ts (lock L1 leaf);
   * the dashboard reads it through its own optional local face, and the 06
   * queue face declares the same binding as the REQUIRED `PipelineEnv.DB`.
   * Unbound → the per-App route fails closed with 500 (dashboard-dependency
   * convention: fail closed like every missing dashboard dependency).
   */
  DB?: D1Database;
  /**
   * Fail-closed kill-switch (postdeploy feedback T4): reviews run ONLY when
   * this is exactly "true". Unset or any other value → every webhook is
   * classified as `ignore` (HTTP 2xx, no queue enqueue). Default OFF.
   */
  REVIEW_ENABLED?: string;
  /**
   * Dashboard (plan 08 B0) GitHub OAuth App credentials — user-to-server
   * login, DISTINCT from the review GitHub App (whose Worker-env secrets
   * were retired in plan 24 — per-App credentials now live encrypted in
   * D1) (.mstar/iterations/v0.3/guides/oauth-vs-github-app.md). Unset →
   * /dashboard routes fail closed.
   */
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /**
   * Independent HMAC key for dashboard session/state cookies (≥32 random
   * bytes; never reuse GITHUB_OAUTH_CLIENT_SECRET — rotation decoupled).
   */
  DASHBOARD_SESSION_SECRET?: string;
  /**
   * Envelope master key for D1-stored dashboard secrets (plan 13 B5, spec
   * dashboard-multi-app-platform § Crypto envelope): base64 of exactly 32
   * random bytes (AES-256-GCM secretbox, src/dashboard/secretbox.ts) —
   * encrypts github_apps credentials (PEM / webhook secret; plan 14 adds
   * per-App provider keys). Missing / malformed → SecretboxKeyError and the
   * encryption-dependent dashboard routes fail closed with 5xx. Never
   * reuse DASHBOARD_SESSION_SECRET — rotation decoupled. wrangler secret /
   * .dev.vars only — never in git.
   */
  DASHBOARD_ENCRYPTION_KEY?: string;
  /**
   * Invite-only dashboard bootstrap (plan 12 B4): comma-separated GitHub
   * logins that are created as `admin` at the OAuth callback when they have
   * no users row yet (compared case-insensitively — GitHub logins are
   * case-insensitive). A Worker VAR, NOT a secret (login names are public
   * identity): set in wrangler.jsonc `vars` (or the Cloudflare dashboard's
   * Worker variable settings) and redeploy; .dev.vars locally. Unset → the
   * first login against an EMPTY users table
   * bootstraps as admin (first-login fallback); every other unknown login
   * is denied (403, zero cookies) until an admin invites it.
   */
  ADMIN_LOGINS?: string;
  /**
   * Optional ops alert webhook (plan 19 T1, architect verdict AL-6): when
   * set, the cron sweep POSTs the `ops_sweep_alert` payload here on
   * threshold breach (JSON body, 3s timeout; a POST failure degrades to a
   * warn log — src/worker/sweep.ts). Absent/empty = log-only alerting.
   * wrangler secret / .dev.vars only — never in git.
   */
  ALERT_WEBHOOK_URL?: string;
};

/**
 * Cron scheduled-face environment (plan 19 T1, AL-6): the `scheduled`
 * handler receives the same Worker bindings as every other face; this
 * narrows the type to what the sweep actually reads. Derived via `Pick` so
 * the narrowing is compiler-enforced against `Env` and cannot drift as `Env`
 * evolves (optionality rides along: `DB` stays optional — unbound fails
 * closed with a warn, never a throw). The sweep is read-only: no queue/KV
 * mutation from this face, so those bindings are deliberately absent here.
 */
export type ScheduledEnv = Pick<Env, "DB" | "ALERT_WEBHOOK_URL">;

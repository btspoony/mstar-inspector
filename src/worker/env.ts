/**
 * Worker fetch-face environment (compass contracts B).
 * No `DB` here — D1 enters only the 06 `PipelineEnv` (consumer face).
 */
import type { KVNamespace, Queue } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../contracts/review-job";

export type Env = {
  APP_ID: string;
  PRIVATE_KEY: string;
  WEBHOOK_SECRET: string;
  REVIEW_QUEUE: Queue<ReviewJobPayload>;
  IDEMPOTENCY_KV: KVNamespace;
  /**
   * Fail-closed kill-switch (postdeploy feedback T4): reviews run ONLY when
   * this is exactly "true". Unset or any other value → every webhook is
   * classified as `ignore` (HTTP 2xx, no queue enqueue). Default OFF.
   */
  REVIEW_ENABLED?: string;
  /**
   * Dashboard (plan 08 B0) GitHub OAuth App credentials — user-to-server
   * login, DISTINCT from the review GitHub App above
   * (.mstar/iterations/v0.3/guides/oauth-vs-github-app.md). Unset →
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
   * encryption-dependent dashboard routes fail closed with 5xx; the legacy
   * env-secret App path is unaffected. Never reuse DASHBOARD_SESSION_SECRET
   * — rotation decoupled. wrangler secret / .dev.vars only — never in git.
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
};

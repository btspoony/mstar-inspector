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
};

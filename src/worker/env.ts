import type { D1Database, Fetcher, KVNamespace, Queue } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../contracts/review-job";

export type Env = {
  REVIEW_QUEUE: Queue<ReviewJobPayload>;
  IDEMPOTENCY_KV: KVNamespace;
  ASSETS?: Fetcher;
  DB?: D1Database;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  DASHBOARD_SESSION_SECRET?: string;
  DASHBOARD_ENCRYPTION_KEY?: string;
  ALERT_WEBHOOK_URL?: string;
  PLATFORM_OPERATORS?: string;
  DEPLOYMENT_MODE?: string;
};

/**
 * Cron scheduled-face environment (AL-6): the `scheduled`
 * handler receives the same Worker bindings as every other face; this
 * narrows the type to what the sweep and the recovery reconciler actually
 * read. Derived via `Pick` so the narrowing is compiler-enforced against
 * `Env` and cannot drift as `Env` evolves (optionality rides along: `DB`
 * stays optional — unbound fails closed with a warn, never a throw). The
 * sweep's reads are joined by one bounded queue write (the comment-claim
 * outbox, below); `DASHBOARD_ENCRYPTION_KEY` (§7.11: "the
 * already-used App-decryption secret binding") is what M8's reconciler
 * needs to decrypt per-App credentials for prepared-send/discovery/resolve
 * recovery — the sweep itself never touches it. `REVIEW_QUEUE` is the one
 * WRITE the sweep performs (migration 0048): it re-sends the stored payload of
 * a `comment_trigger_claims` row whose send never happened, so a crash between
 * claim and send cannot lose a comment-triggered review.
 */
export type ScheduledEnv = Pick<
  Env,
  "DB" | "ALERT_WEBHOOK_URL" | "DASHBOARD_ENCRYPTION_KEY" | "REVIEW_QUEUE"
>;

/** The two deployment shapes `DEPLOYMENT_MODE` accepts. */
export type DeploymentMode = "self-hosted" | "saas";

/**
 * Resolve `DEPLOYMENT_MODE`. Only the two shapes pass; unset, empty and every
 * other value throw — there is no default. A deployment that cannot name its
 * own shape has no defensible first-login story to tell, and a silent fallback
 * would tell one of the two shapes a story that is not theirs. Both read faces
 * (`src/worker/spa-dispatch.ts`, the OAuth callback) map the throw to a named
 * 500.
 */
export function deploymentModeOf(value: string | undefined): DeploymentMode {
  if (value === "self-hosted" || value === "saas") return value;
  const received = value === undefined ? "unset" : JSON.stringify(value);
  throw new Error(`DEPLOYMENT_MODE must be "self-hosted" or "saas", received ${received}`);
}

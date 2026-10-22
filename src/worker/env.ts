/**
 * Worker fetch-face environment (compass contracts B).
 * `DB` (folded into this shared env intersection)
 * is declared optional: the deployed Worker binds it on every face
 * (wrangler.jsonc 05), but this shared type also covers the dashboard
 * module, whose unbound-D1 premises fail closed — the per-App webhook route
 * guards it the same way (500 fail-closed when unbound).
 */
import type { D1Database, Fetcher, KVNamespace, Queue } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../contracts/review-job";

export type Env = {
  REVIEW_QUEUE: Queue<ReviewJobPayload>;
  IDEMPOTENCY_KV: KVNamespace;
  /**
   * Vite SPA assets: wrangler `assets` binding, directory
   * `dist/spa`. Optional on the type so Bun fetch-path tests that omit it
   * fall through to the legacy Hono app; production wrangler.jsonc always
   * binds it. `run_worker_first` means the Worker must `ASSETS.fetch()`
   * enumerated SPA pages and `/assets/*` itself.
   */
  ASSETS?: Fetcher;
  /**
   * D1 binding: the per-App webhook face (`POST
   * /webhook/:appSlug`) reads the `github_apps` row for its slug and touches
   * `app_installations` through src/dashboard/apps-store.ts (lock L1 leaf);
   * the dashboard reads it through its own optional local face, and the 06
   * queue face declares the same binding as the REQUIRED `PipelineEnv.DB`.
   * Unbound → the per-App route fails closed with 500 (dashboard-dependency
   * convention: fail closed like every missing dashboard dependency).
   */
  DB?: D1Database;
  /**
   * Emergency brake (AC4a): the exact `"false"` (case-sensitive,
   * untrimmed) stops ALL reviews — every webhook is classified as `ignore`
   * (HTTP 2xx, no queue enqueue). Unset / `""` / `"true"` / any other value
   * → per-App `github_apps.review_enabled` governs. Leave unset; the env
   * var is not an enable flag.
   */
  REVIEW_ENABLED?: string;
  /**
   * Dashboard GitHub OAuth App credentials — user-to-server
   * login, DISTINCT from the review GitHub App (whose Worker-env secrets
   * were retired — per-App credentials now live encrypted in D1;
   * distinct from a GitHub App). Unset →
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
   * Envelope master key for D1-stored dashboard secrets (spec
   * dashboard-multi-app-platform § Crypto envelope): base64 of exactly 32
   * random bytes (AES-256-GCM secretbox, src/dashboard/secretbox.ts) —
   * encrypts github_apps credentials (PEM / webhook secret, plus
   * per-App provider keys). Missing / malformed → SecretboxKeyError and the
   * encryption-dependent dashboard routes fail closed with 5xx. Never
   * reuse DASHBOARD_SESSION_SECRET — rotation decoupled. wrangler secret /
   * .dev.vars only — never in git.
   */
  DASHBOARD_ENCRYPTION_KEY?: string;
  /**
   * Optional ops alert webhook (architect verdict AL-6): when
   * set, the cron sweep POSTs the `ops_sweep_alert` payload here on
   * threshold breach (JSON body, 3s timeout; a POST failure degrades to a
   * warn log — src/worker/sweep.ts). Absent/empty = log-only alerting.
   * wrangler secret / .dev.vars only — never in git.
   */
  ALERT_WEBHOOK_URL?: string;
  /**
   * Platform-operator allowlist (plan 99): comma-separated GitHub logins,
   * compared case-insensitively through `parseLoginList`. An operator holds NO
   * business rights: without a live `support_grants` row for a workspace they
   * get the outsider 404, and with one they may read that workspace's metadata
   * and member list only. Not a secret — logins are public identity.
   */
  PLATFORM_OPERATORS?: string;
  /**
   * Tenant read mode (migration 0026). `"strict"` makes every
   * execution-facing App read INNER JOIN `app_workspaces`, so an App with no
   * workspace mapping is invisible to the pipeline; unset/empty = `"off"`
   * (today's single-table reads). Resolve it through `tenantModeOf`
   * (src/worker/tenant-mode.ts) — an illegal value throws instead of
   * silently reading as `off`.
   */
  WORKSPACE_TENANT_MODE?: "off" | "strict";
};

/**
 * Cron scheduled-face environment (AL-6): the `scheduled`
 * handler receives the same Worker bindings as every other face; this
 * narrows the type to what the sweep and the recovery reconciler actually
 * read. Derived via `Pick` so the narrowing is compiler-enforced against
 * `Env` and cannot drift as `Env` evolves (optionality rides along: `DB`
 * stays optional — unbound fails closed with a warn, never a throw). The
 * sweep is read-only; `DASHBOARD_ENCRYPTION_KEY` (§7.11: "the
 * already-used App-decryption secret binding") is what M8's reconciler
 * needs to decrypt per-App credentials for prepared-send/discovery/resolve
 * recovery — the sweep itself never touches it.
 */
export type ScheduledEnv = Pick<Env, "DB" | "ALERT_WEBHOOK_URL" | "DASHBOARD_ENCRYPTION_KEY">;

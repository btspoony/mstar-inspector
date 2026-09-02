/**
 * Worker entry — Hono app exported as the module `fetch` handler (no listen).
 * 06 appends the queue wiring here (worker → pipeline, the only legal edge);
 * 19 T1 appends the cron `scheduled` wiring (worker → store read-only sweep,
 * AL-6 — the sweep statically imports nothing workerd-only, so the Bun test
 * runner keeps importing this module without SDK mocks).
 *
 * Routes:
 * - GET/HEAD /dashboard* trailing slash → 301 (src/worker/redirects.ts)
 * - GET/HEAD enumerated SPA pages with Accept text/html → ASSETS index.html
 * - GET /healthz → 200 {"ok":true}
 * - POST /webhook/:appSlug → per-App webhook face (plan 13 Task 2; plan 24
 *   Task 1: the ONLY HTTP review entry — the legacy bare `/webhook` face is
 *   retired): slug → github_apps row (active, not deleted) → that App's
 *   decrypted webhook secret verifies the signature → classify → enqueue
 *   with `appRef: { appId }` (spec § Multi-App 契约, locks L3/L4); the
 *   classified payload's installation_id touches `app_installations`
 *   (fire-and-forget relative to the enqueue, plan 13 Task 4)
 * - /dashboard/* → GitHub OAuth login + signed-cookie session shell (08 B0)
 */
import { Hono } from "hono";
import type { ExecutionContext, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import type { Env, ScheduledEnv } from "./env";
import { defaultSweepLog, runSweep } from "./sweep";
import { redactSecrets } from "../pipeline/redact";
import type { ReviewJobPayload } from "../contracts/review-job";
import type { PipelineEnv } from "../pipeline/consumer";
import { classifyWebhook, WEBHOOK_BODY_LIMIT, type WebhookOutcome } from "./webhooks";
import { defaultLog, handleReviewJob } from "./handlers";
import { createAppsStore, type DeliveryOutcome } from "../dashboard/apps-store";
import { createSecretbox } from "../dashboard/secretbox";
import { dashboardApp } from "../dashboard/index";
import { trailingSlashRedirect } from "./redirects";
import { spaDispatch } from "./spa-dispatch";

const app = new Hono<{ Bindings: Env }>();
// Plan 29 T3 + plan 30 T4: `/dashboard*` GET/HEAD redirects (trailing
// slash + the `/dashboard/apps` exact alias) then SPA dispatch. Both run
// BEFORE the dashboard membership guard (mounted inside dashboardApp) so
// POST family, OAuth, and APIs still fall through unchanged.
app.use("*", trailingSlashRedirect());
app.use("*", spaDispatch());
/**
 * Classifier outcome → delivery-record outcome (plan 20 QC wave 1, S-2):
 * the pure mapping the per-App route applies immediately after
 * classifyWebhook — reject → rejected / ignore → ignored / job → paused
 * when the App's review switch is off, else ok. Extracted from the inline
 * ternary so a future outcome (e.g. AL-21's `hold`) extends one function
 * instead of every call site; unit-tested in
 * tests/worker/webhook-deliveries.test.ts. `reviewEnabled` is the App
 * row's review_enabled flag (0 = the producer-side pause gate).
 */
export function deliveryOutcomeFromWebhook(
  outcome: { kind: WebhookOutcome["kind"] },
  reviewEnabled: number,
): DeliveryOutcome {
  if (outcome.kind === "reject") return "rejected";
  if (outcome.kind === "ignore") return "ignored";
  return reviewEnabled === 0 ? "paused" : "ok";
}

/**
 * Structured warn for the webhook face's rejection/bookkeeping paths (plan
 * 13 QC F-005; plan 15 log hygiene): the caller passes the real stage label
 * (e.g. `webhook_body_too_large`,
 * `db_binding_missing`, `installation_upsert_failed`) and it rides `event` —
 * never the generic "unknown" — so log consumers can filter these warns by
 * event alone; `reason` keeps the same label for the reason-keyed greps and
 * the three-field structured shape is unchanged.
 */
function webhookWarn(event: string, detail: string, msg: string): void {
  defaultLog.warn({ event, reason: event, detail }, msg);
}

/**
 * Structured INFO twin (AL-23-2): the review_paused line is a legitimate
 * ops state answering 2xx, so it drops from warn to info — same
 * three-field shape, filterable by event, no sampling, no aggregation
 * state.
 */
function webhookInfo(event: string, detail: string, msg: string): void {
  defaultLog.info({ event, reason: event, detail }, msg);
}

app.get("/healthz", (c) => c.json({ ok: true }));
// 08 B0: GitHub OAuth + dashboard shell. Route isolation: the dashboard
// module never imports pipeline/store/review (architect decision Q2).
app.route("/dashboard", dashboardApp);

/**
 * Per-App webhook face (plan 13 Task 2, spec § Multi-App 契约; plan 24
 * Task 1: the ONLY HTTP review entry — the legacy bare `/webhook` face is
 * retired). Pre-order: body-size cap (413) → REVIEW_ENABLED
 * kill-switch (non-"true" → 2xx ignore, zero side effects; deployment-level
 * global switch, not per-App) → DB-unbound guard (500 fail-closed — the
 * dashboard-dependency convention) → slug lookup → signature verify. The
 * slug locates the `github_apps` row (active, not deleted) whose DECRYPTED
 * webhook secret parameterizes the same `classifyWebhook` classifier
 * (secret-parameterized only — the classifier never sees the App
 * identity); the route handler attaches `appRef: { appId }`
 * after classification, before `REVIEW_QUEUE.send` (lock L3).
 * Unknown slug / disabled / soft-deleted → 404, zero enqueue. Any webhook
 * secret decrypt failure (missing DASHBOARD_ENCRYPTION_KEY, tampered
 * envelope) → 500 fail-closed (lock L1); GitHub retries, nothing enqueues.
 *
 * Per-App pause (plan 16, spec 语义锁 B3 — paused ≠ disabled): once the
 * signature VERIFIED (classifyWebhook returned a non-reject),
 * `last_webhook_at` is touched exactly once — after signature verification,
 * regardless of the subsequent enqueue outcome (job / ignore / paused; a
 * queue-send failure below still leaves the touch committed), before the
 * pause check. Reject paths and the pre-verify kill-switch return never
 * touch, so the column reads "last verified delivery" (NOT "last successful
 * enqueue") and is decoupled from the review switch. Then
 * `review_enabled=0` answers 2xx with ZERO enqueue (the webhook stays
 * healthy while reviews are paused); disabled/deleted keep their 404 above.
 * The in-flight queue face ack-skips paused messages symmetrically
 * (consumer lock L4).
 *
 * Install bookkeeping (plan 13 Task 4): a classified job payload always
 * carries `installation_id`, so the accepted path touches
 * `app_installations` (seen_at upsert, lock L1 store). The touch runs AFTER
 * the enqueue — fire-and-forget relative to it, so the review path never
 * waits on bookkeeping — and a bookkeeping failure only logs a structured
 * warn: it never blocks the enqueue nor fails the webhook (best-effort
 * install health, B3 roadmap).
 *
 * Delivery recording (plan 20 Task 1, AL-20-1): immediately after
 * classification (before the reject return) ONE best-effort row is appended
 * to `webhook_deliveries` — every classified outcome lands (rejected /
 * ignored / paused / ok), the pre-classify failures record nothing, and a
 * store failure only logs a structured warn (the response and enqueue are
 * never affected). The retired legacy face recorded nothing (AL-20-1:
 * legacy 不落行 — it was the fallback path with no dashboard consumer).
 */
app.post("/webhook/:appSlug", async (c) => {
  // Body-size cap checked BEFORE buffering the body (B6).
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > WEBHOOK_BODY_LIMIT) {
    webhookWarn(
      "webhook_body_too_large",
      `content_length=${contentLength}`,
      "per-App webhook rejected with 413 — body exceeds size limit",
    );
    return c.text("payload too large", 413);
  }
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? null;
  const eventName = c.req.header("x-github-event") ?? null;

  // Kill-switch BEFORE the slug lookup (spec ordering; zero side effects —
  // no D1 read when reviews are off). The flag is still passed to
  // classifyWebhook below so the handler and classifier share the same
  // computed REVIEW_ENABLED.
  const reviewEnabled = c.env.REVIEW_ENABLED === "true";
  if (!reviewEnabled) {
    webhookWarn(
      "review_disabled",
      "REVIEW_ENABLED is not 'true'",
      "webhook ignored — reviews disabled by the REVIEW_ENABLED kill-switch",
    );
    return c.text("ignored", 200);
  }

  // DB-unbound guard (plan 13 T4 fold): unreachable on the deployed Worker
  // (wrangler.jsonc binds DB globally) — the branch exists because the
  // shared fetch-face Env keeps DB optional for the dashboard's unbound-D1
  // premises. Fail-closed 500, zero enqueue.
  const db = c.env.DB;
  if (db === undefined) {
    webhookWarn(
      "db_binding_missing",
      "env.DB is unbound",
      "per-App webhook rejected with 500 — DB binding missing (fail-closed)",
    );
    return c.text("db binding missing", 500);
  }
  const appsStore = createAppsStore(db);

  // Slug lookup: exactly one active, non-deleted App may serve this route.
  // Unknown / disabled / soft-deleted are all 404 with zero side effects
  // (the log distinguishes them for the operator; the response does not).
  const slug = c.req.param("appSlug");
  const row = await appsStore.getAppBySlug(slug);
  if (row === null) {
    webhookWarn("unknown_app_slug", `slug=${slug}`, "per-App webhook rejected with 404 — unknown app slug");
    return c.text("unknown app slug", 404);
  }
  if (row.deleted_at !== null) {
    webhookWarn("app_deleted", `slug=${slug}`, "per-App webhook rejected with 404 — app is soft-deleted");
    return c.text("unknown app slug", 404);
  }
  if (row.status !== "active") {
    webhookWarn("app_disabled", `slug=${slug}`, "per-App webhook rejected with 404 — app is disabled");
    return c.text("unknown app slug", 404);
  }

  // Decrypt this App's webhook secret (secretbox envelope, AAD pins the
  // row). Fail-closed 500 on any decrypt failure — the signature is never
  // verified against anything but the stored secret, and nothing enqueues.
  let appSecret: string;
  try {
    appSecret = await createSecretbox(c.env.DASHBOARD_ENCRYPTION_KEY).decryptSecret(
      row.webhook_secret_enc,
      `github_apps.webhook_secret_enc:${row.id}`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    webhookWarn(
      "webhook_secret_decrypt_failed",
      detail,
      "per-App webhook rejected with 500 — webhook secret decrypt failed (fail-closed)",
    );
    return c.text("webhook secret decrypt failed", 500);
  }

  // Plan 15 (architect lock L1): the verifier memoizes under the row id as
  // cacheKey — a rotated webhook secret (same id, new envelope → new
  // secret) is rebuilt + REPLACED on the next delivery; entries are
  // structurally bounded (≤ github_apps rows) with no eviction policy.
  const outcome = await classifyWebhook(appSecret, rawBody, signature, eventName, defaultLog, reviewEnabled, row.id);

  // Plan 20 (AL-20-1): best-effort delivery recording — the R2 diagnostics
  // face ("断线看得见"). ONE row per VERIFIED delivery, written immediately
  // after classification (before the reject return) so EVERY classified
  // outcome lands: reject → rejected (status_code = the classifier's
  // status), ignore → ignored, job + review_enabled=0 → paused, job → ok.
  // The pre-classify failures (413 / kill-switch / db-guard / 404 /
  // decrypt 500) never reach this line and record nothing (the retired
  // legacy face recorded nothing by design — AL-20-1: legacy 不落行; app_id
  // is NOT NULL FK). Best-effort like the
  // last_webhook_at touch: a store failure logs a structured warn and never
  // changes the response or the enqueue.
  try {
    await appsStore.recordDelivery({
      appId: row.id,
      eventName,
      outcome: deliveryOutcomeFromWebhook(outcome, row.review_enabled),
      statusCode: outcome.kind === "reject" ? outcome.status : null,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    webhookWarn("delivery_record_failed", detail, "webhook delivery record failed — webhook response unaffected");
  }

  if (outcome.kind === "reject") {
    return c.text(outcome.reason, outcome.status);
  }

  // Plan 16 (L5): the signature VERIFIED (classifyWebhook returned a
  // non-reject), so this delivery is touched — after signature verification,
  // regardless of the subsequent enqueue outcome (job / ignore / paused; a
  // queue-send failure in handleReviewJob below still leaves this touch
  // committed). The reject returns above and the pre-verify kill-switch
  // return never reach this line, so the column reads "last verified
  // delivery", NOT "last successful enqueue". Best-effort (same pattern as
  // the install upsert below): a failure logs a structured warn and never
  // blocks the response.
  try {
    await appsStore.touchLastWebhook(row.id);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    webhookWarn("last_webhook_touch_failed", detail, "last_webhook_at touch failed — webhook response unaffected");
  }

  if (outcome.kind === "ignore") {
    return c.text("ignored", 200);
  }

  // Pause gate (plan 16, spec 语义锁 B3 — paused ≠ disabled): review_enabled
  // =0 answers 2xx with ZERO enqueue — the webhook stays healthy (and
  // touched, above) while reviews are paused. disabled/deleted already
  // returned 404 above; the consumer ack-skips the in-flight messages it
  // can no longer prevent (lock L4).
  if (row.review_enabled === 0) {
    // AL-23-2: warn→info — paused is a legitimate ops state (2xx, zero
    // enqueue), so the line rides the info channel with the same structured
    // fields; no sampling, no aggregation state.
    webhookInfo(
      "review_paused",
      `slug=${slug}`,
      "per-App webhook ignored with 2xx — app review paused (zero enqueue)",
    );
    return c.text("ignored", 200);
  }
  // Lock L3: the App identity is attached at the route handler — after
  // classification, before the queue send. The queue message carries the
  // appId reference only (lock L4: the PEM never leaves the consumer).
  await handleReviewJob({ ...outcome.payload, appRef: { appId: row.id } }, {
    env: c.env,
    log: defaultLog,
  });
  // Install bookkeeping (plan 13 Task 4): the classified job payload always
  // carries installation_id, so touch `app_installations` AFTER the enqueue
  // — fire-and-forget relative to it (the review path never waits on
  // bookkeeping) and best-effort: a failure logs a structured warn and the
  // webhook still returns 200 (never blocks or fails the enqueue). The
  // bare touch passes no account_login — the store's COALESCE preserves the
  // stored login.
  try {
    await appsStore.upsertInstallation({ appId: row.id, installationId: outcome.payload.installation_id });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    webhookWarn("installation_upsert_failed", detail, "installation upsert failed — enqueue unaffected");
  }
  return c.text("accepted", 200);
});

export default {
  fetch: app.fetch,
  // 06 queue wiring — the ONLY legal worker → pipeline edge (compass A).
  // Dynamic import: the consumer statically loads the workerd-only
  // @cloudflare/sandbox SDK, which Bun's test runner cannot resolve — a
  // static import would break the fetch-path tests (platform-specific
  // module exception to the static-import rule).
  async queue(batch: MessageBatch<ReviewJobPayload>, env: Env & PipelineEnv): Promise<void> {
    const { createReviewConsumer } = await import("../pipeline/consumer");
    await createReviewConsumer(env)(batch);
  },
  // 19 T1 cron wiring (AL-6): the trailing-24h `review_failures` sweep. The
  // WHOLE sweep is try/caught — a sweep failure must never throw out of
  // `scheduled` (a throwing cron handler just retries into alert noise). The
  // sweep reads D1 only: no queue/KV mutation from this face (ScheduledEnv
  // deliberately omits those bindings). The handler awaits the sweep
  // directly, so no ctx.waitUntil is needed.
  async scheduled(_controller: ScheduledController, env: ScheduledEnv, _ctx: ExecutionContext): Promise<void> {
    try {
      if (!env.DB) {
        defaultSweepLog.warn(
          { event: "ops_sweep_db_unbound", detail: "DB binding missing — sweep skipped" },
          "ops sweep skipped",
        );
        return;
      }
      await runSweep(env.DB, { alertUrl: env.ALERT_WEBHOOK_URL });
    } catch (error) {
      // SEC-03: the sweep-failure detail is redacted before the warn line —
      // an infra error can interpolate a secret-shaped value
      // (defense-in-depth; clean strings pass through unchanged).
      defaultSweepLog.warn(
        {
          event: "ops_sweep_failed",
          detail: redactSecrets(error instanceof Error ? error.message : String(error)),
        },
        "ops sweep failed",
      );
    }
  },
};

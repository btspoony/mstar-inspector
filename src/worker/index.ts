/**
 * Worker entry — Hono app exported as the module `fetch` handler (no listen).
 * 06 appends the queue wiring here (worker → pipeline, the only legal edge).
 *
 * Routes:
 * - GET /healthz → 200 {"ok":true}
 * - POST /webhook → verified GitHub webhook → classify → enqueue (legacy
 *   env-App face; attaches an explicit `{ kind: "legacy" }` appRef, lock L3)
 * - POST /webhook/:appSlug → per-App webhook face (plan 13 Task 2): slug →
 *   github_apps row (active, not deleted) → that App's decrypted webhook
 *   secret verifies the signature → classify → enqueue with
 *   `{ kind: "app", appId }` (spec § Multi-App 契约, locks L3/L4); the
 *   classified payload's installation_id touches `app_installations`
 *   (fire-and-forget relative to the enqueue, plan 13 Task 4)
 * - /dashboard/* → GitHub OAuth login + signed-cookie session shell (08 B0)
 */
import { Hono } from "hono";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { Env } from "./env";
import type { ReviewJobPayload } from "../contracts/review-job";
import type { PipelineEnv } from "../pipeline/consumer";
import { classifyWebhook, WEBHOOK_BODY_LIMIT } from "./webhooks";
import { defaultLog, handleReviewJob } from "./handlers";
import { createAppsStore } from "../dashboard/apps-store";
import { createSecretbox } from "../dashboard/secretbox";
import { dashboardApp } from "../dashboard/index";

const app = new Hono<{ Bindings: Env }>();

/**
 * Structured warn for the per-App route's rejection/bookkeeping paths (plan
 * 13 QC F-005): the caller passes the real stage label (e.g.
 * `db_binding_missing`, `installation_upsert_failed`) and it rides `event` —
 * never the generic "unknown" — so log consumers can filter these warns by
 * event alone; `reason` keeps the same label for the reason-keyed greps and
 * the three-field structured shape is unchanged.
 */
function webhookWarn(event: string, detail: string, msg: string): void {
  defaultLog.warn({ event, reason: event, detail }, msg);
}

app.get("/healthz", (c) => c.json({ ok: true }));
// 08 B0: GitHub OAuth + dashboard shell. Route isolation: the dashboard
// module never imports pipeline/store/review (architect decision Q2).
app.route("/dashboard", dashboardApp);

app.post("/webhook", async (c) => {
  const secret = c.env.WEBHOOK_SECRET;
  // Body-size cap checked BEFORE buffering the body (B6): an oversized
  // payload is rejected with 413 before any signature work or body read.
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > WEBHOOK_BODY_LIMIT) {
    defaultLog.warn(
      {
        event: "unknown",
        reason: "webhook_body_too_large",
        detail: `content_length=${contentLength}`,
      },
      "webhook rejected with 413 — body exceeds size limit",
    );
    return c.text("payload too large", 413);
  }
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? null;
  const eventName = c.req.header("x-github-event") ?? null;

  // T4 kill-switch: reviews run ONLY when REVIEW_ENABLED is exactly "true"
  // (fail-closed — unset/any other value → every webhook is ignored, 2xx).
  const reviewEnabled = c.env.REVIEW_ENABLED === "true";
  const outcome = await classifyWebhook(secret, rawBody, signature, eventName, defaultLog, reviewEnabled);

  if (outcome.kind === "reject") {
    return c.text(outcome.reason, outcome.status);
  }
  if (outcome.kind === "ignore") {
    return c.text("ignored", 200);
  }
  // Idempotency pre-check (non-null head_sha only) + REVIEW_QUEUE.send.
  // KV failure → conservative pass (enqueue anyway, D1 fallback).
  // Lock L3: the legacy face attaches an EXPLICIT `{ kind: "legacy" }` — no
  // "absent = legacy" dual convention on the producer side.
  await handleReviewJob({ ...outcome.payload, appRef: { kind: "legacy" } }, { env: c.env, log: defaultLog });
  return c.text("accepted", 200);
});

/**
 * Per-App webhook face (plan 13 Task 2, spec § Multi-App 契约). Shared
 * pre-order with the legacy route: body-size cap (413) → REVIEW_ENABLED
 * kill-switch (non-"true" → 2xx ignore, zero side effects; deployment-level
 * global switch, not per-App) → DB-unbound guard (500 fail-closed — the
 * dashboard-dependency convention) → slug lookup → signature verify. The
 * slug locates the `github_apps` row (active, not deleted) whose DECRYPTED
 * webhook secret parameterizes the same `classifyWebhook` classifier
 * (secret-parameterized only — the classifier never sees the App
 * identity); the route handler attaches `appRef { kind: "app", appId }`
 * after classification, before `REVIEW_QUEUE.send` (lock L3).
 * Unknown slug / disabled / soft-deleted → 404, zero enqueue. Any webhook
 * secret decrypt failure (missing DASHBOARD_ENCRYPTION_KEY, tampered
 * envelope) → 500 fail-closed (lock L1); GitHub retries, nothing enqueues.
 *
 * Install bookkeeping (plan 13 Task 4): a classified job payload always
 * carries `installation_id`, so the accepted path touches
 * `app_installations` (seen_at upsert, lock L1 store). The touch runs AFTER
 * the enqueue — fire-and-forget relative to it, so the review path never
 * waits on bookkeeping — and a bookkeeping failure only logs a structured
 * warn: it never blocks the enqueue nor fails the webhook (best-effort
 * install health, B3 roadmap). The legacy face has no app row to attach and
 * deliberately performs NO upsert.
 */
app.post("/webhook/:appSlug", async (c) => {
  // Body-size cap checked BEFORE buffering the body (B6) — same gate as the
  // legacy route.
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
  // classifyWebhook below so both routes share the identical classifier.
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

  const outcome = await classifyWebhook(appSecret, rawBody, signature, eventName, defaultLog, reviewEnabled);

  if (outcome.kind === "reject") {
    return c.text(outcome.reason, outcome.status);
  }
  if (outcome.kind === "ignore") {
    return c.text("ignored", 200);
  }
  // Lock L3: the App identity is attached at the route handler — after
  // classification, before the queue send. The queue message carries the
  // appId reference only (lock L4: the PEM never leaves the consumer).
  await handleReviewJob({ ...outcome.payload, appRef: { kind: "app", appId: row.id } }, {
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
};

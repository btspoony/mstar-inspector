/**
 * Worker entry — Hono app exported as the module `fetch` handler (no listen).
 * 06 appends the queue wiring here (worker → pipeline, the only legal edge);
 * The cron face appends the `scheduled` wiring (worker → store read-only sweep,
 * AL-6 — the sweep statically imports nothing workerd-only, so the Bun test
 * runner keeps importing this module without SDK mocks).
 *
 * Routes:
 * - GET/HEAD /dashboard* trailing slash → 301 (src/worker/redirects.ts)
 * - GET/HEAD enumerated SPA pages with Accept text/html → ASSETS index.html
 * - GET /healthz → 200 {"ok":true,"version":"vX.Y.Z"} (version
 *   from the generated src/version.ts, same shape as the smoke-entry face)
 * - POST /webhook/:workspaceId/:appId → per-App webhook face (the ONLY HTTP review
 *   entry — the legacy bare `/webhook` face is
 *   retired): our webhook path → github_apps row (active, not deleted) → that App's
 *   decrypted webhook secret verifies the signature → classify → enqueue
 *   with `appRef: { appId }` (spec § Multi-App 契约, locks L3/L4); the
 *   classified payload's installation_id touches `app_installations`
 *   (fire-and-forget relative to the enqueue)
 * - /dashboard/* → GitHub OAuth login + signed-cookie session shell (08 B0)
 */
import { Hono } from "hono";
import type { ExecutionContext, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import type { Env, ScheduledEnv } from "./env";
import { defaultSweepLog, runSweep } from "./sweep";
import { reconcileReviewLifecycle } from "./lifecycle-reconcile";
import { reconcileReviewChecks } from "./check-reconcile";
import { redactSecrets } from "../pipeline/redact";
import type { ReviewJobPayload } from "../contracts/review-job";
import type { PipelineEnv } from "../pipeline/consumer";
import {
  classifyWebhook,
  MENTION_MISS_REASON,
  payloadMentionsALogin,
  WEBHOOK_BODY_LIMIT,
  type WebhookOutcome,
} from "./webhooks";
import { defaultLog, handleReviewJob } from "./handlers";
import { createAppsStore, type DeliveryOutcome } from "../dashboard/apps-store";
import { createSecretbox } from "../dashboard/secretbox";
import { dashboardApp, dashboardTenantGate } from "../dashboard/index";
import { adminApp } from "../admin/index";
import { isFlagEnabled } from "../admin/flags";
import { trailingSlashRedirect } from "./redirects";
import { spaDispatch } from "./spa-dispatch";
import { APP_VERSION } from "../version";

const app = new Hono<{ Bindings: Env }>();
// `/dashboard*` GET/HEAD redirects (trailing
// slash), then the tenant route-family gate, then SPA dispatch. The gate runs
// HERE, ahead of SPA dispatch: a retired App path (`/dashboard/apps…`,
// `/dashboard/api/apps…`) must answer 404 even when the SPA shell could serve
// it. Requests the gate passes are unchanged; the dashboard app re-mounts the
// same (idempotent) gate ahead of its own routes so direct mounts keep working.
app.use("*", trailingSlashRedirect());
app.use("/dashboard/*", dashboardTenantGate);
app.use("*", spaDispatch());
/**
 * Classifier outcome → delivery-record outcome (QC wave 1, S-2):
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
 * Structured warn for the webhook face's rejection/bookkeeping paths (QC
 * F-005; log hygiene): the caller passes the real stage label
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

/**
 * Byte-authoritative streamed body read for the webhook cap (61-R1): reads
 * the request stream up to `limit` bytes and UTF-8-decodes exactly those
 * bytes — TextDecoder's default (UTF-8, non-fatal) is the same decode
 * `request.text()` performed, so the returned string is decode-identical for
 * HMAC signature verification. Returns null the moment the accumulated byte
 * count exceeds `limit`: the remainder is never consumed (the stream is
 * cancelled), so a missing, chunked, or lying `content-length` header can
 * never buffer past the cap. `null` → the caller answers 413 with the
 * existing `webhook_body_too_large` warn.
 */
async function readBodyWithinLimit(request: Request, limit: number): Promise<string | null> {
  const stream = request.body;
  if (stream === null) {
    return "";
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// `version` rides the healthz face — additive field, `ok:true`
// contract unchanged; displayed with the `v` prefix (tag-shaped, eyeball-
// reconcilable). Single source = generated src/version.ts.
app.get("/healthz", (c) => c.json({ ok: true, version: `v${APP_VERSION}` }));
// 08 B0: GitHub OAuth + dashboard shell. Route isolation: the dashboard
// module never imports pipeline/store/review (architect decision Q2).
app.route("/dashboard", dashboardApp);

/**
 * Per-App webhook face (spec § Multi-App 契约; the ONLY HTTP review
 * entry — the legacy bare `/webhook` face is
 * retired). Pre-order: body-size cap (413) → DB-unbound guard (500
 * fail-closed — the dashboard-dependency convention) → workspace + app id
 * lookup → signature verify → per-App `review_enabled` pause gate. The two
 * URL segments locate the `github_apps` row (active, not deleted) in THAT
 * workspace, whose DECRYPTED webhook secret parameterizes the same
 * `classifyWebhook` classifier (secret-parameterized only — the classifier
 * never sees the App identity); the route handler attaches
 * `appRef: { appId }` after classification, before `REVIEW_QUEUE.send`
 * (lock L3). Both segments are immutable internal ids (the workspace's
 * `workspaces.id` and the App's `github_apps.id`) — GitHub's mutable App
 * slug is never part of the URL, so a rename cannot break deliveries.
 * Unknown / mismatched pair / disabled / soft-deleted → 404, zero enqueue. Any webhook
 * secret decrypt failure (missing DASHBOARD_ENCRYPTION_KEY, tampered
 * envelope) → 500 fail-closed (lock L1); GitHub retries, nothing enqueues.
 *
 * Per-App pause (spec 语义锁 — paused ≠ disabled): once the
 * signature VERIFIED (classifyWebhook returned a non-reject),
 * `last_webhook_at` is touched exactly once — after signature verification,
 * regardless of the subsequent enqueue outcome (job / ignore / paused; a
 * queue-send failure below still leaves the touch committed), before the
 * pause check. Reject paths never touch, so the column reads "last verified
 * delivery" (NOT "last successful enqueue") and is decoupled from the review
 * switch. Then `review_enabled=0` answers 2xx with ZERO enqueue (the webhook
 * stays healthy while reviews are paused); disabled/deleted keep their 404
 * above. The in-flight queue face ack-skips paused messages symmetrically
 * (consumer lock L4).
 *
 * Install bookkeeping: a classified job payload always
 * carries `installation_id`, so the accepted path touches
 * `app_installations` (seen_at upsert, lock L1 store). The touch runs AFTER
 * the enqueue — fire-and-forget relative to it, so the review path never
 * waits on bookkeeping — and a bookkeeping failure only logs a structured
 * warn: it never blocks the enqueue nor fails the webhook (best-effort
 * install health, B3 roadmap).
 *
 * Delivery recording (AL-20-1): immediately after
 * classification (before the reject return) ONE best-effort row is appended
 * to `webhook_deliveries` — every classified outcome lands (rejected /
 * ignored / paused / ok), the pre-classify failures record nothing, and a
 * store failure only logs a structured warn (the response and enqueue are
 * never affected). The retired legacy face recorded nothing (AL-20-1:
 * legacy 不落行 — it was the fallback path with no dashboard consumer).
 */
app.post("/webhook/:workspaceId/:appId", async (c) => {
  // Body-size cap checked BEFORE buffering the body (B6). Two gates: the
  // truthful over-limit header short-circuits before any byte is read, and
  // the streamed read below is byte-authoritative (61-R1) — a missing,
  // chunked, or lying `content-length` header never bypasses the byte count.
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > WEBHOOK_BODY_LIMIT) {
    webhookWarn(
      "webhook_body_too_large",
      `content_length=${contentLength}`,
      "per-App webhook rejected with 413 — body exceeds size limit",
    );
    return c.text("payload too large", 413);
  }
  const rawBody = await readBodyWithinLimit(c.req.raw, WEBHOOK_BODY_LIMIT);
  if (rawBody === null) {
    webhookWarn(
      "webhook_body_too_large",
      `read_bytes>${WEBHOOK_BODY_LIMIT}`,
      "per-App webhook rejected with 413 — body exceeds size limit",
    );
    return c.text("payload too large", 413);
  }
  const signature = c.req.header("x-hub-signature-256") ?? null;
  const eventName = c.req.header("x-github-event") ?? null;

  // DB-unbound guard (fold-in): unreachable on the deployed Worker
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
  // The webhook path lookup is a tenant-facing `github_apps` read (AC2): the
  // store's one read face joins `app_workspaces`, so an App with no workspace
  // mapping is unknown here too (404 with zero decrypt, zero delivery row and
  // zero enqueue).
  const appsStore = createAppsStore(db);

  // Workspace + App lookup: the pair must name an App that belongs to that
  // workspace. Unknown / mismatched / disabled / soft-deleted are all 404 with
  // zero side effects (the log distinguishes them for the operator; the
  // response does not).
  const workspaceId = c.req.param("workspaceId");
  const appId = c.req.param("appId");
  const webhookRef = `workspace_id=${workspaceId} app_id=${appId}`;
  const row = await appsStore.getAppForWebhook(workspaceId, appId);
  if (row === null) {
    webhookWarn(
      "unknown_webhook_path",
      webhookRef,
      "per-App webhook rejected with 404 — unknown webhook path",
    );
    return c.text("unknown webhook path", 404);
  }
  if (row.deleted_at !== null) {
    webhookWarn("app_deleted", webhookRef, "per-App webhook rejected with 404 — app is soft-deleted");
    return c.text("unknown webhook path", 404);
  }
  if (row.status !== "active") {
    webhookWarn("app_disabled", webhookRef, "per-App webhook rejected with 404 — app is disabled");
    return c.text("unknown webhook path", 404);
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

  // Architect lock L1: the verifier memoizes under the row id as
  // cacheKey — a rotated webhook secret (same id, new envelope → new
  // secret) is rebuilt + REPLACED on the next delivery; entries are
  // structurally bounded (≤ github_apps rows) with no eviction policy.
  // Trigger context (spec review-trigger-policy §2 read path): the
  // already-resolved row's review_trigger_mode gates the pull_request auto
  // face and its GitHub slug keys the issue_comment bot mention — no second
  // lookup, no App identity beyond that. The mention target is GitHub's own
  // slug (`github_slug`), NOT our webhook path: a rename changes the login that
  // can trigger a review. NULL (never synced) collapses to "" and matches
  // nothing — the existing fail-safe.
  const appSlug = row.github_slug ?? "";
  const outcome = await classifyWebhook(
    appSecret,
    rawBody,
    signature,
    eventName,
    defaultLog,
    row.id,
    { mode: row.review_trigger_mode, appSlug },
  );

  // ...which is also why an unsynced row must not fail SILENTLY: with no slug
  // the mention can never match, so a `manual`-mode App (whose only trigger
  // the mention is) just stops reviewing while the delivery reads `ignored`.
  // Two gates keep this warn off every ordinary ignore: the classifier must
  // have reached its mention check and missed (a `created` comment that did not
  // match an empty slug — `edited`, other events and rejects never get here),
  // AND the body must actually carry a login mention. Nothing else changes: the
  // outcome, the delivery row's vocabulary (`ignored`) and the response stay as
  // they were.
  if (
    appSlug === "" &&
    outcome.kind === "ignore" &&
    outcome.reason === MENTION_MISS_REASON &&
    payloadMentionsALogin(rawBody)
  ) {
    webhookWarn(
      "mention_unresolved",
      `${webhookRef} row_id=${row.id}`,
      "per-App webhook ignored an issue_comment mention — github_slug is not synced yet; open the App's settings page to sync it",
    );
  }

  // AL-20-1: best-effort delivery recording — the R2 diagnostics
  // face ("断线看得见"). ONE row per VERIFIED delivery, written immediately
  // after classification (before the reject return) so EVERY classified
  // outcome lands: reject → rejected (status_code = the classifier's
  // status), ignore → ignored, job + review_enabled=0 → paused, job → ok.
  // The pre-classify failures (413 / db-guard / 404 /
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

  // Lock L5: the signature VERIFIED (classifyWebhook returned a
  // non-reject), so this delivery is touched — after signature verification,
  // regardless of the subsequent enqueue outcome (job / ignore / paused; a
  // queue-send failure in handleReviewJob below still leaves this touch
  // committed). The reject returns above never reach this line, so the
  // column reads "last verified delivery", NOT "last successful enqueue".
  // Best-effort (same pattern as the install upsert below): a failure logs a
  // structured warn and never blocks the response.
  try {
    await appsStore.touchLastWebhook(row.id);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    webhookWarn("last_webhook_touch_failed", detail, "last_webhook_at touch failed — webhook response unaffected");
  }

  if (outcome.kind === "ignore") {
    return c.text("ignored", 200);
  }

  // Pause gate (spec 语义锁 — paused ≠ disabled): review_enabled
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
      webhookRef,
      "per-App webhook ignored with 2xx — app review paused (zero enqueue)",
    );
    return c.text("ignored", 200);
  }
  // Global review flag (spec §3.1, compass D21): OFF closes the ENQUEUE face
  // for every App — same contract as the per-App pause above (2xx, zero
  // enqueue) and deliberately NOT a dequeue-side check: work already queued
  // keeps running. Absent flag row = enabled.
  if (!(await isFlagEnabled(db, "review_global"))) {
    webhookInfo(
      "review_global_off",
      webhookRef,
      "per-App webhook ignored with 2xx — review_global flag off (zero enqueue)",
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
  // Install bookkeeping: the classified job payload always
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

/**
 * The `saas` router: `app` plus the hidden operator console.
 *
 * Built here, after every `app` registration — `route()` copies the source
 * app's route table at call time, so a route added to `app` later would be
 * absent from this one. The admin mount belongs to this router only: the
 * module body runs once per isolate while the deployment shape arrives per
 * request, which is why the choice happens in `fetch` instead of a mount
 * condition. A `self-hosted` deployment therefore serves `app`, where
 * `/_internal_admin` is an unknown path (404) for every caller — no runtime
 * mode flag inside a handler.
 */
const saasApp = new Hono<{ Bindings: Env }>()
  .route("/", app)
  .route("/_internal_admin", adminApp);

export default {
  fetch: (request: Request, env: Env, ctx?: ExecutionContext): Response | Promise<Response> =>
    (env.DEPLOYMENT_MODE === "saas" ? saasApp : app).fetch(request, env, ctx),
  // 06 queue wiring — the ONLY legal worker → pipeline edge (compass A).
  // Dynamic import: the consumer statically loads the sandbox adapter, which
  // imports the workerd-only `cloudflare:workers` builtin — Bun's test runner
  // cannot resolve it, so a
  // static import would break the fetch-path tests (platform-specific
  // module exception to the static-import rule).
  async queue(batch: MessageBatch<ReviewJobPayload>, env: Env & PipelineEnv): Promise<void> {
    const { createReviewConsumer } = await import("../pipeline/consumer");
    await createReviewConsumer(env)(batch);
  },
  // Cron wiring (AL-6): the trailing-24h `review_failures` sweep,
  // composed (spec review-lifecycle §7.11) with the M8 recovery
  // reconciler and the M7 Check recovery reconciler — runSweep →
  // reconcileReviewLifecycle → reconcileReviewChecks — each stage caught
  // INDEPENDENTLY so one stage's failure can never break another, and nothing
  // ever throws out of `scheduled` (a throwing cron handler just retries into
  // alert noise). The sweep reads D1 only; the reconcilers additionally read
  // the DASHBOARD_ENCRYPTION_KEY binding to route per-App recovery credentials
  // (§7.6). All three stages are awaited directly, so no ctx.waitUntil is
  // needed.
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
    // M8 recovery reconciler (§7.11) — OWN try/catch AFTER runSweep.
    // reconcileReviewLifecycle is throw-proof by contract; the catch is the
    // composition's independent-failure guarantee (and matches the
    // upcoming stage shape).
    try {
      await reconcileReviewLifecycle(env);
    } catch (error) {
      defaultSweepLog.warn(
        {
          event: "ops_lifecycle_reconcile_failed",
          detail: redactSecrets(error instanceof Error ? error.message : String(error)),
        },
        "lifecycle reconcile failed",
      );
    }
    // M7 Check recovery reconciler (§7.11.2) — the SECOND independent
    // reconciler, in its OWN try/catch AFTER the M8 lane. M8 owns publication
    // proof; this lane only reads what M8 persisted, so ordering is what makes
    // a proven publication visible to the Check conclusion in the same run.
    try {
      await reconcileReviewChecks(env);
    } catch (error) {
      defaultSweepLog.warn(
        {
          event: "ops_check_reconcile_failed",
          detail: redactSecrets(error instanceof Error ? error.message : String(error)),
        },
        "check reconcile failed",
      );
    }
  },
};

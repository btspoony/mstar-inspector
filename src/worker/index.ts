import { Hono } from "hono";
import type { D1Database, ExecutionContext, MessageBatch, ScheduledController, Workflow } from "@cloudflare/workers-types";
import { deploymentModeOf, type DeploymentMode, type Env, type ScheduledEnv } from "./env";
import { defaultSweepLog, runSweep } from "./sweep";
import { reconcileReviewLifecycle } from "./lifecycle-reconcile";
import { reconcileReviewChecks } from "./check-reconcile";
import { reconcileReviewRoute } from "../pipeline/route-reconcile";
import { redactSecrets } from "../pipeline/redact";
import type { ReviewJobPayload } from "../contracts/review-job";
import { QUOTA_SKIP_REASON } from "../contracts/failure-stages";
import type { PipelineEnv } from "../pipeline/consumer";
import type * as ConsumerModule from "../pipeline/consumer";
import type { AttemptRef } from "../pipeline/review-attempt-execution";
import {
  classifyWebhook,
  MENTION_MISS_REASON,
  NO_TARGET_REASON,
  payloadMentionsALogin,
  pullRequestRecord,
  WEBHOOK_BODY_LIMIT,
  webhookRepositoryFullName,
  type WebhookOutcome,
} from "./webhooks";
import { defaultLog, deliveryRefusalReason, handleReviewJob, type DeliveryRefusal } from "./handlers";
import { findCheckAttemptByRunId } from "../store/review-checks";
import {
  createReviewBotsStore,
  type BotScope,
  type DeliveryOutcome,
  type GithubAppTenantRow,
} from "../dashboard/apps-store";
import {
  createTargetsStore,
  checkGateOf,
  getWorkspaceReviewDefaults,
  parseTargetReviewLevel,
  readEffectiveTargetSettings,
  type ReviewTargetRow,
} from "../dashboard/targets-store";
import {
  getMaintenanceMode,
  getReviewRouteWorkflowGate,
  maintenanceClosed,
  readDefaultReviewLevel,
} from "../dashboard/runtime-config-store";
import { checkEntitlement } from "../dashboard/entitlement";
import { quotaMonth, resolveQuotaProfile, rpFor } from "../store/quota-store";
import { sumMonthlyRp } from "../store/usage-store";
import { attachCheckAtAcceptance, createCheckLifecycle } from "../pipeline/checks";
import { createReviewCommenter } from "../pipeline/comment";
import { createSecretbox } from "../dashboard/secretbox";
import { dashboardApp, dashboardMaintenanceGate, dashboardTenantGate } from "../dashboard/index";
import { adminApp } from "../admin/index";
import { isFlagEnabled } from "../admin/flags";
import { trailingSlashRedirect } from "./redirects";
import { spaDispatch } from "./spa-dispatch";
import { APP_VERSION } from "../version";

const app = new Hono<{ Bindings: Env }>();
app.use("*", trailingSlashRedirect());
app.use("/dashboard/*", dashboardTenantGate);
app.use("/dashboard/*", dashboardMaintenanceGate);
app.use("*", spaDispatch());
/**
 * Classifier outcome → delivery-record outcome (QC wave 1, S-2):
 * the pure mapping the per-App route applies immediately after
 * classifyWebhook — reject → rejected / ignore → ignored / job → paused
 * when the App's review switch is off, else ok. An `installation` delivery
 * maps to ignored: it is verified but not a reviewable event — it enqueues
 * nothing, so `ok` ("job enqueued") would overstate it and would also let
 * `DELIVERY_VERDICT_TIER_SQL` rank an install row above a newer ignored
 * delivery. The pause gate must never describe it as paused either.
 * Extracted from the inline
 * ternary so a future outcome (e.g. AL-21's `hold`) extends one function
 * instead of every call site; unit-tested in
 * tests/worker/webhook-deliveries.test.ts. `reviewEnabled` is the delivery's
 * EFFECTIVE pause (0 = the route's `paused` derivation: the bot's operational
 * flag or the target's business flag at 0); `reviewGlobal`
 * is the `review_global` server flag the route reads once per request (false =
 * the global kill switch closed the enqueue face for every App). Either switch
 * off makes a `job` read `paused`: `ok` means "job enqueued", so recording it
 * for a delivery the global flag blocked would overstate the platform exactly
 * as the per-App pause would.
 *
 * `sharedBotRefused` is the third gate: a job both switches admitted and the
 * shared-bot capability then refused reads `skipped`. `ok` would claim a job
 * was enqueued, and `paused` would tell an operator a switch is off while it
 * is on.
 */
export function deliveryOutcomeFromWebhook(
  outcome: { kind: WebhookOutcome["kind"] },
  reviewEnabled: number,
  reviewGlobal: boolean,
  sharedBotRefused = false,
): DeliveryOutcome {
  if (outcome.kind === "reject") return "rejected";
  if (outcome.kind === "ignore") return "ignored";
  if (outcome.kind === "installation" || outcome.kind === "installation_removed") return "ignored";
  // Defensive only: the route rewrites `check_rerun` into a job or an ignore
  // before it consults this function, so this arm is unreachable in the route.
  if (outcome.kind === "check_rerun") return "ignored";
  if (reviewEnabled === 0 || !reviewGlobal) return "paused";
  return sharedBotRefused ? "skipped" : "ok";
}

function webhookWarn(event: string, detail: string, msg: string): void {
  defaultLog.warn({ event, reason: event, detail }, msg);
}

function webhookInfo(event: string, detail: string, msg: string): void {
  defaultLog.info({ event, reason: event, detail }, msg);
}

async function recordInstallation(
  appsStore: ReturnType<typeof createReviewBotsStore>,
  appId: string,
  installationId: number,
  accountLogin: string | null,
  authoritative: boolean,
): Promise<void> {
  try {
    await appsStore.upsertInstallation({ appId, installationId, accountLogin, authoritative });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    webhookWarn(
      "installation_upsert_failed",
      detail,
      "installation upsert failed — webhook response and enqueue unaffected",
    );
  }
}

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

/**
 * How long the delivery path waits for the Check attach before it enqueues
 * (spec §7.9). The attach is one token mint, one create and two D1 writes in
 * the normal case; past this bound the enqueue proceeds and the attach keeps
 * running on the invocation context, where the consumer's bounded takeover of a
 * stalled delivery holder covers the overlap.
 */
export const CHECK_ATTACH_INLINE_BUDGET_MS = 2_500;

async function withinBudget(promise: Promise<unknown>, budgetMs: number): Promise<void> {
  const { promise: budget, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, budgetMs);
  try {
    await Promise.race([promise.then(() => {}), budget]);
  } finally {
    clearTimeout(timer);
  }
}

async function attachCheckOnAcceptance(input: {
  db: D1Database;
  env: Env;
  row: Pick<GithubAppTenantRow, "id" | "github_app_id" | "private_key_enc">;
  payload: Omit<ReviewJobPayload, "botRef" | "targetId">;
  deliveryId: string;
}): Promise<void> {
  const { db, env, row, payload, deliveryId } = input;
  const headSha = payload.head_sha;
  if (headSha === null) return;
  try {
    const pem = await createSecretbox(env.DASHBOARD_ENCRYPTION_KEY).decryptSecret(
      row.private_key_enc,
      `github_apps.private_key_enc:${row.id}`,
    );
    const commenter = createReviewCommenter(
      { APP_ID: String(row.github_app_id), PRIVATE_KEY: pem },
      { db, nowMs: () => Date.now() },
    );
    const adapter = commenter.checks;
    if (adapter === undefined) {
      webhookWarn(
        "check_attach_failed",
        "the App's review-write client exposes no Checks surface",
        "check attach failed — delivery unaffected (best-effort)",
      );
      return;
    }
    const result = await attachCheckAtAcceptance(
      { db, adapter, nowMs: () => Date.now() },
      {
        scope: {
          appId: row.id,
          installationId: payload.installation_id,
          owner: payload.owner,
          repo: payload.repo,
          prNumber: payload.pr_number,
        },
        githubAppId: row.github_app_id,
        headSha,
        triggeredBy: payload.triggered_by,
        action: payload.action,
        deliveryId,
      },
    );
    if (result.kind === "failed") {
      webhookWarn(
        "check_attach_failed",
        redactSecrets(result.reason),
        "check attach failed — delivery unaffected (best-effort)",
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    webhookWarn(
      "check_attach_failed",
      redactSecrets(detail),
      "check attach failed — delivery unaffected (best-effort)",
    );
  }
}

/**
 * The store-only settlement lane a REFUSED delivery uses (spec §7.9): a `null`
 * adapter freezes the skip's conclusion and releases the lease, so the minute
 * reconciler performs the single remote update and the webhook does ZERO
 * credential work.
 *
 * The App's REAL gate is read lazily — only when a settlement actually runs and
 * its head carries a readable result. Judging a head against an ABSENT gate
 * defers the run to a reconciler that only sees publications linked to the
 * attempt (or written after it), so a head whose publication already confirmed
 * and passed would freeze `failure` at the deadline. A gate read that faults
 * still rejects, which defers exactly as before (the transient-I/O case).
 */
export function refusalSkipSettlement(input: { db: D1Database; target: ReviewTargetRow }) {
  return createCheckLifecycle({
    db: input.db,
    nowMs: () => Date.now(),
    getAdapter: () => null,
    getCheckGate: async () => checkGateOf(await readEffectiveTargetSettings(input.db, input.target)),
  });
}

/**
 * Settle the refused delivery's Check AFTER this delivery's attach resolves.
 *
 * The webhook stops waiting at `CHECK_ATTACH_INLINE_BUDGET_MS` and the
 * invocation keeps the attach running; a settlement started inline would race a
 * create that is still in flight and find no settleable row (`review-checks`
 * claims only a row whose create state is `known` and that carries a run id).
 * The row would then be left to the recovery lane, which closes it as a
 * FAILURE instead of the neutral skip a refusal owes. Chaining keeps exactly
 * one settlement, on this delivery's own attach identity, inside the same
 * invocation — the claim condition itself is untouched.
 *
 * Best-effort by contract: an attach is already fully caught by
 * {@link attachCheckOnAcceptance}, and a settlement fault is one structured
 * warn. Nothing here can change the 2xx the route already owes GitHub.
 */
export async function settleRefusedAfterAttach(input: {
  attach: Promise<unknown>;
  settle: () => Promise<unknown>;
  warn: (detail: string) => void;
}): Promise<void> {
  try {
    await input.attach;
  } catch {
  }
  try {
    await input.settle();
  } catch (err) {
    input.warn(err instanceof Error ? err.message : String(err));
  }
}

async function quotaRefusal(
  db: D1Database,
  target: ReviewTargetRow,
  scope: BotScope,
  mode: DeploymentMode,
): Promise<DeliveryRefusal | null> {
  const month = quotaMonth(new Date());
  const profile = await resolveQuotaProfile(db, month.startIso);
  let level = parseTargetReviewLevel(target.review_level);
  if (level === null) level = (await readDefaultReviewLevel(db)).value;
  const cost = rpFor(level, scope === "shared" ? "shared" : "byok", profile);
  const used = await sumMonthlyRp(db, target.workspace_id, month.startIso, month.endIso);

  const verdict = await checkEntitlement({
    db,
    mode,
    workspaceId: target.workspace_id,
    kind: "review-quota",
    monthStart: month.startIso,
    usedRp: used,
    costRp: cost,
  });
  return !verdict.ok && verdict.refusal.kind === "review-quota"
    ? { kind: "quota-exhausted", limit: verdict.refusal.limit, used: verdict.refusal.used, cost: verdict.refusal.cost }
    : null;
}

app.get("/healthz", (c) => c.json({ ok: true, version: `v${APP_VERSION}` }));
app.route("/dashboard", dashboardApp);
app.post("/webhook/:workspaceId/:appId", async (c) => {
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

  const db = c.env.DB;
  if (db === undefined) {
    webhookWarn(
      "db_binding_missing",
      "env.DB is unbound",
      "per-App webhook rejected with 500 — DB binding missing (fail-closed)",
    );
    return c.text("db binding missing", 500);
  }
  const appsStore = createReviewBotsStore(db);

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

  const maintenance = await getMaintenanceMode(db);
  if (maintenanceClosed(maintenance)) {
    webhookWarn(
      "maintenance_skip",
      `${webhookRef} row_id=${row.id}`,
      "per-App webhook answered 503 — the platform is in its maintenance window, so GitHub retries this delivery",
    );
    return c.text("maintenance in progress", 503);
  }

  const targetsStore = createTargetsStore(db);
  const delivery: { target: ReviewTargetRow | null; installationId: number | null } = {
    target: null,
    installationId: null,
  };

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

  const appSlug = row.github_slug ?? "";
  let classified: unknown = null;
  let outcome = await classifyWebhook(
    appSecret,
    rawBody,
    signature,
    eventName,
    defaultLog,
    row.id,
    async ({ installationId, repository }) => {
      delivery.installationId = installationId;
      const repo = repository!;
      delivery.target = await targetsStore.resolveByRepo(row.id, repo);
      const target = delivery.target;
      if (target === null) return null;
      const mode =
        target.follow_workspace_defaults === 1
          ? (await getWorkspaceReviewDefaults(db, target.workspace_id)).triggerMode
          : target.review_trigger_mode;
      return { mode, appSlug, reviewDrafts: target.review_drafts !== 0, githubAppId: row.github_app_id };
    },
    (parsed) => {
      classified = parsed;
    },
  );

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

  if (outcome.kind === "check_rerun") {
    const rerun = outcome;
    // The attempt row — not the payload — is the authoritative PR identity
    // (a fork PR's delivery carries an empty pull_requests list), and the
    // (github_app_id, check_run_id) pair is the only "this App owns that
    // run" proof. A miss means the run was never ours: ignore with 200.
    const attempt = await findCheckAttemptByRunId(db, row.github_app_id, rerun.checkRunId).catch((err: unknown) => {
      webhookWarn(
        "check_rerun_lookup_failed",
        `${webhookRef} row_id=${row.id} check_run_id=${rerun.checkRunId} detail=${err instanceof Error ? err.message : String(err)}`,
        "per-App webhook could not resolve the rerequested check run — answering ignored (fail-closed)",
      );
      return null;
    });
    if (attempt === null) {
      webhookWarn(
        "check_rerun_no_attempt",
        `${webhookRef} row_id=${row.id} check_run_id=${rerun.checkRunId}`,
        "per-App webhook ignored a rerequested check run — no review check names it (foreign or pre-Checks run)",
      );
      outcome = { kind: "ignore", reason: "no review check for this check run" };
    } else {
      outcome = {
        kind: "job",
        payload: {
          installation_id: attempt.installationId,
          owner: attempt.owner,
          repo: attempt.repo,
          pr_number: attempt.prNumber,
          head_sha: attempt.headSha,
          action: "rerequested",
          triggered_by: "check_run",
          rerun_check_run_id: rerun.checkRunId,
        },
        installationAccount: rerun.installationAccount,
        accountAuthoritative: false,
      };
    }
  }

  const target = delivery.target;
  if (outcome.kind === "ignore" && outcome.reason === NO_TARGET_REASON) {
    webhookWarn(
      "no_target_for_repo",
      `${webhookRef} row_id=${row.id} installation_id=${delivery.installationId ?? "unknown"}`,
      "per-App webhook ignored with 200 — no review target resolves for this delivery (zero enqueue, no ledger row)",
    );
  }
  const paused = target !== null && (row.review_enabled === 0 || target.review_enabled === 0);

  let reviewGlobal = true;
  if (outcome.kind === "job" && !paused) {
    try {
      reviewGlobal = await isFlagEnabled(db, "review_global");
    } catch (err) {
      reviewGlobal = false;
      const detail = err instanceof Error ? err.message : String(err);
      webhookWarn(
        "review_global_read_failed",
        detail,
        "review_global flag read failed — treating reviews as disabled (fail-closed); webhook response and bookkeeping unaffected",
      );
    }
  }
  if (outcome.kind === "job") {
    const routeGate = await getReviewRouteWorkflowGate(db);
    if (routeGate.mode !== "on") {
      const line = JSON.stringify({
        event: "review_route_gate_closed",
        review_route_workflow: "off",
        gate_saved: routeGate.saved,
        gate_degraded: routeGate.degraded,
        gate_reason: routeGate.reason ?? null,
        gate_rejected: routeGate.rejected ?? null,
        installation_id: outcome.payload.installation_id,
        owner: outcome.payload.owner,
        repo: outcome.payload.repo,
        pr_number: outcome.payload.pr_number,
        head_sha: outcome.payload.head_sha,
        msg: "review route is off (review.route.workflow) — delivery refused at acceptance: no Check attached, nothing enqueued",
      });
      if (routeGate.degraded) console.warn(line);
      else console.log(line);
      return c.text("ignored", 200);
    }
  }
  const mode = deploymentModeOf(c.env.DEPLOYMENT_MODE);
  let refusal: DeliveryRefusal | null = null;
  if (outcome.kind === "job" && target !== null && !paused && reviewGlobal) {
    try {
      if (row.scope === "shared") {
        const verdict = await checkEntitlement({
          db,
          mode,
          workspaceId: target.workspace_id,
          kind: "shared-bot",
          botScope: "shared",
        });
        if (!verdict.ok && verdict.refusal.kind === "shared-bot") {
          refusal = { kind: "shared-bot-not-included", planId: verdict.refusal.planId };
        }
      }
      if (refusal === null && mode !== "self-hosted") {
        refusal = await quotaRefusal(db, target, row.scope, mode);
      }
    } catch (err) {
      refusal = { kind: "entitlement-unreadable" };
      webhookWarn(
        "entitlement_gate_failed",
        redactSecrets(err instanceof Error ? err.message : String(err)),
        "entitlement gate could not answer — refusing the delivery (fail-closed), webhook answers 200",
      );
    }
  }
  try {
    await appsStore.recordDelivery({
      appId: row.id,
      eventName,
      outcome: deliveryOutcomeFromWebhook(outcome, paused ? 0 : 1, reviewGlobal, refusal !== null),
      statusCode: outcome.kind === "reject" ? outcome.status : null,
      repositoryFullName: webhookRepositoryFullName(classified),
      reason: outcome.kind === "reject" ? outcome.reason : null,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    webhookWarn("delivery_record_failed", detail, "webhook delivery record failed — webhook response unaffected");
  }

  if (outcome.kind === "reject") {
    return c.text(outcome.reason, outcome.status);
  }

  if (eventName === "pull_request" && target !== null) {
    const record = pullRequestRecord(classified);
    if (record === null) {
      webhookWarn(
        "pull_request_record_skipped",
        `${webhookRef} row_id=${row.id}`,
        "pull_request not recorded — payload carried no owner/repo/number/state",
      );
    } else {
      try {
        await appsStore.upsertPullRequest({ appId: row.id, targetId: target.id, ...record });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        webhookWarn("pull_request_record_failed", detail, "pull_request record failed — webhook response unaffected");
      }
    }
  }

  try {
    await appsStore.touchLastWebhook(row.id);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    webhookWarn("last_webhook_touch_failed", detail, "last_webhook_at touch failed — webhook response unaffected");
  }

  if (outcome.kind === "ignore") {
    return c.text("ignored", 200);
  }

  if (outcome.kind === "job") {
    await recordInstallation(
      appsStore,
      row.id,
      outcome.payload.installation_id,
      outcome.installationAccount,
      outcome.accountAuthoritative,
    );
  }

  if (outcome.kind === "installation") {
    await recordInstallation(
      appsStore,
      row.id,
      outcome.installationId,
      outcome.accountLogin,
      outcome.accountAuthoritative,
    );
    return c.text("accepted", 200);
  }

  if (outcome.kind === "installation_removed") {
    try {
      await appsStore.markInstallationRemoved(row.id, outcome.installationId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      webhookWarn(
        "installation_remove_failed",
        detail,
        "installation removal stamp failed — webhook response and enqueue unaffected",
      );
    }
    return c.text("accepted", 200);
  }

  if (paused) {
    webhookInfo(
      "review_paused",
      webhookRef,
      "per-App webhook ignored with 2xx — app review paused (zero enqueue)",
    );
    return c.text("ignored", 200);
  }
  if (!reviewGlobal) {
    webhookInfo(
      "review_global_off",
      webhookRef,
      "per-App webhook ignored with 2xx — review_global flag off (zero enqueue)",
    );
    return c.text("ignored", 200);
  }
  const skipSettlement = refusalSkipSettlement({ db, target: target! });
  await handleReviewJob({ ...outcome.payload, botRef: { appId: row.id }, targetId: target!.id }, {
    env: { IDEMPOTENCY_KV: c.env.IDEMPOTENCY_KV, REVIEW_QUEUE: c.env.REVIEW_QUEUE, DB: db },
    log: defaultLog,
    beforeEnqueue: async (payload) => {
      const attachDeliveryId = crypto.randomUUID();
      const attach = attachCheckOnAcceptance({ db, env: c.env, row, payload, deliveryId: attachDeliveryId });
      const headSha = payload.head_sha;
      const work =
        refusal === null || headSha === null
          ? attach
          : settleRefusedAfterAttach({
              attach,
              settle: () =>
                skipSettlement.settleSkipped({
                  scope: {
                    appId: row.id,
                    installationId: payload.installation_id,
                    owner: payload.owner,
                    repo: payload.repo,
                    prNumber: payload.pr_number,
                  },
                  headSha,
                  triggeredBy: payload.triggered_by,
                  action: payload.action,
                  attachDeliveryId,
                  reason: deliveryRefusalReason(refusal),
                }),
              warn: (detail) =>
                webhookWarn(
                  "check_skip_settle_failed",
                  redactSecrets(detail),
                  "check skip settlement failed — the run is left to the reconciler",
                ),
            });
      try {
        c.executionCtx.waitUntil(work);
      } catch {
        void work;
      }
      await withinBudget(attach, CHECK_ATTACH_INLINE_BUDGET_MS);
      return { ...payload, attachDeliveryId };
    },
  }, refusal);
  return c.text("accepted", 200);
});

const saasApp = new Hono<{ Bindings: Env }>()
  .route("/", app)
  .route("/_internal_admin", adminApp);

/**
 * The Check lane's own cron expression (spec §7.11.2): every minute. It runs
 * `reconcileReviewChecks` alone — the sweep and the publication reconciler
 * stay on their fifteen-minute cadence.
 */
export const CHECK_RECOVERY_CRON = "* * * * *";

async function runCheckReconcileStage(env: ScheduledEnv): Promise<void> {
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
}

type ReviewQueueEnv = Env & PipelineEnv & { REVIEW_WORKFLOW?: Workflow<AttemptRef> };

type ReviewQueueConsumerModule = Pick<
  typeof ConsumerModule,
  "createReviewConsumer" | "createWorkflowInstance"
>;

/**
 * ONE queue batch, end to end: the deployment gate, then the consumer through
 * the Workflow starter.
 *
 * The consumer is a LOADER parameter (defaulting to the dynamic import) so a
 * test can drive this wiring with a fake module instead of stubbing
 * `src/pipeline/consumer` process-wide — `mock.module` cannot be undone in Bun
 * (measured: neither `mock.restore()` nor re-mocking restores the real one), so
 * a stub here would leak into every later file that imports the consumer.
 */
export async function runReviewQueueBatch(
  batch: MessageBatch<ReviewJobPayload>,
  env: ReviewQueueEnv,
  ctx: ExecutionContext,
  loadConsumer: () => Promise<ReviewQueueConsumerModule> = () => import("../pipeline/consumer"),
): Promise<void> {
  const gate = await getReviewRouteWorkflowGate(env.DB);
  if (gate.mode !== "on") {
    const line = JSON.stringify({
      event: "review_route_gate_closed",
      review_route_workflow: "off",
      gate_saved: gate.saved,
      gate_degraded: gate.degraded,
      gate_reason: gate.reason ?? null,
      gate_rejected: gate.rejected ?? null,
      batch_messages: batch.messages.length,
      msg: "review route is off (review.route.workflow) — the batch was acknowledged and no Workflow instance was created",
    });
    if (gate.degraded) console.warn(line);
    else console.log(line);
    return;
  }
  const workflow = env.REVIEW_WORKFLOW;
  if (workflow === undefined) {
    throw new Error("REVIEW_WORKFLOW binding is not configured — the review route cannot create an attempt");
  }
  const { createReviewConsumer, createWorkflowInstance } = await loadConsumer();
  await createReviewConsumer(
    env,
    undefined,
    {},
    { waitUntil: (promise) => ctx.waitUntil(promise) },
    (_deps, ref) => createWorkflowInstance(workflow, ref),
  )(batch);
}

export default {
  fetch: (request: Request, env: Env, ctx?: ExecutionContext): Response | Promise<Response> =>
    (env.DEPLOYMENT_MODE === "saas" ? saasApp : app).fetch(request, env, ctx),
  async queue(batch: MessageBatch<ReviewJobPayload>, env: ReviewQueueEnv, ctx: ExecutionContext): Promise<void> {
    await runReviewQueueBatch(batch, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: ScheduledEnv, _ctx: ExecutionContext): Promise<void> {
    if (env.DB) {
      const maintenance = await getMaintenanceMode(env.DB);
      if (maintenanceClosed(maintenance)) {
        defaultSweepLog.warn(
          { event: "maintenance_skip", detail: `cron=${controller.cron}` },
          "cron invocation skipped — the platform is in its maintenance window",
        );
        return;
      }
    }
    if (controller.cron === CHECK_RECOVERY_CRON) {
      await runCheckReconcileStage(env);
      return;
    }
    const db = env.DB;
    if (db === undefined) {
      defaultSweepLog.warn(
        { event: "ops_sweep_db_unbound", detail: "DB binding missing — sweep skipped" },
        "ops sweep skipped",
      );
      return;
    }
    try {
      await runSweep(db, { alertUrl: env.ALERT_WEBHOOK_URL, queue: env.REVIEW_QUEUE });
    } catch (error) {
      defaultSweepLog.warn(
        {
          event: "ops_sweep_failed",
          detail: redactSecrets(error instanceof Error ? error.message : String(error)),
        },
        "ops sweep failed",
      );
    }
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
    try {
      const routeKv = (env as Env).IDEMPOTENCY_KV;
      await reconcileReviewRoute({
        DB: db,
        REVIEW_QUEUE: env.REVIEW_QUEUE,
        IDEMPOTENCY_KV: routeKv,
        // The pass owns the refused round's accounting replay, including its log line.
        log: defaultSweepLog,
      });
    } catch (error) {
      defaultSweepLog.warn(
        {
          event: "ops_route_reconcile_failed",
          detail: redactSecrets(error instanceof Error ? error.message : String(error)),
        },
        "route handoff reconcile failed",
      );
    }
  },
};

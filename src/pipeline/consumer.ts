/**
 * note: Queue consumer — the review pipeline main flow.
 *
 * Flow (compass S7): message → resolve the App's sandbox
 * image (the stored review_bots.sandbox_image_id through the closed
 * registry — unknown/disabled ids fail closed BEFORE the guard/sandbox) →
 * dedup the delivery's OWN head (payload sha or PR watermark; reviewed or
 * already published → ack with no Check claim and no container) → getSandbox
 * (unique id per attempt) →
 * clone the PR head branch (git
 * transport auth via scoped extraheader env) → `git rev-parse HEAD` for the
 * AUTHORITATIVE sha →
 * dedup by that sha (hit → ack) → diff → numstat (the seat-partition
 * universe) → write the runner `--input` JSON (reconFacts, plus the per-App
 * `modelOverrides` role map; no-map App = byte-identical
 * payload) → exec the
 * in-image runner `--level <quick|default|deep>` (exec env =
 * provider credential pools + PI_CODING_AGENT_DIR/HARNESS_PLUGIN_ROOT +
 * OMP_REVIEW_MODEL; all key material and the model chain come ONLY from
 * the App's own per-App config (AL-24-5 zero global fallback: an App missing
 * its model chain or a chain provider's key fails closed after App
 * resolution via the F-001 channel — review failed log + review_failures
 * row + rethrow → retry×3 → DLQ); GH_TOKEN rides ONLY the git/gh step
 * envs) → parse
 * the mstar.review/v1 envelope → (spec §7.7 FROZEN ORDER) dedup +
 * publication-journal handoff read BEFORE model work → pending confirmed
 * lifecycle apply + targets/evidence/discussion capture → optional fenced
 * Check claim (the §7.10 seam; absent `checks` dep = no Checks, M8 fully
 * operational) → runner + concurrent bounded recheck → validation +
 * conservative §7.4 reconciliation + §7.10 closure + final body →
 * STAGE the complete private payload BEFORE any GitHub mutation →
 * epoch-fenced claim + proof-based publication (proof persisted before KV
 * done) → proof-gated store.put + ONE idempotent lifecycle batch →
 * intent-prepared line comments + id capture → resolution LAST (verified
 * snapshots enqueued before the single inline discover+resolve attempt) →
 * proof-read Check terminalize → finally destroy. Any step throwing →
 * structured log
 * + a best-effort review_failures row (stage classified from the phase in
 * flight; AL-6 — DLQ-bound infra failures otherwise leave
 * zero D1 trace) + rethrow (queue retry → DLQ). The runtime runner has NO
 * summary-degrade path: exit 0 means stdout is the engine-validated
 * envelope; a non-zero exit keeps the no-post/no-insert rethrow. A
 * parse/validate failure takes the DEGRADE path instead (AL-1, now routed
 * through the §7.7 journal as a `degraded` publication):
 * review_failures row (stage=parse) + staged→sent degraded comment (both
 * best-effort) + ack — parseReviewOutput is a pure function of
 * run.stdout, so retry is deterministic waste. No reviews row and NO KV
 * done-state on degrade; a later trigger for the same sha re-runs the
 * review UNLESS the §7.7 step-2 journal read finds a non-terminal row for
 * that scope/SHA (which hands off to recovery and acks — the applied
 * degraded publication is terminal and never blocks a legitimate re-run).
 * Three typed outcomes never throw: the in-flight
 * guard (bugbot BB-3) — guard-held schedules a per-message delayed retry
 * (60s/120s/240s) and finally acks with a warning instead of DLQing — a
 * PAUSED App's message (review_enabled=0), which acks
 * immediately with ZERO side effects (no guard, no sandbox, no token
 * mint, no app-config read, no GitHub write, no retry, no DLQ) — and the
 * parse-fail degrade.
 *
 * Sha consistency (bugbot A2): every downstream use — idempotency key, D1
 * row, posted commit_id, KV completion — is keyed off the sha read back
 * from the checked-out HEAD, never the webhook payload sha (which only
 * feeds the pre-enqueue KV fast path in the worker). The diff, the clone
 * files and the commit_id therefore always describe the same commit; a
 * force-push between webhook delivery and processing is captured by the
 * rev-parse instead of drifting silently. The ONE pre-sandbox read (step 4)
 * consults the delivery's OWN head — the payload sha, or the PR watermark a
 * mention carries — and only short-circuits a head this lane already
 * reviewed AND that is still the PR's live head: that duplicate creates no
 * Check attempt and no container. A hit is verified against the ledger
 * watermark before it acks, so a delivery whose keyed head has since moved
 * falls through and reviews the live head — in `manual` mode a push queues
 * nothing, so this delivery is that commit's only chance. An unreadable
 * watermark keeps the ack with one warning (it must never become a second
 * paid review), and the read runs only on a hit. It is a fast path, not the
 * dedup authority: the checkout-keyed read below still decides what the live
 * clone holds — so a force-push after delivery is caught there, and the
 * clone's head is claimed only on a dedup AND journal miss. An
 * already-published head is as final as an already-reviewed one — a live
 * journal row hands off to recovery with no claim and no paid work — but
 * only while that journal row is keyed on the live head.
 *
 * Module boundary (compass contracts A): this is the ONLY legal edge from
 * worker → pipeline (worker/index.ts queue wiring). It imports contracts/
 * (payload + idempotency key), review/schema (pure zod) + packages/shared/src/runtime
 * (pure port types/constants — dual-face, zero omp SDK),
 * store/artifact-store (07 D1 ArtifactStore) + store/failure-store (the
 * review_failures leaf), and the pipeline modules —
 * never src/worker/**.
 */

import type { Message, MessageBatch, Workflow } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../contracts/review-job";
import {
  clearCommentClaimPayload,
  closeCommentClaim,
  deliveryKeyOf,
  guardDropDedupeKeyOf,
  markAttemptHandoff,
  readAttemptHandoff,
  recordGuardDropIntent,
  reserveAttemptHandoff,
} from "../store/review-route-store";
import {
  classifyGithubRateLimit,
  GITHUB_RATE_LIMIT_PREFIX,
  MAINTENANCE_DEFERRED_STAGE,
} from "../contracts/failure-stages";
import { FAILURE_SUMMARIES, type FailureCode } from "../contracts/failure-codes";
import {
  idemKey,
  kvClaimKey,
  rerunIdemKey,
  IDEMPOTENCY_SECONDS,
  IDEM_DROPPED,
  IDEM_FAILED,
  IDEM_PAUSED,
  IDEM_SUPERSEDED,
  isReviewClaim,
  putAbandonClaim,
  type IdempotencyKey,
} from "../contracts/idem";
import type { ReviewLevel } from "../../packages/shared/src/runtime";
import { providerEnvName } from "./provider-catalog";
import { redactExactSecrets, redactSecrets } from "./redact";
import { createArtifactStore } from "../store/artifact-store";
import { createFailureStore, QUEUE_MAX_ATTEMPTS } from "../store/failure-store";
import { type PublicationRow } from "../store/finding-lifecycle";
import { rerunCheckRunIdOfAttemptKey } from "../store/review-checks";
import { type Scope } from "../../packages/shared/src/recheck-wire";
import type { D1Like } from "../store/types";
import { getSandbox, type ReviewSandbox } from "./sandbox";
import {
  attemptSandboxId,
  claimUnactivatedAttempt,
  markAttemptRevoked,
  readAttemptActivation,
  type RunnerAppConfig,
} from "./review-attempt";
import {
  createReviewCommenter,
  type ReviewCommenter,
} from "./comment";
import { createReviewBotsStore, type BotScope } from "../dashboard/apps-store";
import {
  checkGateOf,
  createTargetsStore,
  readEffectiveTargetSettings,
  type ReviewTargetRow,
} from "../dashboard/targets-store";
import { createSecretbox } from "../dashboard/secretbox";
import {
  getMaintenanceMode,
  maintenanceClosed,
  readDefaultReviewLevel,
} from "../dashboard/runtime-config-store";
import {
  createAppConfigStore,
  type CustomProviderConsumerConfig,
} from "../dashboard/app-config-store";
import { getSandboxImage, type SandboxImageDefinition } from "../contracts/sandbox-images";
import { createCheckLifecycle } from "./checks";
import {
  acquireInflight,
  describeInflightError,
  extendInflightTtl,
  releaseInflight,
  type AcquireInflightOptions,
  type InflightKey,
} from "../store/inflight-store";
import { readReviewConcurrency } from "./concurrency-reader";
import {
  CHECK_UPDATE_DEFAULT,
  readCheckBudgets,
  type CheckBudgets,
} from "./check-budgets-reader";
import {
  readReviewAttemptCapMs,
  reviewGuardTtlForDeadline,
  runnerTimeoutMs,
} from "../review-budget";
import {
  boundedBestEffort,
  findIncrementBase,
  journalHandoffRow,
  kvDoneHit,
  payloadIdentityFields,
  settleSkippedRow,
  toBaseFields,
  type AdmissionRefusalFields,
  type AttemptRef,
  type CheckBackgroundSink,
  type ConsumerLog,
  type ConsumerLogFields,
  type PipelineEnv,
  type ProcessDeps,
  type ProcessOutcome,
  type RunnerConfig,
} from "./review-attempt-execution";

export {
  BIND_UNBOUND_THREADS_MAX_ENTRIES,
  INLINE_RESOLVE_ENTRY_MS,
  INLINE_RESOLVE_MAX_ENTRIES,
  PR_CONTEXT_EXEC_TIMEOUT_MS,
  PR_CONTEXT_WORST_CASE_MS,
  bindUnboundThreads,
  extractIssueRefs,
} from "./review-attempt-execution";
export type {
  AdmissionRefusalFields,
  CheckBackgroundSink,
  CheckHandle,
  CheckLifecycleHooks,
  ConsumerLog,
  ConsumerLogFields,
  PipelineEnv,
  ProcessDeps,
  ProcessOutcome,
} from "./review-attempt-execution";


/**
 * Total deliveries a message gets before the queue DLQs it: wrangler.jsonc's
 * `queues.consumers[].max_retries` is 5, so 1 initial delivery + 5 retries —
 * one per guard rung (`guardRetryDelaysSeconds`) plus the delivery that acks.
 * The FINAL delivery stamps its idempotency key `failed` (processMessage's
 * catch) because that commit was never reviewed.
 *
 * Exported so the coupling is ASSERTED, not just commented:
 * `tests/pipeline/queue-config-contract.test.ts` reads wrangler.jsonc and
 * fails when the two numbers drift.
 */
export { QUEUE_MAX_ATTEMPTS } from "../store/failure-store";




/** Default sink: structured JSON lines on stdout/stderr. No secrets logged. */
export const defaultConsumerLog: ConsumerLog = {
  info: (fields, msg) => console.log(JSON.stringify({ ...fields, msg: msg ?? "" })),
  warn: (fields, msg) => console.warn(JSON.stringify({ ...fields, msg: msg ?? "" })),
  error: (fields, msg) => console.error(JSON.stringify({ ...fields, msg: msg ?? "" })),
};



const GUARD_RETRY_DELAYS_SECONDS: Record<ReviewLevel, readonly number[]> = {
  quick: [60, 300, 300, 900, 900],
  default: [60, 300, 300, 900, 900],
  deep: [90, 480, 300, 900, 900],
};

/** Guard-held backoff schedule for the job's review level (spec d5-budget L4). */
export function guardRetryDelaysSeconds(level: ReviewLevel): readonly number[] {
  return GUARD_RETRY_DELAYS_SECONDS[level];
}




async function markQueuedBehindInflightRow(
  deps: ProcessDeps,
  payload: ReviewJobPayload,
  heldHeadSha: string | null | undefined,
): Promise<void> {
  if (deps.checks?.markQueuedBehindInflight === undefined) return;
  const attachedHeadSha = payload.head_sha;
  if (attachedHeadSha === null || attachedHeadSha === undefined || attachedHeadSha === "") return;
  if (heldHeadSha === null || heldHeadSha === undefined || heldHeadSha === "") return;
  const warn = (detail: string) =>
    deps.log.warn({ ...payloadIdentityFields(payload), event: "check_queued_relabel_failed" }, detail);
  try {
    const read = await boundedBestEffort(
      readCheckBudgets(deps.env.DB, {
        warn: (readerFields, msg) => deps.log.warn({ ...payloadIdentityFields(payload), ...readerFields }, msg),
      }),
      CHECK_UPDATE_DEFAULT,
    );
    if (read === null) {
      warn(
        `held check relabel skipped: the check-budget read exceeded ${CHECK_UPDATE_DEFAULT}ms (the delayed retry is unaffected)`,
      );
      return;
    }
    const budgets = read.value;
    const relabeled = await boundedBestEffort(
      deps.checks.markQueuedBehindInflight({
        scope: {
          appId: payload.botRef.appId,
          installationId: payload.installation_id,
          owner: payload.owner,
          repo: payload.repo,
          prNumber: payload.pr_number,
        },
        headSha: attachedHeadSha,
        triggeredBy: payload.triggered_by,
        action: payload.action,
        rerunCheckRunId: payload.rerun_check_run_id,
        attachDeliveryId: payload.attachDeliveryId,
        summary: `Queued — the review in flight for this pull request (head ${heldHeadSha.slice(0, 7)}) holds the slot; this commit starts when it finishes.`,
        updateBudgetMs: budgets.updateMs,
        warn,
      }),
      budgets.updateMs,
    );
    if (relabeled === null) {
      warn(
        `held check relabel skipped: the store write or the Check update exceeded ${budgets.updateMs}ms (the delayed retry is unaffected)`,
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(
      { ...payloadIdentityFields(payload), event: "check_queued_relabel_failed" },
      `held check relabel failed (the run stays as it was; the retry is unaffected): ${detail}`,
    );
  }
}

async function handleGuardHeld(
  message: Message<ReviewJobPayload>,
  deps: ProcessDeps,
  admission: AdmissionRefusalFields,
  heldHeadSha: string | null,
  level: ReviewLevel,
  commentClaimConsumed: boolean,
): Promise<void> {
  const fields = { ...toBaseFields(message.body), ...admission };
  const cause = admission.error_cause === undefined ? "" : `; cause ${admission.error_cause}`;
  const heldBecause = `held by ${admission.reason} (system_cap ${admission.system_cap}, workspace_cap ${admission.workspace_cap}${cause})`;
  const what = admission.reason === "pr-held" ? "review already in flight" : "review not admitted";
  const delays = guardRetryDelaysSeconds(level);
  const delaySeconds = delays[message.attempts - 1];
  let restoreFailure: string | null = null;
  const restoreClaimForRetry = async (queuedMs: number): Promise<"none" | "restored" | "failed"> => {
    if (!commentClaimConsumed || message.body.comment_id === undefined) return "none";
    const payload = message.body;
    try {
      await deps.env.DB.prepare(
        `UPDATE comment_trigger_claims
            SET state = 'queued', payload_json = ?, consumed_ms = NULL, queued_ms = ?
          WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND comment_id = ?
            AND state = 'consumed'`,
      )
        .bind(
          JSON.stringify(payload),
          queuedMs,
          payload.installation_id,
          payload.owner,
          payload.repo,
          payload.pr_number,
          payload.comment_id,
        )
        .run();
      return "restored";
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(fields, `comment claim restore failed: ${detail}`);
      return "failed";
    }
  };
  if (delaySeconds !== undefined) {
    const claim = await restoreClaimForRetry(Date.now() + delaySeconds * 1000);
    if (claim !== "failed") {
      if (admission.reason === "pr-held") {
        await markQueuedBehindInflightRow(deps, message.body, heldHeadSha);
      }
      deps.log.info(
        fields,
        `${what} — scheduling delayed retry in ${delaySeconds}s (attempt ${message.attempts}; ${heldBecause})`,
      );
      message.retry({ delaySeconds });
      return;
    }
    restoreFailure = "comment claim restore failed";
  }
  deps.log.warn(
    fields,
    restoreFailure !== null
      ? `review dropped: ${restoreFailure} (attempt ${message.attempts}; ${heldBecause}) — acking, no DLQ`
      : `${what} after ${delays.length} delayed retries (attempt ${message.attempts}; ${heldBecause}) — acking, no DLQ (guard-held is not an error; the next event for the PR re-reviews)`,
  );
  const payloadSha = message.body.head_sha;
  const heldSha = heldHeadSha ?? "";
  if (
    restoreFailure === null &&
    admission.reason === "pr-held" &&
    (payloadSha === null || payloadSha === "" || heldSha === "" || payloadSha === heldSha)
  ) {
    if (commentClaimConsumed) {
      await clearCommentClaimPayload(deps.env.DB, message.body).catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(fields, `benign duplicate: comment claim payload clear failed: ${detail}`);
      });
    }
    message.ack();
    return;
  }
  try {
    await recordGuardDropIntent(deps.env.DB, {
      dedupeKey: guardDropDedupeKeyOf(message.body),
      payload: message.body,
      nowMs: Date.now(),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(fields, `dropped delivery could not be recorded as owed — refusing to ack: ${detail}`);
    throw err;
  }
  if ((await restoreClaimForRetry(Date.now())) === "failed") {
    throw new Error(
      `review dropped for ${message.body.owner}/${message.body.repo}#${message.body.pr_number} but its comment claim could not be handed back — refusing to ack, the recovery pass owns the retained payload`,
    );
  }
  message.ack();
  const headSha = payloadSha ?? "";
  if (headSha !== "") {
    const claimKey = kvClaimKey(message.body, headSha);
    try {
      await putAbandonClaim(deps.env.IDEMPOTENCY_KV, claimKey, IDEM_DROPPED, IDEMPOTENCY_SECONDS);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(fields, `dropped-claim KV update failed (the skip may still treat this commit as queued): ${detail}`);
    }
  }
  const identity = `${message.body.owner}/${message.body.repo}#${message.body.pr_number}`;
  const heldNote =
    admission.reason === "pr-held" && payloadSha && heldSha && payloadSha !== heldSha
      ? ` — the in-flight review holds head_sha ${heldSha}, so this commit was never reviewed`
      : "";
  await settleSkippedRow(deps, message.body, message.body.head_sha, `review admission refused: ${admission.reason}`);
  return deps.failureStore
    .record({
      target_id: message.body.targetId,
      installation_id: message.body.installation_id,
      owner: message.body.owner,
      repo: message.body.repo,
      pr_number: message.body.pr_number,
      head_sha: headSha,
      stage: "pipeline",
      code: "review.admission.refused",
      trackId: `${message.body.owner}/${message.body.repo}#${message.body.pr_number}@${headSha}`,
      message: FAILURE_SUMMARIES["review.admission.refused"],
      error: `${restoreFailure !== null ? `review dropped: ${restoreFailure}; admission refused` : `review dropped after ${delays.length} refused retries`}: ${admission.reason} (system_cap ${admission.system_cap}, workspace_cap ${admission.workspace_cap}${cause}) — PR ${identity}, head_sha ${
        headSha === "" ? "unresolved (comment trigger, no sha in payload)" : headSha
      }${heldNote}`,
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(fields, `review_failures insert failed (drop trace lost): ${detail}`);
    });
}




type CommenterResolution =
  | {
      kind: "ok";
      commenter: ReviewCommenter;
      githubAppId: number;
      workspaceId: string;
      reviewLevel: ReviewLevel | null;
      scope: BotScope;
      usageWorkspaceId: string;
    }
  | { kind: "paused" };

async function resolveCommenter(payload: ReviewJobPayload, deps: ProcessDeps): Promise<CommenterResolution> {
  const botId = payload.botRef.appId;
  const row = await createReviewBotsStore(deps.env.DB).getAppById(botId);
  if (row === null) {
    deps.appCommenters.delete(botId);
    throw new Error(
      `per-App credential resolution failed: app ${botId} not found, has no workspace mapping, or its workspace is deleted`,
    );
  }
  if (row.deleted_at !== null) {
    deps.appCommenters.delete(botId);
    throw new Error(`per-App credential resolution failed: app ${botId} is soft-deleted`);
  }
  if (row.status !== "active") {
    deps.appCommenters.delete(botId);
    throw new Error(`per-App credential resolution failed: app ${botId} is ${row.status}`);
  }
  const target = await deps.targets.getForExecution(payload.targetId);
  if (target === null) {
    deps.appCommenters.delete(botId);
    throw new Error(
      `per-App credential resolution failed: app ${botId} has no review target ${payload.targetId}`,
    );
  }
  if (target.bot_id !== botId) {
    deps.appCommenters.delete(botId);
    throw new Error(
      `per-App credential resolution failed: target ${target.id} belongs to bot ${target.bot_id}, not ${botId}`,
    );
  }
  if (row.review_enabled === 0) return { kind: "paused" };
  const effective = await readEffectiveTargetSettings(deps.env.DB, target);
  if (!effective.reviewEnabled) {
    return { kind: "paused" };
  }
  const fingerprint = JSON.stringify([row.github_app_id, row.private_key_enc]);
  const cached = deps.appCommenters.get(botId);
  if (cached !== undefined && cached.fingerprint === fingerprint) {
    return {
      kind: "ok",
      commenter: cached.commenter,
      githubAppId: cached.githubAppId,
      workspaceId: row.workspace_id,
      reviewLevel: effective.level,
      scope: row.scope,
      usageWorkspaceId: target.workspace_id,
    };
  }
  const pem = await createSecretbox(deps.env.DASHBOARD_ENCRYPTION_KEY).decryptSecret(
    row.private_key_enc,
    `github_apps.private_key_enc:${row.id}`,
  );
  const commenter = deps.createAppCommenter({ APP_ID: String(row.github_app_id), PRIVATE_KEY: pem });
  deps.appCommenters.set(botId, { commenter, fingerprint, githubAppId: row.github_app_id });
  return {
    kind: "ok",
    commenter,
    githubAppId: row.github_app_id,
    workspaceId: row.workspace_id,
    reviewLevel: effective.level,
    scope: row.scope,
    usageWorkspaceId: target.workspace_id,
  };
}

type PrHeadAnswer = { headSha: string | null; headAt: string | null };

async function resolveAppConfig(payload: ReviewJobPayload, deps: ProcessDeps): Promise<RunnerAppConfig> {
  const botId = payload.botRef.appId;
  try {
    const cfg = await createAppConfigStore(
      deps.env.DB,
      deps.env.DASHBOARD_ENCRYPTION_KEY,
    ).getAppConfig(botId);
    return { keys: cfg.keys, modelChain: cfg.modelChain };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`per-App config resolution failed: app ${botId}: ${detail}`);
  }
}

async function resolveModelOverrides(
  payload: ReviewJobPayload,
  deps: ProcessDeps,
): Promise<Record<string, string> | undefined> {
  const botId = payload.botRef.appId;
  try {
    const overrides = await createAppConfigStore(
      deps.env.DB,
      deps.env.DASHBOARD_ENCRYPTION_KEY,
    ).getModelOverridesForConsumer(botId);
    return Object.keys(overrides).length > 0 ? overrides : undefined;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`per-App model-role resolution failed: app ${botId}: ${detail}`);
  }
}
async function resolveCustomProviders(
  payload: ReviewJobPayload,
  deps: ProcessDeps,
): Promise<CustomProviderConsumerConfig[] | undefined> {
  const botId = payload.botRef.appId;
  try {
    const providers = await createAppConfigStore(
      deps.env.DB,
      deps.env.DASHBOARD_ENCRYPTION_KEY,
    ).getCustomProvidersForConsumer(botId);
    return providers.length > 0 ? providers : undefined;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`per-App custom-provider resolution failed: app ${botId}: ${detail}`);
  }
}

async function resolveSandboxImage(payload: ReviewJobPayload, deps: ProcessDeps): Promise<SandboxImageDefinition> {
  const botId = payload.botRef.appId;
  try {
    const row = await createReviewBotsStore(deps.env.DB).getAppById(botId);
    if (row === null) {
      throw new Error("app not found");
    }
    const image = getSandboxImage(row.sandbox_image_id);
    if (image === undefined) {
      throw new Error(`unknown sandbox image id ${JSON.stringify(row.sandbox_image_id)}`);
    }
    if (!image.enabled) {
      throw new Error(`sandbox image id ${JSON.stringify(row.sandbox_image_id)} is disabled`);
    }
    return image;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`per-App sandbox image resolution failed: app ${botId}: ${detail}`);
  }
}

function assertAppConfigComplete(
  appCfg: RunnerAppConfig,
  customProviders: readonly CustomProviderConsumerConfig[] | undefined,
  modelOverrides: Record<string, string> | undefined,
  appId: string,
): void {
  const chain = appCfg.modelChain === null ? "" : appCfg.modelChain.trim();
  const hasSelector = chain.split(",").some((segment) => segment.trim() !== "");
  if (!hasSelector) {
    throw new Error(`per-App config incomplete: app ${appId}: missing model chain`);
  }
  const availableProviders = new Set<string>();
  for (const [provider, keys] of Object.entries(appCfg.keys)) {
    if (providerEnvName(provider) !== undefined && keys.some((key) => key.trim() !== "")) {
      availableProviders.add(provider);
    }
  }
  for (const decl of customProviders ?? []) {
    if (decl.api_keys.some((key) => key.trim() !== "")) availableProviders.add(decl.provider_id);
  }
  const chains: Array<{ role: string | null; chain: string }> = [
    { role: null, chain },
    ...(modelOverrides === undefined
      ? []
      : Object.entries(modelOverrides).map(([role, overrideChain]) => ({
          role,
          chain: overrideChain.trim(),
        }))),
  ];
  for (const { role, chain: candidateChain } of chains) {
    if (role !== null) {
      const overrideHasSelector = candidateChain
        .split(",")
        .some((segment) => segment.trim() !== "");
      if (!overrideHasSelector) {
        throw new Error(
          `per-App config incomplete: app ${appId}: role override \`${role}\`: missing model chain`,
        );
      }
    }
    for (const segment of candidateChain.split(",")) {
      const selector = segment.trim();
      if (selector === "") continue;
      const provider = selector.split("/")[0]!.trim();
      if (!availableProviders.has(provider)) {
        const where = role === null ? "" : `role override \`${role}\` `;
        throw new Error(
          provider === "ark-plan"
            ? `per-App config incomplete: app ${appId}: ${where}the ark-plan provider was removed — point the chain at a provider the runtime serves (a built-in catalog provider with its key configured, or your own declaration)`
            : `per-App config incomplete: app ${appId}: ${where}provider ${provider} has no configured key`,
        );
      }
    }
  }
}



async function newerCommitHasJob(
  deps: ProcessDeps,
  payload: ReviewJobPayload,
  headSha: string | null,
  fields: ConsumerLogFields,
): Promise<boolean> {
  if (!headSha) return false;
  // The claim belongs to ANOTHER commit's delivery, so it carries no rerun
  // dimension of ours — `kvClaimKey(payload, headSha)` would append this
  // delivery's `:rerun:{id}` and never find it. The plain key is only the fast
  // path: a newer head whose job arrived via check_run.rerequested claims
  // under `{idemKey}:rerun:{rerequested run id}` — the CONCLUDED run it was
  // asked to rerun, kept only on the attempt's `attempt_key` suffix — so the
  // D1 probe below supplies that leg instead. A bare nonterminal
  // `review_checks` row is NOT job proof on its own — a refused delivery
  // (quota / entitlement) attaches a check at beforeEnqueue yet never
  // enqueues — so the row must be corroborated: a `check_run` row by its
  // rerun KV claim, any other row by the plain claim already missed above.
  const idempotencyKey: IdempotencyKey = {
    installation_id: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    pr_number: payload.pr_number,
    head_sha: headSha,
  };
  try {
    const claim = await deps.env.IDEMPOTENCY_KV.get(idemKey(idempotencyKey));
    if (isReviewClaim(claim)) return true;
    // A non-review claim value still falls through to D1: the KV value records
    // how a write went, not whether the head's review is really in flight.
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(fields, `supersede KV read failed — probing D1 instead: ${detail}`);
  }
  try {
    const reviewed = await deps.env.DB.prepare(
      `SELECT 1 FROM reviews
         WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND head_sha = ?
       LIMIT 1`,
    )
      .bind(
        payload.installation_id,
        payload.owner,
        payload.repo,
        payload.pr_number,
        headSha,
      )
      .first();
    if (reviewed !== null) return true;
    const openRows = await deps.env.DB.prepare(
      `SELECT check_run_id, triggered_by, attempt_key FROM review_checks
         WHERE bot_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND head_sha = ? AND terminal_ms IS NULL`,
    )
      .bind(
        payload.botRef.appId,
        payload.owner,
        payload.repo,
        payload.pr_number,
        headSha,
      )
      .all<{ check_run_id: number | null; triggered_by: string; attempt_key: string }>();
    // One head can hold SEVERAL nonterminal rows — e.g. a refused
    // `pull_request` attach (no claim) beside a real `check_run` rerun — so
    // every row gets a say, not just the first one LIMIT picked.
    const rerunIds = new Set<number>();
    for (const row of openRows.results) {
      // The claim lives under the REREQUESTED (concluded) run id — the row's
      // own `check_run_id` is the new run GitHub created for this attempt,
      // which can never be the claim's run id (and may still be NULL
      // mid-attach). A non-`check_run` row names no claim: its plain key is
      // exactly what the fast path already missed, so it proves nothing.
      if (row.triggered_by !== "check_run") continue;
      const rerunCheckRunId = rerunCheckRunIdOfAttemptKey(row.attempt_key);
      if (rerunCheckRunId !== null) rerunIds.add(rerunCheckRunId);
    }
    // A rerun writes its enqueue claim under `{idemKey}:rerun:{rerequested
    // id}`; the row alone cannot distinguish "queued" from "refused at the
    // door". One failed read only forfeits that row's say — a sibling row
    // may still carry proof.
    for (const rerunCheckRunId of rerunIds) {
      try {
        const rerunClaim = await deps.env.IDEMPOTENCY_KV.get(
          rerunIdemKey(idempotencyKey, rerunCheckRunId),
        );
        if (isReviewClaim(rerunClaim)) return true;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          fields,
          `supersede rerun-claim read failed — checking remaining rows: ${detail}`,
        );
      }
    }
    return false;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(fields, `supersede D1 probe failed — reviewing normally: ${detail}`);
    return false;
  }
}
type ConsumerOverrides = Partial<
  Pick<
    ProcessDeps,
    | "store"
    | "failureStore"
    | "createAppCommenter"
    | "getSandbox"
    | "checks"
    | "selectPrHead"
    | "findIncrementBase"
    | "attemptCapMs"
  >
> & {
  startAttempt?: AttemptStarter;
};

/** How a host hands an admitted attempt to the execution route. */
export type AttemptStarter = (
  deps: ProcessDeps,
  ref: AttemptRef,
) => Promise<WorkflowCreateVerdict | void>;

/** The create outcome a host can confirm: new, or already present. */
export type WorkflowCreateVerdict = "created" | "exists";

/**
 * A DEFINITE `Workflow.create` rejection — a configuration or validation
 * failure the instance did not survive. This is a failure, not an ambiguous
 * success: the attempt is settled as failed and the delivery takes the queue's
 * retry path.
 */
export class WorkflowCreateFailedError extends Error {
  constructor(
    readonly attemptId: string,
    readonly cause: unknown,
  ) {
    super(
      `attempt ${attemptId}: the Workflow instance could not be created (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = "WorkflowCreateFailedError";
  }
}

/**
 * A Workflow `create` whose outcome is not confirmed. The instance MAY exist,
 * so the delivery is ACKED and never retried in place: a queue retry could pay
 * twice. The handoff row stays `ambiguous` and the delivery's OWN recorded
 * attempt id is what the route's recovery pass replays, so a create that did
 * land is never duplicated by a second attempt id.
 */
export class WorkflowCreateAmbiguousError extends Error {
  constructor(
    readonly attemptId: string,
    readonly cause: unknown,
  ) {
    super(
      `attempt ${attemptId}: the Workflow instance creation reply was not confirmed (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = "WorkflowCreateAmbiguousError";
  }
}

function classifyWorkflowCreateFailure(err: unknown): "definite" | "unknown" {
  const status = (err as { status?: unknown } | null)?.status;
  if (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425 &&
    status !== 429 &&
    status !== 409
  ) {
    return "definite";
  }
  return "unknown";
}

async function attemptInstancePresence(
  workflow: Workflow<AttemptRef>,
  attemptId: string,
): Promise<"exists" | "absent" | "unknown"> {
  try {
    const handle = await workflow.get(attemptId);
    await handle.status();
    return "exists";
  } catch (err) {
    return (err as { status?: unknown } | null)?.status === 404 ? "absent" : "unknown";
  }
}

/**
 * Create the attempt's Workflow instance. Instance id = attempt id, so a replay
 * of the same admitted attempt addresses the same instance and a lost reply
 * cannot create a second one.
 */
export async function createWorkflowInstance(
  workflow: Workflow<AttemptRef>,
  ref: AttemptRef,
): Promise<WorkflowCreateVerdict> {
  try {
    await workflow.create({ id: ref.attemptId, params: ref });
    return "created";
  } catch (err) {
    const presence = await attemptInstancePresence(workflow, ref.attemptId);
    if (presence === "exists") return "exists";
    if (presence === "unknown") throw new WorkflowCreateAmbiguousError(ref.attemptId, err);
    if (classifyWorkflowCreateFailure(err) === "definite") {
      throw new WorkflowCreateFailedError(ref.attemptId, err);
    }
    throw new WorkflowCreateAmbiguousError(ref.attemptId, err);
  }
}

/**
 * Build one host's channel to the pipeline: the stores, the per-App caches and
 * the factories a phase re-derives its live objects from. Both hosts share it —
 * the queue consumer that admits, and the Workflow step host that executes — so
 * a phase sees the same surface on either side of the handoff.
 */
export function createProcessDeps(
  env: PipelineEnv,
  log: ConsumerLog = defaultConsumerLog,
  overrides: ConsumerOverrides = {},
  background?: CheckBackgroundSink,
): ProcessDeps {
  const appCommenters = new Map<string, { commenter: ReviewCommenter; fingerprint: string; githubAppId: number }>();
  const appsStore = createReviewBotsStore(env.DB);
  const targetsStore = createTargetsStore(env.DB);
  const deps: ProcessDeps = {
    env,
    store: overrides.store ?? createArtifactStore(env.DB),
    targets: targetsStore,
    failureStore: overrides.failureStore ?? createFailureStore(env.DB),
    appCommenters,
    runnerConfigs: new Map(),
    checkSettlements: new Map(),
    credentials: new Map(),
    createAppCommenter: overrides.createAppCommenter ?? ((cred) => createReviewCommenter(cred, { db: env.DB })),
    getSandbox: overrides.getSandbox ?? ((binding, id) => getSandbox(binding, id)),
    selectPrHead: overrides.selectPrHead ?? appsStore.selectPrHead,
    findIncrementBase: overrides.findIncrementBase ?? findIncrementBase,
    attemptCapMs: overrides.attemptCapMs,
    log,
    background,
  };
  deps.checks =
    overrides.checks ??
    createCheckLifecycle({
      db: env.DB,
      nowMs: () => Date.now(),
      getAdapter: (scope) => appCommenters.get(scope.appId)?.commenter.checks ?? null,
      getCheckGate: async (scope) => {
        const row = await env.DB.prepare(
          `SELECT * FROM review_targets
            WHERE bot_id = ? AND repo_owner = ? COLLATE NOCASE AND repo_name = ? COLLATE NOCASE
              AND deleted_at IS NULL
            ORDER BY created_at, id LIMIT 1`,
        )
          .bind(scope.appId, scope.owner, scope.repo)
          .first<ReviewTargetRow>();
        if (row === null) return null;
        return checkGateOf(await readEffectiveTargetSettings(env.DB, row));
      },
    });
  return deps;
}

/** What a successor may conclude about an expired attempt's sandbox (spec §7.9). */
export type SuccessorStopEvidence = "no-container" | "revoked" | "running" | "unavailable";

function queueStampOf(timestamp: unknown): number | null {
  if (timestamp instanceof Date) {
    const ms = timestamp.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * The successor's evidence, in the order the state makes decidable.
 *
 * 1. CLAIM THE ACTIVATION FIRST (`claimUnactivatedAttempt`). Winning it is a
 *    fact about the future: no container can ever be created for that attempt,
 *    so capacity and the PR may move. It wins only when nothing activated the
 *    attempt — an INSERT when no row exists, or a revoke of a row that never
 *    activated.
 * 2. LOSING means the attempt is or was activated, and the only remaining
 *    evidence is that attempt's OWN container answering not-running. The id
 *    comes from that row (a minted-but-unwritten handle is not a stop, item 4),
 *    and `revoke()` observes then revokes in one critical section.
 * 3. A REVOCATION THAT FAILED IS NOT DONE: a throw, a `revoked: false`, or a
 *    durable mark that did not land all answer `unavailable`, and the caller
 *    holds the PR and retries next round.
 */
export async function priorAttemptStopEvidence(
  db: D1Like,
  getSandbox: (binding: unknown, id: string) => Promise<ReviewSandbox>,
  binding: unknown,
  attemptId: string,
): Promise<SuccessorStopEvidence> {
  try {
    if (await claimUnactivatedAttempt(db, attemptId, Date.now())) return "no-container";
  } catch {
    return "unavailable";
  }
  let activation: Awaited<ReturnType<typeof readAttemptActivation>>;
  try {
    activation = await readAttemptActivation(db, attemptId);
  } catch {
    return "unavailable";
  }
  if (activation === null || activation.sandboxId === null) return "unavailable";
  let verdict: { revoked: boolean; running: boolean };
  try {
    const sandbox = await getSandbox(binding, activation.sandboxId);
    if (sandbox.revoke === undefined) return "unavailable";
    verdict = await sandbox.revoke();
  } catch {
    return "unavailable";
  }
  if (verdict.running) return "running";
  if (!verdict.revoked) return "unavailable";
  try {
    return (await markAttemptRevoked(db, attemptId, Date.now())) ? "revoked" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * The `review_failures.error` cause token a platform pause writes beside its
 * code — the same shape `maintenance_window` uses, so an operator counter can
 * name the cause without parsing the sentence.
 */
export const PLATFORM_PAUSE_REASON = "platform_paused";

/** The cause token a closed deployment gate writes beside its own code. */
export const DEPLOYMENT_GATE_REASON = "deployment_gate_closed";

/**
 * The two PROVEN halt states of `reviewRunState`: reviews cannot run, and the
 * reason is a fact rather than a read fault. Each names its own failure code,
 * cause token and log event, so the queue's settlement and the operator's
 * answer describe the same state.
 */
export type ReviewHaltState = "paused-platform" | "blocked-deployment-gate";

const HALT_SETTLEMENT = {
  "paused-platform": {
    code: "review.paused.platform",
    cause: PLATFORM_PAUSE_REASON,
    checkReason: "review paused",
    event: "review_paused",
    why: "the review switch (review_global) is off",
    line: "review platform paused (review_global off) — every delivery in this batch is settled as paused and acked; no Workflow instance is created",
  },
  "blocked-deployment-gate": {
    code: "review.blocked.deployment_gate",
    cause: DEPLOYMENT_GATE_REASON,
    checkReason: "review route not open",
    event: "review_blocked_deployment_gate",
    why: "the deployment's review route (review.route.workflow) is not open",
    line: "review route closed (review.route.workflow) — every delivery in this batch is settled as blocked and acked; no Workflow instance is created",
  },
} as const satisfies Record<
  ReviewHaltState,
  { code: FailureCode; cause: string; checkReason: string; event: string; why: string; line: string }
>;

/**
 * The halt row's durable identity: the target + comment id when the delivery
 * is a bot mention, otherwise the delivery key. A mention's webhook copy and
 * its outbox resend disagree on `deliveryKeyOf` — the claim's `payload_json`
 * is saved after `targetId` is resolved but before the webhook attaches a
 * delivery id — so keying on the comment id is what keeps both copies on ONE
 * row. The `targetId` stays in the key because two Apps may serve one
 * repository: the same comment id then names a DIFFERENT delivery per target,
 * and each needs its own row.
 */
function haltRowIdentity(payload: ReviewJobPayload): string {
  return payload.comment_id !== undefined
    ? `comment:${payload.targetId}:${payload.comment_id}`
    : deliveryKeyOf(payload);
}

/**
 * End a whole queue batch VISIBLY while reviews provably cannot run — the
 * platform switch is off, or the deployment's routing gate is not open.
 *
 * Neither halt is a silent ack: each delivery's attached run is settled through
 * the SAME paused skip the per-App pause uses (`settleSkippedRow`), one
 * `review_failures` row names the cause with its own code, the commit's
 * idempotency claim is handed back as `paused` (so a resume re-enqueues it
 * instead of skipping it for a day), and the message is acked. Nothing here
 * creates a Workflow instance or starts a container.
 *
 * The row is written BEFORE the Check is settled and its failure is NOT
 * caught: a failed insert must leave the message unacked so the queue
 * redelivers it — the plan's "every queued delivery ends with a durable failure
 * row" cannot hold on a best-effort write. The row's `id` is the delivery's
 * mention identity (`haltRowIdentity`) and the insert is `ON CONFLICT DO
 * NOTHING`, so two mentions of one PR each keep their row while a replay of
 * either copy of one delivery rewrites nothing.
 *
 * An acked bot mention with an open comment claim is a resend the sweep would
 * deliver to a platform that cannot run it (or replay once it resumes), so
 * the claim is closed with the settlement (`closeCommentClaim`) and that
 * failure is uncaught for the same reason.
 */
export async function settleHaltedBatch(
  batch: MessageBatch<ReviewJobPayload>,
  env: PipelineEnv,
  state: ReviewHaltState,
  log: ConsumerLog = defaultConsumerLog,
  overrides: ConsumerOverrides = {},
): Promise<void> {
  const deps = createProcessDeps(env, log, overrides);
  const first = batch.messages[0];
  if (first === undefined) return;
  const halt = HALT_SETTLEMENT[state];
  log.warn(
    {
      ...payloadIdentityFields(first.body),
      event: halt.event,
      queue: batch.queue,
      batch_size: batch.messages.length,
    },
    halt.line,
  );
  for (const message of batch.messages) {
    const payload = message.body;
    const fields = { ...payloadIdentityFields(payload), event: halt.event };
    if (payload.head_sha) {
      try {
        await putAbandonClaim(
          deps.env.IDEMPOTENCY_KV,
          idemKey({
            installation_id: payload.installation_id,
            owner: payload.owner,
            repo: payload.repo,
            pr_number: payload.pr_number,
            head_sha: payload.head_sha,
          }),
          IDEM_PAUSED,
          IDEMPOTENCY_SECONDS,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log.warn(fields, `paused-claim KV write failed (the skip may still treat this commit as queued): ${detail}`);
      }
    }
    const identity = `${payload.owner}/${payload.repo}#${payload.pr_number}`;
    await deps.failureStore.record({
      id: `${halt.cause}:${haltRowIdentity(payload)}`,
      target_id: payload.targetId,
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      head_sha: payload.head_sha ?? "",
      stage: "pipeline",
      code: halt.code,
      trackId: `${identity}@${payload.head_sha ?? ""}`,
      message: FAILURE_SUMMARIES[halt.code],
      error: `${halt.cause}: ${halt.why}, so this queued delivery ended without a review — PR ${identity}, head_sha ${
        payload.head_sha === null ? "unresolved (comment trigger, no sha in payload)" : payload.head_sha
      }`,
    });
    await settleSkippedRow(deps, payload, payload.head_sha, halt.checkReason, { paused: true });
    await closeCommentClaim(deps.env.DB, payload);
    message.ack();
  }
}

/**
 * The maintenance window (D20) defers the whole invocation: a mid-upgrade
 * pipeline write could land on a ledger row the backfill just repointed.
 * Every delivery is DEFERRED where the queue still allows it — acking would
 * drop the review for good, while the window is temporary. ONE line per
 * invocation (the queue and the batch size it deferred), not one per message:
 * the batch is the unit the platform redelivers.
 *
 * `retry` is the FIRST choice because it is the only path that keeps the
 * review. Two deliveries have no redelivery left — a runtime that offers no
 * `message.retry`, and a message already on its LAST platform delivery
 * (`wrangler.jsonc` max_retries 5 ⇒ QUEUE_MAX_ATTEMPTS 6 deliveries, and
 * every `retry()` spends one). Those are dropped, so each one takes the
 * failure carrier instead of vanishing: one `review_failures` row
 * (stage `maintenance_deferred`) the 15-min sweep counts and alerts on, then
 * an ack.
 *
 * A batch that was ALREADY halted (`halt` set — the platform switch off or
 * the route gate closed) keeps its halt code, cause and summary on that
 * last-attempt row — the operator card names the pause/gate and the row must
 * not contradict it — and goes STRAIGHT to the replay outbox: the write stamps
 * `maintenance_replay_requested_at` up front, so the sweep lane is the only
 * sender (the operator route answers the stamped row `repeat`, and refuses
 * `reviews_not_running` while the halt holds) and it re-issues the row once
 * the gate and the window are both open. The halted settlement's other side
 * effects run too — the paused KV claim, the Check settled paused, the
 * comment claim closed — so nothing hangs open while the row waits. The row's
 * `id` is the same mention-keyed identity `settleHaltedBatch` writes, so both
 * settlement faces land on one row.
 *
 * shortcut: retry cover is max_retries × 300s (5 × 5 min); a window open
 * longer spends every delivery, and each spent one is now alerted through
 * `review_failures` — upgrade: a re-enqueue-on-close drain, once a window
 * routinely outlives the retry cover.
 */
export async function deferMaintenanceBatch(
  batch: MessageBatch<ReviewJobPayload>,
  deps: ProcessDeps,
  halt?: ReviewHaltState,
): Promise<void> {
  if (batch.messages[0] === undefined) return;
  const deferral = {
    ...payloadIdentityFields(batch.messages[0].body),
    event: "maintenance_defer" as const,
    queue: batch.queue,
    batch_size: batch.messages.length,
  };
  deps.log.warn(deferral, "delivery deferred — the platform is in its maintenance window");
  for (const message of batch.messages) {
    if (typeof message.retry === "function" && message.attempts < QUEUE_MAX_ATTEMPTS) {
      message.retry({ delaySeconds: 300 });
      continue;
    }
    const body = message.body;
    const settled = halt === undefined ? null : HALT_SETTLEMENT[halt];
    const identity = `${body.owner}/${body.repo}#${body.pr_number}`;
    const headSha = body.head_sha ?? "";
    const rowId = settled === null ? undefined : `${settled.cause}:${haltRowIdentity(body)}`;
    await deps.failureStore
      .record({
        ...(rowId === undefined ? {} : { id: rowId }),
        target_id: body.targetId,
        installation_id: body.installation_id,
        owner: body.owner,
        repo: body.repo,
        pr_number: body.pr_number,
        head_sha: headSha,
        stage: MAINTENANCE_DEFERRED_STAGE,
        code: settled === null ? "review.delivery.deferred" : settled.code,
        trackId: `${identity}@${headSha}`,
        message: FAILURE_SUMMARIES[settled === null ? "review.delivery.deferred" : settled.code],
        error:
          settled === null
            ? `maintenance_window: the platform is closed and this delivery has no redelivery left (attempt ${message.attempts} of ${QUEUE_MAX_ATTEMPTS}) — PR ${identity} was never reviewed`
            : `${settled.cause}: ${settled.why}, so this queued delivery ended without a review — PR ${identity}, head_sha ${
                body.head_sha === null ? "unresolved (comment trigger, no sha in payload)" : body.head_sha
              }; the maintenance window's deferral spent its last redelivery (attempt ${message.attempts} of ${QUEUE_MAX_ATTEMPTS})`,
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(deferral, `review_failures insert failed (leaving deferred delivery unacked): ${detail}`);
        throw err;
      });
    if (settled !== null) {
      // The halt settlement's full contract on the last-attempt row: hand the
      // commit's claim back as `paused` (a resume re-enqueues it), hand the
      // row straight to the replay outbox (the stamp IS the outbox mark — the
      // operator route then answers it `repeat`, leaving the sweep's send gate
      // the only sender lane), settle its Check paused like the halted path
      // did before acking, and close the mention's comment claim so the
      // outbox cannot resend it into a stopped platform. The row's stamp
      // update and the claim close stay UNCAUGHT: a failed write must leave
      // the delivery unacked for redelivery.
      if (body.head_sha) {
        try {
          await putAbandonClaim(
            deps.env.IDEMPOTENCY_KV,
            idemKey({
              installation_id: body.installation_id,
              owner: body.owner,
              repo: body.repo,
              pr_number: body.pr_number,
              head_sha: body.head_sha,
            }),
            IDEM_PAUSED,
            IDEMPOTENCY_SECONDS,
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          deps.log.warn(deferral, `paused-claim KV write failed (the skip may still treat this commit as queued): ${detail}`);
        }
      }
      await deps.env.DB.prepare("UPDATE review_failures SET maintenance_replay_requested_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), rowId)
        .run();
      await settleSkippedRow(deps, body, body.head_sha, settled.checkReason, { paused: true });
      await closeCommentClaim(deps.env.DB, body);
    }
    message.ack();
  }
}

/**
 * Create the queue consumer: admission, dedupe, skip settlement and the
 * hand-off only. One admitted delivery becomes one Workflow instance through
 * the caller's `startAttempt` (or the `startAttempt` override); the consumer
 * itself never creates a container, mints a credential or runs the model.
 *
 * The store and commenters are created once per consumer instance (per-App
 * commenter instances live in the appCommenters Map — one per appId, lock L4).
 *
 * `log` is injectable for tests (default: structured JSON lines). `overrides`
 * lets tests substitute the store / failureStore / per-App commenter
 * factory / sandbox factory without process-wide mock.module (bun's
 * relative-path mock.module leaks across test files sharing a worker — CI
 * run 32946710695).
 */
export function createReviewConsumer(
  env: PipelineEnv,
  log: ConsumerLog = defaultConsumerLog,
  overrides: ConsumerOverrides = {},
  background?: CheckBackgroundSink,
  startAttempt?: AttemptStarter,
): (batch: MessageBatch<ReviewJobPayload>) => Promise<void> {
  const deps = createProcessDeps(env, log, overrides, background);
  const starter = overrides.startAttempt ?? startAttempt;
  return async (batch) => {
    // The maintenance window (D20) defers the whole invocation: a mid-upgrade
    // pipeline write could land on a ledger row the backfill just repointed.
    // ONE read per invocation; nothing else in the batch runs.
    const maintenance = await getMaintenanceMode(env.DB);
    if (maintenanceClosed(maintenance)) {
      await deferMaintenanceBatch(batch, deps);
      return;
    }
    for (const message of batch.messages) {
      // The Queue send stamp is the attempt's queue-wait origin (the duration
      // report's `enqueued_ms`), never its cap anchor — the cap starts at this
      // delivery's claim (I-000683). It is a `Date` on the platform and may be
      // absent in a hand-built test batch; the boundary normalization keeps an
      // absent stamp absent.
      const sentAtMs = queueStampOf(message.timestamp);
      const outcome = await processMessage(message.body, deps, message.attempts, starter, sentAtMs);
      if (outcome.kind === "guard-held") {
        await handleGuardHeld(
          message,
          deps,
          outcome.admission,
          outcome.heldHeadSha,
          outcome.level,
          outcome.commentClaimConsumed,
        );
      } else if (outcome.kind === "paused") {
        message.ack();
      } else if (outcome.kind === "degraded") {
        message.ack();
      } else if (outcome.kind === "superseded") {
        message.ack();
      } else if (outcome.kind === "rerun-stale") {
        // Already settled above: the stale run was closed, so a redelivery
        // would only re-settle it.
        message.ack();
      } else if (outcome.kind === "routed") {
        message.ack();
      } else if (outcome.kind === "unknown") {
        message.ack();
      } else if (outcome.kind === "budget-exhausted") {
        message.ack();
      }
    }
  };
}



/**
 * Rebuild the per-App GITHUB channel for a Workflow step host. A separate
 * invocation has none of the admission invocation's resolved state, so the App
 * adapter is resolved again from `payload` + `deps`; nothing secret crosses the
 * boundary. The paused gate and the sandbox-image gate already ran before the
 * instance was created.
 *
 * The paid-provider configuration is deliberately NOT resolved here. A resumed
 * host may have to finish `collect`/`publish` for work that is already paid
 * for, and those phases need no model chain or provider key: hydrating it here
 * would turn a rotated provider key into a failure settlement over a durable
 * result. `ensureRunnerConfig` resolves it at the steps that actually spend it.
 *
 * Returns `"paused"` when the App was paused after admission: the attempt owes
 * no review, and the caller settles its attached run as skipped.
 */
export async function hydrateAttemptHost(
  payload: ReviewJobPayload,
  deps: ProcessDeps,
): Promise<"ready" | "paused"> {
  const resolution = await resolveCommenter(payload, deps);
  if (resolution.kind === "paused") return "paused";
  return "ready";
}

/**
 * The App's paid-runner configuration, resolved by the STEP that spends it and
 * cached on the host channel so one host resolves it once. Fail-closed exactly
 * as admission is (`assertAppConfigComplete`): a chain-less App cannot start a
 * paid run, so the step that would start one fails there, with the attempt's
 * own records intact.
 */
export async function ensureRunnerConfig(
  payload: ReviewJobPayload,
  deps: ProcessDeps,
): Promise<RunnerConfig> {
  const cached = deps.runnerConfigs.get(payload.botRef.appId);
  if (cached !== undefined) return cached;
  const appCfg = await resolveAppConfig(payload, deps);
  const modelOverrides = await resolveModelOverrides(payload, deps);
  const customProviders = await resolveCustomProviders(payload, deps);
  assertAppConfigComplete(appCfg, customProviders, modelOverrides, payload.botRef.appId);
  const config: RunnerConfig = { appCfg, modelOverrides, customProviders };
  deps.runnerConfigs.set(payload.botRef.appId, config);
  return config;
}

/**
 * @param attempts the delivery number of this message (1 = first delivery);
 *   only the value past the queue's retry budget matters — it stamps the
 *   idempotency key `failed` so a DLQ-bound commit stops counting as reviewed-
 *   or-pending proof.
 * @param queueSentAtMs the original Queue send stamp, already normalized at the
 *   boundary: `null` means the platform supplied none. It is recorded as the
 *   attempt's queue-wait origin (`enqueued_ms`) and never anchors the cap — an
 *   absent stamp stays absent rather than be invented for the report. A
 *   redelivery of an already-frozen attempt ignores it in favour of the
 *   recorded deadline.
 */
async function processMessage(
  payload: ReviewJobPayload,
  deps: ProcessDeps,
  attempts = 1,
  startAttempt?: AttemptStarter,
  queueSentAtMs: number | null = null,
): Promise<ProcessOutcome> {
  // This invocation's entry instant — the delivery's claim. Every best-effort
  // step that can spend a sandbox window is measured against it, and it is the
  // origin of an attempt's cap (I-000683): a message delayed behind the guard's
  // backoff is claimed long after it was enqueued.
  const roundStartedAt = Date.now();
  // The delivery key and the recorded attempt id are learned inside the try, so
  // a DB fault or a legacy payload still flows through the structured failure
  // channel. A redelivery of this message finds the row its predecessor wrote
  // and replays the SAME attempt id, so an interrupted handoff can never mint a
  // second attempt that could pay twice.
  let deliveryKey = "";
  let attemptId: string = crypto.randomUUID();
  let sandboxId = attemptSandboxId(attemptId);
  let inflight: { key: InflightKey; attemptId: string; ttlSeconds: number } | null = null;
  let level: ReviewLevel | undefined;
  let baseFields: ConsumerLogFields | undefined;
  let commentClaimConsumed = false;
  let checkClaimSha: string | null = null;
  let handedOff = false;
  let handoffRecorded = false;
  let guardHeldOutcome = false;
  let checkBudgets: CheckBudgets | null = null;
  try {
    baseFields = toBaseFields(payload);
    deliveryKey = deliveryKeyOf(payload);
    const previousHandoff = await readAttemptHandoff(deps.env.DB, deliveryKey);
    if (previousHandoff?.state === "created") {
      deps.log.info(
        { ...payloadIdentityFields(payload), attempt_id: previousHandoff.attemptId },
        "review attempt already handed off to its Workflow instance — ack without a second instance",
      );
      return { kind: "routed" };
    }
    if (previousHandoff !== null) {
      attemptId = previousHandoff.attemptId;
      sandboxId = attemptSandboxId(attemptId);
    }
    if (payload.comment_id !== undefined) {
      if (payload.successor_of !== undefined || previousHandoff !== null) {
        deps.log.info(
          { ...payloadIdentityFields(payload), attempt_id: attemptId },
          "replay of a recorded attempt — the comment claim was consumed before the handoff row; the handoff is its at-most-once",
        );
      } else {
        const claimed = await deps.env.DB.prepare(
          `UPDATE comment_trigger_claims SET state = 'consumed', consumed_ms = ?
            WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND comment_id = ?
              AND state = 'queued'`,
        )
          .bind(
            Date.now(),
            payload.installation_id,
            payload.owner,
            payload.repo,
            payload.pr_number,
            payload.comment_id,
          )
          .run();
        if (claimed.meta.changes === 0) {
          deps.log.info(baseFields, "comment trigger already claimed — ack without running");
          return { kind: "ok" };
        }
        commentClaimConsumed = true;
      }
    }
    const resolution = await resolveCommenter(payload, deps);
    if (resolution.kind === "paused") {
      deps.log.info(
        { ...baseFields, event: "review_paused" },
        "review paused — app review_enabled=0; acking without a review (no retry, no DLQ)",
      );
      if (payload.head_sha) {
        try {
          await putAbandonClaim(
            deps.env.IDEMPOTENCY_KV,
            kvClaimKey(payload, payload.head_sha!),
            IDEM_PAUSED,
            IDEMPOTENCY_SECONDS,
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          deps.log.warn(
            { ...baseFields, event: "review_paused" },
            `paused-claim KV write failed (the skip may still treat this commit as queued): ${detail}`,
          );
        }
      }
      await settleSkippedRow(deps, payload, payload.head_sha, "review paused", { paused: true });
      return { kind: "paused" };
    }
    const { githubAppId, workspaceId, usageWorkspaceId } = resolution;
    let watermark: PrHeadAnswer | null | undefined;
    let watermarkFaultLogged = false;
    const selectWatermark = (): Promise<PrHeadAnswer | null> =>
      deps.selectPrHead({
        targetId: payload.targetId,
        owner: payload.owner,
        repo: payload.repo,
        prNumber: payload.pr_number,
      });
    const warnWatermarkFault = (fallback: string, err: unknown): void => {
      if (watermarkFaultLogged) return;
      watermarkFaultLogged = true;
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        { ...payloadIdentityFields(payload), app_id: payload.botRef.appId },
        `PR head watermark read failed (${fallback}): ${detail}`,
      );
    };
    const readWatermark = async (fallback: string): Promise<PrHeadAnswer | null> => {
      if (watermark === undefined) {
        try {
          watermark = await selectWatermark();
        } catch (err) {
          watermark = null;
          warnWatermarkFault(fallback, err);
        }
      }
      return watermark;
    };
    const payloadHeadSha = payload.head_sha;
    const payloadHeadAt = payload.head_at;
    // A rerun must review the commit its check names, never a newer one: the
    // checkout follows the PR ref, so without this gate a rerun of an old
    // check would pay for the live head and hang the result on the old run.
    // This runs before any sandbox work and regardless of whether the named
    // head was ever reviewed (the settled arms below only cover a reviewed
    // or journaled head).
    if (payload.triggered_by === "check_run" && payloadHeadSha) {
      const live = await readWatermark("fail-open: reviewing the rerun's own head");
      if (live?.headSha && live.headSha !== payloadHeadSha) {
        deps.log.info(
          { ...baseFields, event: "review_superseded", reason: "superseded" },
          `rerun-stale: rerun targets ${payloadHeadSha.slice(0, 7)} but the PR head is ${live.headSha.slice(0, 7)} — settling the check instead of reviewing the live head`,
        );
        await settleSkippedRow(deps, payload, payloadHeadSha, "rerun targets a commit that is no longer the PR head");
        return { kind: "rerun-stale" };
      }
    }
    if (payloadHeadSha && payloadHeadAt) {
      const ledgerHead = await readWatermark("fail-open: reviewing normally");
      if (
        ledgerHead?.headAt &&
        ledgerHead.headAt > payloadHeadAt &&
        ledgerHead.headSha !== payloadHeadSha &&
        (await newerCommitHasJob(deps, payload, ledgerHead.headSha, baseFields))
      ) {
        deps.log.info(
          { ...baseFields, event: "review_superseded", reason: "superseded", superseded_by_head_at: ledgerHead.headAt },
          `delivery superseded — the PR head has advanced to ${ledgerHead.headAt} (head_sha ${ledgerHead.headSha ?? "unknown"}), acking with no review side effects (no retry, no DLQ, no container)`,
        );
        try {
          await putAbandonClaim(
            deps.env.IDEMPOTENCY_KV,
            kvClaimKey(payload, payloadHeadSha),
            IDEM_SUPERSEDED,
            IDEMPOTENCY_SECONDS,
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          deps.log.warn(
            { ...baseFields, event: "review_superseded" },
            `superseded-claim KV write failed (a redelivery may review this obsolete commit): ${detail}`,
          );
        }
        await settleSkippedRow(deps, payload, payloadHeadSha, "superseded by a newer commit");
        return { kind: "superseded" };
      }
    }
    const appLevel = resolution.reviewLevel;
    if (appLevel !== null) {
      level = appLevel;
    } else {
      const fallback = await readDefaultReviewLevel(deps.env.DB);
      level = fallback.value;
      if (fallback.degraded) {
        deps.log.warn(
          { ...baseFields, event: "review_level_degraded", level: fallback.value },
          "operator default review level read degraded — using the documented default",
        );
      }
    }
    const appCfg = await resolveAppConfig(payload, deps);
    const modelOverrides = await resolveModelOverrides(payload, deps);
    const customProviders = await resolveCustomProviders(payload, deps);
    await resolveSandboxImage(payload, deps);
    assertAppConfigComplete(appCfg, customProviders, modelOverrides, payload.botRef.appId);
    const admissionFields = baseFields;
    const concurrency = await readReviewConcurrency(deps.env.DB, workspaceId, {
      warn: (readerFields, msg) => deps.log.warn({ ...admissionFields, ...readerFields }, msg),
    });
    const lifecycleScope: Scope = {
      appId: payload.botRef.appId,
      installationId: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
    };
    const inflightKey: InflightKey = {
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      workspace_id: workspaceId,
    };
    // THE ATTEMPT'S ONE HARD STOP is frozen HERE, before the admission row is
    // taken: that row's TTL must hold the whole attempt, so the instant cannot
    // be discovered afterwards. The cap runs from THIS delivery's claim, never
    // from the Queue send stamp: a message held behind the guard's cumulative
    // delayed retries is delivered long after it was enqueued, and an origin on
    // that stamp left every such delivery a spent deadline (I-000683). A row
    // written before the deadline column existed is anchored ONCE from its OWN
    // admission stamp — the only instant that attempt had — never from this
    // delivery's clock, so a redelivery or a recovery re-enqueue cannot move it.
    // The first writer wins the write itself (store), and a degraded cap read
    // throws so admission retries instead of inventing a cap.
    let deadlineMs: number;
    if (previousHandoff?.deadlineMs !== null && previousHandoff?.deadlineMs !== undefined) {
      deadlineMs = previousHandoff.deadlineMs;
    } else {
      const capMs =
        deps.attemptCapMs ??
        (await readReviewAttemptCapMs(deps.env.DB, {
          warn: (readerFields, msg) =>
            deps.log.warn({ ...(baseFields ?? payloadIdentityFields(payload)), ...readerFields }, msg),
        }));
      deadlineMs = (previousHandoff?.createdMs ?? roundStartedAt) + capMs;
    }
    const ttlSeconds = reviewGuardTtlForDeadline(deadlineMs, Date.now(), level);
    const admissionOpts: AcquireInflightOptions = {
      systemCap: concurrency.system,
      workspaceCap: concurrency.workspace,
      attemptId,
      ttlSeconds,
      headSha: payload.head_sha ?? null,
      now: new Date(Date.now()).toISOString(),
    };
    let admission = await acquireInflight(deps.env.DB, inflightKey, admissionOpts);
    if (!admission.ok && admission.reason === "pr-held" && admission.heldExpired) {
      const priorAttemptId = admission.heldAttemptId;
      const evidence = await priorAttemptStopEvidence(
        deps.env.DB,
        deps.getSandbox,
        deps.env.SANDBOX,
        priorAttemptId,
      );
      if (evidence === "no-container" || evidence === "revoked") {
        admission = await acquireInflight(deps.env.DB, inflightKey, {
          ...admissionOpts,
          priorStopped: { attemptId: priorAttemptId },
        });
      } else {
        deps.log.warn(
          { ...baseFields, prior_attempt_id: priorAttemptId, succession: evidence, event: "review_succession_refused" },
          evidence === "running"
            ? "the prior attempt's container is still running — the PR and its capacity stay with that holder"
            : "the prior attempt's sandbox could not be observed — no takeover; the PR stays held",
        );
      }
    }
    if (!admission.ok) {
      const errorCause = admission.reason === "error" ? describeInflightError(admission.cause) : undefined;
      const refusal: AdmissionRefusalFields = {
        reason: admission.reason,
        system_cap: concurrency.system,
        workspace_cap: concurrency.workspace,
        error_cause: errorCause,
      };
      if (errorCause !== undefined) {
        deps.log.warn(
          { ...baseFields, ...refusal },
          `review admission failed (storage error: ${errorCause}) — treating as held; no review admitted`,
        );
      }
      guardHeldOutcome = true;
      return {
        kind: "guard-held",
        commentClaimConsumed,
        admission: refusal,
        heldHeadSha: admission.reason === "pr-held" ? admission.heldHeadSha : null,
        level,
      };
    }
    inflight = { key: inflightKey, attemptId, ttlSeconds };
    if (deps.checks !== undefined) {
      checkBudgets = await readCheckBudgets(deps.env.DB, {
        warn: (readerFields, msg) =>
          deps.log.warn({ ...(baseFields ?? payloadIdentityFields(payload)), ...readerFields }, msg),
      });
      const earlyHeadSha = payload.head_sha || (await readWatermark("fail-open: reviewing normally"))?.headSha || null;
      if (earlyHeadSha !== null) {
        const earlyKey: IdempotencyKey = {
          installation_id: payload.installation_id,
          owner: payload.owner,
          repo: payload.repo,
          pr_number: payload.pr_number,
          head_sha: earlyHeadSha,
        };
        const earlyFields: ConsumerLogFields = {
          ...(baseFields ?? payloadIdentityFields(payload)),
          head_sha: earlyHeadSha,
          idempotency_key: kvClaimKey(payload, earlyHeadSha),
        };
        let liveHeadSha: string | null | undefined;
        const liveHead = async (): Promise<string | null> => {
          if (liveHeadSha === undefined) {
            let read: PrHeadAnswer | null = null;
            let faulted = false;
            try {
              read = await selectWatermark();
            } catch (err) {
              faulted = true;
              warnWatermarkFault("ack the keyed head now, do not re-review", err);
            }
            liveHeadSha = read?.headSha ?? null;
            if (!faulted && liveHeadSha === null) {
              deps.log.warn(
                earlyFields,
                "PR head watermark unreadable — ack the keyed head now, do not re-review",
              );
            }
          }
          return liveHeadSha;
        };
        const earlyDone = await kvDoneHit(deps.env.IDEMPOTENCY_KV, kvClaimKey(payload, earlyHeadSha), earlyFields, deps.log);
        let earlyReviewed = earlyDone;
        if (!earlyReviewed) {
          try {
            earlyReviewed = (await deps.store.findByIdempotencyKey(earlyKey)) !== null;
          } catch (err) {
            deps.log.warn(
              earlyFields,
              `early idempotency read failed — continuing to the checkout-keyed path: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        let movedHeadSha: string | null = null;
        if (earlyReviewed) {
          const live = await liveHead();
          if (live === null || live === earlyHeadSha) {
            deps.log.info(earlyFields, earlyDone ? "KV idempotency hit — ack" : "idempotency hit — ack");
            await settleSkippedRow(deps, payload, payload.head_sha, "already reviewed for this head");
            return { kind: "ok" };
          }
          movedHeadSha = live;
        }
        let earlyJournal: { id: string; phase: PublicationRow["phase"] } | null = null;
        try {
          earlyJournal = await journalHandoffRow(deps.env.DB, lifecycleScope, earlyHeadSha);
        } catch (err) {
          deps.log.warn(
            earlyFields,
            `early publication journal read failed — continuing to the checkout-keyed path: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (earlyJournal !== null) {
          const live = await liveHead();
          if (live === null || live === earlyHeadSha) {
            deps.log.info(
              earlyFields,
              `publication journal hit (phase ${earlyJournal.phase}, id ${earlyJournal.id}) — handing off to recovery, ack without a second paid review`,
            );
            await settleSkippedRow(deps, payload, payload.head_sha, "a publication for this head already exists");
            return { kind: "ok" };
          }
          movedHeadSha = live;
        }
        if (movedHeadSha !== null) {
          deps.log.info(
            earlyFields,
            `delivery keyed on ${earlyHeadSha.slice(0, 7)} but the PR head is ${movedHeadSha.slice(0, 7)} — reviewing the live head`,
          );
          await settleSkippedRow(deps, payload, earlyHeadSha, "superseded by a newer commit", { announceNoOp: true });
          // A rerun names the commit its run was created for. Reviewing the live
          // head would attach that result to a check the operator never asked
          // about (and pay twice), so the run is settled as skipped instead.
          if (payload.triggered_by === "check_run") {
            deps.log.info(
              earlyFields,
              "rerun targets a commit that is no longer the PR head — settling the check instead of reviewing the live head",
            );
            return { kind: "rerun-stale" };
          }
        }
        checkClaimSha = movedHeadSha ?? earlyHeadSha;
      }
    }
    if (startAttempt === undefined) {
      throw new Error(
        "review route: no attempt starter is configured — the queue handler must pass the Workflow route",
      );
    }
    const usageSource: AttemptRef["usageSource"] = resolution.scope === "shared" ? "shared" : "byok";
    deps.runnerConfigs.set(payload.botRef.appId, { appCfg, modelOverrides, customProviders });
    const handoff = await reserveAttemptHandoff(deps.env.DB, {
      deliveryKey,
      attemptId,
      payload,
      nowMs: Date.now(),
      // The SAME instant `deadlineMs` counted its cap from: the row stores the
      // origin, and every later delivery reads it back instead of this one's
      // clock — one origin per attempt, not one per delivery.
      createdMs: roundStartedAt,
      deadlineMs,
      enqueuedMs: queueSentAtMs,
    });
    if (handoff.attemptId !== attemptId) {
      deps.log.warn(
        {
          ...(baseFields ?? payloadIdentityFields(payload)),
          sandbox_id: sandboxId,
          attempt_id: attemptId,
        },
        `another delivery owns this handoff (attempt ${handoff.attemptId}) — ack without a second instance`,
      );
      return { kind: "routed" };
    }
    if (commentClaimConsumed) {
      await clearCommentClaimPayload(deps.env.DB, payload).catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          { ...(baseFields ?? payloadIdentityFields(payload)), attempt_id: attemptId },
          `comment claim payload clear failed — the row stays recoverable: ${detail}`,
        );
      });
    }
    handoffRecorded = true;
    if (handoff.deadlineMs !== null && handoff.deadlineMs !== deadlineMs) {
      await extendInflightTtl(
        deps.env.DB,
        inflightKey,
        attemptId,
        reviewGuardTtlForDeadline(handoff.deadlineMs, Date.now(), level),
      );
    }
    const attemptRef: AttemptRef = {
      attemptId,
      payload,
      level,
      roundStartedAt,
      // Both read from the ROW, never re-derived from this delivery's clock:
      // the origin and the instant it anchored are one pair, frozen by the
      // first writer.
      budgetStartMs: handoff.createdMs,
      deadlineMs: handoff.deadlineMs ?? deadlineMs,
      githubAppId,
      usageWorkspaceId,
      usageSource,
      checkBudgets,
      checkClaimSha,
      inflight,
      attempts,
    };
    try {
      const verdict = await startAttempt(deps, attemptRef);
      await markAttemptHandoff(deps.env.DB, deliveryKey, "created", Date.now());
      if (verdict !== "exists") {
        inflight = null;
        handedOff = true;
      }
    } catch (err) {
      if (err instanceof WorkflowCreateAmbiguousError) {
        await markAttemptHandoff(deps.env.DB, deliveryKey, "ambiguous", Date.now());
        inflight = null;
        handedOff = true;
        deps.log.warn(
          {
            ...(baseFields ?? payloadIdentityFields(payload)),
            sandbox_id: sandboxId,
            attempt_id: attemptId,
            event: "review_workflow_create_ambiguous",
          },
          `workflow instance creation was not confirmed — acked without a retry, the handoff stays for recovery (${err.message})`,
        );
        return { kind: "routed" };
      }
      if (err instanceof WorkflowCreateFailedError) {
        await markAttemptHandoff(deps.env.DB, deliveryKey, "failed", Date.now());
        throw err;
      }
      inflight = null;
      handedOff = true;
      throw err;
    }
    return { kind: "routed" };
  } catch (err) {
    if (handedOff) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    // The one cause this path can name from evidence: a GitHub rate limit, read
    // by the classifier the row's own prefix already uses. The error TEXT stays
    // as it was (operator counters read its prefix); the code rides beside it.
    const code: FailureCode =
      classifyGithubRateLimit(err) === null ? "review.internal.unclassified" : "review.github.rate_limited";
    deps.log.error(
      {
        ...(baseFields ?? payloadIdentityFields(payload)),
        sandbox_id: sandboxId,
        ...(level === undefined
          ? {}
          : {
              level,
              runner_timeout_ms: runnerTimeoutMs(level),
              orchestration: level === "deep" ? "parent" : "bun-fanout",
            }),
        error_code: code,
        attempt_id: attemptId,
      },
      `review failed: ${detail}`,
    );
    const persistedDetail =
      classifyGithubRateLimit(err) === "secondary" ? `${GITHUB_RATE_LIMIT_PREFIX}${detail}` : detail;
    try {
      await deps.failureStore.record({
        target_id: payload.targetId,
        installation_id: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        pr_number: payload.pr_number,
        head_sha: baseFields?.head_sha ?? payload.head_sha ?? "",
        stage: "pipeline",
        code,
        trackId: attemptId,
        message: FAILURE_SUMMARIES[code],
        error: redactExactSecrets(redactSecrets(persistedDetail), []),
      });
    } catch (recordErr) {
      const recordDetail = recordErr instanceof Error ? recordErr.message : String(recordErr);
      deps.log.warn(
        { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId },
        `review_failures insert failed: ${recordDetail}`,
      );
    }
    if (attempts >= QUEUE_MAX_ATTEMPTS && payload.head_sha) {
      try {
        await putAbandonClaim(
          deps.env.IDEMPOTENCY_KV,
          kvClaimKey(payload, payload.head_sha!),
          IDEM_FAILED,
          IDEMPOTENCY_SECONDS,
        );
      } catch (kvErr) {
        const kvDetail = kvErr instanceof Error ? kvErr.message : String(kvErr);
        deps.log.warn(
          { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId },
          `failed-claim KV write failed (the skip may still treat this commit as queued): ${kvDetail}`,
        );
      }
    }
    throw err;
  } finally {
    if (commentClaimConsumed && !handoffRecorded && !guardHeldOutcome) {
      await clearCommentClaimPayload(deps.env.DB, payload).catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId },
          `comment claim payload clear failed — the recovery pass may replay this delivery: ${detail}`,
        );
      });
    }
    if (inflight !== null) {
      try {
        await releaseInflight(deps.env.DB, inflight.key, inflight.attemptId);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId },
          `review admission release failed — the row expires by TTL (${inflight.ttlSeconds}s): ${detail}`,
        );
      }
    }
  }
}


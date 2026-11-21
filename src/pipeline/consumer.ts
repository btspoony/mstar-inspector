/**
 * Queue consumer — the review pipeline main flow.
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
  deliveryKeyOf,
  markAttemptHandoff,
  readAttemptHandoff,
  reserveAttemptHandoff,
} from "../store/review-route-store";
import {
  classifyGithubRateLimit,
  GITHUB_RATE_LIMIT_PREFIX,
  MAINTENANCE_DEFERRED_STAGE,
} from "../contracts/failure-stages";
import {
  idemKey,
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
// The hand-off's two fenced writes live in the Check registry (§7.9/§7.11.2):
// linking the publication the probe found, and releasing the claim to recovery.
import { type PublicationRow } from "../store/finding-lifecycle";
import { type Scope } from "../../packages/shared/src/recheck-wire";
import { getSandbox } from "./sandbox";
import {
  attemptSandboxId,
  type RunnerAppConfig,
} from "./review-attempt";
import {
  createReviewCommenter,
  type ReviewCommenter,
} from "./comment";
// Per-App credential resolution (lock L4): the consumer is a
// sanctioned reader of the dashboard store leaves (apps-store reads the
// review_bots row, secretbox decrypts the PEM) — the dashboard ↛
// pipeline/worker isolation is one-directional and unaffected.
import { createReviewBotsStore, type BotScope } from "../dashboard/apps-store";
import {
  checkGateOf,
  createTargetsStore,
  readEffectiveTargetSettings,
  type ReviewTargetRow,
} from "../dashboard/targets-store";
import { createSecretbox } from "../dashboard/secretbox";
// The operator default review depth (migration 0047 pairing): read ONLY when
// the target row's `review_level` is NULL, through the same runtime-config leaf
// the admission settings use.
import {
  getMaintenanceMode,
  maintenanceClosed,
  readDefaultReviewLevel,
} from "../dashboard/runtime-config-store";
// Per-App AI-config resolution: the same sanctioned reader
// edge — app-config-store reads bot_provider_keys / bot_model_config and
// decrypts keys via secretbox (itself a zero-dependency leaf, lock L1).
import {
  createAppConfigStore,
  type CustomProviderConsumerConfig,
} from "../dashboard/app-config-store";
import { getSandboxImage, type SandboxImageDefinition } from "../contracts/sandbox-images";
// §7.10 Check seam implementation: `checks.ts` owns the
// adapter AND the lifecycle it drives; this module owns the seam call sites.
import { createCheckLifecycle } from "./checks";
// Review admission (review-concurrency §1.2): one `review_inflight` row is the
// per-PR lock and the capacity reservation; the cap comes from the pipeline's
// single runtime-config reader (never a dashboard route import).
import {
  acquireInflight,
  describeInflightError,
  releaseInflight,
  type InflightKey,
} from "../store/inflight-store";
import { readReviewConcurrency } from "./concurrency-reader";
import {
  CHECK_UPDATE_DEFAULT,
  readCheckBudgets,
  type CheckBudgets,
} from "./check-budgets-reader";
// The attempt budget: the cap's read, the reserve ledger and the single
// runner-budget derivation. The Check store imports the same module, so neither
// side owns a second copy of the arithmetic.
import {
  readReviewAttemptCapMs,
  reviewGuardTtlForDeadline,
  runnerTimeoutMs,
} from "../review-budget";
// The admitted attempt's execution lives in its own module (layering:
// consumer → review-attempt-execution → review-attempt). Everything the
// admission half shares with it is imported from there, never duplicated.
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

// Per-call exec bounds (ms) — every sandbox exec carries an explicit timeout
// so a hung gh/git/model call fails deterministically instead of silently
// eating a container (qc3 F-001). The bounds themselves are ledger terms of
// the budget owner (`src/review-budget.ts`), which exports them.

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

// ---------------------------------------------------------------------------
// Review admission (WF-002 + review-concurrency §1.2): one review per PR at a
// time, bounded by the system and workspace caps. The KV mutex is gone — the
// `review_inflight` row (src/store/inflight-store.ts) is the lock AND the
// reservation, written before any sandbox starts and released in the finally.
// ---------------------------------------------------------------------------

/**
 * The round clock, the admission guard ledger and the derived pre-runner
 * cutoff are owned by `src/review-budget.ts`: `GUARD_TIMED_SANDBOX_STEPS`
 * bills this module's timed sandbox steps, `reviewGuardTtlSeconds` answers
 * from the same tier table the runner uses, and `deriveReviewBudget` turns
 * the platform cap, the live terminalize budget and the level into the
 * cutoff every pre-runner step below declines against. The backoff table
 * stays here — it is queue-retry policy, not review wall clock.
 */

/**
 * Guard-held backoff schedule (seconds), indexed by message.attempts (1-based
 * — the first delivery is attempt 1). quick/default: 60s → 300s → 300s → 900s →
 * 900s; deep: 90s → 480s → 300s → 900s → 900s.
 *
 * The schedule must COVER the level's guard TTL, and no rung may outlive the
 * lock it waits on: every entry stays BELOW the level's guard TTL
 * (2292s / 2412s / 2458s), while the CUMULATIVE sum (2460s / 2670s) EXCEEDS it — so by
 * the final delayed attempt the in-flight row has expired and the admission's
 * expired-reclaim branch lets this message take the lock instead of being
 * dropped. Without that sum, a legal review (600s+ runner) could hold the PR
 * past the whole backoff and a `synchronize` for a NEW commit would never be
 * reviewed.
 *
 * The rungs after the first two are deliberately SHORT (300-900s, never the
 * 2100s tail this table used to end on): the live review releases the guard
 * when it finishes, so an unlucky attempt waits at most one rung (900s) rather
 * than half an hour — a staging delivery that arrived 6s before the release ate
 * 35 minutes on the old tail, and the worst case is now 15.
 *
 * Attempts past the schedule's end have consumed the queue's max_retries
 * (`wrangler.jsonc`: one per rung, plus the terminal delivery) and must be
 * acked, not retried (a further retry() would land the job on the DLQ).
 */
const GUARD_RETRY_DELAYS_SECONDS: Record<ReviewLevel, readonly number[]> = {
  quick: [60, 300, 300, 900, 900],
  default: [60, 300, 300, 900, 900],
  deep: [90, 480, 300, 900, 900],
};

/** Guard-held backoff schedule for the job's review level (spec d5-budget L4). */
export function guardRetryDelaysSeconds(level: ReviewLevel): readonly number[] {
  return GUARD_RETRY_DELAYS_SECONDS[level];
}




/**
 * §7.10 held-Check visibility: a delivery the in-flight guard refused still owns
 * the `queued` Check its attach created, and without context that run would sit
 * nameless for the whole backoff (measured on staging 2026-11-13: 41 of one
 * run's 49 minutes were queue time). Relabel it with the HOLDER's head, so the
 * PR page names the review this commit waits for; the run stays `queued`
 * because nothing has started, and only the summary moves.
 *
 * Best-effort by contract, exactly like the skip settlement: one warn on a
 * fault, and the delayed retry the caller is about to schedule never changes.
 * The row lookup keys on the PAYLOAD's head sha — the commit this delivery
 * attached with — never the holder's: the holder's commit belongs to another
 * attempt and another delivery.
 *
 * EVERY part is bounded, because all of it runs before that retry: the settings
 * read by the knob's own documented default (a read must not eat the budget it
 * exists to read), the store write plus the GitHub PATCH by the operator's
 * `review.check.update_timeout_ms`. Only ONE settings read is paid — the value
 * is reused for the send.
 */
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
    // ONE budget read, the same value the terminalize hook uses. A degraded read
    // answers the documented defaults and warns once through the reader itself.
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
    // The store write and the PATCH share the operator's update budget: the
    // adapter applies the same value to the send it issues.
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

/**
 * Handle a guard-held message (bugbot BB-3). The guard is not an error
 * state: instead of throwing (which burns the queue's three immediate
 * retries and DLQs the job — including later synchronize events for the same
 * PR — while the first review is still running), schedule a per-message
 * DELAYED retry via `message.retry({ delaySeconds })`. After the final
 * delayed attempt, ack with a warning: the job is dropped cleanly and the
 * next event for the PR (e.g. a later synchronize) re-reviews. Structured
 * log fields carry the PR identity + attempt count + the admission refusal
 * (`reason` and both caps — spec §1.3: a held line must say which bound held
 * it); the idempotency key is not yet derivable at guard time (it comes from
 * the checked-out sha).
 *
 * `heldHeadSha` is the live row's sha: a `pr-held` drop is only benign while
 * that review covers THIS message's commit. The cumulative backoff
 * (2460s quick/default, 2670s deep) now EXCEEDS the level's guard TTL
 * (2292s / 2412s / 2458s), so the final delayed attempt can reclaim the expired row
 * and review the new commit. A drop that still happens — a cap/storage
 * refusal, or a row that outlived the schedule — must leave a trace, so the
 * terminal ack records the drop row for a commit the live review never
 * covers, and stamps that commit's idempotency claim `dropped` so both the
 * supersede skip and the worker's pre-check stop treating the abandoned job
 * as proof: a redelivery for that commit enqueues again.
 */
async function handleGuardHeld(
  message: Message<ReviewJobPayload>,
  deps: ProcessDeps,
  admission: AdmissionRefusalFields,
  heldHeadSha: string | null,
  level: ReviewLevel,
  commentClaimConsumed: boolean,
): Promise<void> {
  const fields = { ...toBaseFields(message.body), ...admission };
  // Why this message was held, appended to both lines: the delay schedule alone
  // never says whether the PR, the tenant, or the deployment is full. A storage
  // refusal adds its own cause — "error" alone cannot tell a dead D1 binding
  // from a capacity released between the admission's two statements.
  const cause = admission.error_cause === undefined ? "" : `; cause ${admission.error_cause}`;
  const heldBecause = `held by ${admission.reason} (system_cap ${admission.system_cap}, workspace_cap ${admission.workspace_cap}${cause})`;
  // Only a `pr-held` refusal means a review for THIS PR is running; a cap or
  // storage refusal means none exists at all — saying "still in flight" there
  // would send an operator looking for a review that was never started.
  const what = admission.reason === "pr-held" ? "review already in flight" : "review not admitted";
  // The App's resolved depth rides the outcome: processMessage resolved it from
  // the App row BEFORE the guard, so this retry path reads no storage at all.
  const delays = guardRetryDelaysSeconds(level);
  const delaySeconds = delays[message.attempts - 1];
  let retryAllowed = delaySeconds !== undefined;
  let restoreFailure: string | null = null;
  if (delaySeconds !== undefined) {
    if (commentClaimConsumed && message.body.comment_id !== undefined) {
      const payload = message.body;
      try {
        // Other deliveries cannot consume a consumed row; only this delivery can restore it.
        await deps.env.DB.prepare(
          `UPDATE comment_trigger_claims
              SET state = 'queued', payload_json = ?, consumed_ms = NULL, queued_ms = ?
            WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND comment_id = ?
              AND state = 'consumed'`,
        )
          .bind(
            JSON.stringify(payload),
            // Let the scheduled delivery arrive before the outbox recovery window starts.
            Date.now() + delaySeconds * 1000,
            payload.installation_id,
            payload.owner,
            payload.repo,
            payload.pr_number,
            payload.comment_id,
          )
          .run();
      } catch (err) {
        retryAllowed = false;
        const detail = err instanceof Error ? err.message : String(err);
        restoreFailure = `comment claim restore failed: ${detail}`;
        deps.log.warn(fields, `comment claim restore failed — dropping through terminal handling: ${detail}`);
      }
    }
  }
  if (retryAllowed) {
    // Say WHY nothing has started: the attach already put a `queued` run on
    // this commit, and the relabel adds the holder's context to it. Only a
    // `pr-held` refusal names a live review to wait for — a cap/storage
    // refusal has no holder and must not claim one.
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
  deps.log.warn(
    fields,
    restoreFailure !== null
      ? `review dropped: ${restoreFailure} (attempt ${message.attempts}; ${heldBecause}) — acking, no DLQ`
      : `${what} after ${delays.length} delayed retries (attempt ${message.attempts}; ${heldBecause}) — acking, no DLQ (guard-held is not an error; the next event for the PR re-reviews)`,
  );
  message.ack();
  // A cap/storage refusal that survived the whole backoff leaves the review
  // DROPPED with no other D1 trace: no attempt for this PR ever reached the
  // runner, so neither `reviews` nor the failure sweep (which counts
  // `review_failures`) would see it. Record one row here — the terminal drop
  // is the failure event, not each refused attempt. Best-effort: a warn only.
  //
  // `pr-held` is silent only while the live review covers THIS commit: a
  // duplicate of the same sha is normal traffic, and an unresolved identity on
  // either side proves nothing — a null payload sha (comment trigger) and a
  // held row's `""` (that same convention, persisted) both mean "no commit
  // identity recorded", NOT "a different commit". Only two non-empty shas that
  // differ name a commit the live review will never cover, so only that takes
  // the drop-record branch below.
  const payloadSha = message.body.head_sha;
  const heldSha = heldHeadSha ?? "";
  if (
    restoreFailure === null &&
    admission.reason === "pr-held" &&
    (payloadSha === null || payloadSha === "" || heldSha === "" || payloadSha === heldSha)
  ) {
    return;
  }
  // Convention for a job that never resolved a sha (comment trigger —
  // `head_sha` is null in the payload): the row's `head_sha` is `""` (the
  // 0010 column allows it; only `reviews` forbids it), and the PR identity
  // stays in the error text so the row is joinable back to the PR — a bare
  // `""` row tells an operator nothing about which PR was dropped.
  const headSha = payloadSha ?? "";
  // The newer commit's enqueue claim is the supersede skip's ONLY proof, so a
  // job dropped here for good must stop being proof: overwrite its key with
  // "dropped" (the same TTL the worker claim used), the value both readers
  // treat as "not reviewed". `putAbandonClaim` never downgrades `done` — a sha
  // this consumer already reviewed stays proof, or the redelivery would
  // re-review a reviewed commit. Best-effort — a KV fault only leaves a stale
  // "1", which the skip then accepts and `review_failures` traces (the drop
  // row below).
  if (headSha !== "") {
    const claimKey = idemKey({
      installation_id: message.body.installation_id,
      owner: message.body.owner,
      repo: message.body.repo,
      pr_number: message.body.pr_number,
      head_sha: headSha,
    });
    try {
      await putAbandonClaim(deps.env.IDEMPOTENCY_KV, claimKey, IDEM_DROPPED, IDEMPOTENCY_SECONDS);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(fields, `dropped-claim KV update failed (the skip may still treat this commit as queued): ${detail}`);
    }
  }
  const identity = `${message.body.owner}/${message.body.repo}#${message.body.pr_number}`;
  // A shifted-sha drop names the sha the live review holds, so an operator can
  // see which commit was skipped rather than guessing from the refusal code.
  const heldNote =
    admission.reason === "pr-held" && payloadSha && heldSha && payloadSha !== heldSha
      ? ` — the in-flight review holds head_sha ${heldSha}, so this commit was never reviewed`
      : "";
  // §7.9: the TERMINAL refusal is the only guard outcome that settles this
  // delivery's attached run. The retried refusals (the rungs above) settle
  // nothing — a duplicate delivery shares this attempt_key, and the live
  // review's row must never be closed `neutral` by another message's refusal.
  // This is the real drop: the run attached for this message will never
  // execute, so it is settled `neutral` with the refusal named. Best-effort;
  // the ack and the drop record are unaffected.
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
      error: `${restoreFailure !== null ? `review dropped: ${restoreFailure}; admission refused` : `review dropped after ${delays.length} refused retries`}: ${admission.reason} (system_cap ${admission.system_cap}, workspace_cap ${admission.workspace_cap}${cause}) — PR ${identity}, head_sha ${
        headSha === "" ? "unresolved (comment trigger, no sha in payload)" : headSha
      }${heldNote}`,
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(fields, `review_failures insert failed (drop trace lost): ${detail}`);
    });
}

// ---------------------------------------------------------------------------
// Check lifecycle seam (spec review-lifecycle §7.7 steps 4/12 +
// §7.10) — §7.10-owned types so M8 ships and works before the
// implementation: an ABSENT `checks` dependency produces NO Checks while M8
// remains fully operational. Declared with §7.7 types only (Scope, Lease) —
// never a §7.9 type. checks.ts supplies the implementation
// (`createCheckLifecycle`) and `createReviewConsumer` injects it; the dependency stays
// optional, and a hooks object that cannot reach a Checks surface still
// produces no row and no remote run. Hook exceptions/timeouts are caught by
// the consumer (the begin hook gets ≤2 requests / 2 seconds of consumer wait;
// the terminalize hook runs after the review reaches a terminal outcome — a
// pre-publication failure included — and may wait ≤10 seconds, with
// its promise handed to the invocation context — no publication path waits for
// hook retries).
// ---------------------------------------------------------------------------



/**
 * Outcome of the per-message commenter resolution (architect lock
 * L4): `ok` carries the commenter the review runs with PLUS the row's
 * numeric `github_app_id` (the §7.10 Check seam's App identity — the row is
 * already read here, no second query); `paused` is the
 * DISTINCT typed outcome for a paused App (review_enabled=0) — returned
 * AFTER the status/deleted gates (disabled is judged first and keeps its
 * byte-identical throw→retry→DLQ semantics) and consumed by processMessage
 * as an immediate ack-skip. NOT a throw: a throw would enter the
 * retry→DLQ path — the wrong semantics for an intentional pause.
 */
type CommenterResolution =
  | {
      kind: "ok";
      commenter: ReviewCommenter;
      githubAppId: number;
      workspaceId: string;
      /**
       * The target's EFFECTIVE review depth (migrations 0047 + 0067) — `null`
       * = follow the operator default. An inheriting target answers the
       * workspace default, an own-columns row its stored (vocabulary-checked)
       * level, so the depth rides the same read as the Check gate.
       */
      reviewLevel: ReviewLevel | null;
      /**
       * The bot's `scope` (migration 0058) — the RP source multiplier's only
       * input at the metering write. Read off the SAME row this resolution
       * already fetched, so no second bot read is spent on it.
       */
      scope: BotScope;
      /**
       * The workspace the LEDGER row is charged to: the TARGET's
       * (`review_targets.workspace_id`), which is the tenant that asked for the
       * review — and the same workspace the enqueue's ceiling check reads.
       *
       * Deliberately separate from `workspaceId` above: that one is the bot's
       * owning workspace (`bot_workspaces`), which is also the concurrency /
       * inflight key and must stay bot-scoped. For an owned bot the two are
       * equal; for a SHARED bot they are not — `createOnSharedBot` writes only
       * the target into the tenant's workspace — and charging `workspaceId`
       * would bill the bot's owner for every tenant's spend and leave each
       * tenant's own month at zero.
       */
      usageWorkspaceId: string;
    }
  | { kind: "paused" };

/**
 * Resolve the commenter for one message (architect lock L4
 * — consumer-side credential resolution; single path —
 * `payload.botRef.appId` is required, the env-App legacy branch is retired):
 *
 * The `review_bots` row via D1 (re-read per message),
 * gated in order: missing row / soft-deleted / disabled THROWS
 * (unchanged retry→DLQ semantics; the failed gate EVICTS the cached
 * instance) → the job's target row (`payload.targetId`, read without a
 * workspace predicate: execution, not a tenant face), which must exist and
 * belong to this bot → PAUSED (either `review_enabled` at 0, lock L4) returns
 * the DISTINCT `paused` outcome AFTER those gates, leaving any cached
 * instance in place (resume reuses the warm instance — the credential
 * fingerprint ignores review_enabled) → the row's PEM decrypted in memory
 * (secretbox, AAD `github_apps.private_key_enc:<id>`) →
 * `createAppCommenter({ APP_ID: String(github_app_id), PRIVATE_KEY })`,
 * cached per botId in `deps.appCommenters` with the row's credential
 * fingerprint (architect lock L1: `github_app_id` + `private_key_enc` envelope
 * exact-string match — reuse on match, rebuild + replace on rotation).
 *
 * Any unresolvable state — missing row, disabled, soft-deleted, no target, a
 * target naming another bot, missing DASHBOARD_ENCRYPTION_KEY
 * (SecretboxKeyError), tampered envelope — THROWS: the structured error log +
 * rethrow keep the existing retry/DLQ semantics and no GitHub write ever
 * happens. The decrypted PEM lives only in this call's memory and the
 * commenter instance; it is never logged.
 */
async function resolveCommenter(payload: ReviewJobPayload, deps: ProcessDeps): Promise<CommenterResolution> {
  const botId = payload.botRef.appId;
  const row = await createReviewBotsStore(deps.env.DB).getAppById(botId);
  if (row === null) {
    deps.appCommenters.delete(botId);
    // Two resolutions are indistinguishable from a missing one (the INNER
    // JOINs yield null for all three): no `bot_workspaces` mapping and a
    // soft-deleted workspace — the message names every cause.
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
  // The workspace-owned half of the configuration — review depth, the Check
  // gate and the business pause — lives on the target the WEBHOOK resolved and
  // the job named. The consumer never re-decides it; it only proves the row
  // exists and belongs to this bot. A missing target, or one naming another
  // bot, is UNKNOWN configuration, not an absence to default: reviewing with
  // one row's credential and another's gate is exactly what the split forbids,
  // and the queue is not a trust boundary. The structured failure channel
  // (retry → DLQ) is the answer.
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
  // Architect lock L4: the PAUSED gate sits AFTER the status/
  // deleted gates (disabled is judged first — its throw→retry→DLQ semantics
  // stay byte-identical) and returns the DISTINCT typed outcome instead of
  // throwing. Either pause flag suppresses the review: the bot's operational
  // pause and the target's business pause. The cached instance (if any) is
  // deliberately LEFT in place — resuming must reuse the warm instance, and
  // the credential fingerprint (`github_app_id` + `private_key_enc`) is immune
  // to review_enabled writes.
  if (row.review_enabled === 0 || target.review_enabled === 0) {
    // Architect lock L4: the pause gate makes ZERO credential/GitHub calls —
    // no decrypt, no commenter, no token. A delivery attached BEFORE the pause
    // is settled by the STORE-only path (§7.9), which needs no commenter.
    return { kind: "paused" };
  }
  // The credential-fingerprint hardening (architect lock L1): the fingerprint is the
  // exact string pair read from the row THIS call already fetched — zero
  // extra reads, no hashing, never `updated_at` (the per-webhook
  // touchLastWebhook would churn it). A re-saved identical PEM yields a NEW
  // AES-GCM envelope → one harmless rebuild; a real rotation rebuilds with
  // the new credential on the very next message.
  const fingerprint = JSON.stringify([row.github_app_id, row.private_key_enc]);
  // The workspace defaults are read only for a target that actually inherits
  // (migration 0067), so an own-columns target pays no second D1 round trip.
  const effective = await readEffectiveTargetSettings(deps.env.DB, target);
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
  // Cache miss (first message for this App) or fingerprint mismatch
  // (rotation): decrypt + build + REPLACE the entry. A decrypt failure here
  // leaves any pre-rotation entry in place but UNREACHABLE — it can only
  // ever be returned by an exact fingerprint match, i.e. the envelope
  // reverting to that entry's own bytes.
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

/**
 * One PR head watermark answer, read from the App ledger (migration 0044) — the
 * select-only point read on `pull_requests`' UNIQUE key that tells a delivery
 * whether the queue has already overtaken it. `null` shas mean the row exists
 * but no delivery ever stamped it; a `null` answer means the read could not
 * answer at all.
 */
type PrHeadAnswer = { headSha: string | null; headAt: string | null };

/**
 * Resolve the per-App AI config for one message (single path —
 * `botId` is required).
 * ONE `getAppConfig` read per message (all
 * provider keys + the model chain in a single store call — never per key),
 * decrypted in memory. Per spec §4.4, the model chain is the
 * App's DEFAULT chain row (bot_model_chains name = 'default'); an App with
 * no default row resolves modelChain = null (fail-closed, unchanged). The
 * read hangs off the same bot resolution as
 * `resolveCommenter` (the App row is already proven present, active and
 * non-deleted there) and runs BEFORE the in-flight guard so an unresolvable
 * config fails with zero side effects. Keys are re-read every message (no
 * cache) so a dashboard key update applies to the very next review.
 * Failure = fail closed: an undecryptable envelope (tampered row, AAD
 * mismatch) or a missing/malformed DASHBOARD_ENCRYPTION_KEY throws — the
 * structured error log + rethrow keep the existing retry/DLQ semantics.
 * AL-24-5: there are no global keys to fall back to — the App's own keys are
 * the ONLY source, and assertAppConfigComplete (run right after this call)
 * fail-closes any chain provider without a configured key. Decrypted keys
 * live only in this call's memory and the assembled exec env — never
 * logged, never in queue payloads or errors.
 */
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

/**
 * Resolve the App's per-role model overrides for one message (the
 * model-chain rework, spec §4.4): role → verbatim chain value via
 * the decrypt-free `getModelOverridesForConsumer` read (a model selector is
 * configuration, not a secret — no secretbox). The seat → chain mapping
 * resolves each referenced seat to its chain's value; seats with NO
 * reference row (absent = default) and seats referencing the default chain
 * are OMITTED, so the map only carries seats whose chain differs from the
 * App default — byte-identical to the pre-chains bot_model_roles semantics
 * for migrated Apps. An App with NO overrides → `undefined` — the runner
 * input JSON omits the field, byte-identical to a no-map run (the global
 * constraint: empty map = unchanged runner behavior). Hangs off the same
 * bot resolution as `resolveAppConfig` (the App row is already proven
 * present, active and non-deleted there) and runs BEFORE the in-flight
 * guard so a resolution failure has zero side effects. The map is re-read
 * every message (no cache) so a dashboard seat update applies to the very
 * next review. A resolution failure rethrows with the same app-id-prefixed
 * context wrapper as `resolveAppConfig` (greppable retry/DLQ triage).
 */
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
/**
 * Resolve the App's custom-provider declarations for one message (AL-23-1):
 * the DECRYPTING `getCustomProvidersForConsumer` read
 * (every declaration plus its key, provider_id-ascending) via
 * createAppConfigStore — the getAppConfig analogue for bot_custom_providers.
 * An App with NO declarations → `undefined` — the runner input JSON
 * serializes byte-identically to a no-declaration run (the global
 * constraint: empty = unchanged runner behavior). Hangs off the same
 * bot resolution as `resolveAppConfig` (the App row is already proven
 * present, active and non-deleted there) and runs BEFORE the in-flight
 * guard so a resolution failure has zero side effects. The set is re-read
 * every message (no cache) so a dashboard declaration update applies to
 * the very next review.
 * The per-attempt cost — one extra SELECT plus N AES-GCM decryptions, paid
 * even on guard-held/deduped attempts — is accepted by design (QC wave-1
 * S-001): small next to clone/diff, and it is what makes declaration updates
 * apply to the very next review instead of a freshness window.
 * A read/decrypt failure rethrows with the app-id-prefixed context wrapper
 * — an undecryptable envelope (tampered row, AAD mismatch) fails CLOSED,
 * never a silent skip (the getAppConfig convention). Decrypted keys live
 * only in this call's memory and the assembled exec env — never logged,
 * never in the runner input JSON, never in queue payloads or errors.
 */
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

/**
 * Resolve the App's sandbox image for one message: the
 * `review_bots.sandbox_image_id` stored selection through the CLOSED
 * source-controlled registry (`getSandboxImage`) — the ONE deliberate
 * resolution interface between App storage and execution. Fails CLOSED with a
 * structured, non-secret error (an id + app id, never secrets) when the saved
 * id is unknown or not an enabled registry entry — an unknown id can only
 * appear via a direct DB write or a registry contraction, and it must never
 * start a sandbox. Runs BEFORE the in-flight guard / sandbox (zero side
 * effects on failure, F-001 structured channel via the caller's catch) and
 * BEFORE `assertAppConfigComplete`. The definition is used later, when the
 * sandbox is created; it declares no provider and no model. Re-read per message (no cache)
 * so a dashboard image update applies to the very next review.
 */
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

/**
 * Fail-closed per-App configuration gate (AL-24-5 — zero
 * global fallback): the App's modelChain is the ONLY chain source and every
 * provider on the chain must have a key source in the App's OWN config — a
 * BYOK allowlist pool (bot_provider_keys, provider id) or a custom
 * declaration with a non-blank key pool. The SAME requirement applies to
 * selector of every per-role override chain (Bugbot 7aaf18f4): a role
 * override referencing a provider with no configured key must fail closed
 * here, never after the runner clones/starts (the F-001 channel is the
 * fail boundary either way). Missing/blank chain or a chain provider with
 * no key source throws; the error flows through the F-001 structured channel
 * (review failed log + review_failures stage="pipeline" row + rethrow →
 * retry×3 → DLQ) — NO webhook-face reject, NO pause state, NO runtime guard
 * beyond this channel (AL-24-5 verdict 3). The check runs AFTER App
 * resolution and BEFORE the in-flight guard/sandbox, so a misconfigured App
 * fails with zero side effects.
 *
 */
function assertAppConfigComplete(
  appCfg: RunnerAppConfig,
  customProviders: readonly CustomProviderConsumerConfig[] | undefined,
  modelOverrides: Record<string, string> | undefined,
  appId: string,
): void {
  const chain = appCfg.modelChain === null ? "" : appCfg.modelChain.trim();
  // AL-24-5 fail-closed: a chain must contain at least one non-empty
  // comma-separated selector. `","` / `" , "` / `",,,"` are all "missing" —
  // the runner's parseModelSelectors would yield [] and fall back to the
  // in-image DEFAULT_MODEL_PATTERN scaffold (which must stay unreachable
  // from the consumer), and chainHeadSelector would record NULL on a
  // successful put (Interfaces: success never NULL).
  const hasSelector = chain.split(",").some((segment) => segment.trim() !== "");
  if (!hasSelector) {
    throw new Error(`per-App config incomplete: app ${appId}: missing model chain`);
  }
  // The env names the App's OWN config can supply: allowlisted BYOK keys
  // (provider id → envName — non-blank values only) + custom declarations.
  const availableProviders = new Set<string>();
  for (const [provider, keys] of Object.entries(appCfg.keys)) {
    if (providerEnvName(provider) !== undefined && keys.some((key) => key.trim() !== "")) {
      availableProviders.add(provider);
    }
  }
  for (const decl of customProviders ?? []) {
    if (decl.api_keys.some((key) => key.trim() !== "")) availableProviders.add(decl.provider_id);
  }
  // Every chain that must resolve to configured keys: the App's modelChain
  // plus each per-role override's selector chain (Bugbot 7aaf18f4 — the
  // bot_model_roles selectors reach the runner as the `modelOverrides`
  // input field, so they carry the same fail-closed requirement). Both use
  // the runner's parseModelSelectors grammar (comma-separated, trimmed,
  // empty segments dropped; provider = the segment before the first `/`;
  // a selector whose shape yields no provider is left to the runner exactly
  // as the chain path does today — no new fail is invented here).
  // Each override chain must ALSO pass the same zero-selector check as the
  // base chain below (PR #11 review BUG-01): a role chain that trims to a
  // raw `,` / `,,,` / whitespace would otherwise slip past the gate, reach
  // the runner as present-but-empty (runner-side `trim() !== ""` counts it
  // as present), and either run the in-image DEFAULT_MODEL_PATTERN scaffold
  // (with the ark key) or fail at stage=runner AFTER side effects.
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
      if (selector === "") continue; // the runner drops empty segments too
      const provider = selector.split("/")[0]!.trim();
      if (!availableProviders.has(provider)) {
        const where = role === null ? "" : `role override \`${role}\` `;
        // A retired alias is not a missing key: the image declares no provider
        // anymore, so the chain must name a provider the runtime can serve.
        throw new Error(
          provider === "ark-plan"
            ? `per-App config incomplete: app ${appId}: ${where}the ark-plan provider was removed — point the chain at a provider the runtime serves (a built-in catalog provider with its key configured, or your own declaration)`
            : `per-App config incomplete: app ${appId}: ${where}provider ${provider} has no configured key`,
        );
      }
    }
  }
}



/**
 * Does the ledger's newer commit own a job that may still run? The worker
 * claims the idempotency key only AFTER a successful `REVIEW_QUEUE.send`, so
 * the key proves that commit was enqueued. The ledger alone proves nothing:
 * every verified non-reject delivery advances it, including ones that enqueue
 * nothing (a `synchronize` in `open` mode, a paused App, a failed send), so a
 * skip backed by the ledger alone would ack a delivery whose PR head has no
 * review.
 *
 * `"1"` (queued) and `"done"` (reviewed by this consumer) are that proof;
 * `"dropped"` (the guard's terminal ack in handleGuardHeld), `"failed"` (the
 * final delivery is heading to the DLQ), `"paused"` (the App is paused),
 * `"degraded"` (the run ended in a degraded notice) and `"superseded"` (this
 * sha was itself replaced) are NO proof — every one names a commit that was
 * never reviewed, so this delivery must review rather than skip.
 *
 * This is a POINT-IN-TIME read, not a reservation: it proves the newer job was
 * enqueued and not yet terminally dropped when the ack was written. That job
 * can still be dropped afterwards (see handleGuardHeld); the `review_failures`
 * row it leaves is the only trace, and nothing re-enqueues this delivery.
 *
 * Fail-open: an absent ledger sha, an absent key or a KV fault all mean "no
 * proof" → review normally (a fault logs one warn line).
 */
async function newerCommitHasJob(
  deps: ProcessDeps,
  payload: ReviewJobPayload,
  headSha: string | null,
  fields: ConsumerLogFields,
): Promise<boolean> {
  if (!headSha) return false;
  try {
    // Inside the try: an empty ledger sha makes `idemKey` throw, and that is
    // "no proof" too — never a failed delivery.
    const key = idemKey({
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      head_sha: headSha,
    });
    const claim = await deps.env.IDEMPOTENCY_KV.get(key);
    return isReviewClaim(claim);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(fields, `supersede KV read failed — reviewing normally: ${detail}`);
    return false;
  }
}
/**
 * Test seam for createReviewConsumer: additive overrides for the process
 * dependencies (store / failureStore / per-App commenter factory /
 * getSandbox) plus the execution route. The contract
 * `createReviewConsumer(env)` is unchanged — every field defaults to the
 * production implementation when omitted.
 */
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
  /**
   * How this host starts an admitted attempt. Production's queue handler passes
   * the Workflow binding — one instance per admitted attempt; a test harness
   * passes the same step composition with an in-place step, so every suite
   * drives the phases through the one route.
   */
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
 * A Workflow `create` whose reply was lost. The instance may exist, so the
 * delivery is ACKED and never retried: a redelivery mints a fresh attempt id
 * and could pay twice. The handoff row stays for recovery.
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

/**
 * Read a create rejection's class. Only a genuinely unknown outcome may be
 * acked as ambiguous:
 * - "already exists" means the instance IS there (our own redelivery) → exists;
 * - an RPC status in the 4xx range (except the retryable 408/425/429) and a
 *   `TypeError` (a binding/class/validation failure, thrown before the call
 *   left this isolate) are DEFINITE;
 * - anything else — no status, a transport error, a 5xx — is unknown.
 */
function classifyWorkflowCreateFailure(err: unknown): "exists" | "definite" | "unknown" {
  const message = err instanceof Error ? err.message : String(err);
  if (/already exists/i.test(message)) return "exists";
  if (err instanceof TypeError) return "definite";
  const status = (err as { status?: unknown } | null)?.status;
  if (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425 &&
    status !== 429
  ) {
    return "definite";
  }
  return "unknown";
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
    const verdict = classifyWorkflowCreateFailure(err);
    if (verdict === "exists") return "exists";
    if (verdict === "definite") throw new WorkflowCreateFailedError(ref.attemptId, err);
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
  // The per-App commenter cache (lock L4) is also the Check lane's
  // credential route: the lifecycle resolves THIS message's App adapter from
  // it, so a Check never mints a token, client or permission set of its own.
  const appCommenters = new Map<string, { commenter: ReviewCommenter; fingerprint: string; githubAppId: number }>();
  // One App-ledger store per consumer: `selectPrHead` is the supersede
  // decision's point read and must not rebuild the store per message.
  const appsStore = createReviewBotsStore(env.DB);
  // One target store per consumer: the Check lane's gate read resolves the
  // bot's target on every terminalization instead of rebuilding the store.
  const targetsStore = createTargetsStore(env.DB);
  const deps: ProcessDeps = {
    env,
    store: overrides.store ?? createArtifactStore(env.DB),
    targets: targetsStore,
    failureStore: overrides.failureStore ?? createFailureStore(env.DB),
    appCommenters,
    // The attempt's live objects and credentials, registered by the host that
    // resolved them: a phase re-derives what it needs from these instead of
    // receiving them (or a token) across a boundary.
    runnerConfigs: new Map(),
    checkSettlements: new Map(),
    credentials: new Map(),
    // Production factory (§7.5/§7.7 step 11): the commenter is bound
    // to the thread store (`createReviewCommenter(env, { db })`) so
    // `discoverThread` / `resolveFindingThread` are live for the resolution
    // step — the single construction point stays src/pipeline/comment.ts.
    createAppCommenter: overrides.createAppCommenter ?? ((cred) => createReviewCommenter(cred, { db: env.DB })),
    getSandbox: overrides.getSandbox ?? ((binding, id) => getSandbox(binding, id)),
    selectPrHead: overrides.selectPrHead ?? appsStore.selectPrHead,
    findIncrementBase: overrides.findIncrementBase ?? findIncrementBase,
    attemptCapMs: overrides.attemptCapMs,
    log,
    background,
  };
  // §7.10 Check seam: production always supplies the
  // lifecycle; an override replaces it wholesale. An App whose commenter
  // carries no Checks surface yields `null` from `getAdapter`, and the
  // lifecycle then registers no attempt at all. The lifecycle needs NO
  // consumer-wide cancellation state: each `begin` receives its own latch.
  deps.checks =
    overrides.checks ??
    createCheckLifecycle({
      db: env.DB,
      nowMs: () => Date.now(),
      getAdapter: (scope) => appCommenters.get(scope.appId)?.commenter.checks ?? null,
      // The Check gate is the target's configuration. A target IS a repository
      // (migration 0067) and a Check's stored scope carries the bot with the
      // delivery's owner/name, so this is one index seek on the target's own
      // cache columns — the delivery refreshed them, so no second resolution.
      // An unreadable row is `null` (fail-closed).
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
        // The gate is the EFFECTIVE one (migration 0067): an inheriting target
        // runs on the workspace floor, not on the inert placeholder its row
        // carries. An unreadable verdict array is still `null` (fail-closed).
        return checkGateOf(await readEffectiveTargetSettings(env.DB, row));
      },
    });
  return deps;
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
    // ONE read per invocation; nothing else in the batch runs. Every delivery
    // is DEFERRED where the queue still allows it — acking would drop the
    // review for good, while the window is temporary. ONE line per invocation
    // (the queue and the batch size it deferred), not one per message: the batch
    // is the unit the platform redelivers.
    //
    // `retry` is the FIRST choice because it is the only path that keeps the
    // review. Two deliveries have no redelivery left — a runtime that offers no
    // `message.retry`, and a message already on its LAST platform delivery
    // (`wrangler.jsonc` max_retries 5 ⇒ QUEUE_MAX_ATTEMPTS 6 deliveries, and
    // every `retry()` spends one). Those are dropped, so each one takes the
    // failure carrier instead of vanishing: one `review_failures` row
    // (stage `maintenance_deferred`) the 15-min sweep counts and alerts on, then
    // an ack.
    //
    // shortcut: retry cover is max_retries × 300s (5 × 5 min); a window open
    // longer spends every delivery, and each spent one is now alerted through
    // `review_failures` — upgrade to a re-enqueue-on-close drain then.
    const maintenance = await getMaintenanceMode(env.DB);
    if (maintenanceClosed(maintenance)) {
      // An empty batch has nothing to defer (and no identity to name it with).
      if (batch.messages[0] === undefined) return;
      const deferral = {
        ...payloadIdentityFields(batch.messages[0].body),
        event: "maintenance_defer" as const,
        queue: batch.queue,
        batch_size: batch.messages.length,
      };
      log.warn(deferral, "delivery deferred — the platform is in its maintenance window");
      for (const message of batch.messages) {
        if (typeof message.retry === "function" && message.attempts < QUEUE_MAX_ATTEMPTS) {
          message.retry({ delaySeconds: 300 });
          continue;
        }
        // The delivery has no redelivery left: record what it lost, then ack.
        const body = message.body;
        await deps.failureStore
          .record({
            target_id: body.targetId,
            installation_id: body.installation_id,
            owner: body.owner,
            repo: body.repo,
            pr_number: body.pr_number,
            head_sha: body.head_sha ?? "",
            stage: MAINTENANCE_DEFERRED_STAGE,
            error: `maintenance_window: the platform is closed and this delivery has no redelivery left (attempt ${message.attempts} of ${QUEUE_MAX_ATTEMPTS}) — PR ${body.owner}/${body.repo}#${body.pr_number} was never reviewed`,
          })
          .catch((err: unknown) => {
            const detail = err instanceof Error ? err.message : String(err);
            log.warn(deferral, `review_failures insert failed (leaving deferred delivery unacked): ${detail}`);
            throw err;
          });
        message.ack();
      }
      return;
    }
    for (const message of batch.messages) {
      // The Queue send stamp is the attempt deadline's origin. It is a `Date`
      // on the platform and may be absent in a hand-built test batch; a
      // non-finite/absent value falls back to the admission instant.
      const sentAtMs = message.timestamp instanceof Date ? message.timestamp.getTime() : Number(message.timestamp);
      const outcome = await processMessage(message.body, deps, message.attempts, starter, sentAtMs);
      // BB-3: guard-held is a typed outcome — schedule the per-message
      // delayed retry (or the final ack-with-warning) instead of throwing
      // into the queue's immediate ×3 retry → DLQ path.
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
        // Architect lock L4: a paused App's in-flight message is
        // acked DIRECTLY — an intentional skip (its claim was already stamped
        // `paused` inside processMessage), never a retry and never a DLQ
        // entry.
        message.ack();
      } else if (outcome.kind === "degraded") {
        // Architect AL-1: parse-fail degrade — the
        // best-effort failure row and degraded comment already ran inside
        // processMessage; the message is acked DIRECTLY (deterministic
        // model-output failure — retry re-runs the same pure function on the
        // same stdout), never a retry and never a DLQ entry.
        message.ack();
      } else if (outcome.kind === "superseded") {
        // The ledger already holds a newer commit for this PR: this delivery
        // is a leftover, acked directly before any container. No retry (the
        // newer delivery is the one that reviews) and no DLQ.
        message.ack();
      } else if (outcome.kind === "routed") {
        // The admitted attempt now lives in its Workflow instance. The delivery
        // is acked once the instance is created — or once creation was
        // ambiguous, because a redelivery mints a fresh attempt id and could
        // pay twice. Every later settlement belongs to the instance.
        message.ack();
      } else if (outcome.kind === "unknown") {
        // The attempt's container could not be proven, so its result is
        // uncollected and nothing was claimed about it. Ack: a retry would
        // provision another container and pay the model again on an ambiguous
        // attempt. The live Check and the admission row keep their own state —
        // the reconciler owns what an abandoned attempt concludes.
        message.ack();
      } else if (outcome.kind === "budget-exhausted") {
        // The round's wall clock ended the review and its Check `failure` +
        // `budget-exhausted:` row already landed inside processMessage. A
        // confirmed stop is terminal: a paid retry spends a fresh queue
        // attempt to lose the same deadline, so ack directly — no retry, no
        // DLQ, no comment.
        message.ack();
      }
    }
  };
}



/**
 * Rebuild the per-App host channel for a Workflow step host. A separate
 * invocation has none of the admission invocation's resolved state, so the
 * phases' live objects (the App adapter and the keys-bearing runner config)
 * are resolved again from `payload` + `deps`; nothing secret crosses the
 * boundary. The paused gate and the sandbox-image gate already ran before the
 * instance was created — this only supplies what execution needs.
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
  const appCfg = await resolveAppConfig(payload, deps);
  const modelOverrides = await resolveModelOverrides(payload, deps);
  const customProviders = await resolveCustomProviders(payload, deps);
  assertAppConfigComplete(appCfg, customProviders, modelOverrides, payload.botRef.appId);
  deps.runnerConfigs.set(payload.botRef.appId, { appCfg, modelOverrides, customProviders });
  return "ready";
}

/**
 * @param attempts the delivery number of this message (1 = first delivery);
 *   only the value past the queue's retry budget matters — it stamps the
 *   idempotency key `failed` so a DLQ-bound commit stops counting as reviewed-
 *   or-pending proof.
 * @param queueSentAtMs the original Queue send stamp: the attempt deadline's
 *   origin. A redelivery of an already-frozen attempt ignores it in favour of
 *   the recorded deadline.
 */
async function processMessage(
  payload: ReviewJobPayload,
  deps: ProcessDeps,
  attempts = 1,
  startAttempt?: AttemptStarter,
  queueSentAtMs = Number.NaN,
): Promise<ProcessOutcome> {
  // This invocation's entry instant. Every best-effort step that can spend a
  // sandbox window is measured against it, and it is the fallback origin for
  // an attempt whose Queue send stamp is unavailable.
  const roundStartedAt = Date.now();
  // The attempt's clock starts at the ORIGINAL Queue send, not here: the queue
  // wait is charged against the cap. A send stamp after "now" (clock skew) or
  // an absent one is the admission instant instead.
  const enqueuedMs = Number.isFinite(queueSentAtMs) ? Math.min(queueSentAtMs, roundStartedAt) : roundStartedAt;
  // The delivery key and the recorded attempt id are learned inside the try, so
  // a DB fault or a legacy payload still flows through the structured failure
  // channel. A redelivery of this message finds the row its predecessor wrote
  // and replays the SAME attempt id, so an interrupted handoff can never mint a
  // second attempt that could pay twice.
  let deliveryKey = "";
  let attemptId: string = crypto.randomUUID();
  let sandboxId = attemptSandboxId(attemptId);
  // Review admission (WF-002 + review-concurrency §1.2): the live
  // `review_inflight` row this attempt wrote, released in the finally. The
  // key is the PR identity WITHOUT head_sha, so comment-mention jobs
  // (head_sha=null) are serialized per PR too; the row also reserves the
  // workspace and system capacity slots.
  let inflight: { key: InflightKey; attemptId: string; ttlSeconds: number } | null = null;
  // Set once the App row resolves inside the try (the paused gate returns
  // before it); the admission row's TTL needs the same level. inflight ≠ null
  // ⇒ level is set (resolution precedes admission). The failure path tolerates
  // `undefined` — a pre-resolution failure has no App to attribute a level to.
  let level: ReviewLevel | undefined;
  // F-001 (QC wave-1): toBaseFields derefs payload.botRef.appId, so
  // an in-flight pre-deploy message (no `botRef` — AL-24-4 accepts the
  // TypeError) must throw INSIDE the try: it then flows through the
  // established structured channel (review failed: log + AL-6
  // review_failures row + rethrow). Pure relocation — no runtime guard
  // (AL-24-4 forbids one).
  let baseFields: ConsumerLogFields | undefined;
  let commentClaimConsumed = false;
  // The SHA the ADMISSION-time Check claim covers (the live head when the
  // dedup read proved one, else the payload/watermark head), `null` when no
  // claim was made. The execution body owns the claim itself — this
  // invocation only decides which head it is over.
  let checkClaimSha: string | null = null;
  // Set once the attempt owns its body: its catch has already recorded,
  // terminalized and released, so this invocation must only propagate.
  let handedOff = false;
  // §7.10 Check budgets, filled by the ONE per-message runtime read (after the
  // level resolves, before the begin hook). Every terminal path runs after that
  // read; a path that somehow reached one without it is still bounded by the
  // store's documented defaults rather than waiting forever.
  let checkBudgets: CheckBudgets | null = null;
  try {
    baseFields = toBaseFields(payload);
    // THE HANDOFF RECORD, before anything else: a redelivery of this message
    // replays the attempt its predecessor recorded, and a confirmed instance
    // ends the delivery here. A fault is a failure of this invocation, not a
    // reason to mint a second attempt.
    deliveryKey = deliveryKeyOf(payload);
    const previousHandoff = await readAttemptHandoff(deps.env.DB, deliveryKey);
    if (previousHandoff?.state === "created") {
      // The instance was confirmed earlier and this redelivery only missed the
      // ack: the attempt is running, so the delivery is done here.
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
    // Durable per-comment claim (migration 0048) — the atomic step that turns
    // at-least-once queue delivery into at-most-once execution. The worker
    // already inserted the row `queued` before it enqueued, so the conditional
    // UPDATE below decides which delivery runs: a queue redelivery, an outbox
    // re-send, or a delivery arriving after the 24h KV claim lapsed all find
    // `state` no longer `queued` and ack without running.
    //
    // Deliberately BEFORE the level/credential resolution: the claim must be
    // recorded even when the run itself fails, because a comment-triggered
    // review is re-run by posting a new comment (a new id), never by replaying
    // this one (the documented accepted limit).
    //
    // The payload is cleared in the same statement: it is only needed while
    // `queued` (the outbox re-send), and the row itself lives on as the
    // tombstone that refuses every later delivery of this comment.
    if (payload.comment_id !== undefined) {
      if (payload.successor_of !== undefined) {
        // A successor re-admitted after a moved head. The comment claim that
        // produced the original job is already `consumed`, and the successor is
        // not a replay of that comment: its at-most-once guarantee is the
        // outbox dedupe key (the observed head) plus this delivery's own
        // handoff row, so the identity is preserved without a second claim.
        deps.log.info(
          { ...payloadIdentityFields(payload) },
          "successor delivery — the comment claim was consumed by the skipped attempt; the outbox key is its at-most-once",
        );
      } else {
        const claimed = await deps.env.DB.prepare(
          `UPDATE comment_trigger_claims SET state = 'consumed', consumed_ms = ?, payload_json = NULL
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
    // Credential resolution FIRST (lock L4 — consumer-side),
    // before the guard/sandbox: app → D1 row gated
    // missing/deleted/disabled (throw → retry/DLQ, byte-identical) then
    // PAUSED (lock L4: DISTINCT typed outcome, below) → decrypted
    // PEM → per-App commenter instance (cached per appId). An unresolvable
    // App (missing / disabled / soft-deleted / undecryptable) fails
    // structurally here with zero side effects — the rethrow keeps the
    // existing retry/DLQ semantics and no GitHub write ever happens. Token
    // mint and postReview below both use THIS resolved instance (same App
    // identity, lock L4).
    const resolution = await resolveCommenter(payload, deps);
    // Ack-skip (architect lock L4): a paused App's in-flight message
    // is the DISTINCT `paused` outcome — the queue handler acks it directly.
    // EVERYTHING below is skipped: no in-flight guard acquisition (no guard
    // TTL consumed), no sandbox creation, no token mint, no app-config read,
    // no GitHub API call, no retry, no DLQ. The structured log rides the
    // existing ConsumerLogFields channel with `event: "review_paused"`
    // (union widened additively) + app_id + the baseFields PR identity.
    if (resolution.kind === "paused") {
      deps.log.info(
        { ...baseFields, event: "review_paused" },
        "review paused — app review_enabled=0; acking without a review (no retry, no DLQ)",
      );
      // A pause is an answer about the REVIEW, not about the commit: the
      // worker's "1" claim must stop proving a review is coming, or both
      // readers (the supersede skip and the worker's pre-check) would accept
      // it forever. `putAbandonClaim` never downgrades a completed review.
      // Best-effort — a KV fault only leaves the stale "1".
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
          deps.log.warn(
            { ...baseFields, event: "review_paused" },
            `paused-claim KV write failed (the skip may still treat this commit as queued): ${detail}`,
          );
        }
      }
      // §7.9: a delivery attached before the App was paused still has a run to
      // close, and this path never reaches `begin` — settle it `neutral`.
      await settleSkippedRow(deps, payload, payload.head_sha, "review paused");
      return { kind: "paused" };
    }
    // `workspaceId` is the bot's owner (concurrency/inflight); the ledger is
    // charged to the target's workspace — the tenant that asked (see
    // `CommenterResolution.usageWorkspaceId`).
    const { githubAppId, workspaceId, usageWorkspaceId } = resolution;
    // Supersede skip (migration 0044): a queued delivery whose PR head has
    // already advanced must cost nothing that can fail it, hold the guard, or
    // start work — no admission row, no sandbox, no Check, no publication.
    // The per-App credential resolution above has already run (the paused gate
    // needs it); this read is select-only and sits AFTER that gate (a paused
    // App keeps today's ack-and-stop) and BEFORE assertAppConfigComplete /
    // admission, so a storage fault can only add this one read, never a side
    // effect.
    //
    // The ledger advances on EVERY verified non-reject delivery, including the
    // ones that enqueue nothing (a `synchronize` in `open` mode, a paused App,
    // a failed enqueue), so the ledger alone cannot stand as the skip's proof:
    // the newer commit must also own a job — its idempotency key is claimed
    // only after a successful send and is stamped "dropped" when the guard
    // gives that job up for good.
    //
    // That proof is read ONCE, at ack time, and never reserved: it says the
    // newer job was enqueued and not yet terminally dropped when this delivery
    // is acked. If that job is dropped afterwards, nothing re-enqueues this
    // one — the `review_failures` row from the drop is the trace, and the PR's
    // head then has no review until a later delivery. This is the accepted
    // cost of keeping the skip free of retries, not a guarantee that no PR can
    // lose its only review.
    //
    // `issue_comment` jobs and pre-migration messages carry no stamp and take
    // today's path untouched — not even these reads.
    //
    // The ledger stamp is a DELIVERY watermark, so a later delivery naming the
    // SAME sha moves it too (migration 0044): expected and harmless here, since
    // the skip also requires the ledger's sha to differ from this payload's.
    // The watermark read (migration 0044), memoized for the SKIP decisions
    // only: the supersede skip and the early dedup key share one answer. The
    // hit-time live-head check below always issues its OWN read — a memo must
    // never supply the value that comparison decides on, or a mention whose
    // head advanced would be acked. A fault is memoized as a warning, never as
    // an answer: one root cause, one line, however many reads it took.
    let watermark: PrHeadAnswer | null | undefined;
    let watermarkFaultLogged = false;
    const selectWatermark = (): Promise<PrHeadAnswer | null> =>
      deps.selectPrHead({
        targetId: payload.targetId,
        owner: payload.owner,
        repo: payload.repo,
        prNumber: payload.pr_number,
      });
    /** One warn per delivery for a watermark read that could not answer. */
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
    if (payloadHeadSha && payloadHeadAt) {
      const ledgerHead = await readWatermark("fail-open: reviewing normally");
      // Two readable stamps on both sides, the ledger strictly newer, a
      // different commit, and a queued job for that commit: only then is this
      // delivery a leftover. Missing or unreadable input never skips.
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
        // A superseded sha is not reviewed by THIS delivery, so its claim must
        // stop proving a review of it is coming. Deliberately not a tombstone:
        // a force-push can make this sha the head again (A → B → A), and the
        // worker's pre-check re-enqueues any `superseded` claim for exactly
        // that reason — this delivery's ledger comparison is what decides it
        // was a leftover, not the claim. `putAbandonClaim` never downgrades a
        // completed review. Best-effort — a KV fault only leaves the stale "1"
        // and never changes this outcome.
        try {
          await putAbandonClaim(
            deps.env.IDEMPOTENCY_KV,
            idemKey({
              installation_id: payload.installation_id,
              owner: payload.owner,
              repo: payload.repo,
              pr_number: payload.pr_number,
              head_sha: payloadHeadSha,
            }),
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
        // §7.9: this delivery is a leftover and never reaches `begin`, so its
        // attached run is settled `neutral` instead of closing red later.
        await settleSkippedRow(deps, payload, payloadHeadSha, "superseded by a newer commit");
        return { kind: "superseded" };
      }
    }
    // The App's review depth (migrations 0047 + 0067), resolved on the SAME
    // per-message configuration read that resolved its credentials — the
    // admission TTL, the runner budget and the guard backoff all use it. The
    // value is already parsed (an unknown stored level reads as `null`), and
    // NULL follows the operator default: one bounded settings read, issued
    // only then. A degraded read answers the documented default and owes the
    // operator one structured warn (the concurrency reader's contract) — never
    // a silent fallback.
    //
    // AFTER the supersede skip on purpose: a superseded delivery is not the
    // live review, so it must not pay — or degrade on — this read.
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
    // Per-App AI config: hangs off the SAME bot resolution as
    // the commenter — one getAppConfig read per message, before the
    // guard/sandbox so an unresolvable config (undecryptable key envelope,
    // missing DASHBOARD_ENCRYPTION_KEY) fails closed with zero side effects.
    const appCfg = await resolveAppConfig(payload, deps);
    // Per-role model overrides: rides the SAME bot gate,
    // before the guard like the config above. undefined (empty map)
    // → the runner input JSON below stays byte-identical.
    const modelOverrides = await resolveModelOverrides(payload, deps);
    // Custom-provider declarations: hangs off the SAME
    // bot gate, before the guard like the config/overrides above —
    // undefined (no declarations) → the runner input JSON stays
    // byte-identical and no custom-provider pool env is injected. The
    // decrypt face is fail-loud (tamper never swallowed): a broken envelope
    // throws here with zero side effects, never a silently-skipped provider.
    const customProviders = await resolveCustomProviders(payload, deps);
    // The App's sandbox image: resolves the stored
    // review_bots.sandbox_image_id through the CLOSED registry and fails
    // closed (structured, non-secret error) on unknown/disabled ids —
    // BEFORE the in-flight guard and sandbox creation, so an invalid id
    // never starts a container. The definition itself is used later, at
    // sandbox creation; resolution happens here for the fail-closed order.
    await resolveSandboxImage(payload, deps);
    // AL-24-5 fail-closed gate: after App resolution,
    // BEFORE the in-flight guard / sandbox. The App's modelChain is the ONLY
    // chain source and every chain provider must have a key in the App's OWN
    // config (a BYOK allowlist key or a custom declaration); the SAME requirement now covers
    // every per-role override selector chain (Bugbot 7aaf18f4). A
    // misconfigured App throws here
    // and flows through the F-001 structured channel (error log +
    // review_failures stage="pipeline" row + rethrow → retry×3 → DLQ) with
    // ZERO side effects — no webhook-face reject, no pause state, no runtime
    // guard beyond this channel (AL-24-5 verdict 3).
    assertAppConfigComplete(appCfg, customProviders, modelOverrides, payload.botRef.appId);
    // 0. Review admission (WF-002 / bugbot BB-3 + review-concurrency §1.2):
    // ONE conditional D1 insert is both the per-PR lock and the capacity
    // reservation, so a duplicate for this PR or a reached cap returns the
    // DISTINCT guard-held outcome — NOT a throw. The consumer schedules a
    // per-message delayed retry (per level: 60/300/300/900/900s quick/default,
    // 90/480/300/900/900s deep); after the final delayed attempt the job is acked
    // with a warning — guard-held is not an error state and never goes to the
    // DLQ. Admission precedes EVERY sandbox step, so a refused message costs
    // no container.
    // Captured as a const: a `let` widens to `| undefined` inside the callback.
    const admissionFields = baseFields;
    const concurrency = await readReviewConcurrency(deps.env.DB, workspaceId, {
      // ConsumerLog is contravariant against the reader's log: adapt on this
      // side instead of widening the reader — its fields ride this channel.
      warn: (readerFields, msg) => deps.log.warn({ ...admissionFields, ...readerFields }, msg),
    });
    // The Check lane's scope (§7.10) — the same App/PR identity the
    // publication journal and the attempt key use, derivable from the payload
    // alone. Read HERE because the early journal hand-off needs it before the
    // container and the checkout.
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
    // be discovered afterwards. A row written before the deadline column
    // existed is anchored ONCE from its OWN admission stamp — the only instant
    // that attempt had — never from this delivery's clock, so a redelivery or
    // a recovery re-enqueue cannot move it. The first writer wins the write
    // itself (store), and a degraded cap read throws so admission retries
    // instead of inventing a cap.
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
      deadlineMs = (previousHandoff?.createdMs ?? enqueuedMs) + capMs;
    }
    // The guard row must outlive the attempt's own hard stop: an operator cap
    // can exceed the level's ceiling-derived TTL, and a guard that expired
    // first would let a second delivery start the same PR.
    const ttlSeconds = reviewGuardTtlForDeadline(deadlineMs, Date.now(), level);
    const admission = await acquireInflight(deps.env.DB, inflightKey, {
      // Each cap binds to its own predicate: `system` bounds the global live
      // count, `workspace` the tenant's — never the effective min here.
      systemCap: concurrency.system,
      workspaceCap: concurrency.workspace,
      attemptId,
      ttlSeconds,
      // The commit this attempt reviews (`null` for a comment trigger): the
      // row carries it so a later conflicting delivery can tell whether the
      // live review covers its own sha.
      headSha: payload.head_sha ?? null,
      // One clock for the whole round: `new Date()` bypasses the mocked
      // `Date.now()` every deadline in this invocation is measured on, so
      // the row's origin is stamped from the same instant the budget reads.
      now: new Date(Date.now()).toISOString(),
    });
    if (!admission.ok) {
      // §1.3 observability: one admission decision, one refusal record — the
      // caps are the ones this decision was measured against. An `error` also
      // carries its cause: the store answers the same code for a dead D1
      // binding and for a capacity released between its two statements.
      const errorCause = admission.reason === "error" ? describeInflightError(admission.cause) : undefined;
      const refusal: AdmissionRefusalFields = {
        reason: admission.reason,
        system_cap: concurrency.system,
        workspace_cap: concurrency.workspace,
        error_cause: errorCause,
      };
      if (errorCause !== undefined) {
        // Fail closed (spec §1.3): a storage failure never admits, and the
        // store has no log channel — the operator line is this one.
        deps.log.warn(
          { ...baseFields, ...refusal },
          `review admission failed (storage error: ${errorCause}) — treating as held; no review admitted`,
        );
      }
      // A cap/error refusal that never recovers is recorded when the job is
      // finally dropped (handleGuardHeld's terminal ack): recording every
      // refused attempt would write "failure" rows for reviews that a later
      // delayed attempt goes on to complete. `pr-held` carries the live row's
      // sha so that ack can tell a duplicate from a commit it never covers.
      // Deliberately settled in `handleGuardHeld`'s TERMINAL branch only (§7.9):
      // the first three refusals are retried, and a duplicate delivery shares
      // this attempt_key — settling here could close the live review's own run.
      return {
        kind: "guard-held",
        commentClaimConsumed,
        admission: refusal,
        heldHeadSha: admission.reason === "pr-held" ? admission.heldHeadSha : null,
        level,
      };
    }
    inflight = { key: inflightKey, attemptId, ttlSeconds };
    // §7.7 step 4 / §7.9: the Check attempt is claimed at ADMISSION — before
    // the container, the token mint and the clone — so the run appears when the
    // review starts working instead of minutes later. The SHA is the payload's
    // (`pull_request`) or the PR head watermark (`issue_comment`); when neither
    // is readable the post-`rev-parse` block below owns the claim exactly as
    // before. The begin hook is isolated: a Check fault never costs a review.
    if (deps.checks !== undefined) {
      // §7.10 Check budgets: ONE read per message, taken only once this
      // message can actually produce a Check; every terminal path shares it.
      checkBudgets = await readCheckBudgets(deps.env.DB, {
        warn: (readerFields, msg) =>
          deps.log.warn({ ...(baseFields ?? payloadIdentityFields(payload)), ...readerFields }, msg),
      });
      const earlyHeadSha = payload.head_sha || (await readWatermark("fail-open: reviewing normally"))?.headSha || null;
      if (earlyHeadSha !== null) {
        // §7.7 step 2, moved ahead of the claim: a head this lane already
        // reviewed has nothing to review, so a repeat trigger (the same commit,
        // typically a comment) must ACK here — a claim it can only close red
        // would overwrite the head's own result. Same key family as the
        // checkout-keyed dedup below; an unreadable answer falls through to it.
        // A HIT is final only for the head it was KEYED on: the PR's live head
        // is read here and ONLY here, so a miss never pays for it. When the
        // keyed head is behind — a delivery queued before a push, and `manual`
        // mode queues nothing, so this delivery is the newer commit's only
        // chance — the hit falls through and the checkout reviews the live
        // head. An unreadable head keeps the ack with one warning: it must
        // never become a second paid review.
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
          idempotency_key: idemKey(earlyKey),
        };
        // One FRESH read per hit — never on a miss — compared with the head the
        // key was made against, never with itself, so a mention keyed on an
        // older watermark still sees the push that overtook it. This read is
        // ALWAYS its own: the memo above may deduplicate a repeated fault's
        // warning, but it can never supply the value this comparison decides.
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
            // An ANSWER without a head (no ledger row) names the fallback here;
            // a thrown read already logged its one line for the delivery.
            if (!faulted && liveHeadSha === null) {
              deps.log.warn(
                earlyFields,
                "PR head watermark unreadable — ack the keyed head now, do not re-review",
              );
            }
          }
          return liveHeadSha;
        };
        const earlyDone = await kvDoneHit(deps.env.IDEMPOTENCY_KV, idemKey(earlyKey), earlyFields, deps.log);
        let earlyReviewed = earlyDone;
        if (!earlyReviewed) {
          try {
            earlyReviewed = (await deps.store.findByIdempotencyKey(earlyKey)) !== null;
          } catch (err) {
            // A pre-read fault is not an answer: fall through to the existing
            // path, whose checkout-keyed read is the authoritative one and
            // keeps its own retry semantics on failure.
            deps.log.warn(
              earlyFields,
              `early idempotency read failed — continuing to the checkout-keyed path: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        // The head this delivery ends up reviewing, when the keyed one moved.
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
        // An already-PUBLISHED head is as final as an already-REVIEWED one: a
        // live journal row hands off to recovery here exactly as the
        // checkout-keyed gate below does — no claim, no paid work. An
        // unreadable read is a miss (that gate is the authoritative one).
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
          // The keyed head was final, the PR's is not: acking here is exactly
          // what loses the newer commit when no push queues its own review.
          deps.log.info(
            earlyFields,
            `delivery keyed on ${earlyHeadSha.slice(0, 7)} but the PR head is ${movedHeadSha.slice(0, 7)} — reviewing the live head`,
          );
          // The run THIS delivery attached for the old head has no review
          // coming now, so it is settled under this delivery's own attach
          // identity (inheriting that head's conclusion) instead of sitting
          // `in_progress` until its deadline. The attach key is the payload sha
          // OR the watermark a mention carried — `earlyHeadSha` is exactly that
          // head, so a mention settles its run too.
          await settleSkippedRow(deps, payload, earlyHeadSha, "superseded by a newer commit", true);
        }
        checkClaimSha = movedHeadSha ?? earlyHeadSha;
      }
    }
    // Handoff: everything from here on belongs to the admitted attempt's own
    // Workflow instance. This invocation keeps admission, dedupe and skip
    // settlement; what crosses the boundary is DATA — the durable ids plus the
    // delivery's facts. The App adapter and the keys stay on the consumer's
    // own host channel; the instance's host resolves its own.
    if (startAttempt === undefined) {
      // Fail loud BEFORE ownership moves: an admitted attempt with nowhere to
      // execute must not strand its row or silently drop the review.
      throw new Error(
        "review route: no attempt starter is configured — the queue handler must pass the Workflow route",
      );
    }
    const usageSource: AttemptRef["usageSource"] = resolution.scope === "shared" ? "shared" : "byok";
    deps.runnerConfigs.set(payload.botRef.appId, { appCfg, modelOverrides, customProviders });
    // THE HANDOFF IS A RECORD BEFORE IT IS AN EFFECT: write (or read back) the
    // delivery's handoff row with this attempt id, payload and the deadline
    // frozen above, BEFORE the instance is created. An interruption after this
    // line leaves a row the recovery pass replays; a concurrent duplicate of the
    // same message uses the id and instant this row already holds.
    const handoff = await reserveAttemptHandoff(deps.env.DB, {
      deliveryKey,
      attemptId,
      payload,
      nowMs: Date.now(),
      deadlineMs,
    });
    if (handoff.attemptId !== attemptId) {
      // Two deliveries of the same message raced; the other one owns this
      // handoff and will create the instance. Release our admission row and
      // ack: a second instance would be a second paid attempt.
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
    const attemptRef: AttemptRef = {
      attemptId,
      payload,
      level,
      roundStartedAt,
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
        // Ownership moves with a NEW instance: its own cleanup releases the row.
        inflight = null;
        handedOff = true;
      }
      // "exists" confirms an instance an earlier delivery created; this
      // delivery's admission row is released in the finally and the instance
      // keeps the one it owns.
    } catch (err) {
      if (err instanceof WorkflowCreateAmbiguousError) {
        // The instance MAY exist: move ownership and ack. The handoff row stays
        // `ambiguous` for the recovery pass, which re-enqueues the payload so
        // admission re-tries create with the SAME attempt id.
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
        // A DEFINITE failure is a failure, never an ambiguous success: the
        // handoff records it, the admission path below writes the failure row,
        // stamps the claim and rethrows into the queue's retry/DLQ ladder, and
        // a redelivery replays this same attempt id.
        await markAttemptHandoff(deps.env.DB, deliveryKey, "failed", Date.now());
        throw err;
      }
      // Not a create outcome: the starter ran the attempt itself and settled
      // it. The instance owns the attempt; propagate without a second record.
      inflight = null;
      handedOff = true;
      throw err;
    }
    return { kind: "routed" };
  } catch (err) {
    // The attempt body owns every failure past the handoff — it recorded the
    // row, terminalized the Check and released the row. Only propagate.
    if (handedOff) throw err;
    // The admission face failed before the attempt owned a container: nothing
    // was provisioned, so the durable trace is the failure row and the queue's
    // own retry.
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.error(
      {
        ...(baseFields ?? payloadIdentityFields(payload)),
        sandbox_id: sandboxId,
        // Same level attribution the shared catch carried: once the level is
        // resolved, an admission failure is attributed to it and to its
        // runner/orchestration shape, exactly like every other failure line.
        ...(level === undefined
          ? {}
          : {
              level,
              runner_timeout_ms: runnerTimeoutMs(level),
              orchestration: level === "deep" ? "parent" : "bun-fanout",
            }),
      },
      `review failed: ${detail}`,
    );
    // The GitHub secondary-rate-limit cause is tagged HERE — once, before
    // redaction — so the row's text and the store's prefix count share one
    // source of truth (a second detection site would drift).
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
        error: redactExactSecrets(redactSecrets(persistedDetail), []),
      });
    } catch (recordErr) {
      const recordDetail = recordErr instanceof Error ? recordErr.message : String(recordErr);
      deps.log.warn(
        { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId },
        `review_failures insert failed: ${recordDetail}`,
      );
    }
    // The last delivery will never review this commit: stamp its idempotency
    // key `failed` (the worker's claim TTL) so neither the worker's pre-check
    // nor the supersede skip keeps treating the stale "1" as proof. Best-effort
    // — a KV fault only leaves "1" behind, which the failure row traces.
    if (attempts >= QUEUE_MAX_ATTEMPTS && payload.head_sha) {
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
    // The row is released unless the attempt took ownership of it (the handoff
    // clears the local). Scoped to THIS attempt's id, so an older attempt can
    // never delete a row a newer one reclaimed after expiry; a release failure
    // only warns (the row expires by TTL).
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


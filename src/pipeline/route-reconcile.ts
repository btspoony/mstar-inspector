/**
 * The review route's durable recovery pass (migration 0083).
 *
 * Three things can be owed after a host is interrupted:
 *
 * - an ATTEMPT HANDOFF whose instance creation was never confirmed (`owed`, or
 *   `ambiguous` because the create reply was lost). The pass re-enqueues the
 *   recorded payload; the queue handler reads the handoff row, reuses its
 *   attempt id and re-tries create. A replay is idempotent: an instance that
 *   exists answers "already exists" (and is probed for this attempt's id) and
 *   is recorded as created, never a second attempt.
 * - a SETTLEMENT that started and never completed: the Workflow's step retry
 *   and a resumed instance cover the transient cases; this pass covers the one
 *   that outlived both, landing the effects that need no dead host's memory.
 * - a CONSUMED COMMENT CLAIM still carrying its payload: the host died between
 *   consuming the claim and writing the handoff, so the claim row is the only
 *   record left. The pass hands it back to the queue (once — the state
 *   transition is the fence) and the re-delivery takes the ordinary claim path.
 * - a SUCCESSOR intent a moved head recorded but the immediate send did not
 *   deliver. The pass sends it; the outbox dedupe key (App/target, observed head
 *   and originating delivery) means one intent can never produce two
 *   admissions, while an independent origin keeps its own row.
 *
 * `updated_ms` is bumped after a re-enqueue so one sweep cannot hot-loop on the
 * same row; a failed send leaves the clock untouched, so the next pass retries.
 */
import type { D1Database, KVNamespace, Queue } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../contracts/review-job";
import {
  IDEMPOTENCY_SECONDS,
  idemKey,
} from "../contracts/idem";
import { readReviewLaunch } from "./review-attempt";
import { payloadIdentityFields } from "./review-attempt-execution";
import type { ConsumerLogFields } from "./review-attempt-execution";
import { settlementFailureRowStatement } from "../store/failure-store";
import {
  landFailureEffect,
  listCommentClaimsForRecovery,
  listHandoffsForRecovery,
  clearRefusalPending,
  clearRecheckDuty,
  listIncompleteSettlements,
  readRefusalPending,
  readRecheckAttribution,
  readRecheckDuty,
  recordRecheckDuty,
  recordRecheckAttribution,
  recheckRowExists,
  listOwedSuccessors,
  listUnpublishedLaunchSettlements,
  markSuccessorDelivered,
  restoreCommentClaimForRecovery,
  settleAttemptIfDischarged,
  stampOwedSettlementClaim,
  successorGeneration,
  touchAttemptHandoff,
  type AttemptHandoff,
  type SettlementEffect,
} from "../store/review-route-store";

/** A handoff is retried only after this quiet period (a live delivery is still trying). */
export const HANDOFF_RECOVERY_AFTER_MS = 5 * 60_000;
/** Rows per pass per family — the reconciler's own bound. */
export const ROUTE_RECOVERY_LIMIT = 25;

export type ReviewRouteEnv = {
  DB: D1Database;
  REVIEW_QUEUE: Queue<ReviewJobPayload>;
  /** The commit claim the failed-claim stamp is written to. */
  IDEMPOTENCY_KV: KVNamespace;
  /**
   * The pass's log sink. The recheck accounting's attribution LINE is a durable
   * effect owned by whoever finishes the round, so a replay this pass performs
   * has to emit it too. Absent only in a caller that does not log.
   */
  log?: { info?: (fields: ConsumerLogFields & { recheck_replayed?: boolean }, msg: string) => void };
};

/**
 * Land the effects a settlement owes that need no dead host's memory — the
 * failure row and the head's abandoned claim — then let the ONE settlement rule
 * decide completeness from durable facts: the Check must actually be terminal
 * (this pass never concludes it), and the failed-claim stamp is required only
 * when the lane names a commit. The effects this pass landed are the facts; it
 * never certifies the rest.
 *
 * The failure row and its landed fact are ONE persistence step (`landFailureEffect`
 * commits them in a single D1 batch): no interruption and no second pass can see
 * the row without the fact, and the insert is attempt-keyed so a concurrent pass
 * adds nothing.
 */
async function landSettlementEffects(
  env: ReviewRouteEnv,
  handoff: AttemptHandoff,
  landed: Set<SettlementEffect>,
  detail: string,
  nowMs: number,
): Promise<void> {
  // The refused round's accounting comes FIRST: its writes are not part of any
  // claim (F6), so a fault here leaves the duty for the next pass without ever
  // orphaning a landed claim.
  await ensureRecheckAccounting(env, handoff, nowMs);
  // The pass that LANDS the record owns the head-wide claim; an overlapping pass
  // that lost the insert race owns nothing and must not touch it.
  let owned = false;
  if (!landed.has("failure-row")) {
    const recorded = await landFailureEffect(
      env.DB,
      {
        attemptId: handoff.attemptId,
        landed: [...landed],
        failure: {
          target_id: handoff.payload.targetId,
          installation_id: handoff.payload.installation_id,
          owner: handoff.payload.owner,
          repo: handoff.payload.repo,
          pr_number: handoff.payload.pr_number,
          head_sha: handoff.payload.head_sha ?? "",
          stage: "pipeline",
          error: detail,
        },
      },
      nowMs,
    );
    owned = recorded.owned;
    landed.add("failure-row");
  }
  if (!landed.has("claim-stamp") && handoff.payload.head_sha) {
    // ONLY the pass that landed the record may move the head-wide key (a loser or a
    // repair pass cannot prove its generation), and only a PROVEN write — or a
    // proven `done` — is the stamped effect: an unreadable claim stays owed, so the
    // head remains re-triggerable. A repair a non-owner could do is deliberately
    // not attempted: KV has no compare-and-set, so it could overwrite a fresh
    // delivery's claim. See `stampOwedSettlementClaim`'s residual note.
    const stamped = await stampOwedSettlementClaim(env.DB, env.IDEMPOTENCY_KV, {
      attemptId: handoff.attemptId,
      key: idemKey({
        installation_id: handoff.payload.installation_id,
        owner: handoff.payload.owner,
        repo: handoff.payload.repo,
        pr_number: handoff.payload.pr_number,
        head_sha: handoff.payload.head_sha,
      }),
      ttlSeconds: IDEMPOTENCY_SECONDS,
      owned,
    });
    if (stamped === "written" || stamped === "done") landed.add("claim-stamp");
  }
  await settleAttemptIfDischarged(env.DB, { attemptId: handoff.attemptId, landed: [...landed] }, nowMs);
}

/**
 * Finish a refused round's durable accounting that the dead host started: the
 * duty row (`review_recheck_duties`) says what is owed, and this pass — the named
 * owner of an incomplete settlement — writes what is missing. Idempotent: the row
 * is attempt+stage keyed, the attribution fact is keyed by attempt, and a delivery
 * that already emitted is not re-emitted once its fact exists.
 *
 * A fault leaves the duty open; the row stays on the incomplete list and the next
 * pass retries.
 */
async function ensureRecheckAccounting(
  env: ReviewRouteEnv,
  handoff: AttemptHandoff,
  nowMs: number,
): Promise<void> {
  // Only a REFUSAL owes a round: the marker is the intent, the duty carries what
  // to write, and an ordinary failure has neither.
  if (!(await readRefusalPending(env.DB, handoff.attemptId))) return;
  let duty = await readRecheckDuty(env.DB, handoff.attemptId);
  if (duty === null) {
    // The marker is all that survived: register the duty FIRST (so the row and
    // the main failure row this pass writes can never exist without it), owing
    // the attribution alone — the row's content was never recorded.
    duty = {
      attemptId: handoff.attemptId,
      headSha: handoff.payload.head_sha ?? "",
      failureError: null,
      outcome: "absent",
    };
    await recordRecheckDuty(env.DB, duty, nowMs);
  }
  if (duty.failureError !== null && !(await recheckRowExists(env.DB, duty.attemptId))) {
    await settlementFailureRowStatement(
      env.DB,
      {
        target_id: handoff.payload.targetId,
        installation_id: handoff.payload.installation_id,
        owner: handoff.payload.owner,
        repo: handoff.payload.repo,
        pr_number: handoff.payload.pr_number,
        head_sha: duty.headSha,
        stage: "recheck",
        error: duty.failureError,
      },
      `${duty.attemptId}:recheck`,
    ).run();
  }
  if (!(await readRecheckAttribution(env.DB, duty.attemptId))) {
    // At-least-once, like the live emission: log first, then the fact. A pass
    // with no sink cannot certify a line it never emitted, so the duty stays open.
    const sink = env.log?.info;
    if (sink === undefined) {
      throw new Error(`recheck attribution cannot be replayed for ${duty.attemptId}: no log sink`);
    }
    sink(
      {
        ...payloadIdentityFields(handoff.payload),
        attempt_id: duty.attemptId,
        head_sha: duty.headSha,
        recheck_outcome: duty.outcome,
        recheck_replayed: true,
      },
      "recheck round accounted — replayed by the route recovery pass",
    );
    await recordRecheckAttribution(env.DB, duty.attemptId, nowMs);
  }
  await clearRecheckDuty(env.DB, duty.attemptId);
  await clearRefusalPending(env.DB, duty.attemptId);
}

/**
 * Deliver what the route owes./**
 * Deliver what the route owes. Per-row faults are isolated: one bad row never
 * stops the pass, and the row stays owed for the next one.
 */
export async function reconcileReviewRoute(env: ReviewRouteEnv, nowMs = Date.now()): Promise<void> {
  const queue = env.REVIEW_QUEUE;
  // A settled skip's successor is the more urgent one: a head with no review at
  // all. Send first, mark only after the queue accepted it.
  for (const successor of await listOwedSuccessors(env.DB, ROUTE_RECOVERY_LIMIT)) {
    try {
      // Pre-send check: this pass read the row earlier, and a re-arm since then
      // makes the copy in hand stale. Sending it would deliver an obligation the
      // drop has already superseded; the next pass reads the fresher one.
      if ((await successorGeneration(env.DB, successor.dedupeKey)) !== successor.generation) continue;
      await queue.send(successor.payload);
      // Generation-scoped: a re-arm during the send keeps the row owed.
      await markSuccessorDelivered(env.DB, successor.dedupeKey, successor.generation, nowMs);
    } catch {
      // Stays owed; the next pass retries it.
    }
  }
  for (const handoff of await listHandoffsForRecovery(env.DB, {
    updatedBeforeMs: nowMs - HANDOFF_RECOVERY_AFTER_MS,
    limit: ROUTE_RECOVERY_LIMIT,
  })) {
    try {
      await queue.send(handoff.payload);
      await touchAttemptHandoff(env.DB, handoff.deliveryKey, nowMs);
    } catch {
      // Stays owed (the clock is untouched); the next pass retries it.
    }
  }
  // A settlement that STARTED and never completed. The Workflow's own retry
  // covers a transient fault inside the step, and a resumed instance re-runs a
  // step whose result was lost — but neither covers a settlement that outlived
  // both (a persistent fault, or an instance the platform failed). This pass is
  // the durable owner: it lands the effects that need no dead host's memory —
  // the failure row and the commit's claim stamp — and completes the mark. The
  // Check conclusion is NOT redone here: a settlement writes its mark only after
  // `terminalize` returned, so a Check that never concluded has no mark and is
  // closed by the check reconciler at its own lease.
  for (const handoff of await listIncompleteSettlements(env.DB, {
    settlingBeforeMs: nowMs - HANDOFF_RECOVERY_AFTER_MS,
    limit: ROUTE_RECOVERY_LIMIT,
  })) {
    try {
      const landed = new Set<SettlementEffect>(handoff.settledEffects ?? []);
      // A skip is not a failure: the moved-head settlement owns that outcome,
      // and the successor outbox already carries the head it displaced.
      if (landed.has("skip")) continue;
      // ACT ONLY ON A DURABLE OUTCOME. `launched` without an outcome is the
      // unknown paid state — the container may still be running — and a
      // delivery that never provisioned has no outcome to replay. Nothing is
      // written for either; retention owns them.
      const launch = await readReviewLaunch(env.DB, handoff.attemptId);
      if (launch === null || (launch.state !== "failed" && launch.state !== "persisted")) continue;
      await landSettlementEffects(
        env,
        handoff,
        landed,
        `settlement replay: the attempt's settlement did not finish (landed: ${
          landed.size === 0 ? "nothing" : [...landed].join(", ")
        }); the route's recovery pass recorded this failure and finished the settlement`,
        nowMs,
      );
    } catch {
      // Stays incomplete; the next pass retries it.
    }
  }
  // The persisted-but-unpublished crash window (I-000684): the paid result is
  // durable, the attempt's own hard stop has passed and NOTHING was ever staged
  // for its scope/head, so no settlement ever started and the publication lane
  // — which only walks journal rows — can never own it. Landing the same effects
  // a failed review gets is what makes the loss VISIBLE and re-triggerable: a
  // failure row the operator reads and the head's abandoned claim, instead of a
  // paid result hidden behind a queued Check. It is a recorded terminal failure,
  // not a publication: the staged body (diff/catalog/prepared state) is not
  // durable anywhere, so nothing here can re-render what was never written.
  // The SELECTOR is contained with its family: a fault there (a corrupt JSON
  // payload, a store hiccup) yields this pass's selection only — the re-enqueue,
  // settlement and claim families below still run, and the next pass retries.
  let unpublished: AttemptHandoff[] = [];
  try {
    unpublished = await listUnpublishedLaunchSettlements(env.DB, {
      deadlineBeforeMs: nowMs,
      limit: ROUTE_RECOVERY_LIMIT,
    });
  } catch {
    unpublished = [];
  }
  for (const handoff of unpublished) {
    try {
      await landSettlementEffects(
        env,
        handoff,
        new Set<SettlementEffect>(handoff.settledEffects ?? []),
        `publication never started: the attempt persisted its paid result but no publication was staged for ${handoff.payload.head_sha} before its window closed; the route's recovery pass recorded this failure — re-trigger the review to publish it`,
        nowMs,
      );
    } catch {
      // Stays selected; the next pass retries it.
    }
  }
  // A claim whose delivery died before recording anything. The state transition
  // is the exclusive hand-back (a second pass finds it `queued`), and sending
  // AFTER it means a failed send is still owned by the comment outbox lane,
  // which applies that row's own attempt cap.
  for (const claim of await listCommentClaimsForRecovery(env.DB, {
    consumedBeforeMs: nowMs - HANDOFF_RECOVERY_AFTER_MS,
    limit: ROUTE_RECOVERY_LIMIT,
  })) {
    try {
      if (!(await restoreCommentClaimForRecovery(env.DB, claim, nowMs))) continue;
      await queue.send(claim.payload);
    } catch {
      // Already `queued` with its payload: the outbox lane retries it.
    }
  }
}

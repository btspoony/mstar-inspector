import type { D1Database, D1PreparedStatement, D1Result, KVNamespace, Queue } from "@cloudflare/workers-types";
import { FAILURE_SUMMARIES, type FailureCode } from "../contracts/failure-codes";
import type { ReviewJobPayload } from "../contracts/review-job";
import {
  IDEMPOTENCY_SECONDS,
  idemKey,
} from "../contracts/idem";
import { getLostReplySettleMs, REVIEW_ATTEMPT_CAP_MAX_MS } from "../dashboard/runtime-config-store";
import { markAttemptRevokedStatement, readReviewLaunch, recordReviewFailureStatement } from "./review-attempt";
import { payloadIdentityFields } from "./review-attempt-execution";
import type { ConsumerLogFields } from "./review-attempt-execution";
import { settlementFailureRowStatement } from "../store/failure-store";

import {
  beginAttemptSettlementStatement,
  landFailureEffect,
  listCommentClaimsForRecovery,
  listHandoffsForRecovery,
  clearRefusalPending,
  clearRecheckDuty,
  listIncompleteSettlements,
  listLostReplyLaunchSettlements,
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
 *
 * `failure.code` defaults to the unclassified crash-window code; a caller that
 * knows why it settled names it. `failure.owned` is the caller's OWN exclusivity
 * proof when the record it settles was landed by someone else: the lost-reply
 * pass proved it by winning the guarded `launched → failed` move in its batch
 * (`changes() === 1`), which no other pass can win either. `failure.statements`
 * are extra writes that must land in that same batch first — the lost-reply pass
 * uses them to move a `launched` row to `failed` AND revoke it, which is what
 * releases both arms of the capacity hold.
 */
async function landSettlementEffects(
  env: ReviewRouteEnv,
  handoff: AttemptHandoff,
  landed: Set<SettlementEffect>,
  detail: string,
  nowMs: number,
  failure: { code?: FailureCode; owned?: boolean } = {},
): Promise<void> {
  // The refused round's accounting comes FIRST: its writes are not part of any
  // claim (F6), so a fault here leaves the duty for the next pass without ever
  // orphaning a landed claim.
  await ensureRecheckAccounting(env, handoff, nowMs);
  // The pass that LANDS the record owns the head-wide claim; an overlapping pass
  // that lost the insert race owns nothing and must not touch it. A record the
  // dead host already landed needs its own proof, which the caller supplies.
  let owned = failure.owned === true;
  if (!landed.has("failure-row")) {
    const code = failure.code ?? "review.internal.unclassified";
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
          code,
          trackId: handoff.attemptId,
          message: FAILURE_SUMMARIES[code],
          error: detail,
        },
      },
      nowMs,
    );
    owned = owned || recorded.owned;
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
        code: "review.recheck.unaccounted",
        trackId: handoff.attemptId,
        message: FAILURE_SUMMARIES["review.recheck.unaccounted"],
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
 * Settle a row whose paid reply was lost and whose grace past its own deadline
 * has elapsed (I-000694). The live settlement cannot do this: it must leave the
 * row `launched` with no outcome, because a paid child MAY still be running,
 * and `PAID_STATE_UNKNOWN` is what holds the container and the capacity slot.
 * Only the attempt's own hard stop plus a post-deadline grace can say the
 * child is gone, and this pass is where that judgement lands. An anchored row
 * uses its frozen `deadline_ms`; a pre-column row with none uses the maximum
 * attempt cap as an upper bound on that stop.
 *
 * The guarded move to `failed` is the GATE: every other write in this pass is
 * issued only when its `changes` says this pass won the row — a row that
 * terminalized between the selector and the batch (its paid result persisted
 * and still publishable) gets no failure record and no revocation. The revoke
 * rides in front of the move because its own `state = 'launched'` predicate
 * can only match there, and the settlement-start mark trails the move (guarded
 * by `changes() > 0`) so a crash before the failure record still leaves the
 * row inside `listIncompleteSettlements`' lane. The settlement path itself is
 * the NEIGHBOURING one (`landSettlementEffects`), so the Check lane and the
 * head-wide claim behave exactly as they do for every other settled failure.
 */
async function settleLostReplies(
  env: ReviewRouteEnv,
  windowMs: number,
  nowMs: number,
  log: Pick<NonNullable<ReviewRouteEnv["log"]>, "info"> | undefined,
): Promise<void> {
  let candidates: AttemptHandoff[] = [];
  try {
    candidates = await listLostReplyLaunchSettlements(env.DB, {
      deadlineBeforeMs: nowMs - windowMs,
      limit: ROUTE_RECOVERY_LIMIT,
    });
  } catch {
    return;
  }
  for (const handoff of candidates) {
    // An anchored row settles at its frozen deadline; a pre-column legacy row has
    // none and settles at the selector's cap-ceiling bound.
    const deadlineMs = handoff.deadlineMs;
    const detail =
      deadlineMs === null
        ? `a pre-column legacy attempt carries no frozen deadline; its launch is older than the maximum attempt cap (${REVIEW_ATTEMPT_CAP_MAX_MS} ms) plus ${windowMs} ms of grace, and no reply ever arrived`
        : `attempt deadline ${new Date(deadlineMs).toISOString()} passed more than ${windowMs} ms ago, and no reply ever arrived`;
    let moved: D1Result[];
    try {
      moved = await env.DB.batch([
        markAttemptRevokedStatement(env.DB, handoff.attemptId, nowMs),
        recordReviewFailureStatement(env.DB, handoff.attemptId, nowMs),
        beginAttemptSettlementStatement(env.DB, handoff.deliveryKey, nowMs),
      ] as D1PreparedStatement[]);
    } catch {
      // The batch is atomic: nothing moved, the row is untouched and the next pass retries it.
      continue;
    }
    if ((moved[1]?.meta.changes ?? 0) !== 1) continue;
    try {
      await landSettlementEffects(
        env,
        handoff,
        new Set<SettlementEffect>(handoff.settledEffects ?? []),
        detail,
        nowMs,
        {
          code: "review.paid.reply_lost",
          // The guarded batch above moved this attempt's launch row — a one-way
          // CAS no other pass can win — so this pass owns the head-wide claim
          // even when the dead host already landed the failure record itself.
          owned: true,
        },
      );
      log?.info?.(
        { ...payloadIdentityFields(handoff.payload), attempt_id: handoff.attemptId, error_code: "review.paid.reply_lost" },
        `lost reply settled past its attempt's hard-stop bound — capacity released, the attempt is terminal`,
      );
    } catch (err) {
      // The guarded batch above already made the row terminal (`failed`, revoked,
      // settlement started), so this lane cannot retry it: only the
      // incomplete-settlement lane can finish the failure row and the claim.
      // Log the fault so it is observable instead of silently dropped.
      log?.info?.(
        {
          ...payloadIdentityFields(handoff.payload),
          attempt_id: handoff.attemptId,
          error_cause: err instanceof Error ? err.message : String(err),
        },
        "lost-reply settlement faulted after the attempt became terminal — the incomplete-settlement lane owes the rest",
      );
    }
  }
}


/**
 * Deliver what the route owes. Per-row faults are isolated: one bad row never
 * stops the pass, and the row stays owed for the next one.
 */
export async function reconcileReviewRoute(env: ReviewRouteEnv, nowMs = Date.now()): Promise<void> {
  const queue = env.REVIEW_QUEUE;
  for (const successor of await listOwedSuccessors(env.DB, ROUTE_RECOVERY_LIMIT)) {
    try {
      if ((await successorGeneration(env.DB, successor.dedupeKey)) !== successor.generation) continue;
      await queue.send(successor.payload);
      await markSuccessorDelivered(env.DB, successor.dedupeKey, successor.generation, nowMs);
    } catch {
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
    }
  }
  for (const handoff of await listIncompleteSettlements(env.DB, {
    settlingBeforeMs: nowMs - HANDOFF_RECOVERY_AFTER_MS,
    limit: ROUTE_RECOVERY_LIMIT,
  })) {
    try {
      const landed = new Set<SettlementEffect>(handoff.settledEffects ?? []);
      if (landed.has("skip")) continue;
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
  // The lost-reply observation window (I-000694). The live settlement must
  // leave a lost reply `launched` with no outcome — a paid child may still be
  // running, and that is exactly what holds the container and the capacity
  // slot — so nothing moved the row afterwards: capacity stayed held and the
  // Check never terminalized. The attempt's own deadline plus a post-deadline
  // grace retires that last uncertainty; the settlement then takes the SAME
  // path every other settled failure takes, and moving the launch row to
  // `failed` is what releases the hold. The window is read once per pass, never
  // cached: an operator change applies to the next sweep. No attempt cap is read
  // here either: an anchored row settles from its frozen `deadline_ms`, and a
  // pre-column row from the cap's constant validation ceiling, so neither can
  // move a live child's stop earlier.
  const lostReply = await getLostReplySettleMs(env.DB);
  await settleLostReplies(env, lostReply.settleMs, nowMs, env.log);
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
    }
  }
}

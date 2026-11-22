/**
 * invariant: The review route's durable recovery pass (migration 0083).
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
  IDEM_FAILED,
  idemKey,
  putAbandonClaim,
} from "../contracts/idem";
import { createFailureStore } from "../store/failure-store";
import { readReviewLaunch } from "./review-attempt";
import {
  listCommentClaimsForRecovery,
  listHandoffsForRecovery,
  listIncompleteSettlements,
  listOwedSuccessors,
  markSuccessorDelivered,
  restoreCommentClaimForRecovery,
  settleAttemptIfDischarged,
  successorGeneration,
  touchAttemptHandoff,
  type SettlementEffect,
} from "../store/review-route-store";

/** A handoff is retried only after this quiet period (a live delivery is still trying). */
export const HANDOFF_RECOVERY_AFTER_MS = 5 * 60_000;
/** Rows per pass per family — the reconciler's own bound. */
export const ROUTE_RECOVERY_LIMIT = 25;

export type ReviewRouteEnv = {
  DB: D1Database;
  REVIEW_QUEUE: Queue<ReviewJobPayload>;
  /** note: The commit claim the failed-claim stamp is written to. */
  IDEMPOTENCY_KV: KVNamespace;
};

/**
 * Deliver what the route owes. Per-row faults are isolated: one bad row never
 * stops the pass, and the row stays owed for the next one.
 */
export async function reconcileReviewRoute(env: ReviewRouteEnv, nowMs = Date.now()): Promise<void> {
  const queue = env.REVIEW_QUEUE;
  // invariant: A settled skip's successor is the more urgent one: a head with no review at
  // all. Send first, mark only after the queue accepted it.
  for (const successor of await listOwedSuccessors(env.DB, ROUTE_RECOVERY_LIMIT)) {
    try {
      // note: Pre-send check: this pass read the row earlier, and a re-arm since then
      // makes the copy in hand stale. Sending it would deliver an obligation the
      // drop has already superseded; the next pass reads the fresher one.
      if ((await successorGeneration(env.DB, successor.dedupeKey)) !== successor.generation) continue;
      await queue.send(successor.payload);
      // note: Generation-scoped: a re-arm during the send keeps the row owed.
      await markSuccessorDelivered(env.DB, successor.dedupeKey, successor.generation, nowMs);
    } catch {
      // note: Stays owed; the next pass retries it.
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
      // note: Stays owed (the clock is untouched); the next pass retries it.
    }
  }
  // invariant: A settlement that STARTED and never completed. The Workflow's own retry
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
      // note: A skip is not a failure: the moved-head settlement owns that outcome,
      // and the successor outbox already carries the head it displaced.
      if (landed.has("skip")) continue;
      // invariant: ACT ONLY ON A DURABLE OUTCOME. `launched` without an outcome is the
      // unknown paid state — the container may still be running — and a
      // delivery that never provisioned has no outcome to replay. Nothing is
      // written for either; retention owns them.
      const launch = await readReviewLaunch(env.DB, handoff.attemptId);
      if (launch === null || (launch.state !== "failed" && launch.state !== "persisted")) continue;
      if (!landed.has("failure-row")) {
        await createFailureStore(env.DB).record({
          target_id: handoff.payload.targetId,
          installation_id: handoff.payload.installation_id,
          owner: handoff.payload.owner,
          repo: handoff.payload.repo,
          pr_number: handoff.payload.pr_number,
          head_sha: handoff.payload.head_sha ?? "",
          stage: "pipeline",
          error: `settlement replay: the attempt's settlement did not finish (landed: ${
            landed.size === 0 ? "nothing" : [...landed].join(", ")
          }); the route's recovery pass recorded this failure and finished the settlement`,
        });
        landed.add("failure-row");
      }
      if (!landed.has("claim-stamp") && handoff.payload.head_sha) {
        await putAbandonClaim(
          env.IDEMPOTENCY_KV,
          idemKey({
            installation_id: handoff.payload.installation_id,
            owner: handoff.payload.owner,
            repo: handoff.payload.repo,
            pr_number: handoff.payload.pr_number,
            head_sha: handoff.payload.head_sha,
          }),
          IDEM_FAILED,
          IDEMPOTENCY_SECONDS,
        );
        landed.add("claim-stamp");
      }
      // invariant: The ONE settlement rule decides completeness from durable facts: the
      // Check must actually be terminal (this pass never concludes it), and the
      // failed-claim stamp is required only when the lane names a commit. The
      // effects this pass landed are the facts; it never certifies the rest.
      await settleAttemptIfDischarged(
        env.DB,
        { attemptId: handoff.attemptId, landed: [...landed] },
        nowMs,
      );
    } catch {
      // note: Stays incomplete; the next pass retries it.
    }
  }
  // note: A claim whose delivery died before recording anything. The state transition
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
      // note: Already `queued` with its payload: the outbox lane retries it.
    }
  }
}

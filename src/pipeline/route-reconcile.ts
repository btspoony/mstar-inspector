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
import type { D1Database, Queue } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../contracts/review-job";
import {
  listCommentClaimsForRecovery,
  listHandoffsForRecovery,
  listOwedSuccessors,
  markSuccessorDelivered,
  restoreCommentClaimForRecovery,
  successorGeneration,
  touchAttemptHandoff,
} from "../store/review-route-store";

/** A handoff is retried only after this quiet period (a live delivery is still trying). */
export const HANDOFF_RECOVERY_AFTER_MS = 5 * 60_000;
/** Rows per pass per family — the reconciler's own bound. */
export const ROUTE_RECOVERY_LIMIT = 25;

export type ReviewRouteEnv = { DB: D1Database; REVIEW_QUEUE: Queue<ReviewJobPayload> };

/**
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

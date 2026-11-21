/**
 * The review route's durable recovery pass (migration 0083).
 *
 * Two things can be owed after a host is interrupted:
 *
 * - an ATTEMPT HANDOFF whose instance creation was never confirmed (`owed`, or
 *   `ambiguous` because the create reply was lost). The pass re-enqueues the
 *   recorded payload; the queue handler reads the handoff row, reuses its
 *   attempt id and re-tries create. A replay is idempotent: an instance that
 *   exists answers "already exists" and is recorded as created, never a second
 *   attempt.
 * - a SUCCESSOR intent a moved head recorded but the immediate send did not
 *   deliver. The pass sends it; the outbox dedupe key (the observed head) means
 *   one moved head can never produce two successor admissions.
 *
 * `updated_ms` is bumped after a re-enqueue so one sweep cannot hot-loop on the
 * same row; a failed send leaves the clock untouched, so the next pass retries.
 */
import type { D1Database, Queue } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../contracts/review-job";
import {
  listHandoffsForRecovery,
  listOwedSuccessors,
  markSuccessorDelivered,
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
      await queue.send(successor.payload);
      await markSuccessorDelivered(env.DB, successor.dedupeKey, nowMs);
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
}

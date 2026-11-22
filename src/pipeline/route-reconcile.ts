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
  IDEMPOTENCY_KV: KVNamespace;
};

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
      await settleAttemptIfDischarged(
        env.DB,
        { attemptId: handoff.attemptId, landed: [...landed] },
        nowMs,
      );
    } catch {
    }
  }
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

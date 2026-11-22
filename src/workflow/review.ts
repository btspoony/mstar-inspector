import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ReviewJobPayload } from "../contracts/review-job";
import {
  createProcessDeps,
  ensureRunnerConfig,
  hydrateAttemptHost,
} from "../pipeline/consumer";
import {
  AttemptPhaseError,
  cleanupAttempt,
  collectAttempt,
  prepareAttempt,
  publishAttempt,
  reviewAttempt,
  settleAttemptFailure,
  settleSkippedRow,
  payloadIdentityFields,
  type AttemptRef,
  type CleanupInput,
  type ProcessDeps,
} from "../pipeline/review-attempt-execution";
import { MovedHeadError } from "../pipeline/review-attempt";
import { POST_RUNNER_READ_BUDGET_MS } from "../review-budget";
import {
  beginAttemptSettlement,
  deliveryKeyOf,
  markSuccessorDelivered,
  readAttemptHandoff,
  recordSuccessorIntent,
  successorIntentOf,
} from "../store/review-route-store";
import type { Env } from "../worker/env";
import type { PipelineEnv } from "../pipeline/review-attempt-execution";

/** The Worker env a Workflow instance sees (the platform binding intersection). */
export type ReviewWorkflowEnv = Env & PipelineEnv;

/** How the workflow re-admits a head that displaced the frozen identity. */
export type SuccessorQueue = (payload: ReviewJobPayload) => Promise<void>;

/**
 * Compose the attempt's five phases as durable steps. Exported (not only a
 * method) so the whole route can be driven with a step double: the phases are
 * the same calls either way.
 */
export async function runReviewAttemptWorkflow(
  deps: ProcessDeps,
  ref: AttemptRef,
  step: WorkflowStep,
  enqueueSuccessor: SuccessorQueue,
): Promise<void> {
  const cleanup: CleanupInput = {};
  try {
    if ((await ensureHostChannel(deps, ref)) === "paused") {
      await settleSkippedRow(deps, ref.payload, ref.payload.head_sha, "review paused", { paused: true });
      return;
    }
    const prepared = await step.do("prepare", async () => {
      await ensureRunnerConfig(ref.payload, deps);
      return prepareAttempt(deps, ref);
    });
    if (prepared.kind === "settled") return;
    cleanup.headSha = prepared.prepared.headSha;
    const remainingMs = Math.max(1, prepared.prepared.runnerDeadlineMs - Date.now());
    await step.do(
      "review",
      {
        retries: { limit: 0, delay: 0 },
        timeout: remainingMs + POST_RUNNER_READ_BUDGET_MS,
      },
      async () => {
        await ensureRunnerConfig(ref.payload, deps);
        return reviewAttempt(deps, ref, prepared.prepared);
      },
    );
    const collected = await step.do("collect", () => collectAttempt(deps, ref, prepared.prepared));
    if (collected.kind === "settled") return;
    await step.do("publish", () => publishAttempt(deps, ref, collected.collected.publicationId));
  } catch (err) {
    const facts = err instanceof AttemptPhaseError ? err.facts : undefined;
    if (facts?.headSha !== undefined) cleanup.headSha = facts.headSha;
    if (facts?.runnerStartedAt !== undefined && !facts.runnerReturned) cleanup.unproven = true;
    const moved = movedHeadOf(err);
    await step.do(
      "settle-failure",
      { retries: { limit: 1, delay: 1 }, timeout: "5 minutes" },
      async () => {
        const deliveryKey = deliveryKeyOf(ref.payload);
        const handoff = await readAttemptHandoff(deps.env.DB, deliveryKey);
        if (handoff !== null && handoff.settledMs !== null) return { settled: true };
        if (handoff !== null) await beginAttemptSettlement(deps.env.DB, deliveryKey, Date.now());
        await settleAttemptFailure(deps, ref, err, cleanup);
        return { settled: true };
      },
    );
    if (moved !== null) {
      await step.do("successor", { retries: { limit: 0, delay: 0 }, timeout: "5 minutes" }, async () => {
        await recordSuccessor(deps, ref, moved, enqueueSuccessor);
        return { recorded: true };
      });
    }
  } finally {
    await step.do("cleanup", { retries: { limit: 0, delay: 0 }, timeout: "5 minutes" }, async () => {
      await cleanupAttempt(deps, ref, cleanup);
      return { cleaned: true };
    });
  }
}

/**
 * One instance per admitted attempt. The instance id IS the attempt id, so the
 * platform's own id uniqueness is a second fence under the consumer's D1 claim,
 * and a restart addresses the same attempt.
 */
export class ReviewWorkflow extends WorkflowEntrypoint<ReviewWorkflowEnv, AttemptRef> {
  async run(event: Readonly<WorkflowEvent<AttemptRef>>, step: WorkflowStep): Promise<void> {
    const deps = createProcessDeps(this.env);
    const queue = this.env.REVIEW_QUEUE;
    await runReviewAttemptWorkflow(deps, event.payload, step, (payload) =>
      queue.send(payload).then(() => undefined),
    );
  }
}

async function ensureHostChannel(deps: ProcessDeps, ref: AttemptRef): Promise<"ready" | "paused"> {
  if (deps.appCommenters.has(ref.payload.botRef.appId)) return "ready";
  return hydrateAttemptHost(ref.payload, deps);
}

function movedHeadOf(err: unknown): { headSha: string | null } | null {
  const cause = err instanceof AttemptPhaseError ? err.cause : err;
  if (!(cause instanceof MovedHeadError)) return null;
  const headSha = err instanceof AttemptPhaseError ? err.facts.headSha : null;
  return { headSha };
}

async function recordSuccessor(
  deps: ProcessDeps,
  ref: AttemptRef,
  moved: { headSha: string | null },
  enqueueSuccessor: SuccessorQueue,
): Promise<void> {
  const fields = { ...payloadIdentityFields(ref.payload), attempt_id: ref.attemptId };
  if (moved.headSha === null) {
    deps.log.warn(
      { ...fields, event: "review_moved_head_no_successor" },
      "the attempt row carries another caller's identity and the checkout never observed a head — nothing to re-admit",
    );
    return;
  }
  const intent = successorIntentOf(ref.payload, moved.headSha);
  if (intent === null) return;
  const stored = await recordSuccessorIntent(deps.env.DB, {
    dedupeKey: intent.dedupeKey,
    payload: intent.payload,
    nowMs: Date.now(),
  });
  try {
    await enqueueSuccessor(stored.payload);
    await markSuccessorDelivered(deps.env.DB, intent.dedupeKey, stored.generation, Date.now());
    deps.log.warn(
      { ...fields, event: "review_moved_head_successor", head_sha: moved.headSha },
      "moved head settled as skipped — the observed head was re-admitted so a new attempt owns it",
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(
      { ...fields, event: "review_successor_enqueue_failed", head_sha: moved.headSha },
      `the moved head's successor is recorded and owed — the recovery pass will deliver it (${detail})`,
    );
  }
}

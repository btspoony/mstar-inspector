/**
 * The ONE paid execution route for a review attempt.
 *
 * The queue consumer admits, dedupes and settles skips, then creates exactly
 * one instance per admitted attempt (`env.REVIEW_WORKFLOW`); this module runs
 * that instance. Each phase is its own durable step, so a restart resumes from
 * a boundary instead of a live stack, and the paid step is declared
 * `retries: { limit: 0 }` — the platform must never launch a second model call
 * for one attempt.
 *
 * Step inputs and outputs are the execution module's data handoffs (4b's
 * invariant), never a container, token or live object: the step host rebuilds
 * those from `deps` plus the durable attempt row.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ReviewJobPayload } from "../contracts/review-job";
import {
  createProcessDeps,
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
  // The facts cleanup needs from this invocation: the checkout sha it knew and
  // whether the container's state was left unknown. Everything else it proves
  // from the launch row.
  const cleanup: CleanupInput = {};
  try {
    if ((await ensureHostChannel(deps, ref)) === "paused") {
      // The App was paused after admission: the attempt owes no review, and
      // the run this delivery attached is settled instead of waiting out its
      // deadline.
      await settleSkippedRow(deps, ref.payload, ref.payload.head_sha, "review paused");
      return;
    }
    const prepared = await step.do("prepare", () => prepareAttempt(deps, ref));
    if (prepared.kind === "settled") return;
    cleanup.headSha = prepared.prepared.headSha;
    // The step must outlive the container's own deadline — the container
    // enforces the hard stop — plus the bounded read of its reply.
    const remainingMs = Math.max(1, prepared.prepared.runnerDeadlineMs - Date.now());
    await step.do(
      "review",
      {
        // The platform cannot retry the paid step.
        retries: { limit: 0, delay: 0 },
        timeout: remainingMs + POST_RUNNER_READ_BUDGET_MS,
      },
      () => reviewAttempt(deps, ref, prepared.prepared),
    );
    const collected = await step.do("collect", () => collectAttempt(deps, ref, prepared.prepared));
    if (collected.kind === "settled") return;
    await step.do("publish", () => publishAttempt(deps, ref, collected.collected.publicationId));
  } catch (err) {
    const moved = movedHeadOf(err);
    await settleAttemptFailure(deps, ref, err, cleanup);
    if (moved !== null) await handOffSuccessor(deps, ref, moved, enqueueSuccessor);
  } finally {
    await cleanupAttempt(deps, ref, cleanup);
  }
}

/**
 * One instance per admitted attempt. The instance id IS the attempt id, so the
 * platform's own id uniqueness is a second fence under the consumer's D1 claim,
 * and a restart addresses the same attempt.
 */
export class ReviewWorkflow extends WorkflowEntrypoint<ReviewWorkflowEnv, AttemptRef> {
  async run(event: Readonly<WorkflowEvent<AttemptRef>>, step: WorkflowStep): Promise<void> {
    // A Workflow invocation has none of the queue invocation's host state: the
    // per-App adapter and runner config are resolved again from the payload.
    const deps = createProcessDeps(this.env);
    const queue = this.env.REVIEW_QUEUE;
    await runReviewAttemptWorkflow(deps, event.payload, step, (payload) =>
      queue.send(payload).then(() => undefined),
    );
  }
}

/**
 * Fill the host channel only when this host has not resolved it already. The
 * queue's handoff filled it for the in-process test route; a Workflow host
 * starts empty and re-resolves.
 */
async function ensureHostChannel(deps: ProcessDeps, ref: AttemptRef): Promise<"ready" | "paused"> {
  const appId = ref.payload.botRef.appId;
  if (deps.appCommenters.has(appId) && deps.runnerConfigs.has(appId)) return "ready";
  return hydrateAttemptHost(ref.payload, deps);
}

/** The phase wrapper's cause, when the cause is a moved head. */
function movedHeadOf(err: unknown): { headSha: string | null } | null {
  const cause = err instanceof AttemptPhaseError ? err.cause : err;
  if (!(cause instanceof MovedHeadError)) return null;
  const headSha = err instanceof AttemptPhaseError ? err.facts.headSha : null;
  return { headSha };
}

/**
 * A moved head does not continue under the frozen identity: the attempt has
 * already settled as skipped, and the head it actually observed is re-admitted
 * through the queue so ADMISSION decides the successor. That keeps one owner of
 * supersession — the queue's admission — instead of letting the workflow mint
 * an attempt the capacity and dedupe rules never saw.
 */
async function handOffSuccessor(
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
  const successor: ReviewJobPayload = {
    ...ref.payload,
    head_sha: moved.headSha,
    head_at: new Date().toISOString(),
    // The successor is a NEW review of the observed head, not this delivery:
    // the comment claim and the Check attach both belonged to the skipped one.
    comment_id: undefined,
    attachDeliveryId: undefined,
  };
  try {
    await enqueueSuccessor(successor);
    deps.log.warn(
      { ...fields, event: "review_moved_head_successor", head_sha: moved.headSha },
      "moved head settled as skipped — the observed head was re-admitted so a new attempt owns it",
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(
      { ...fields, event: "review_successor_enqueue_failed", head_sha: moved.headSha },
      `the moved head could not be re-admitted — the skip row is the trace (${detail})`,
    );
  }
}

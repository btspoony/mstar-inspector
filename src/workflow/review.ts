/**
 * invariant: The ONE paid execution route for a review attempt.
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
  // invariant: The facts cleanup needs: the checkout sha it knew and whether the
  // container's state was left unknown. They are recomputed from the thrown
  // error below (never from a local a step might skip on replay), so a resumed
  // host hands cleanup the same input.
  const cleanup: CleanupInput = {};
  try {
    if ((await ensureHostChannel(deps, ref)) === "paused") {
      // note: The App was paused after admission: the attempt owes no review, and
      // the run this delivery attached is settled instead of waiting out its
      // deadline.
      await settleSkippedRow(deps, ref.payload, ref.payload.head_sha, "review paused", { paused: true });
      return;
    }
    // invariant: The App's paid-provider configuration is resolved by the steps that
    // SPEND it, never by the host entry: a restart that only has to finish
    // `collect`/`publish` for already-paid work must not fail because a
    // provider key rotated after the paid call.
    const prepared = await step.do("prepare", async () => {
      await ensureRunnerConfig(ref.payload, deps);
      return prepareAttempt(deps, ref);
    });
    if (prepared.kind === "settled") return;
    cleanup.headSha = prepared.prepared.headSha;
    // invariant: The step must outlive the container's own deadline — the container
    // enforces the hard stop — plus the bounded read of its reply.
    const remainingMs = Math.max(1, prepared.prepared.runnerDeadlineMs - Date.now());
    await step.do(
      "review",
      {
        // invariant: The platform cannot retry the paid step.
        retries: { limit: 0, delay: 0 },
        timeout: remainingMs + POST_RUNNER_READ_BUDGET_MS,
      },
      // invariant: The prepare step may be checkpointed on a host that never ran it, so
      // the step that pays resolves (or reuses) the config itself.
      async () => {
        await ensureRunnerConfig(ref.payload, deps);
        return reviewAttempt(deps, ref, prepared.prepared);
      },
    );
    const collected = await step.do("collect", () => collectAttempt(deps, ref, prepared.prepared));
    if (collected.kind === "settled") return;
    await step.do("publish", () => publishAttempt(deps, ref, collected.collected.publicationId));
  } catch (err) {
    // invariant: Cleanup's input is derived from the error itself, so it is identical on
    // a replay that never re-executes the settlement callback.
    const facts = err instanceof AttemptPhaseError ? err.facts : undefined;
    if (facts?.headSha !== undefined) cleanup.headSha = facts.headSha;
    if (facts?.runnerStartedAt !== undefined && !facts.runnerReturned) cleanup.unproven = true;
    const moved = movedHeadOf(err);
    // invariant: Everything after the paid step is its own durable step: a JavaScript
    // `catch`/`finally` does not survive an interrupted host. The settlement
    // step retries ONCE: its first attempt can hit a transient fault, and a
    // settlement that never runs leaves the Check open forever.
    await step.do(
      "settle-failure",
      { retries: { limit: 1, delay: 1 }, timeout: "5 minutes" },
      async () => {
        // invariant: The mark is COMPLETION, written by the settlement itself once its
        // effects are durable — never an entry claim. Reading it here skips a
        // settlement that finished; an interruption before it finished leaves
        // no mark, so this step (or its retry, or a resumed host) settles again.
        const deliveryKey = deliveryKeyOf(ref.payload);
        const handoff = await readAttemptHandoff(deps.env.DB, deliveryKey);
        if (handoff !== null && handoff.settledMs !== null) return { settled: true };
        // invariant: The in-progress marker: this row is now the route's recovery pass's
        // obligation if this execution never reaches its completion mark.
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
      // invariant: The retention table still decides: cleanup destroys only what the
      // durable records authorise, and `cleanup.unproven` can only narrow it.
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
    // note: A Workflow invocation has none of the queue invocation's host state: the
    // per-App adapter and runner config are resolved again from the payload.
    const deps = createProcessDeps(this.env);
    const queue = this.env.REVIEW_QUEUE;
    await runReviewAttemptWorkflow(deps, event.payload, step, (payload) =>
      queue.send(payload).then(() => undefined),
    );
  }
}

/**
 * invariant: Fill the host channel only when this host has not resolved it already. The
 * queue's handoff filled it for the in-process test route; a Workflow host
 * starts empty and re-resolves.
 */
async function ensureHostChannel(deps: ProcessDeps, ref: AttemptRef): Promise<"ready" | "paused"> {
  if (deps.appCommenters.has(ref.payload.botRef.appId)) return "ready";
  return hydrateAttemptHost(ref.payload, deps);
}

/** note: The phase wrapper's cause, when the cause is a moved head. */
function movedHeadOf(err: unknown): { headSha: string | null } | null {
  const cause = err instanceof AttemptPhaseError ? err.cause : err;
  if (!(cause instanceof MovedHeadError)) return null;
  const headSha = err instanceof AttemptPhaseError ? err.facts.headSha : null;
  return { headSha };
}

/**
 * invariant: A moved head does not continue under the frozen identity: the attempt has
 * already settled as skipped, and the head it actually observed is written to
 * the successor OUTBOX — a durable row the route's recovery pass retries — then
 * delivered on a best-effort basis. The moved head's own settlement
 * (`settleMovedHead`) writes that row BEFORE it terminalizes the old Check, so
 * this step only re-records the same intent (idempotent) and sends it.
 *
 * Admission decides the successor (capacity, dedupe, Check claim); the workflow
 * never mints an attempt those rules never saw.
 */
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
  // invariant: The durable fact first: the outbox row. Even if the send below never
  // happens, the recovery pass delivers it. The payload SENT is the stored one:
  // a concurrent writer of the same intent wins, and its payload is what
  // admission must see — never a locally rebuilt variant beside it.
  const stored = await recordSuccessorIntent(deps.env.DB, {
    dedupeKey: intent.dedupeKey,
    payload: intent.payload,
    nowMs: Date.now(),
  });
  try {
    await enqueueSuccessor(stored.payload);
    // note: Generation-scoped: if the row was re-armed while this send was in flight,
    // it stays owed and the recovery pass delivers the fresher one.
    await markSuccessorDelivered(deps.env.DB, intent.dedupeKey, stored.generation, Date.now());
    deps.log.warn(
      { ...fields, event: "review_moved_head_successor", head_sha: moved.headSha },
      "moved head settled as skipped — the observed head was re-admitted so a new attempt owns it",
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // note: The row stays owed: the recovery pass will deliver it. A lost send is not
    // a lost successor.
    deps.log.warn(
      { ...fields, event: "review_successor_enqueue_failed", head_sha: moved.headSha },
      `the moved head's successor is recorded and owed — the recovery pass will deliver it (${detail})`,
    );
  }
}

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ReviewJobPayload } from "../contracts/review-job";
import {
  createProcessDeps,
  ensureRunnerConfig,
  hydrateAttemptHost,
} from "../pipeline/consumer";
import {
  cleanupAttempt,
  collectAttempt,
  prepareAttempt,
  publishAttempt,
  reviewAttempt,
  readDurablePaid,
  settleAttemptFailure,
  phaseFailureRecord,
  errorClassOf,
  PhaseTransientError,
  transientFactsOf,
  settleSkippedRow,
  payloadIdentityFields,
  type AttemptRef,
  type CleanupInput,
  type AttemptPhase,
  type PhaseFailure,
  type PreparedAttempt,
  type ProcessDeps,
} from "../pipeline/review-attempt-execution";
import { ConfigUnresolvedError } from "../pipeline/review-attempt";
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
 * A phase's classified terminal failure, raised INSIDE the Workflow (never
 * inside a `step.do` callback) so the existing try/catch/finally shape keeps
 * running while the facts themselves crossed the step boundary as data.
 */
export class PhaseFailed extends Error {
  constructor(readonly failure: PhaseFailure) {
    super(failure.message);
    this.name = "PhaseFailed";
  }
}

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
  let prepared: PreparedAttempt | null = null;
  let inPhase: AttemptPhase = "prepare";
  try {
    if ((await ensureHostChannel(deps, ref)) === "paused") {
      await settleSkippedRow(deps, ref.payload, ref.payload.head_sha, "review paused", { paused: true });
      return;
    }
    const step1 = await step.do("prepare", async () => {
      // A per-App config fault is a KNOWN, terminal refusal: retrying it only
      // burns the step's budget. It is classified here, inside the step, so the
      // outcome crosses the boundary as the same record every other terminal
      // failure uses.
      try {
        await ensureRunnerConfig(ref.payload, deps);
      } catch (err) {
        const failure = phaseFailureRecord(
          {
            phase: "prepare",
            stage: "pipeline",
            headSha: null,
            runnerReturned: false,
            tier: ref.level,
            budgetMs: 0,
            changedLines: null,
            sendAttemptPublicationId: null,
          },
          new ConfigUnresolvedError(err instanceof Error ? err.message : String(err)),
        );
        if (failure !== null) return { kind: "failed" as const, failure };
        throw err;
      }
      return prepareAttempt(deps, ref);
    });
    if (step1.kind === "settled") return;
    // A terminal outcome is a RETURN VALUE; the signal is raised here, outside
    // the callback, so replaying the cached step re-raises the same one.
    if (step1.kind === "failed") throw new PhaseFailed(step1.failure);
    prepared = step1.prepared;
    const handoff = prepared;
    cleanup.headSha = handoff.headSha;
    const remainingMs = Math.max(1, handoff.runnerDeadlineMs - Date.now());
    // The phase is set BEFORE the boundary, as collect and publish already do:
    // a platform failure of the step itself — the callback never ran — must
    // still attribute the throw to the phase the instance was in.
    inPhase = "review";
    const reviewed = await step.do(
      "review",
      {
        retries: { limit: 0, delay: 0 },
        timeout: remainingMs + POST_RUNNER_READ_BUDGET_MS,
      },
      // The prepare step may be checkpointed on a host that never ran it, so
      // the step that pays resolves (or reuses) the config itself — but ONLY
      // when it still has to pay. A replayed step can find the paid result
      // already durable, and collect then finishes from the attempt's sealed
      // credential set: resolving today's config for it would make an
      // already-paid result depend on configuration that may have been removed,
      // and a resolution fault would settle the attempt as a failure.
      async () => {
        // Config is resolved only for a step that can still PAY. A persisted
        // result needs none (collect owns it), and a non-payable row must not
        // make an already-decided attempt depend on today's configuration.
        if ((await readDurablePaid(deps, ref.attemptId)).kind === "payable") {
          await ensureRunnerConfig(ref.payload, deps);
        }
        return reviewAttempt(deps, ref, handoff);
      },
    );
    if ("failure" in reviewed) throw new PhaseFailed(reviewed.failure);
    inPhase = "collect";
    const collected = await step.do("collect", () => collectAttempt(deps, ref, handoff));
    if (collected.kind === "settled") return;
    if (collected.kind === "failed") throw new PhaseFailed(collected.failure);
    inPhase = "publish";
    const published = await step.do("publish", () =>
      publishAttempt(deps, ref, collected.collected.publicationId),
    );
    if ("failure" in published) throw new PhaseFailed(published.failure);
  } catch (err) {
    // A classified error thrown OUTSIDE a phase wrapper (this file's own host
    // and fence probes) is turned into the same record; only an unclassified
    // one stays a throw, settled as ordinary and retried by a fresh delivery.
    // An unclassified throw carries the stage its own step observed (a clone
    // failure is `sandbox`, a runner failure `runner`); only a throw raised HERE
    // — this file's host and fence probes — has no step to ask.
    // A Workflows retry rebuilds the thrown error without its prototype, so the
    // facts are read off the own property, never through `instanceof`.
    const transient = transientFactsOf(err);
    const failure =
      err instanceof PhaseFailed
        ? err.failure
        : phaseFailureRecord(
            {
              phase: inPhase,
              stage: transient?.stage ?? "pipeline",
              headSha: transient?.headSha ?? prepared?.headSha ?? null,
              runnerReturned: transient?.runnerReturned ?? prepared !== null,
              tier: ref.level,
              budgetMs: prepared?.runnerEffectiveMs ?? 0,
              changedLines: prepared?.observedChangedLines ?? null,
              sendAttemptPublicationId: transient?.sendAttemptPublicationId ?? null,
            },
            err instanceof PhaseTransientError ? err.cause : err,
          );
    if (failure?.headSha !== undefined && failure.headSha !== null) cleanup.headSha = failure.headSha;
    // The settlement concluded "unknown": no proof of what runs on the slot
    // exists, and the D1 row cannot express that (it proves only that nothing
    // was paid). The veto therefore rides the cleanup input, computed HERE from
    // the record so a replay of the settle step cannot lose it.
    if (failure?.class === "unknown" && failure.containerStateUnknown) cleanup.unproven = true;
    const moved = failure?.class === "moved-head" ? { headSha: failure.headSha } : null;
    await step.do(
      "settle-failure",
      { retries: { limit: 1, delay: 1 }, timeout: "5 minutes" },
      async () => {
        const deliveryKey = deliveryKeyOf(ref.payload);
        const handoff = await readAttemptHandoff(deps.env.DB, deliveryKey);
        if (handoff !== null && handoff.settledMs !== null) return { settled: true };
        if (handoff !== null) await beginAttemptSettlement(deps.env.DB, deliveryKey, Date.now());
        const outcome = await settleAttemptFailure(
          deps,
          ref,
          // A thrown, unclassified error has no record: it settles as the
          // ordinary failure its message describes (D6 "after retries run out").
          failure ??
            ordinaryFailure(
              err instanceof PhaseTransientError ? err.cause : err,
              inPhase,
              prepared,
              transient,
            ),
          prepared,
        );
        // An UNCLASSIFIED throw is transient: it rethrows here so the step's
        // own retry (and, exhausted, the platform) retries the delivery. The
        // second attempt sees the settled mark and returns. `unknown` is not a
        // retry: the attempt holds capacity and its container on evidence
        // nobody observed, and a replay would settle it a second time.
        if (failure === null && outcome.kind !== "unknown") {
          throw (err instanceof PhaseTransientError ? err.cause : err);
        }
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
 * A thrown error with no failure record: the rebuilt object is used for its
 * MESSAGE only — extracted without `instanceof`, with a leading `"<name>: "`
 * stripped — and settled as the ordinary branch those errors take.
 */
function ordinaryFailure(
  err: unknown,
  phase: AttemptPhase,
  prepared: PreparedAttempt | null,
  transient?: PhaseTransientError["facts"],
): PhaseFailure {
  const raw = err instanceof Error ? err.message : String(err);
  // The class the throw site captured rides the transient facts as plain data;
  // only a throw with no wrapper — this file's own host probes — is asked for
  // its constructor directly, and a rebuild without a prototype still answers
  // through its surviving `name`.
  const errorClass = transient?.errorClass ?? errorClassOf(err);
  const message = raw.replace(/^[A-Za-z][\w.]*Error: /, "");
  return {
    class: "failure",
    phase,
    // The stage the failing step reported, so a clone failure is not flattened
    // into the same `pipeline` a Workflow-level fault records.
    stage: transient?.stage ?? "pipeline",
    headSha: transient?.headSha ?? prepared?.headSha ?? null,
    // Only the step that observed the runner outranks the row. A rebuilt throw
    // from the engine (a step that timed out) observed nothing, so the record
    // must not claim the runner returned: the settlement's `paid-unknown` guard
    // reads this field to decide whether an unconfirmed row may be concluded.
    runnerReturned: transient?.runnerReturned ?? false,
    message,
    // The throw site's own cause when one was chained, otherwise the class and
    // the bounded message the settlement would otherwise have to re-derive —
    // the observation the reconciler renders carries the facts as data, never
    // a sentence parsed back out of the composed text.
    // The cause is NOT bounded here: it is sanitized at settlement, and a cut
    // that ran first would destroy the exact match the redaction needs. The
    // observation path bounds it after the exact pass.
    cause: errorCauseText(err) ?? (errorClass === undefined ? message : `${errorClass}: ${message}`),
    ...(transient?.lastStage === undefined ? {} : { lastStage: transient.lastStage }),
    ...(errorClass === undefined ? {} : { errorClass }),
    sendAttemptPublicationId: transient?.sendAttemptPublicationId ?? null,
    rateLimited: transient?.rateLimited ?? null,
  };
}

/** A chained string cause, read with a real narrow — never an inline cast shape. */
function errorCauseText(err: unknown): string | undefined {
  if (err === null || typeof err !== "object" || !("cause" in err)) return undefined;
  const cause = (err as Error).cause;
  return typeof cause === "string" && cause !== "" ? cause : undefined;
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

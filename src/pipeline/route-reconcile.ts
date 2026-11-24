import type { D1Database, D1PreparedStatement, D1Result, KVNamespace, Queue } from "@cloudflare/workers-types";
import { FAILURE_SUMMARIES, type FailureCode } from "../contracts/failure-codes";
import type { ReviewJobPayload } from "../contracts/review-job";
import {
  IDEMPOTENCY_SECONDS,
  idemKey,
} from "../contracts/idem";
import { getLostReplySettleMs } from "../dashboard/runtime-config-store";
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
  listLateObservedFailures,
  listLostReplyLaunchSettlements,
  readAttemptHandoffByAttempt,
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
  syncSettledFailureRow,
  touchAttemptHandoff,
  type AttemptHandoff,
  type AttemptObservation,
  type SettlementEffect,
} from "../store/review-route-store";

/** A handoff is retried only after this quiet period (a live delivery is still trying). */
export const HANDOFF_RECOVERY_AFTER_MS = 5 * 60_000;
/** Rows per pass per family — the reconciler's own bound. */
export const ROUTE_RECOVERY_LIMIT = 25;

/**
 * The observation the attempt holds RIGHT NOW — never the selector's copy: the
 * selector read the row before it decided to settle, and the live phase may have
 * recorded its cause since. A FAILED read throws on purpose: it is not evidence
 * that nothing was observed, so the attempt is skipped for this pass and its
 * lane selects it again (the next cron pass retries). A successful read returns
 * exactly what the row holds, `null` included.
 */
async function readObservedCause(
  env: ReviewRouteEnv,
  handoff: AttemptHandoff,
): Promise<AttemptObservation | null> {
  const row = await readAttemptHandoffByAttempt(env.DB, handoff.attemptId);
  return row?.observation ?? null;
}

/**
 * Mechanism vocabulary a cause can carry, and the plain noun an author reads
 * instead. A closed list on purpose: whoever threw wrote the cause, and only
 * this row is author-visible. Anything absent stays — "GitHub" or "the diff" is
 * the author's own language. Plurals first so a plural never half-matches.
 */
const MECHANISM_TERMS: readonly (readonly [RegExp, string])[] = [
  [/\bdurable\s+objects\b/gi, "review service"],
  [/\bdurable\s+object\b/gi, "review service"],
  [/\bcontainer(s?)\b/gi, "review environment$1"],
  [/\bsandbox(es)?\b/gi, "review environment$1"],
  [/\bmarker(s?)\b/gi, "attempt setup$1"],
  [/\bexec(s?)\b/gi, "review step$1"],
  [/\bworkflow\s+instances?\b/gi, "review run"],
  [/\bworkflows?\b/gi, "review run"],
  [/\bchild\s+process(?:es)?\b/gi, "review step"],
  [/\b(?:\d+|thousands?)\s*ms\b/gi, "a short time"],
];

/**
 * The fallback `review_failures.error` the lost-reply lane writes when no
 * observation existed yet — two constants (anchored / pre-column), which is
 * what lets the late-observation sync PROVE a row is this reconciler's own
 * before rewriting it. The deadline and the grace are durable on the launch
 * and handoff rows; the sentence states the conclusion.
 */
const LOST_REPLY_FALLBACK_ERROR =
  "its attempt deadline plus the post-deadline grace elapsed, and no reply ever arrived";
const LOST_REPLY_FALLBACK_ERROR_UNANCHORED =
  "a pre-column legacy attempt carries no frozen deadline; its launch outlived the maximum attempt cap plus the post-deadline grace, and no reply ever arrived";

/**
 * The exact row shape this reconciler writes for a lost reply with no
 * observation: attempt-keyed, the lane's own code, and one of its fallback
 * sentences. The late-observation sync binds this shape — a row any other
 * producer wrote is never selected, never rewritten.
 */
const LOST_REPLY_FALLBACK_SHAPE = {
  fallbackCode: "review.paid.reply_lost",
  fallbackErrors: [LOST_REPLY_FALLBACK_ERROR, LOST_REPLY_FALLBACK_ERROR_UNANCHORED],
  fallbackMessage: FAILURE_SUMMARIES["review.paid.reply_lost"],
} as const;

/**
 * The cause an author can be shown, read as DATA off the observation: the
 * throw site carried it next to its composed message, so nothing here parses
 * the message back apart. The `Name:` prefix and the `(after <n>ms)` suffix
 * are the throw boundary's own envelope; what remains is elided term by term
 * and bounded.
 */
function authorFacingCause(observed: AttemptObservation): string {
  let cause = (observed.cause ?? "")
    .replace(/^[A-Za-z]*Error:\s*/, "")
    .replace(/\(\s*after\s+\d+\s*ms\s*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const [pattern, plain] of MECHANISM_TERMS) cause = cause.replace(pattern, plain);
  cause = cause.replace(/\s+([.,;:])/g, "$1").trim();
  if (cause === "") return "";
  cause = `${cause[0]!.toUpperCase()}${cause.slice(1)}`;
  return cause.length > 200 ? `${cause.slice(0, 197)}…` : cause;
}

/**
 * The `review_failures.message` sentence for a row: the code's own summary
 * ("what happened, was anything charged") and then the cause the phase actually
 * observed in author-facing words. The observation's composed text stays in
 * `error`, which is the operator's text — that is the whole split, so this
 * function grows no option, no policy read and no second dialect.
 *
 * No observation means no cause to name: the summary alone stands, which is the
 * pass's honest statement of what IT saw (a deadline that passed in silence).
 */
function authorFacingMessage(code: FailureCode, observed: AttemptObservation | null): string {
  const summary = FAILURE_SUMMARIES[code];
  if (observed === null) return summary;
  const cause = authorFacingCause(observed);
  return cause === "" ? summary : `${summary} ${cause}`;
}

/**
 * What this pass logs through `log.info`. One sink carries two shapes: the
 * PR-scoped lines a settlement or recheck replay names, and this pass's own
 * fault lines. A selector fault covers every selected row at once, so it names
 * no PR; a per-row sync fault names the attempt it left selected.
 */
export type ReviewRouteLogFields =
  | (ConsumerLogFields & { recheck_replayed?: boolean })
  | {
      event: "review_late_observation_selector_failed" | "review_late_observation_sync_failed";
      /** The fault's own message — the cause this lane used to swallow. */
      error_cause: string;
      attempt_id?: string;
    };

export type ReviewRouteEnv = {
  DB: D1Database;
  REVIEW_QUEUE: Queue<ReviewJobPayload>;
  IDEMPOTENCY_KV: KVNamespace;
  /**
   * The pass's log sink. The recheck accounting's attribution LINE is a durable
   * effect owned by whoever finishes the round, so a replay this pass performs
   * has to emit it too. Absent only in a caller that does not log.
   *
   * Declared as a method on purpose: the production sweep sink accepts
   * `Record<string, unknown>` while the consumer/test sink accepts the narrower
   * `ConsumerLogFields`, and method parameters are checked bivariantly — one
   * port serves both without casting at either call site.
   */
  log?: { info?(fields: ReviewRouteLogFields, msg: string): void };
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
 * adds nothing. This pass is the ONLY failure-row writer for a settlement (the
 * phase records an observation instead), so no ownership proof exists beyond
 * the insert's own `meta.changes`.
 *
 * `failure.code` defaults to the unclassified crash-window code; a caller that
 * knows why it settled names it. The handoff's own `observation` — what the LIVE
 * settlement recorded before it could conclude anything — WINS over both, and it
 * is read HERE rather than taken from the selector's snapshot: a phase that
 * records its cause between this pass's selection and its insert must still be
 * described. That read is a GATE: if it fails, the read throws, the row is not
 * written, and the lane that selected the attempt retries on the next pass — a
 * lost read is never evidence that nothing was observed, so no snapshot is ever
 * settled in its place. What the read returns composes the row: its code names
 * the row, its composed text lands in `error`, and `message` carries the cause
 * in author-facing words (see `authorFacingMessage`), because `error` is the
 * operator's raw text. An observation recorded after the insert is applied to
 * the same row by the pass's own late-observation sync.
 *
 * One row per attempt, in every interleaving: the insert is attempt-keyed
 * (`ON CONFLICT DO NOTHING`), so a concurrent pass adds nothing.
 */
async function landSettlementEffects(
  env: ReviewRouteEnv,
  handoff: AttemptHandoff,
  landed: Set<SettlementEffect>,
  detail: string,
  nowMs: number,
  failure: { code?: FailureCode } = {},
): Promise<void> {
  // The refused round's accounting comes FIRST: its writes are not part of any
  // claim (F6), so a fault here leaves the duty for the next pass without ever
  // orphaning a landed claim.
  await ensureRecheckAccounting(env, handoff, nowMs);
  // The pass that LANDS the record owns the head-wide claim; an overlapping pass
  // that lost the insert race owns nothing and must not touch it.
  let owned = false;
  if (!landed.has("failure-row")) {
    const observed = await readObservedCause(env, handoff);
    const code = observed?.code ?? failure.code ?? "review.internal.unclassified";
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
          message: authorFacingMessage(code, observed),
          error: observed?.message ?? detail,
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
    // The fallback sentence is a constant per row shape — the shared constant
    // is also the PROOF the late-observation sync uses to tell a row this
    // reconciler wrote from a row any other producer owns.
    const detail =
      handoff.deadlineMs === null ? LOST_REPLY_FALLBACK_ERROR_UNANCHORED : LOST_REPLY_FALLBACK_ERROR;
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
        { code: "review.paid.reply_lost" },
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
  // The late observation, once. The settlement composes its row from the
  // observation it can read at insertion time; a phase that records its cause
  // afterwards — after the pass settled the attempt — would otherwise leave a
  // row stating only the fallback. This is the ONE repair: attempt-keyed, in
  // place. Idempotence is content, never a clock: only the reconciler's own
  // fallback shape (its code, its sentence, its summary) is selected, a row
  // already carrying the observation leaves the lane for good, and a row any
  // other producer wrote is never touched. A fault leaves the row selected
  // for the next pass — and is LOGGED: a lane that fails every pass while
  // silently swallowing the reason is invisible, and the sibling lost-reply
  // catch below is the shape this pass already uses.
  let lateObserved: AttemptHandoff[] = [];
  try {
    lateObserved = await listLateObservedFailures(env.DB, {
      ...LOST_REPLY_FALLBACK_SHAPE,
      limit: ROUTE_RECOVERY_LIMIT,
    });
  } catch (err) {
    env.log?.info?.(
      {
        event: "review_late_observation_selector_failed",
        error_cause: err instanceof Error ? err.message : String(err),
      },
      "late-observation repair is inert for this pass — the selector failed, so the next pass retries it",
    );
    lateObserved = [];
  }
  for (const handoff of lateObserved) {
    const observed = handoff.observation;
    if (observed === null) continue;
    try {
      await syncSettledFailureRow(env.DB, {
        attemptId: handoff.attemptId,
        code: observed.code,
        error: observed.message,
        message: authorFacingMessage(observed.code, observed),
      });
    } catch (err) {
      // The row stays selected (content, never a clock), and the fault is
      // visible: without this line a permanently failing sync is undiagnosable.
      env.log?.info?.(
        {
          event: "review_late_observation_sync_failed",
          attempt_id: handoff.attemptId,
          error_cause: err instanceof Error ? err.message : String(err),
        },
        "the late-observation sync faulted — the row stays selected for the next pass",
      );
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
    }
  }
}

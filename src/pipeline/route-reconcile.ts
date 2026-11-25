import type { D1Database, D1PreparedStatement, D1Result, KVNamespace, Queue } from "@cloudflare/workers-types";
import { FAILURE_SUMMARIES, type FailureCode } from "../contracts/failure-codes";
import type { ReviewJobPayload } from "../contracts/review-job";
import {
  IDEMPOTENCY_SECONDS,
  kvClaimKey,
} from "../contracts/idem";
import { getLostReplySettleMs } from "../dashboard/runtime-config-store";
import { expireInflightStatement } from "../store/inflight-store";
import { readReviewLaunch, recordReviewFailureStatement } from "./review-attempt";
import { payloadIdentityFields } from "./review-attempt-execution";
import type { ConsumerLogFields } from "./review-attempt-execution";
import { settlementFailureRowStatement, type ReviewFailureInput } from "../store/failure-store";

import {
  beginAttemptSettlementStatement,
  closeUnownedSettlement,
  landFailureEffect,
  recordLandedEffectStatement,
  revokeUnsettledLaunchStatement,
  settlementRecordInsertStatement,
  listCommentClaimsForRecovery,
  listHandoffsForRecovery,
  clearRefusalPending,
  clearRecheckDuty,
  listIncompleteSettlements,
  listLateObservedFailures,
  LOST_REPLY_FALLBACK_ERROR,
  LOST_REPLY_FALLBACK_ERROR_UNANCHORED,
  LOST_REPLY_FALLBACK_SHAPE,
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
  recordSettlementAttempt,
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

/** Position of the head in the canonical attempt key's flat tuple (`attemptKey`). */
const ATTEMPT_KEY_HEAD_INDEX = 5;

/**
 * The frozen Check identity's head — the LAST resort for a row whose own
 * reviewed-head record is missing (an attempt prepared before that record
 * existed). Admission can pin this identity to a commit the PR ledger already
 * knew while the checkout landed on a newer one, so it is never preferred over
 * the attempt's own record; `null` when it names no head at all, so the
 * dashboard's empty-head rule keeps its own case. A FAILED read throws, exactly
 * like `readObservedCause`: a row whose head cannot be read is not evidence that
 * it names none, so the lane retries.
 */
async function readFrozenIdentityHead(env: ReviewRouteEnv, attemptId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT attempt_key FROM review_launches WHERE attempt_id = ?`)
    .bind(attemptId)
    .first<{ attempt_key: string | null }>();
  if (row?.attempt_key == null) return null;
  let tuple: unknown;
  try {
    // A rerun key appends `#rerun:<id>` to the canonical tuple; `#` cannot
    // occur in any tuple field, so the base is the prefix before it.
    tuple = JSON.parse(row.attempt_key.split("#rerun:")[0] as string);
  } catch {
    return null;
  }
  if (!Array.isArray(tuple)) return null;
  const head = tuple[ATTEMPT_KEY_HEAD_INDEX];
  return typeof head === "string" && head !== "" ? head : null;
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
 * The head the settled row is attributed to — the head the attempt actually
 * REVIEWED, which its prepare recorded before any paid step. The delivery's own
 * head is only the fallback (a head can move between the delivery and the
 * checkout, and the review that failed ran on the newer one), and the frozen
 * Check identity is the LAST resort for a row written before that record
 * existed: admission can pin it to a commit the PR ledger already knew, so
 * attributing the failure to it stores the row under a commit nobody reviewed,
 * which hides it from the current-head view. Only a row that truly names no head
 * stays empty — the dashboard's empty-head rule keeps it out of the current-head
 * scope, as it must.
 */
async function settledHeadSha(env: ReviewRouteEnv, handoff: AttemptHandoff): Promise<string> {
  if (handoff.reviewedHeadSha !== null) return handoff.reviewedHeadSha;
  const carried = handoff.payload.head_sha;
  if (carried !== null && carried !== undefined && carried !== "") return carried;
  return (await readFrozenIdentityHead(env, handoff.attemptId)) ?? "";
}

/**
 * The row a settlement records, composed from what is durable NOW: the phase's
 * observation (which wins over the caller's default code), the head the attempt
 * actually reviewed, and the author-facing sentence. Shared with the lane that
 * lands the record inside its own guarded batch.
 */
async function settlementFailureInput(
  env: ReviewRouteEnv,
  handoff: AttemptHandoff,
  detail: string,
  failure: { code?: FailureCode },
): Promise<ReviewFailureInput> {
  const observed = await readObservedCause(env, handoff);
  const code = observed?.code ?? failure.code ?? "review.internal.unclassified";
  return {
    id: handoff.attemptId,
    target_id: handoff.payload.targetId,
    installation_id: handoff.payload.installation_id,
    owner: handoff.payload.owner,
    repo: handoff.payload.repo,
    pr_number: handoff.payload.pr_number,
    head_sha: await settledHeadSha(env, handoff),
    stage: "pipeline",
    code,
    trackId: handoff.attemptId,
    message: authorFacingMessage(code, observed),
    error: observed?.message ?? detail,
  };
}

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
 * the row without the fact, and the insert carries the attempt's own existence
 * predicate (`SETTLEMENT_RECORD_MISSING`), so a concurrent pass, a replay, or a
 * row an older build wrote under a random id adds nothing. This pass is the ONLY
 * failure-row writer for a settlement (the phase records an observation instead),
 * so the insert's own `meta.changes` is the whole ownership proof.
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
 * One row per attempt, in every interleaving: the guarded insert writes only
 * when the attempt has no record yet, and `ON CONFLICT(id) DO NOTHING` absorbs
 * two simultaneous writers.
 */
async function landSettlementEffects(
  env: ReviewRouteEnv,
  handoff: AttemptHandoff,
  landed: Set<SettlementEffect>,
  detail: string,
  nowMs: number,
  failure: { code?: FailureCode } = {},
  /**
   * Whether THIS pass created the record, when the caller already landed it in
   * its own guarded batch. `null` means this call lands it (the publication and
   * incomplete lanes); `false` means the attempt's record already existed, so
   * nothing here may stamp the head.
   */
  created: boolean | null = null,
): Promise<void> {
  // The refused round's accounting comes FIRST: its writes are not part of any
  // claim (F6), so a fault here leaves the duty for the next pass without ever
  // orphaning a landed claim.
  await ensureRecheckAccounting(env, handoff, nowMs);
  // The pass that LANDS the record owns the head-wide claim; an overlapping pass
  // that lost the insert race owns nothing and must not touch it.
  let owned = created === true;
  if (!landed.has("failure-row")) {
    const recorded = await landFailureEffect(
      env.DB,
      {
        attemptId: handoff.attemptId,
        landed: [...landed],
        failure: await settlementFailureInput(env, handoff, detail, failure),
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
      key: kvClaimKey(handoff.payload, handoff.payload.head_sha),
      ttlSeconds: IDEMPOTENCY_SECONDS,
      owned,
    });
    if (stamped === "written" || stamped === "done") landed.add("claim-stamp");
  }
  await settleAttemptIfDischarged(env.DB, { attemptId: handoff.attemptId, landed: [...landed] }, nowMs);
  // A pass that could not land the record itself owns nothing here, and the one
  // effect it may never write is the head-wide claim stamp. Once every other
  // obligation has landed, leaving the settlement marker would keep this row in
  // the incomplete lane for an effect no replay can own — so stop scheduling it
  // and let the owed stamp stand as the recorded residual.
  if (!owned) await closeUnownedSettlement(env.DB, { attemptId: handoff.attemptId, landed: [...landed] });
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
/**
 * The release batch's precondition, on the same `?1` (attempt) bind every
 * statement of that batch carries: the launch row still reads `launched` with no
 * outcome. The guarded insert and the landed fact AND it into their own guards,
 * so a race that terminalized the row another way (`persisted`, by a live
 * settlement writing its result) writes neither — the release would not have won
 * the row, and nothing may claim it did.
 */
const LAUNCH_STILL_LIVE_SQL = `EXISTS (SELECT 1 FROM review_launches l
  WHERE l.attempt_id = ?1 AND l.state = 'launched' AND l.result_outcome IS NULL)`;

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
    // The RELEASE is all this pass owes unconditionally. The record may already
    // exist (a settlement that got as far as its row and died before moving the
    // launch row, or a previous build's row), and whoever wrote it owns its
    // effects and its claim; what that record authorises here is the terminal
    // move — and only that. Revoking a row this pass did not settle would retire
    // the attempt, and a retired row can never be torn down
    // (`reviewAttemptSandbox` refuses it), so the container's stop proof would be
    // lost and the PR would stay held after its lease expired. The successor's
    // own stop evidence takes a released row, exactly as after a live failure.
    //
    // Existence is therefore a PREDICATE of the batch, never a read before it.
    // The guarded insert asks "does this attempt already have a record?" (any
    // build's row: the attempt-keyed id, or a legacy random id carrying the
    // attempt in `track_id`) and writes only when the answer is no; its `changes`
    // is the proof THIS pass created the record, and the only proof a head-wide
    // claim may rest on. The revoke asks the SAME question and rides in front of
    // the insert over the same rows, so it fires exactly when the insert wins. A
    // pass that loses the race — or that finds an older build's row — writes no
    // second record, revokes nothing and claims nothing.
    //
    // The landed fact (`failure-row`) and the settlement start ride in this same
    // batch: a stop before the effects can then never leave the next pass
    // believing it may create the record or claim the head. What this pass leaves
    // unlanded stays with its own lanes — a Check that never concludes keeps the
    // handoff scheduled (the Check lane owns it), and once only the un-ownable
    // stamp remains the handoff is closed instead of retried forever.
    let failure: ReviewFailureInput | null = null;
    try {
      failure = await settlementFailureInput(env, handoff, detail, { code: "review.paid.reply_lost" });
    } catch {
      failure = null;
    }
    const statements = [
      ...(failure === null
        ? []
        : [
            // The record FIRST — its own row count is what the revoke below is
            // gated on (SQL cannot read a later statement's result).
            settlementRecordInsertStatement(env.DB, failure, handoff.attemptId, LAUNCH_STILL_LIVE_SQL),
            // Immediately after it: only a pass whose insert created the record
            // retires the row, and the insert's own count is the gate.
            revokeUnsettledLaunchStatement(env.DB, handoff.attemptId, nowMs),
          ]),
      // The landed fact, in the batch that moves the row: it lands when a record
      // is durable at this point (our insert above counts) and the row is still
      // live, so a stop right after this batch never loses it.
      recordLandedEffectStatement(env.DB, handoff.attemptId, "failure-row", LAUNCH_STILL_LIVE_SQL),
      // The lease ends with the review: the row stops counting against the caps
      // at once, and it stays so a same-PR successor still owes the stop proof.
      expireInflightStatement(
        env.DB,
        {
          installation_id: handoff.payload.installation_id,
          owner: handoff.payload.owner,
          repo: handoff.payload.repo,
          pr_number: handoff.payload.pr_number,
        },
        handoff.attemptId,
        nowMs,
        LAUNCH_STILL_LIVE_SQL,
      ),
      // The release — only a `launched` row moves, so one pass wins it — and the
      // settlement start, which closes the batch and reads the release's count.
      recordReviewFailureStatement(env.DB, handoff.attemptId, nowMs),
      beginAttemptSettlementStatement(env.DB, handoff.deliveryKey, nowMs),
    ];
    let moved: D1Result[];
    try {
      moved = await env.DB.batch(statements as D1PreparedStatement[]);
    } catch {
      // The batch is atomic: nothing moved, the row is untouched and the next pass retries it.
      continue;
    }
    // The release is the gate (the settlement start closes the batch): a row
    // another pass terminalized in between gets no settlement effects from this
    // one.
    if ((moved[moved.length - 2]?.meta.changes ?? 0) !== 1) continue;
    // ...composed, but never gating the release: a lost observation read is not
    // evidence that nothing was observed, so the release above stands, the record
    // waits for the next pass (the settlement start gave the incomplete lane
    // ownership of it), and nothing is settled from the selector's older snapshot.
    if (failure === null) {
      log?.info?.(
        { ...payloadIdentityFields(handoff.payload), attempt_id: handoff.attemptId, error_code: "review.paid.reply_lost" },
        `lost reply released past its attempt's hard-stop bound — its record could not be composed, so the settlement lane owes it`,
      );
      continue;
    }
    // The ownership proof is the guarded insert's own row count (statement 0):
    // zero means the attempt's record already existed (any build's), and only the
    // creating pass may stamp the head.
    const owned = failure !== null && (moved[0]?.meta.changes ?? 0) === 1;
    const landed = new Set<SettlementEffect>(handoff.settledEffects ?? []);
    landed.add("failure-row");
    try {
      await landSettlementEffects(env, handoff, landed, detail, nowMs, { code: "review.paid.reply_lost" }, owned);
      log?.info?.(
        { ...payloadIdentityFields(handoff.payload), attempt_id: handoff.attemptId, error_code: "review.paid.reply_lost" },
        owned
          ? `lost reply settled past its attempt's hard-stop bound — capacity released, the attempt is terminal`
          : `lost reply released past its attempt's hard-stop bound — its durable record already existed, so this pass wrote no second one, claimed nothing, and left the row to the stop proof`,
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
      // The attempt stamp is the bounded-retry mark (I-000709): this row's
      // turn is spent even when the settlement below faults or skips, so on
      // the next pass it yields to rows not yet attempted — and is retried
      // after them, never dropped.
      await recordSettlementAttempt(env.DB, handoff.deliveryKey, nowMs);
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

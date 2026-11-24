/**
 * The review route's durable handoffs (migration 0083).
 *
 * Two records make the route's transitions survive an interrupted host:
 *
 * - `review_attempt_handoffs` — the admission's handoff record, written BEFORE
 *   the Workflow instance is created. The delivery key is the stable identity of
 *   the queue message, so a redelivery finds the same row and replays the same
 *   attempt id (the UNIQUE attempt id makes a second attempt impossible). The
 *   row's state records the create outcome, and its settle-once mark keeps a
 *   re-executed settlement step from settling twice.
 * - `review_successors` — the moved head's outbox. The dedupe key is the
 *   observed head's identity, so one moved head records at most one successor;
 *   a delivery pass (immediate, then the reconciler) sends it and marks it
 *   delivered only after the queue accepted it.
 *
 * Store module boundary (compass contracts A): D1 types only, no pipeline or
 * worker imports.
 */
import type { KVNamespace } from "@cloudflare/workers-types";
import { REVIEW_ATTEMPT_CAP_MAX_MS } from "../dashboard/runtime-config-store";
import type { ReviewJobPayload } from "../contracts/review-job";
import { IDEM_FAILED, putAbandonClaim, type AbandonClaimWrite } from "../contracts/idem";
import { FAILURE_SUMMARIES, isFailureCode, type FailureCode } from "../contracts/failure-codes";
import { settlementFailureRowStatement, type ReviewFailureInput } from "./failure-store";
import type { D1Like, D1StatementLike } from "./types";

export type AttemptHandoffState = "owed" | "ambiguous" | "created" | "failed";

/**
 * What a live settlement OBSERVED about an outcome it could not conclude: the
 * throw site's own classification, its composed message verbatim (`error` on
 * the failure row is that raw text) and the bounded, already-redacted cause
 * it carried as data (`cause`), which is what the reconciler renders into the
 * author-facing message. No part is reconstructed from another part.
 *
 * It rides the delivery's handoff row because that row is the durable evidence
 * the recovery lanes already read for this attempt, and because neither
 * `review_launches` slot could hold it: `result_json` is CHECK-coupled to
 * `state = 'persisted'` (writing one would forge a durable result), and the
 * frozen Check triple is coupled to `check_owed_ms`. No new column is needed —
 * the observation is row state, never queue payload (`toHandoff` keeps it out
 * of `payload`), and the reconciler remains the ONLY failure-row writer.
 */
export type AttemptObservation = { code: FailureCode; message: string; cause?: string };

/** The `payload_json` key the observation rides under, never part of the payload. */
const OBSERVATION_KEY = "attemptObservation";

/**
 * The `payload_json` key the reviewed head rides under, never part of the
 * payload: the same row-state convention the observation uses, because
 * `payload` is what a recovery re-enqueue sends and what `deliveryKeyOf`
 * hashes, so a second key in the body would change an existing attempt's
 * delivery identity.
 */
const REVIEWED_HEAD_KEY = "reviewedHeadSha";

/**
 * The fallback `review_failures.error` the lost-reply lane writes when no
 * observation existed yet — two constants (anchored / pre-column), which is what
 * lets the late-observation sync PROVE a row is that lane's own before rewriting
 * it. The deadline and the grace are durable on the launch and handoff rows; the
 * sentence states the conclusion.
 *
 * Owned HERE because two readers must agree on it: the sync selector that
 * rewrites such a row, and the settlement's guard deciding whether a row already
 * tells the attempt's story (a fallback row does not — it is a placeholder
 * awaiting exactly that cause).
 */
export const LOST_REPLY_FALLBACK_ERROR =
  "its attempt deadline plus the post-deadline grace elapsed, and no reply ever arrived";
export const LOST_REPLY_FALLBACK_ERROR_UNANCHORED =
  "a pre-column legacy attempt carries no frozen deadline; its launch outlived the maximum attempt cap plus the post-deadline grace, and no reply ever arrived";

/**
 * The exact row shape the lost-reply lane writes for an attempt with no
 * observation: attempt-keyed, the lane's own code, and one of its fallback
 * sentences. The late-observation sync binds this shape — a row any other
 * producer wrote is never selected, never rewritten.
 */
export const LOST_REPLY_FALLBACK_SHAPE = {
  fallbackCode: "review.paid.reply_lost",
  fallbackErrors: [LOST_REPLY_FALLBACK_ERROR, LOST_REPLY_FALLBACK_ERROR_UNANCHORED],
  fallbackMessage: FAILURE_SUMMARIES["review.paid.reply_lost"],
} as const;

export type AttemptHandoff = {
  deliveryKey: string;
  attemptId: string;
  payload: ReviewJobPayload;
  state: AttemptHandoffState;
  /**
   * The attempt's hard stop, frozen when this row was first written: the
   * claiming delivery's `createdMs` (its entry instant) plus the operator's
   * end-to-end cap. Every replay of the same attempt reads it instead of
   * re-deriving it. `null` only on a row written before the column existed —
   * "not yet anchored"; the next admission anchors it ONCE from `createdMs`
   * (the only instant that attempt actually had), never from a later
   * delivery's clock.
   */
  deadlineMs: number | null;
  enqueuedMs: number | null;
  /** The origin `deadlineMs` counted its cap from — the ONE round-clock origin. */
  createdMs: number;
  settledMs: number | null;
  settledEffects: SettlementEffect[] | null;
  settlingMs: number | null;
  /**
   * The live settlement's own record of why this attempt's outcome could not be
   * concluded, or `null` when nothing was observed (or the row predates the
   * write). The recovery pass composes its failure row from THIS — the observed
   * cause is the operator's, the code is the throw site's — and falls back to
   * its own deadline sentence only when no observation exists.
   */
  observation: AttemptObservation | null;
  /**
   * The head this attempt's checkout actually resolved, recorded by prepare
   * before any paid step, or `null` when no head was resolved (or the row
   * predates the write). Recovery attributes the failure row to THIS — never to
   * the frozen Check identity, which admission can pin to an older commit than
   * the checkout landed on.
   */
  reviewedHeadSha: string | null;
};

/**
 * The stable identity of one queue message. A redelivery carries the same body,
 * so it maps to the same handoff row; a genuinely new delivery (another
 * comment, another push) differs in at least one of these fields.
 */
export function deliveryKeyOf(payload: ReviewJobPayload): string {
  const botRef = payload.botRef as { appId?: string } | undefined;
  return JSON.stringify([
    payload.installation_id,
    payload.owner,
    payload.repo,
    payload.pr_number,
    payload.head_sha,
    payload.head_at ?? null,
    payload.comment_id ?? null,
    payload.attachDeliveryId ?? null,
    payload.successor_of ?? null,
    botRef?.appId ?? null,
    payload.targetId,
    payload.action,
    payload.triggered_by,
  ]);
}

function successorDedupeKeyOf(input: {
  appId: string;
  targetId: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  headSha: string;
  origin: string;
}): string {
  return JSON.stringify([
    "successor",
    input.appId,
    input.targetId,
    input.installation_id,
    input.owner.toLowerCase(),
    input.repo.toLowerCase(),
    input.pr_number,
    input.headSha,
    input.origin,
  ]);
}

/**
 * The successor intent for a moved head: the outbox row's identity plus the
 * delivery admission will re-run. Built BEFORE the settlement that
 * terminalizes the old Check (the record precedes the effect) and rebuilt
 * identically by every replay, because it reads only durable fields.
 */
export function successorIntentOf(
  payload: ReviewJobPayload,
  movedHeadSha: string | null,
): { dedupeKey: string; payload: ReviewJobPayload } | null {
  if (movedHeadSha === null) return null;
  const origin = deliveryKeyOf(payload);
  const dedupeKey = successorDedupeKeyOf({
    appId: payload.botRef.appId,
    targetId: payload.targetId,
    installation_id: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    pr_number: payload.pr_number,
    headSha: movedHeadSha,
    origin,
  });
  return {
    dedupeKey,
    payload: {
      ...payload,
      head_sha: movedHeadSha,
      head_at: movedHeadSha === payload.head_sha ? payload.head_at : undefined,
      successor_of: origin,
      attachDeliveryId: successorAttachIdOf(dedupeKey),
    },
  };
}

/**
 * The successor delivery's own Check-attach identity. It names the successor
 * delivery (stable across outbox retries), never the webhook attach of the
 * head that moved: a skip of the successor settles the run this identity
 * created, which is none, so the lifecycle answers a clean no-op instead of
 * taking another head's run.
 */
export function successorAttachIdOf(dedupeKey: string): string {
  return `successor:${dedupeKey}`;
}

type HandoffRow = {
  delivery_key: string;
  attempt_id: string;
  payload_json: string;
  state: AttemptHandoffState;
  deadline_ms: number | null;
  enqueued_ms: number | null;
  created_ms: number;
  settled_ms: number | null;
  settled_effects: string | null;
  settling_ms: number | null;
};

function toHandoff(row: HandoffRow): AttemptHandoff {
  // The observation and the reviewed head share the row but never the payload:
  // `payload` is what a recovery re-enqueue sends and what `deliveryKeyOf`
  // hashes, so leaking either key would change the delivery identity of an
  // existing attempt. Destructuring keeps the parse fail-fast (a non-object body
  // throws, as before).
  const {
    [OBSERVATION_KEY]: raw,
    [REVIEWED_HEAD_KEY]: reviewedHead,
    ...payload
  } = JSON.parse(row.payload_json) as ReviewJobPayload & Record<string, unknown>;
  return {
    deliveryKey: row.delivery_key,
    attemptId: row.attempt_id,
    payload: payload as ReviewJobPayload,
    state: row.state,
    deadlineMs: row.deadline_ms,
    enqueuedMs: row.enqueued_ms,
    createdMs: row.created_ms,
    settledMs: row.settled_ms,
    settledEffects: row.settled_effects === null ? null : (JSON.parse(row.settled_effects) as SettlementEffect[]),
    settlingMs: row.settling_ms,
    observation: toObservation(raw),
    reviewedHeadSha: typeof reviewedHead === "string" && reviewedHead !== "" ? reviewedHead : null,
  };
}

/**
 * Anything off the vocabulary — a foreign key, a non-string message or cause,
 * a payload from another build — reads as "nothing was observed", so the
 * recovery pass falls back to its own sentence instead of rendering an unknown
 * string as an author-facing code.
 */
function toObservation(value: unknown): AttemptObservation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { code, message, cause } = value as Record<string, unknown>;
  if (!isFailureCode(code) || typeof message !== "string" || message === "") return null;
  if (cause !== undefined && typeof cause !== "string") return null;
  return { code, message, ...(cause === undefined ? {} : { cause }) };
}

/**
 * Record the head this attempt's checkout actually resolved — the commit its
 * review runs on. Row state, never queue payload (same convention as the
 * observation above), and written by prepare BEFORE the paid step, so recovery
 * can attribute a failure to the head that was reviewed even when the host that
 * knew it is gone.
 *
 * The write is not guarded on an existing value: a re-prepared attempt resolves
 * its head again, and the LAST resolution is the one its paid step used. `false`
 * means no handoff row carries this attempt (a delivery that never reached
 * admission), which leaves the frozen Check identity as the only evidence.
 */
export async function recordReviewedHead(
  db: D1Like,
  input: { attemptId: string; headSha: string; nowMs: number },
): Promise<boolean> {
  const written = await db
    .prepare(
      `UPDATE review_attempt_handoffs
          SET payload_json = json_set(payload_json, '$.${REVIEWED_HEAD_KEY}', ?),
              updated_ms = ?
        WHERE attempt_id = ?`,
    )
    .bind(input.headSha, input.nowMs, input.attemptId)
    .run();
  return written.meta.changes === 1;
}

/**
 * Record what the live settlement observed about an outcome it could not
 * conclude. The FIRST observation for the attempt stands: a replay of the same
 * settlement carries the same cause, and a later lane has strictly less
 * evidence than the phase that was there. `false` means the row does not exist
 * or an observation was already recorded.
 *
 * An existing `review_failures` row is deliberately NOT a reason to refuse: the
 * pass may settle the attempt before the phase records its cause, and the late
 * observation is then applied to that same row by
 * `listLateObservedFailures`/`syncSettledFailureRow`. `nowMs` lands on
 * `updated_ms` — the same clock the recovery quiet period reads (the sync
 * orders by content, never by time).
 */
export async function recordAttemptObservation(
  db: D1Like,
  input: { attemptId: string; observation: AttemptObservation; nowMs: number },
): Promise<boolean> {
  const written = await db
    .prepare(
      `UPDATE review_attempt_handoffs
          SET payload_json = json_set(payload_json, '$.${OBSERVATION_KEY}', json(?)),
              updated_ms = ?
        WHERE attempt_id = ?
          AND json_extract(payload_json, '$.${OBSERVATION_KEY}') IS NULL`,
    )
    .bind(JSON.stringify(input.observation), input.nowMs, input.attemptId)
    .run();
  return written.meta.changes === 1;
}

/**
 * Failure rows still carrying the writer's own fallback while their attempt
 * holds an observation. Idempotence is content, never a clock: no timestamp is
 * compared anywhere here, so an observation recorded between the composer's
 * read and its insert — across any second boundary — still reaches the row.
 *
 * `f.error IS NOT` the observation's own message is exactly "not synced yet": a
 * synced row leaves this lane for good, a second pass selects nothing and
 * writes nothing.
 *
 * The writer's OWN shape is what keeps a foreign row out: `f.track_id` must
 * name the attempt, `f.error_code` the lane's code, `f.error` one of the
 * writer's exact fallback sentences and `f.message` its fallback summary — the
 * caller binds its own constants, so a row another producer wrote is never
 * selected even when an observation exists.
 */
export async function listLateObservedFailures(
  db: D1Like,
  input: { limit: number; fallbackCode: string; fallbackErrors: readonly string[]; fallbackMessage: string },
): Promise<AttemptHandoff[]> {
  const rows = await db
    .prepare(
      `SELECT h.delivery_key, h.attempt_id, h.payload_json, h.state, h.deadline_ms,
              h.enqueued_ms, h.created_ms, h.settled_ms, h.settled_effects, h.settling_ms
         FROM review_attempt_handoffs h
         JOIN review_failures f ON f.id = h.attempt_id
        WHERE json_extract(h.payload_json, '$.${OBSERVATION_KEY}.message') IS NOT NULL
          AND f.error IS NOT json_extract(h.payload_json, '$.${OBSERVATION_KEY}.message')
          AND f.track_id = h.attempt_id
          AND f.error_code = ?
          AND f.error IN (${input.fallbackErrors.map(() => "?").join(",")})
          AND f.message = ?
        ORDER BY h.updated_ms
        LIMIT ?`,
    )
    .bind(input.fallbackCode, ...input.fallbackErrors, input.fallbackMessage, input.limit)
    .all<HandoffRow>();
  return rows.results.map(toHandoff);
}

/**
 * Apply a late observation to the attempt's existing failure row: the SAME row,
 * keyed by the attempt, rewritten to the story the phase actually observed.
 * The selector above is the ownership proof — only the reconciler's own
 * fallback shape reaches this call — so a keyed update is enough, and a row
 * already carrying the observation leaves the lane for good.
 */
export async function syncSettledFailureRow(
  db: D1Like,
  input: { attemptId: string; code: FailureCode; error: string; message: string },
): Promise<boolean> {
  const written = await db
    .prepare(`UPDATE review_failures SET error_code = ?, error = ?, message = ? WHERE id = ?`)
    .bind(input.code, input.error, input.message, input.attemptId)
    .run();
  return written.meta.changes === 1;
}

/** The delivery's handoff record, or `null` when this body was never handed off. */
export async function readAttemptHandoff(db: D1Like, deliveryKey: string): Promise<AttemptHandoff | null> {
  const row = await db
    .prepare(
      `SELECT delivery_key, attempt_id, payload_json, state, deadline_ms, enqueued_ms, created_ms, settled_ms, settled_effects, settling_ms
         FROM review_attempt_handoffs WHERE delivery_key = ?`,
    )
    .bind(deliveryKey)
    .first<HandoffRow>();
  return row === null ? null : toHandoff(row);
}

/**
 * The handoff row by its attempt id — the handle a recovery lane holds (a
 * publication names its attempt, never the delivery key). `attempt_id` is
 * UNIQUE, so this is the same row `readAttemptHandoff` answers.
 */
export async function readAttemptHandoffByAttempt(db: D1Like, attemptId: string): Promise<AttemptHandoff | null> {
  const row = await db
    .prepare(
      `SELECT delivery_key, attempt_id, payload_json, state, deadline_ms, enqueued_ms, created_ms, settled_ms, settled_effects, settling_ms
         FROM review_attempt_handoffs WHERE attempt_id = ?`,
    )
    .bind(attemptId)
    .first<HandoffRow>();
  return row === null ? null : toHandoff(row);
}

/**
 * Whether this attempt's Check is still open. The pair is the one the attempt
 * froze on its launch row; a row with no frozen key has no Check to conclude.
 */
export async function attemptCheckIsOpen(db: D1Like, attemptId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS open FROM review_launches l
         JOIN review_checks c
           ON c.attempt_key = l.attempt_key AND c.generation = l.attempt_generation
        WHERE l.attempt_id = ? AND c.terminal_ms IS NULL
        LIMIT 1`,
    )
    .bind(attemptId)
    .first<{ open: number }>();
  return row !== null;
}

/**
 * Write the handoff BEFORE the create, or read back the row a previous delivery
 * of the same message wrote. `INSERT … ON CONFLICT DO NOTHING` makes two
 * concurrent attempts to reserve the same delivery harmless: both read back the
 * one row, and the caller uses ITS attempt id.
 *
 * `createdMs` is the ORIGIN of `deadlineMs` — the instant the claiming delivery
 * froze its cap from — and the FIRST writer binds it to `created_ms` in the same
 * insert. `created_ms` is therefore never "when the row was inserted": every
 * later delivery reads the origin back from the row (`budgetStartMs`), so no two
 * deliveries of one attempt can derive two origins for one deadline. `nowMs` is
 * the write's own clock and lands on `updated_ms` only.
 *
 * `deadlineMs` is frozen by the FIRST writer too: a conflicting insert changes
 * nothing, and the conditional UPDATE only fills the column a pre-migration row
 * left NULL. So a redelivery, a concurrent duplicate or a recovery re-enqueue
 * can never move the attempt's hard stop. The caller derives the candidate for
 * a NULL row from that row's `createdMs`, so two deliveries of one attempt
 * compute the same instant even before the write lands. A row that is STILL
 * unanchored after this call refuses to run: no caller may execute an attempt
 * without the instant its Check row will carry.
 */
export async function reserveAttemptHandoff(
  db: D1Like,
  input: {
    deliveryKey: string;
    attemptId: string;
    payload: ReviewJobPayload;
    nowMs: number;
    createdMs: number;
    deadlineMs: number;
    enqueuedMs: number | null;
  },
): Promise<AttemptHandoff> {
  await db
    .prepare(
      `INSERT INTO review_attempt_handoffs
         (delivery_key, attempt_id, payload_json, state, deadline_ms, enqueued_ms, created_ms, updated_ms)
       VALUES (?, ?, ?, 'owed', ?, ?, ?, ?)
       ON CONFLICT (delivery_key) DO NOTHING`,
    )
    .bind(
      input.deliveryKey,
      input.attemptId,
      JSON.stringify(input.payload),
      input.deadlineMs,
      input.enqueuedMs,
      input.createdMs,
      input.nowMs,
    )
    .run();
  await db
    .prepare(
      `UPDATE review_attempt_handoffs SET deadline_ms = ?
        WHERE delivery_key = ? AND deadline_ms IS NULL`,
    )
    .bind(input.deadlineMs, input.deliveryKey)
    .run();
  const row = await readAttemptHandoff(db, input.deliveryKey);
  if (row === null) {
    throw new Error(`review attempt handoff for ${input.deliveryKey} disappeared after its insert`);
  }
  if (row.deadlineMs === null) {
    throw new Error(
      `review attempt handoff for ${input.deliveryKey} carries no deadline and could not be anchored — refusing to run an attempt on an unrecorded instant`,
    );
  }
  return row;
}

/** Record a create outcome's state on the delivery's handoff row. */
export async function markAttemptHandoff(
  db: D1Like,
  deliveryKey: string,
  state: AttemptHandoffState,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(`UPDATE review_attempt_handoffs SET state = ?, updated_ms = ? WHERE delivery_key = ?`)
    .bind(state, nowMs, deliveryKey)
    .run();
}

/** Bump the recovery clock after a re-enqueue, so one sweep cannot hot-loop. */
export async function touchAttemptHandoff(db: D1Like, deliveryKey: string, nowMs: number): Promise<void> {
  await db
    .prepare(`UPDATE review_attempt_handoffs SET updated_ms = ? WHERE delivery_key = ?`)
    .bind(nowMs, deliveryKey)
    .run();
}

/**
 * The effects a settlement can make durable (see `settleAttemptFailure`).
 *
 * `recheck-row` and `recheck-attribution` are the refused round's two durable
 * effects. They are REQUIRED while the attempt's duty row (`review_recheck_duties`)
 * names them as still owed, and their existence — not a host's claim, a log call
 * or a timestamp — is what lets the settlement rule discharge the attempt.
 */
export type SettlementEffect =
  | "failure-row"
  | "check"
  | "claim-stamp"
  | "skip"
  | "publication"
  | "recheck-row"
  | "recheck-attribution";

/** The seat's own round outcome — the vocabulary the attribution line reports. */
export type RecheckOutcome = "ok" | "failed" | "absent" | "skipped";

/** The round accounting a refusal still owes (everything a replay needs). */
export type RecheckDuty = {
  attemptId: string;
  headSha: string;
  /** The sanitized shipped-failure detail; `null` = no row owed. */
  failureError: string | null;
  outcome: RecheckOutcome;
};

const RECORD_RECHECK_DUTY_SQL = `
INSERT INTO review_recheck_duties (attempt_id, head_sha, failure_error, outcome, created_ms)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(attempt_id) DO NOTHING
`;
const READ_RECHECK_DUTY_SQL = `
SELECT attempt_id, head_sha, failure_error, outcome FROM review_recheck_duties WHERE attempt_id = ?
`;
const CLEAR_RECHECK_DUTY_SQL = `DELETE FROM review_recheck_duties WHERE attempt_id = ?`;
const RECORD_RECHECK_ATTRIBUTION_SQL = `
INSERT INTO review_recheck_attributions (attempt_id, created_ms) VALUES (?, ?)
ON CONFLICT(attempt_id) DO NOTHING
`;
const READ_RECHECK_ATTRIBUTION_SQL = `SELECT 1 AS present FROM review_recheck_attributions WHERE attempt_id = ?`;
const RECHECK_ROW_EXISTS_SQL = `SELECT 1 AS present FROM review_failures WHERE id = ?`;
/**
 * A row for this attempt that is NOT the lost-reply lane's placeholder: `error`
 * outside the fallback sentences, or another code, or another summary. Any such
 * row is a lane-authored story ("publication never started …") and the phase's
 * later observation must not replace it.
 *
 * A fallback-shaped row is deliberately NOT a story: it exists precisely because
 * no observation had arrived, and the late-observation sync rewrites it in place
 * — so recording the observation is what makes that repair possible. COALESCE
 * keeps a NULL code/message (a pre-0106 row) on the "story" side.
 */
const ATTEMPT_FAILURE_STORY_SQL = `
SELECT 1 AS present FROM review_failures
 WHERE track_id = ?
   AND NOT (
     COALESCE(error_code, '') = ?
     AND COALESCE(error, '') IN (?, ?)
     AND COALESCE(message, '') = ?
   )`;

/**
 * Whether a failure row already tells this attempt's story in words the phase
 * cannot improve on. The live settlement records only an OBSERVATION — never a
 * row — so a row that exists here came from a recovery lane that saw materially
 * more (a durable paid result with nothing staged), and its sentence must stand.
 * A fallback-shaped row is excluded: see `ATTEMPT_FAILURE_STORY_SQL`.
 */
export async function attemptFailureStoryExists(db: D1Like, attemptId: string): Promise<boolean> {
  const row = await db
    .prepare(ATTEMPT_FAILURE_STORY_SQL)
    .bind(
      attemptId,
      LOST_REPLY_FALLBACK_SHAPE.fallbackCode,
      ...LOST_REPLY_FALLBACK_SHAPE.fallbackErrors,
      LOST_REPLY_FALLBACK_SHAPE.fallbackMessage,
    )
    .first<{ present: number }>();
  return row !== null;
}
const MARK_REFUSAL_PENDING_SQL = `
INSERT INTO review_refusal_pending (attempt_id, created_ms) VALUES (?, ?)
ON CONFLICT(attempt_id) DO NOTHING
`;
const READ_REFUSAL_PENDING_SQL = `SELECT 1 AS present FROM review_refusal_pending WHERE attempt_id = ?`;
const CLEAR_REFUSAL_PENDING_SQL = `DELETE FROM review_refusal_pending WHERE attempt_id = ?`;

/**
 * Record the refusal INTENT, before any accounting effect. Its presence — not
 * the duty's — is what tells every settlement lane downstream that this attempt
 * refused a review and owes its round's effects.
 */
export async function markRefusalPending(db: D1Like, attemptId: string, nowMs: number): Promise<void> {
  await db.prepare(MARK_REFUSAL_PENDING_SQL).bind(attemptId, nowMs).run();
}

/** Whether this attempt refused a review and still owes its round's accounting. */
export async function readRefusalPending(db: D1Like, attemptId: string): Promise<boolean> {
  const row = await db.prepare(READ_REFUSAL_PENDING_SQL).bind(attemptId).first<{ present: number }>();
  return row !== null;
}

/** Discharge the refusal marker — its round's effects are durable. */
export async function clearRefusalPending(db: D1Like, attemptId: string): Promise<void> {
  await db.prepare(CLEAR_REFUSAL_PENDING_SQL).bind(attemptId).run();
}

/**
 * Open the round's duty: written BEFORE any effect, so a host that dies mid-way
 * leaves the recovery owner everything it needs. Idempotent.
 */
export async function recordRecheckDuty(db: D1Like, duty: RecheckDuty, nowMs: number): Promise<void> {
  await db
    .prepare(RECORD_RECHECK_DUTY_SQL)
    .bind(duty.attemptId, duty.headSha, duty.failureError, duty.outcome, nowMs)
    .run();
}

/** The attempt's open round duty, or `null` when nothing is owed. */
export async function readRecheckDuty(db: D1Like, attemptId: string): Promise<RecheckDuty | null> {
  const row = await db.prepare(READ_RECHECK_DUTY_SQL).bind(attemptId).first<{
    attempt_id: string;
    head_sha: string;
    failure_error: string | null;
    outcome: RecheckOutcome;
  }>();
  if (row === null) return null;
  return {
    attemptId: row.attempt_id,
    headSha: row.head_sha,
    failureError: row.failure_error,
    outcome: row.outcome,
  };
}

/** Discharge the duty — BOTH its effects are durable. */
export async function clearRecheckDuty(db: D1Like, attemptId: string): Promise<void> {
  await db.prepare(CLEAR_RECHECK_DUTY_SQL).bind(attemptId).run();
}

/** Whether the round's attribution line was already emitted for this attempt. */
export async function readRecheckAttribution(db: D1Like, attemptId: string): Promise<boolean> {
  const row = await db.prepare(READ_RECHECK_ATTRIBUTION_SQL).bind(attemptId).first<{ present: number }>();
  return row !== null;
}

/**
 * Record that the round's attribution line was emitted. Inserted AFTER the log
 * call, so the delivery contract is at-least-once: a crash in between re-emits,
 * and the sink accepts a duplicate; it can never claim a line that never ran.
 */
export async function recordRecheckAttribution(db: D1Like, attemptId: string, nowMs: number): Promise<void> {
  await db.prepare(RECORD_RECHECK_ATTRIBUTION_SQL).bind(attemptId, nowMs).run();
}

/** Whether the attempt's `recheck` shipped-failure row is durable. */
export async function recheckRowExists(db: D1Like, attemptId: string): Promise<boolean> {
  const row = await db.prepare(RECHECK_ROW_EXISTS_SQL).bind(`${attemptId}:recheck`).first<{ present: number }>();
  return row !== null;
}

/**
 * Complete the settle-once mark. It is written by the settlement itself, and it
 * records **which effects landed**: `settled_ms` is set only when the required
 * set is complete, so the mark can never certify an effect that is missing,
 * while `settled_effects` tells a replay (and an operator) what is still owed.
 * `true` means this caller completed it; `false` means a previous execution got
 * there first or the set is not complete (the replay finishes it).
 */
export async function markAttemptSettled(
  db: D1Like,
  deliveryKey: string,
  landed: readonly SettlementEffect[],
  required: readonly SettlementEffect[],
  nowMs: number,
): Promise<boolean> {
  const written = await settlementStatement(db, "delivery_key = ?", [deliveryKey], landed, required, nowMs).run();
  return written.meta.changes === 1;
}

/** What one settlement execution actually made durable for its attempt. */
export type AttemptSettlementInput = {
  attemptId: string;
  landed: readonly SettlementEffect[];
};

async function settlementPlan(
  db: D1Like,
  input: AttemptSettlementInput,
): Promise<{ deliveryKey: string; landed: SettlementEffect[]; required: SettlementEffect[] } | null> {
  const handoff = await readAttemptHandoffByAttempt(db, input.attemptId);
  if (handoff === null) return null;
  const landed = new Set<SettlementEffect>([...(handoff.settledEffects ?? []), ...input.landed]);
  const checkInvolved = (await readAttemptCheckKey(db, input.attemptId)) !== null;
  const checkOpen = checkInvolved ? await attemptCheckIsOpen(db, input.attemptId) : false;
  if (checkOpen) landed.delete("check");
  else if (checkInvolved) landed.add("check");

  let required: SettlementEffect[];
  if (landed.has("skip")) {
    required = ["skip"];
  } else if (landed.has("failure-row")) {
    required = settlementObligationsOf(handoff.payload, checkInvolved);
    // (The refused round's two effects are read from durable facts below.)
  } else if (landed.has("publication")) {
    required = ["publication"];
    if (checkInvolved) required.push("check");
  } else {
    return null;
  }
  // The refused round's effects come from DURABLE FACTS, and only the FAILURE
  // lane reads them: the publication lane must never be blocked by round state
  // (a clean review's accounting is best-effort). The refusal MARKER is what says
  // a round is owed at all — a duty row whose insert never committed cannot hide
  // the obligation — while the duty carries what to write and the row/fact carry
  // what already landed. The live settlement and the recovery pass share this
  // plan, so neither can discharge an incomplete ledger.
  if (required.includes("failure-row") && (await readRefusalPending(db, input.attemptId))) {
    const duty = await readRecheckDuty(db, input.attemptId);
    // A row is owed only when the duty says one was shipped (a cancelled round or
    // one that sent nothing owes the attribution alone).
    if (duty !== null && duty.failureError !== null) {
      if (await recheckRowExists(db, input.attemptId)) landed.add("recheck-row");
      else required.push("recheck-row");
    }
    if (await readRecheckAttribution(db, input.attemptId)) landed.add("recheck-attribution");
    else required.push("recheck-attribution");
  }
  return { deliveryKey: handoff.deliveryKey, landed: [...landed], required };
}

/**
 * The settlement rule as a plain statement for the attempt's OWN handoff row —
 * the batchable form of `settleAttemptIfDischarged` (same plan, same union, same
 * completeness rule). `null` means no lane has closed (or no handoff row): there
 * is nothing to mark.
 */
export async function settlementStatementForEffects(
  db: D1Like,
  input: AttemptSettlementInput,
  nowMs: number,
): Promise<D1StatementLike | null> {
  const plan = await settlementPlan(db, input);
  if (plan === null) return null;
  return settlementStatement(db, "attempt_id = ?", [input.attemptId], plan.landed, plan.required, nowMs);
}

/**
 * Land the failure effect and its settle-once fact as ONE persistence step. The
 * row is inserted and the fact recorded in a single D1 batch, so no interruption
 * (a crash, a KV fault, a second pass) can ever see one without the other; the
 * insert's deterministic attempt-scoped id makes a concurrent pass a no-op.
 *
 * `landed` is the OWNERSHIP proof the caller needs for the head-wide claim: the
 * insert reports whether THIS pass wrote the row (`meta.changes`), so an
 * overlapping pass that lost the race knows it owns nothing. `false` when the
 * attempt has no handoff row to mark — nothing is written, because a row the
 * settle-once rule cannot see is not a fact.
 */
export async function landFailureEffect(
  db: D1Like,
  input: AttemptSettlementInput & {
    failure: ReviewFailureInput;
  },
  nowMs: number,
): Promise<{ landed: boolean; owned: boolean }> {
  const landed: SettlementEffect[] = input.landed.includes("failure-row")
    ? [...input.landed]
    : [...input.landed, "failure-row"];
  const mark = await settlementStatementForEffects(db, { attemptId: input.attemptId, landed }, nowMs);
  if (mark === null) return { landed: false, owned: false };
  const results = await db.batch([
    settlementFailureRowStatement(db, input.failure, input.attemptId),
    mark,
  ]);
  // The row insert is second-to-last; the mark always closes the batch.
  const insert = results[results.length - 2];
  return { landed: true, owned: (insert?.meta.changes ?? 0) === 1 };
}

/**
 * Stamp the head's abandoned claim — the head-wide key — ONLY from the pass that
 * provably owns this attempt's settlement, i.e. the pass whose own insert landed
 * the failure record (`owned`). KV has no compare-and-set and the value cannot
 * tell one delivery's `1` from another's, so exclusivity is the only safe rule: a
 * pass that lost the insert race — or that is only repairing an earlier pass's
 * unlanded stamp — cannot prove its generation and writes NOTHING. The head may
 * already have been re-claimed by a fresh delivery, and the row's failure record
 * stands without this write.
 *
 * residual: an owner whose KV write faulted leaves the stamp owed forever; no
 * later pass can prove ownership, so no repair is attempted. Closing that needs a
 * compare-and-set (or a generation-scoped key) this platform does not offer.
 *
 * `null` means nothing was written. The write's own proof is the caller's to
 * judge (`written`/`done` are facts, `unreadable` is still owed).
 */
export async function stampOwedSettlementClaim(
  db: D1Like,
  kv: KVNamespace,
  input: { attemptId: string; key: string; ttlSeconds: number; owned: boolean },
): Promise<AbandonClaimWrite | null> {
  if (!input.owned) return null;
  const handoff = await readAttemptHandoffByAttempt(db, input.attemptId);
  // The owner still defers to a settlement another actor completed in between.
  if (handoff === null || handoff.settledMs !== null) return null;
  return putAbandonClaim(kv, input.key, IDEM_FAILED, input.ttlSeconds);
}

/**
 * Apply the rule now: merge what this execution landed and complete the mark
 * only when the attempt's obligations are discharged. `false` means nothing was
 * written (no lane closed, or no handoff row).
 */
export async function settleAttemptIfDischarged(
  db: D1Like,
  input: AttemptSettlementInput,
  nowMs: number,
): Promise<boolean> {
  const plan = await settlementPlan(db, input);
  if (plan === null) return false;
  return markAttemptSettled(db, plan.deliveryKey, plan.landed, plan.required, nowMs);
}

/**
 * The rule as a STATEMENT for a caller that must record it inside another
 * transaction (a recovery apply). The publication guard makes the statement
 * self-checking: it only lands when the journal really reached `applied`. The
 * obligations are read from durable facts NOW, before the batch.
 */
export async function settlementStatementIfDischarged(
  db: D1Like,
  input: AttemptSettlementInput & { publicationId: string },
  nowMs: number,
): Promise<D1StatementLike | null> {
  const plan = await settlementPlan(db, input);
  if (plan === null) return null;
  return settlementStatement(
    db,
    `attempt_id = ? AND EXISTS (
       SELECT 1 FROM review_publications WHERE id = ? AND phase = 'applied'
     )`,
    [input.attemptId, input.publicationId],
    plan.landed,
    plan.required,
    nowMs,
  );
}

function settlementStatement(
  db: D1Like,
  whereSql: string,
  whereBinds: readonly string[],
  landed: readonly SettlementEffect[],
  required: readonly SettlementEffect[],
  nowMs: number,
): D1StatementLike {
  return db
    .prepare(
      `UPDATE review_attempt_handoffs
          SET settled_effects = (
                SELECT json_group_array(value) FROM (
                  SELECT value FROM json_each(COALESCE(settled_effects, '[]'))
                  UNION
                  SELECT value FROM json_each(?)
                )
              ),
              settled_ms = CASE
                WHEN settled_ms IS NOT NULL THEN settled_ms
                WHEN NOT EXISTS (
                  SELECT 1 FROM json_each(?) req
                   WHERE req.value NOT IN (
                     SELECT value FROM json_each(COALESCE(settled_effects, '[]'))
                     UNION
                     SELECT value FROM json_each(?)
                   )
                ) THEN ?
                ELSE NULL
              END
        WHERE ${whereSql}`,
    )
    .bind(
      JSON.stringify(landed),
      JSON.stringify(required),
      JSON.stringify(landed),
      nowMs,
      ...whereBinds,
    );
}

/**
 * Mark that a settlement STARTED. Written before the settlement's effects, so
 * a settlement that never completes is distinguishable from an attempt that has
 * not failed yet — and therefore recoverable by the route's pass.
 */
export async function beginAttemptSettlement(db: D1Like, deliveryKey: string, nowMs: number): Promise<void> {
  await db.prepare(BEGIN_SETTLEMENT_SQL).bind(nowMs, deliveryKey).run();
}

const BEGIN_SETTLEMENT_SQL = `UPDATE review_attempt_handoffs SET settling_ms = COALESCE(settling_ms, ?) WHERE delivery_key = ?`;

/**
 * The settlement-start mark as a batchable statement. `changes() > 0` reads the
 * row count of the statement placed IMMEDIATELY before it in the same batch —
 * it must follow the guarded write whose match proves this pass owns the
 * settlement, so a pass that lost its terminal move never enters
 * `listIncompleteSettlements` claiming work it never began.
 */
export function beginAttemptSettlementStatement(
  db: D1Like,
  deliveryKey: string,
  nowMs: number,
): D1StatementLike {
  return db.prepare(`${BEGIN_SETTLEMENT_SQL} AND changes() > 0`).bind(nowMs, deliveryKey);
}

/**
 * The effects a settlement OWES for this delivery: its own durable failure row,
 * and the commit's failed-claim stamp when the delivery names a commit. The
 * Check conclusion is not listed: a settlement only writes the mark after its
 * `terminalize` returned, so a Check that never concluded leaves no mark at all
 * (and the Check row's own lease hands it to the check reconciler), while a
 * concluded one is already recorded in the effects.
 */
export function settlementObligationsOf(payload: ReviewJobPayload, checkInvolved: boolean): SettlementEffect[] {
  return [
    "failure-row",
    ...(checkInvolved ? (["check"] as const) : []),
    ...(payload.head_sha ? (["claim-stamp"] as const) : []),
  ];
}

/** The Check identity the attempt froze on its launch row (`null` = no Check). */
export async function readAttemptCheckKey(
  db: D1Like,
  attemptId: string,
): Promise<{ key: string; generation: number } | null> {
  const row = await db
    .prepare(`SELECT attempt_key, attempt_generation FROM review_launches WHERE attempt_id = ?`)
    .bind(attemptId)
    .first<{ attempt_key: string | null; attempt_generation: number | null }>();
  if (row === null || row.attempt_key === null) return null;
  return { key: row.attempt_key, generation: row.attempt_generation ?? 0 };
}

/**
 * Settlements that STARTED and never completed, quiet long enough that a live
 * step is not racing this pass.
 */
export async function listIncompleteSettlements(
  db: D1Like,
  input: { settlingBeforeMs: number; limit: number },
): Promise<AttemptHandoff[]> {
  const rows = await db
    .prepare(
      `SELECT delivery_key, attempt_id, payload_json, state, deadline_ms, enqueued_ms, created_ms, settled_ms, settled_effects, settling_ms
         FROM review_attempt_handoffs
        WHERE settled_ms IS NULL AND settling_ms IS NOT NULL AND settling_ms <= ?
        ORDER BY settling_ms
        LIMIT ?`,
    )
    .bind(input.settlingBeforeMs, input.limit)
    .all<HandoffRow>();
  return rows.results.map(toHandoff);
}

/**
 * The persisted-but-unpublished crash window (I-000684): the attempt's paid
 * result is durable, its own hard stop has passed, and NOTHING was ever staged
 * for THIS attempt — so the publication lane (which only ever walks journal
 * rows) can never pick it up and no settlement ever started. The pass turns that
 * into the recorded terminal failure a failed review already gets, so the state
 * is visible and re-triggerable instead of a paid result hidden behind a queued
 * Check.
 *
 * `state = 'created'` keeps the instances that never got one in the re-enqueue
 * family's hands; `settling_ms IS NULL` keeps a settlement that already started
 * in `listIncompleteSettlements`. The journal anti-join is keyed FIRST on the
 * PRODUCER's own identity (`payload.admittedAttemptId`, else `payload.attemptId`
 * — the fields `collect` freezes into the staged payload), which is
 * head-independent: a headless delivery resolves its checkout head and stages
 * that body, and a resolved head that differs from the payload's is still this
 * attempt's publication. One row exists per scope/head/kind, so a PRIOR
 * generation's terminal `failed`/`degraded` journal must not suppress this
 * attempt's failure record. Rows written before the identity existed carry
 * neither field: those keep the old conservative scope/head rule (no migration
 * invents an identity), and a headless delivery can never match that arm. A
 * headless launch with NO journal of its own is recorded with the empty-head
 * convention and without a claim write.
 *
 * A row whose durable effects carry `failure-row` but NOT `claim-stamp` has LEFT
 * this lane: the record landed, the head-wide claim stamp never did, and the
 * owner-exclusive rule lets no later pass write it (`owned === false`), so such
 * a row can never discharge and re-selecting it every pass would let those rows
 * monopolize the bounded oldest-first batch; its residual sentinel decays on its
 * own TTL (I-000688). A row whose stamp landed TOO keeps a live obligation (the
 * Check, while it is still open), so it stays selected and its settlement
 * completes once that obligation clears — and the landed stamp means no second
 * claim write is attempted.
 */
export async function listUnpublishedLaunchSettlements(
  db: D1Like,
  input: { deadlineBeforeMs: number; limit: number },
): Promise<AttemptHandoff[]> {
  const rows = await db
    .prepare(
      `SELECT h.delivery_key, h.attempt_id, h.payload_json, h.state, h.deadline_ms,
              h.enqueued_ms, h.created_ms, h.settled_ms, h.settled_effects, h.settling_ms
         FROM review_attempt_handoffs h
         JOIN review_launches l ON l.attempt_id = h.attempt_id
        WHERE h.settled_ms IS NULL AND h.settling_ms IS NULL AND h.state = 'created'
          AND l.state = 'persisted'
          AND h.deadline_ms IS NOT NULL AND h.deadline_ms <= ?
          AND NOT (
            EXISTS (
              SELECT 1 FROM json_each(COALESCE(h.settled_effects, '[]'))
               WHERE value = 'failure-row'
            )
            AND NOT EXISTS (
              SELECT 1 FROM json_each(COALESCE(h.settled_effects, '[]'))
               WHERE value = 'claim-stamp'
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM review_publications p
             WHERE (
               -- OWNERSHIP FIRST, head-independent: a journal this attempt staged is
               -- its own body (a headless delivery's checkout head, or a resolved head
               -- that differs from the payload) and the publication lane owns it. The
               -- tenant scope leads so the expression index (0101) seeks by prefix and
               -- an unrelated tenant's history is never touched.
               p.bot_id = json_extract(h.payload_json, '$.botRef.appId')
               AND p.installation_id = json_extract(h.payload_json, '$.installation_id')
               AND p.owner = json_extract(h.payload_json, '$.owner')
               AND p.repo = json_extract(h.payload_json, '$.repo')
               AND p.pr_number = json_extract(h.payload_json, '$.pr_number')
               AND COALESCE(
                 json_extract(p.payload_json, '$.admittedAttemptId'),
                 json_extract(p.payload_json, '$.attemptId')
               ) = h.attempt_id
             )
             OR (
               -- Legacy rows carry no identity: keep the old conservative scope/head
               -- rule. A headless delivery has no head to match, so it never lands
               -- here (no migration invents an identity).
               COALESCE(
                 json_extract(p.payload_json, '$.admittedAttemptId'),
                 json_extract(p.payload_json, '$.attemptId')
               ) IS NULL
               AND json_extract(h.payload_json, '$.head_sha') IS NOT NULL
               AND p.bot_id = json_extract(h.payload_json, '$.botRef.appId')
               AND p.installation_id = json_extract(h.payload_json, '$.installation_id')
               AND p.owner = json_extract(h.payload_json, '$.owner')
               AND p.repo = json_extract(h.payload_json, '$.repo')
               AND p.pr_number = json_extract(h.payload_json, '$.pr_number')
               AND p.head_sha = json_extract(h.payload_json, '$.head_sha')
             )
          )
        ORDER BY h.deadline_ms, h.delivery_key
        LIMIT ?`,
    )
    .bind(input.deadlineBeforeMs, input.limit)
    .all<HandoffRow>();
  return rows.results.map(toHandoff);
}

/**
 * The lost-reply observation window (I-000694): the paid exec was issued, its
 * reply never arrived, and the grace past the attempt's own deadline has now
 * elapsed. `settleAttemptFailure` leaves exactly this shape on purpose —
 * `launched` with no `result_outcome` and `containerStateUnknown: true`,
 * because a paid child may still be running — but nothing used to move the row
 * afterwards, so the attempt held capacity forever and its Check never
 * terminalized.
 *
 * `deadline_ms + window <= now` is the liveness proxy there is: the attempt's
 * hard stop is the instant its paid exec is killed, so a row whose deadline
 * passed longer than the grace ago has no live child left to protect. The row's
 * FROZEN `deadline_ms` is that instant and nothing else is: a `created_ms + cap`
 * synthesis would read a cap resolved in THIS pass, which either degrades to
 * the default while the row was admitted under a stored larger cap or shrinks
 * when an operator lowers the cap afterwards — both settle a live paid child
 * early. So an anchored row is settled from `deadline_ms` alone.
 *
 * The pre-column legacy set (`deadline_ms IS NULL`, written before migration
 * 0084) has no frozen anchor and no other lane reaches it: the incomplete-
 * settlement lane selects `settling_ms IS NOT NULL`, which a row that never
 * started a settlement cannot match. Its bound is the CAP's own validation
 * ceiling instead: an attempt's hard stop is `created_ms + cap` and `cap` can
 * never exceed `REVIEW_ATTEMPT_CAP_MAX_MS`, so the launched row cannot have a
 * live child later than `launched_at_ms + REVIEW_ATTEMPT_CAP_MAX_MS` (the
 * launch never precedes the create). That ceiling is a constant upper bound,
 * not a tunable read, so neither a degraded read nor a lowered cap can move it
 * earlier. A row with no `launched_at_ms` matches neither branch.
 *
 * The anti-join on `review_failures` is the idempotence guard: the failure row
 * is keyed by the attempt, so a row that already settled once is never selected
 * again and a concurrent pass can never mint a second one. That row is written
 * by THIS lane alone — the live settlement records only an OBSERVATION on the
 * handoff row (see `AttemptObservation`), never a failure row — so a row
 * existing here means the settlement already ran.
 *
 * `state = 'launched'` and `result_outcome IS NULL` are the shape that holds
 * capacity (`PAID_STATE_UNKNOWN` in `inflight-store`); once the settlement
 * moves the row to `failed` it stops matching both, so this pass is the ONE
 * mechanism that releases the hold — no second time bound is added there.
 */
export async function listLostReplyLaunchSettlements(
  db: D1Like,
  input: { deadlineBeforeMs: number; limit: number },
): Promise<AttemptHandoff[]> {
  const rows = await db
    .prepare(
      `SELECT h.delivery_key, h.attempt_id, h.payload_json, h.state, h.deadline_ms,
              h.enqueued_ms, h.created_ms, h.settled_ms, h.settled_effects, h.settling_ms
         FROM review_attempt_handoffs h
         JOIN review_launches l ON l.attempt_id = h.attempt_id
        WHERE l.state = 'launched' AND l.result_outcome IS NULL
          AND (
            (h.deadline_ms IS NOT NULL AND h.deadline_ms <= ?1)
            OR (h.deadline_ms IS NULL AND l.launched_at_ms <= ?2)
          )
          AND NOT EXISTS (
            SELECT 1 FROM review_failures f WHERE f.id = h.attempt_id
          )
        ORDER BY h.deadline_ms, h.delivery_key
        LIMIT ?3`,
    )
    .bind(
      input.deadlineBeforeMs,
      input.deadlineBeforeMs - REVIEW_ATTEMPT_CAP_MAX_MS,
      input.limit,
    )
    .all<HandoffRow>();
  return rows.results.map(toHandoff);
}

/**
 * Handoffs whose create is not confirmed and whose last touch is old enough to
 * retry. `ambiguous` rows are included on purpose: the instance may exist, and
 * the replay is idempotent (create answers "already exists").
 */
export async function listHandoffsForRecovery(
  db: D1Like,
  input: { updatedBeforeMs: number; limit: number },
): Promise<AttemptHandoff[]> {
  const rows = await db
    .prepare(
      `SELECT delivery_key, attempt_id, payload_json, state, deadline_ms, enqueued_ms, created_ms, settled_ms, settled_effects, settling_ms
         FROM review_attempt_handoffs
        WHERE state IN ('owed', 'ambiguous') AND updated_ms <= ?
        ORDER BY updated_ms
        LIMIT ?`,
    )
    .bind(input.updatedBeforeMs, input.limit)
    .all<HandoffRow>();
  return rows.results.map(toHandoff);
}

/**
 * Record the moved head's successor intent. Idempotent: one row per intent.
 * Returns the row's STORED payload — the winner's — because that is what
 * admission must be handed: a second caller that builds a different payload for
 * the same intent (another `successor_of`, another attach id) must not send its
 * own version beside the recorded one.
 */
export async function recordSuccessorIntent(
  db: D1Like,
  input: { dedupeKey: string; payload: ReviewJobPayload; nowMs: number },
): Promise<{ payload: ReviewJobPayload; generation: number }> {
  await db
    .prepare(
      `INSERT INTO review_successors (dedupe_key, payload_json, state, created_ms, generation)
       VALUES (?, ?, 'owed', ?, 0)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .bind(input.dedupeKey, JSON.stringify(input.payload), input.nowMs)
    .run();
  const row = await db
    .prepare(`SELECT payload_json, generation FROM review_successors WHERE dedupe_key = ?`)
    .bind(input.dedupeKey)
    .first<{ payload_json: string; generation: number }>();
  if (row === null) {
    throw new Error(`review successor intent for ${input.dedupeKey} disappeared after its insert`);
  }
  return { payload: JSON.parse(row.payload_json) as ReviewJobPayload, generation: row.generation };
}

/** Successor intents still owed a queue send. */
export async function listOwedSuccessors(
  db: D1Like,
  limit: number,
): Promise<Array<{ dedupeKey: string; payload: ReviewJobPayload; generation: number }>> {
  const rows = await db
    .prepare(
      `SELECT dedupe_key, payload_json, generation FROM review_successors
        WHERE state = 'owed' ORDER BY created_ms LIMIT ?`,
    )
    .bind(limit)
    .all<{ dedupe_key: string; payload_json: string; generation: number }>();
  return rows.results.map((row) => ({
    dedupeKey: row.dedupe_key,
    payload: JSON.parse(row.payload_json) as ReviewJobPayload,
    generation: row.generation,
  }));
}

/**
 * The row's CURRENT generation. A sender that read the row earlier carries the
 * old number and must not deliver over a re-arm: this is the pre-send check.
 */
export async function successorGeneration(db: D1Like, dedupeKey: string): Promise<number | null> {
  const row = await db
    .prepare(`SELECT generation FROM review_successors WHERE dedupe_key = ?`)
    .bind(dedupeKey)
    .first<{ generation: number }>();
  return row?.generation ?? null;
}

/** Mark a successor delivered AFTER the queue accepted it. */
export async function markSuccessorDelivered(
  db: D1Like,
  dedupeKey: string,
  generation: number,
  nowMs: number,
): Promise<boolean> {
  const written = await db
    .prepare(
      `UPDATE review_successors SET state = 'delivered', delivered_ms = ?
        WHERE dedupe_key = ? AND generation = ? AND state = 'owed'`,
    )
    .bind(nowMs, dedupeKey, generation)
    .run();
  return written.meta.changes === 1;
}

/**
 * The outbox identity of a delivery the guard gave up on for good.
 */
export function guardDropDedupeKeyOf(payload: ReviewJobPayload): string {
  return JSON.stringify(["guard-drop", deliveryKeyOf(payload)]);
}

/**
 * Record — or RE-ARM — the owed retry for a dropped delivery. The upsert is
 * deliberate: once a delivery's first owed row has been delivered, a LATER
 * ladder of the same delivery that is dropped again must make that row owed
 * again. Without it the first re-delivery would consume the only chance and a
 * guard still held would lose the review for good — ack-and-forget by another
 * name. Each re-arm costs one full retry ladder, because only a drop reaches
 * this line.
 */
export async function recordGuardDropIntent(
  db: D1Like,
  input: { dedupeKey: string; payload: ReviewJobPayload; nowMs: number },
): Promise<{ payload: ReviewJobPayload; generation: number }> {
  await db
    .prepare(
      `INSERT INTO review_successors (dedupe_key, payload_json, state, created_ms, generation)
       VALUES (?, ?, 'owed', ?, 1)
       ON CONFLICT (dedupe_key) DO UPDATE SET
         payload_json = excluded.payload_json,
         state = 'owed',
         delivered_ms = NULL,
         generation = review_successors.generation + 1`,
    )
    .bind(input.dedupeKey, JSON.stringify(input.payload), input.nowMs)
    .run();
  const row = await db
    .prepare(`SELECT payload_json, generation FROM review_successors WHERE dedupe_key = ?`)
    .bind(input.dedupeKey)
    .first<{ payload_json: string; generation: number }>();
  if (row === null) {
    throw new Error(`guard-drop record for ${input.dedupeKey} disappeared after its write`);
  }
  return { payload: JSON.parse(row.payload_json) as ReviewJobPayload, generation: row.generation };
}

/** One consumed comment claim whose delivery died before it recorded anything. */
export type CommentClaimRecovery = {
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  comment_id: number;
  payload: ReviewJobPayload;
};

/**
 * Consumed comment claims that STILL CARRY their payload. The consumer clears
 * the payload once the delivery's handoff row exists (or once an ordinary
 * failure ends the delivery), so a row that keeps it is a delivery that died
 * between consuming the claim and writing the handoff — the one window the
 * claim row itself has to record.
 */
export async function listCommentClaimsForRecovery(
  db: D1Like,
  input: { consumedBeforeMs: number; limit: number },
): Promise<CommentClaimRecovery[]> {
  const rows = await db
    .prepare(
      `SELECT installation_id, owner, repo, pr_number, comment_id, payload_json
         FROM comment_trigger_claims
        WHERE state = 'consumed' AND payload_json IS NOT NULL AND consumed_ms <= ?
        ORDER BY consumed_ms
        LIMIT ?`,
    )
    .bind(input.consumedBeforeMs, input.limit)
    .all<{
      installation_id: number;
      owner: string;
      repo: string;
      pr_number: number;
      comment_id: number;
      payload_json: string;
    }>();
  return rows.results.map((row) => ({
    installation_id: row.installation_id,
    owner: row.owner,
    repo: row.repo,
    pr_number: row.pr_number,
    comment_id: row.comment_id,
    payload: JSON.parse(row.payload_json) as ReviewJobPayload,
  }));
}

/**
 * Hand one orphaned claim back to the queue. The conditional update IS the
 * hand-back: only one recovery pass can move the row out of `consumed`, so a
 * second pass sends nothing. The row goes back to `queued` (not to a new
 * state) so the re-delivery takes the ordinary claim path, and so a failed send
 * is retried by the existing comment outbox lane, which owns the attempt cap.
 */
export async function restoreCommentClaimForRecovery(
  db: D1Like,
  claim: CommentClaimRecovery,
  nowMs: number,
): Promise<boolean> {
  const written = await db
    .prepare(
      `UPDATE comment_trigger_claims
          SET state = 'queued', consumed_ms = NULL, queued_ms = ?
        WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND comment_id = ?
          AND state = 'consumed' AND payload_json IS NOT NULL`,
    )
    .bind(nowMs, claim.installation_id, claim.owner, claim.repo, claim.pr_number, claim.comment_id)
    .run();
  return written.meta.changes === 1;
}

/**
 * Drop a comment claim's payload once the delivery no longer needs the claim
 * row to carry it: the handoff row now owns recovery, or an ordinary failure
 * ended the delivery (a comment review is re-run by posting a new comment).
 * Best-effort by contract — a fault only leaves the row recoverable.
 */
export async function clearCommentClaimPayload(db: D1Like, payload: ReviewJobPayload): Promise<void> {
  if (payload.comment_id === undefined) return;
  await db
    .prepare(
      `UPDATE comment_trigger_claims SET payload_json = NULL
        WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND comment_id = ?
          AND state = 'consumed'`,
    )
    .bind(payload.installation_id, payload.owner, payload.repo, payload.pr_number, payload.comment_id)
    .run();
}

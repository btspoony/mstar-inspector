import type { ReviewJobPayload } from "../contracts/review-job";
import type { D1Like, D1StatementLike } from "./types";

export type AttemptHandoffState = "owed" | "ambiguous" | "created" | "failed";

export type AttemptHandoff = {
  deliveryKey: string;
  attemptId: string;
  payload: ReviewJobPayload;
  state: AttemptHandoffState;
  deadlineMs: number | null;
  enqueuedMs: number | null;
  createdMs: number;
  settledMs: number | null;
  settledEffects: SettlementEffect[] | null;
  settlingMs: number | null;
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
  return {
    deliveryKey: row.delivery_key,
    attemptId: row.attempt_id,
    payload: JSON.parse(row.payload_json) as ReviewJobPayload,
    state: row.state,
    deadlineMs: row.deadline_ms,
    enqueuedMs: row.enqueued_ms,
    createdMs: row.created_ms,
    settledMs: row.settled_ms,
    settledEffects: row.settled_effects === null ? null : (JSON.parse(row.settled_effects) as SettlementEffect[]),
    settlingMs: row.settling_ms,
  };
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
 * `deadlineMs` is frozen by the FIRST writer: a conflicting insert changes
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
      input.nowMs,
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

/** The effects a settlement can make durable (see `settleAttemptFailure`). */
export type SettlementEffect = "failure-row" | "check" | "claim-stamp" | "skip" | "publication";

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
  } else if (landed.has("publication")) {
    required = ["publication"];
    if (checkInvolved) required.push("check");
  } else {
    return null;
  }
  return { deliveryKey: handoff.deliveryKey, landed: [...landed], required };
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
  await db
    .prepare(`UPDATE review_attempt_handoffs SET settling_ms = COALESCE(settling_ms, ?) WHERE delivery_key = ?`)
    .bind(nowMs, deliveryKey)
    .run();
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

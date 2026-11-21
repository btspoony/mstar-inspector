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
import type { ReviewJobPayload } from "../contracts/review-job";
import type { D1Like } from "./types";

export type AttemptHandoffState = "owed" | "ambiguous" | "created" | "failed";

export type AttemptHandoff = {
  deliveryKey: string;
  attemptId: string;
  payload: ReviewJobPayload;
  state: AttemptHandoffState;
  /** The settle-once mark the Workflow's settlement step takes after completing. */
  settledMs: number | null;
};

/**
 * The stable identity of one queue message. A redelivery carries the same body,
 * so it maps to the same handoff row; a genuinely new delivery (another
 * comment, another push) differs in at least one of these fields.
 */
export function deliveryKeyOf(payload: ReviewJobPayload): string {
  // A pre-deploy message may carry no `botRef` (AL-24-4 accepts the TypeError
  // on the admission path); the key must not throw before the structured
  // failure channel can speak for it.
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

/** One moved head, one successor: the observed head's identity is the dedupe key. */
export function successorDedupeKeyOf(input: {
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  headSha: string;
}): string {
  return JSON.stringify([
    "successor",
    input.installation_id,
    input.owner.toLowerCase(),
    input.repo.toLowerCase(),
    input.pr_number,
    input.headSha,
  ]);
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
  settled_ms: number | null;
};

function toHandoff(row: HandoffRow): AttemptHandoff {
  return {
    deliveryKey: row.delivery_key,
    attemptId: row.attempt_id,
    payload: JSON.parse(row.payload_json) as ReviewJobPayload,
    state: row.state,
    settledMs: row.settled_ms,
  };
}

/** The delivery's handoff record, or `null` when this body was never handed off. */
export async function readAttemptHandoff(db: D1Like, deliveryKey: string): Promise<AttemptHandoff | null> {
  const row = await db
    .prepare(
      `SELECT delivery_key, attempt_id, payload_json, state, settled_ms
         FROM review_attempt_handoffs WHERE delivery_key = ?`,
    )
    .bind(deliveryKey)
    .first<HandoffRow>();
  return row === null ? null : toHandoff(row);
}

/**
 * Write the handoff BEFORE the create, or read back the row a previous delivery
 * of the same message wrote. `INSERT … ON CONFLICT DO NOTHING` makes two
 * concurrent attempts to reserve the same delivery harmless: both read back the
 * one row, and the caller uses ITS attempt id.
 */
export async function reserveAttemptHandoff(
  db: D1Like,
  input: { deliveryKey: string; attemptId: string; payload: ReviewJobPayload; nowMs: number },
): Promise<AttemptHandoff> {
  await db
    .prepare(
      `INSERT INTO review_attempt_handoffs
         (delivery_key, attempt_id, payload_json, state, created_ms, updated_ms)
       VALUES (?, ?, ?, 'owed', ?, ?)
       ON CONFLICT (delivery_key) DO NOTHING`,
    )
    .bind(input.deliveryKey, input.attemptId, JSON.stringify(input.payload), input.nowMs, input.nowMs)
    .run();
  const row = await readAttemptHandoff(db, input.deliveryKey);
  if (row === null) {
    throw new Error(`review attempt handoff for ${input.deliveryKey} disappeared after its insert`);
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
 * The settle-once mark. `true` means THIS caller took it and must run the
 * settlement; `false` means a previous execution already completed it (or is
 * completing it), so the settlement step returns without settling again.
 */
export async function claimAttemptSettlement(db: D1Like, deliveryKey: string, nowMs: number): Promise<boolean> {
  const written = await db
    .prepare(
      `UPDATE review_attempt_handoffs SET settled_ms = ?
        WHERE delivery_key = ? AND settled_ms IS NULL`,
    )
    .bind(nowMs, deliveryKey)
    .run();
  return written.meta.changes === 1;
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
      `SELECT delivery_key, attempt_id, payload_json, state, settled_ms
         FROM review_attempt_handoffs
        WHERE state IN ('owed', 'ambiguous') AND updated_ms <= ?
        ORDER BY updated_ms
        LIMIT ?`,
    )
    .bind(input.updatedBeforeMs, input.limit)
    .all<HandoffRow>();
  return rows.results.map(toHandoff);
}

/** Record the moved head's successor intent. Idempotent: one row per observed head. */
export async function recordSuccessorIntent(
  db: D1Like,
  input: { dedupeKey: string; payload: ReviewJobPayload; nowMs: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO review_successors (dedupe_key, payload_json, state, created_ms)
       VALUES (?, ?, 'owed', ?)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .bind(input.dedupeKey, JSON.stringify(input.payload), input.nowMs)
    .run();
}

/** Successor intents still owed a queue send. */
export async function listOwedSuccessors(
  db: D1Like,
  limit: number,
): Promise<Array<{ dedupeKey: string; payload: ReviewJobPayload }>> {
  const rows = await db
    .prepare(
      `SELECT dedupe_key, payload_json FROM review_successors
        WHERE state = 'owed' ORDER BY created_ms LIMIT ?`,
    )
    .bind(limit)
    .all<{ dedupe_key: string; payload_json: string }>();
  return rows.results.map((row) => ({
    dedupeKey: row.dedupe_key,
    payload: JSON.parse(row.payload_json) as ReviewJobPayload,
  }));
}

/** Mark a successor delivered AFTER the queue accepted it. */
export async function markSuccessorDelivered(db: D1Like, dedupeKey: string, nowMs: number): Promise<void> {
  await db
    .prepare(
      `UPDATE review_successors SET state = 'delivered', delivered_ms = ?
        WHERE dedupe_key = ? AND state = 'owed'`,
    )
    .bind(nowMs, dedupeKey)
    .run();
}

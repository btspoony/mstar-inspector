/**
 * Finding lifecycle store (spec review-lifecycle §7.1/§7.2/
 * §7.7/§7.11.1) — durable lifecycle rows, fair rotation, the private
 * pre-publication journal and the resolution-queue accessors.
 *
 * Module boundary (the artifact-store precedent): `db` is the narrow D1
 * face (`D1Like`); imports are the store layer (types / artifact-store) and
 * the zero-dependency recheck wire contract only — NO worker/pipeline
 * dependencies. Every query binds the complete authenticated scope
 * `(appId, installationId, owner, repo, prNumber)` (spec §7.0); every
 * multi-row transition is ONE logical `db.batch` sequence (knowledge
 * `d1-batch-atomicity`: D1 batch is the transaction primitive), executed in
 * chunks of at most 25 statements per batch for the recovery apply
 * (§7.11.1) with every statement replay-safe AND carrying the live-lease
 * predicate inline; claims use conditional SQL
 * and inspect `meta.changes` — no KV CAS assumption. Timestamps are integer
 * Unix milliseconds from one caller-supplied clock per call (spec §7.0).
 *
 * Journal privacy (spec §7.1 Visibility): `review_publications` /
 * `review_finding_rounds` are the PRIVATE journal. The read faces here are
 * exactly: `readPublicationProof` (consumer + M7), `listPublicationRecovery`
 * (M8 only), `listResolutionRecovery` (M8). NO reviewer-visible result read
 * (the `reviews`/`findings` tables via artifact-store) joins any of them,
 * even after apply — staged rows are unreachable through result reads until
 * the confirmed publication is applied by the frozen §7.7 step order.
 *
 * Replay semantics: `stagePublication` conflicts return the existing
 * immutable payload; `applyPublishedLifecycle` is proof-gated, gates on the
 * publication phase, and makes every lifecycle write replay-safe (rounds
 * and association intents `ON CONFLICT DO NOTHING`, the seen upsert and the
 * scheduling update skip already-applied publications), so a replay after
 * `store.put` but before the lifecycle batch never duplicates findings and
 * a publication replay never increments `reopen_count` twice.
 */

import type { Assessment, Coverage, OriginalFinding, RecheckTarget, ThreadSnapshot } from "../contracts/recheck";
import { ASSESSMENT_TARGET_CAP } from "../contracts/recheck";
import { createArtifactStore, type ReviewArtifactDoc } from "./artifact-store";
import type {
  D1BatchResult,
  D1Like,
  D1StatementLike,
  ReviewFindingRow,
  ReviewPublicationRow,
  ReviewThreadRow,
} from "./types";

/** The authenticated routing scope (spec §7.0) — wire copy lives in the
 *  recheck contract; re-exported here as the store's scope vocabulary. */
export type { Scope } from "../contracts/recheck";
import type { Scope } from "../contracts/recheck";

// ---------------------------------------------------------------------------
// §7.7 journal types — single normative copy lives in spec §7.7; this is the
// single CODE copy (the wire subset of §7.3 is exported from
// src/contracts/recheck.ts instead — do not restate either).
// ---------------------------------------------------------------------------

/** Epoch-fenced lease (spec §7.7). A live lease requires holder + epoch +
 *  `untilMs > now`; claims always increment the epoch. */
export type Lease = { holder: string; epoch: number; untilMs: number };

export type PublicationProof = {
  publicationId: string; scope: Scope; headSha: string;
  kind: 'review' | 'degraded'; round: number; commentId: number;
  bodySha256: string; confirmedMs: number;
};

/**
 * §7.5 marker data shapes needed by the journal payload (`LineIntent` rides
 * `PublicationPayload.lineIntents`; `VerifiedResolution` rides
 * `LifecycleRound.resolutions`). The marker FUNCTIONS (`lineMarker` /
 * `parseLineMarker` / discovery / resolution) belong to
 * `src/pipeline/review-threads.ts`, which imports these type declarations —
 * a single code copy of the shapes.
 */
export type LineIntent = {
  associationId: string; findingRowId: string; publicationId: string;
  scope: Scope; originalSha: string; round: number;
  path: string; line: number; body: string; bodySha256: string;
};
export type VerifiedResolution = {
  assessment: Assessment; snapshot: ThreadSnapshot;
  issueDigest: string; issueCoverage: Coverage;
};

export type LifecycleRound = {
  selectedRowIds: string[]; assessments: Assessment[];
  seen: { rowId: string; findingId: string; original: OriginalFinding }[];
  resolutions: { associationId: string; verified: VerifiedResolution }[];
  coverage: { totalOpen: number; selected: number; assessed: number; omitted: number; capped: number; contextCoverage: Coverage };
};

export type PublicationPayload = {
  version: 1; scope: Scope; headSha: string; kind: 'review' | 'degraded';
  round: number; targetCommentId: number | null; body: string; bodySha256: string;
  artifact: ReviewArtifactDoc | null; lifecycle: LifecycleRound | null;
  lineIntents: LineIntent[];
};

export type PublicationRow = {
  id: string; payload: PublicationPayload; proof: PublicationProof | null;
  phase: 'prepared' | 'sending' | 'confirmed' | 'applied' | 'failed' | 'unknown' | 'superseded';
  lease: Lease | null; attempts: number; nextAttemptMs: number | null;
  recoveryState: 'pending' | 'done' | 'local-error' | 'suspended';
};

// ---------------------------------------------------------------------------
// Constants (spec §7.7 step 8, §7.11.1, §7.3)
// ---------------------------------------------------------------------------

/** Publication lease duration (spec §7.7 step 8: "120s, epoch-fenced"). */
export const PUBLICATION_LEASE_MS = 120_000;
/** Recovery attempt cap — rows at/after this count leave the selectors. */
export const LIFECYCLE_MAX_ATTEMPTS = 5;
/** Staged payload cap (spec §7.7: size ≤1 MiB UTF-8; reject, never truncate). */
export const PUBLICATION_MAX_BYTES = 1_048_576;
/**
 * Backoff after the Nth failed recovery attempt (spec §7.11.1: "1,2,4,8,16
 * minutes"); indexed by `attempts - 1` after the failure. The fifth failure
 * gives up (local-error) instead of scheduling a sixth attempt.
 */
export const LIFECYCLE_BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 960_000];
/** §7.11.1 apply budget: at most 25 row-transition statements per db.batch. */
export const LIFECYCLE_APPLY_BATCH_STATEMENTS = 25;
/** §7.11.1: a prepared publication older than this may be sent by recovery. */
export const PREPARED_SEND_MIN_AGE_MS = 60_000;

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

function leaseOf(row: { holder: string | null; lease_epoch: number; lease_until_ms: number | null }): Lease | null {
  if (row.holder === null || row.lease_until_ms === null) return null;
  return { holder: row.holder, epoch: row.lease_epoch, untilMs: row.lease_until_ms };
}

function publicationRowOf(row: ReviewPublicationRow): PublicationRow {
  return {
    id: row.id,
    payload: JSON.parse(row.payload_json) as PublicationPayload,
    proof: row.proof_json === null ? null : (JSON.parse(row.proof_json) as PublicationProof),
    phase: row.phase as PublicationRow["phase"],
    lease: leaseOf(row),
    attempts: row.attempts,
    nextAttemptMs: row.next_attempt_ms,
    recoveryState: row.recovery_state as PublicationRow["recoveryState"],
  };
}

function threadScope(row: { id: string; app_id: string; installation_id: number; owner: string; repo: string; pr_number: number }): {
  associationId: string; scope: Scope;
} {
  return {
    associationId: row.id,
    scope: {
      appId: row.app_id, installationId: row.installation_id,
      owner: row.owner, repo: row.repo, prNumber: row.pr_number,
    },
  };
}

// ---------------------------------------------------------------------------
// Fair rotation (spec §7.2)
// ---------------------------------------------------------------------------

/**
 * Open-row selection for the recheck seat: query OPEN rows only, ordered by
 * `COALESCE(last_scheduled_ms, created_ms), id` (oldest waiting first — no
 * newest-updated or permanent never-assessed priority), capped at
 * `ASSESSMENT_TARGET_CAP` (25) regardless of the caller's `limit` so a
 * misbehaving caller cannot break the rotation fairness. Association IDs
 * list the row's ACTIVE (non-superseded) thread associations — superseded
 * ones are dead and never offered again. Unselected rows are NOT returned
 * here; the caller represents them via the aggregate cap count in the
 * round coverage (spec §7.2).
 */
export async function selectAssessmentTargets(db: D1Like, scope: Scope, limit: number): Promise<RecheckTarget[]> {
  const capped = Math.max(0, Math.min(limit, ASSESSMENT_TARGET_CAP));
  if (capped === 0) return [];
  const rows = await db
    .prepare(
      `SELECT * FROM review_findings
       WHERE app_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND state = 'open'
       ORDER BY COALESCE(last_scheduled_ms, created_ms), id
       LIMIT ?`,
    )
    .bind(scope.appId, scope.installationId, scope.owner, scope.repo, scope.prNumber, capped)
    .all<ReviewFindingRow>();
  const found = rows.results;
  if (found.length === 0) return [];

  const placeholders = found.map(() => "?").join(",");
  const threads = await db
    .prepare(
      `SELECT id, finding_row_id FROM review_threads
       WHERE finding_row_id IN (${placeholders}) AND superseded_by_publication_id IS NULL`,
    )
    .bind(...found.map((row) => row.id))
    .all<{ id: string; finding_row_id: string }>();

  const associations = new Map<string, string[]>();
  for (const thread of threads.results) {
    const list = associations.get(thread.finding_row_id);
    if (list === undefined) associations.set(thread.finding_row_id, [thread.id]);
    else list.push(thread.id);
  }

  return found.map((row) => ({
    rowId: row.id,
    findingId: row.finding_id,
    original: JSON.parse(row.original_json) as OriginalFinding,
    firstSeenSha: row.first_seen_sha,
    lastAssessment: row.last_assessment_json === null
      ? null
      : (JSON.parse(row.last_assessment_json) as Assessment),
    associationIds: associations.get(row.id) ?? [],
  }));
}

/** Aggregate count of open lifecycle rows for the scope (coverage line). */
export async function countOpenFindings(db: D1Like, scope: Scope): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM review_findings
       WHERE app_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND state = 'open'`,
    )
    .bind(scope.appId, scope.installationId, scope.owner, scope.repo, scope.prNumber)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Private pre-publication journal (spec §7.7)
// ---------------------------------------------------------------------------

/**
 * Stage the COMPLETE private payload before any primary GitHub mutation
 * (spec §7.7 step 7). Serializes the entire validated redacted payload —
 * over the 1 MiB UTF-8 cap throws (reject, never truncate JSON or emit an
 * unrecoverable publication). No result row is written here. An insert
 * conflict (same publication id, or the same scope+SHA+kind under a second
 * id) returns the EXISTING immutable payload — a prepared/confirmed
 * publication is never overwritten with a second model result. Rows stage
 * as phase `prepared`, `recovery_state='pending'`, attempts 0.
 */
export async function stagePublication(
  db: D1Like,
  input: { id: string; payload: PublicationPayload; nowMs: number },
): Promise<PublicationRow> {
  const payloadJson = JSON.stringify(input.payload);
  const bytes = new TextEncoder().encode(payloadJson).length;
  if (bytes > PUBLICATION_MAX_BYTES) {
    throw new Error(
      `finding-lifecycle: staged payload is ${bytes} bytes, over the ${PUBLICATION_MAX_BYTES}-byte journal cap — rejecting instead of truncating`,
    );
  }
  const scope = input.payload.scope;
  const insert = await db
    .prepare(
      `INSERT INTO review_publications
         (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
          payload_json, created_ms, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      input.id, scope.appId, scope.installationId, scope.owner, scope.repo,
      scope.prNumber, input.payload.headSha, input.payload.kind,
      payloadJson, input.nowMs, input.nowMs,
    )
    .run();

  if (insert.meta.changes === 0) {
    // Conflict: the existing immutable payload wins (same-id replay OR a
    // second model result for the same scope+SHA+kind).
    const existing =
      (await db.prepare(`SELECT * FROM review_publications WHERE id = ?`).bind(input.id).first<ReviewPublicationRow>()) ??
      (await db
        .prepare(
          `SELECT * FROM review_publications
           WHERE app_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
             AND head_sha = ? AND kind = ?`,
        )
        .bind(scope.appId, scope.installationId, scope.owner, scope.repo, scope.prNumber, input.payload.headSha, input.payload.kind)
        .first<ReviewPublicationRow>());
    if (existing === null) {
      throw new Error("finding-lifecycle: staging conflict but the existing row is unreadable");
    }
    return publicationRowOf(existing);
  }

  const row = await db.prepare(`SELECT * FROM review_publications WHERE id = ?`).bind(input.id).first<ReviewPublicationRow>();
  if (row === null) throw new Error("finding-lifecycle: staged publication row disappeared immediately after insert");
  return publicationRowOf(row);
}

/**
 * Conditional epoch-fenced claim (spec §7.0 claims / §7.7 step 8): only a
 * non-terminal publication (`prepared`/`sending`/`unknown`/`confirmed` —
 * `applied`/`failed`/`superseded` are terminal) with a free or expired
 * lease can be claimed; claiming increments the epoch, stamps holder and a
 * fresh 120s lease, counts one attempt, and moves `prepared` to `sending`.
 * Returns null when the row is gone, terminal, or another holder owns a
 * live lease.
 */
export async function claimPublication(db: D1Like, id: string, holder: string, nowMs: number): Promise<Lease | null> {
  const claim = await db
    .prepare(
      `UPDATE review_publications
       SET holder = ?, lease_epoch = lease_epoch + 1, lease_until_ms = ?, updated_ms = ?,
           attempts = attempts + 1,
           phase = CASE WHEN phase = 'prepared' THEN 'sending' ELSE phase END
       WHERE id = ? AND phase IN ('prepared','sending','unknown','confirmed')
         AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`,
    )
    .bind(holder, nowMs + PUBLICATION_LEASE_MS, nowMs, id, nowMs)
    .run();
  if (claim.meta.changes === 0) return null;
  const row = await db.prepare(`SELECT * FROM review_publications WHERE id = ?`).bind(id).first<ReviewPublicationRow>();
  if (row === null || row.holder !== holder || row.lease_until_ms === null) return null;
  return { holder, epoch: row.lease_epoch, untilMs: row.lease_until_ms };
}

/**
 * Persist the confirmed publication proof under the live lease (spec §7.7
 * step 8: "Immediately persist proof before KV done"). Fails closed on any
 * lease/identity mismatch (wrong holder, wrong epoch, terminal or foreign
 * scope/SHA, proof pointing at another publication). Confirmation moves the
 * row to `confirmed` with recovery `pending` — the apply is now due.
 */
export async function recordPublicationProof(db: D1Like, id: string, lease: Lease, proof: PublicationProof): Promise<boolean> {
  if (proof.publicationId !== id) return false;
  const result = await db
    .prepare(
      `UPDATE review_publications
       SET phase = 'confirmed', proof_json = ?, confirmed_ms = ?, updated_ms = ?,
           recovery_state = 'pending', next_attempt_ms = NULL
       WHERE id = ? AND holder = ? AND lease_epoch = ?
         AND phase IN ('prepared','sending','unknown','confirmed')
         AND app_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
         AND head_sha = ?`,
    )
    .bind(
      JSON.stringify(proof), proof.confirmedMs, proof.confirmedMs,
      id, lease.holder, lease.epoch,
      proof.scope.appId, proof.scope.installationId, proof.scope.owner, proof.scope.repo, proof.scope.prNumber,
      proof.headSha,
    )
    .run();
  return result.meta.changes > 0;
}

/**
 * Read the persisted publication proof by EXACT App/scope/SHA (spec §7.9:
 * "Read proof by exact App/scope/SHA"). When `publicationId` is supplied
 * that row is preferred; a normal (`review`) proof takes precedence over a
 * `degraded` one within the same exact scope/SHA. Rows without persisted
 * proof prove nothing — null means unproven, never "not published".
 */
export async function readPublicationProof(
  db: D1Like,
  input: { scope: Scope; headSha: string; publicationId?: string },
): Promise<PublicationProof | null> {
  const row = await db
    .prepare(
      `SELECT proof_json FROM review_publications
       WHERE app_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
         AND head_sha = ? AND proof_json IS NOT NULL
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END,
                CASE WHEN kind = 'review' THEN 0 ELSE 1 END,
                created_ms, id
       LIMIT 1`,
    )
    .bind(
      input.scope.appId, input.scope.installationId, input.scope.owner,
      input.scope.repo, input.scope.prNumber, input.headSha,
      input.publicationId ?? "",
    )
    .first<{ proof_json: string }>();
  if (row === null) return null;
  return JSON.parse(row.proof_json) as PublicationProof;
}

/**
 * Proof-gated idempotent apply — the frozen §7.7 step 9 local sequence:
 * (1) the existing atomic `store.put` for the review artifact (idempotent
 * UNIQUE no-op — a replay after store.put but before the lifecycle apply
 * does not duplicate findings; skipped entirely when the review row already
 * exists), then (2) the lifecycle writes in batches of at most 25 row
 * transitions (§7.11.1), whose FINAL statement marks the publication applied
 * under the lease. Degraded proof creates no
 * normal review/lifecycle rows — it only marks applied. Rows absent from
 * `seen` are never deleted. Returns false (and writes nothing) when the
 * row is unknown, the lease is not live, proof is missing, or the payload
 * is not a complete review publication; the previously-applied row
 * short-circuits to true (idempotent replay).
 *
 * The lease fence is ATOMIC, not a read-then-write window: every lifecycle
 * statement (and the applied marker, degraded path included) carries the
 * live-lease predicate `(id, holder, lease_epoch, lease_until_ms > now)` in
 * its own SQL, and a fresh-clock chunk-boundary probe additionally stops a
 * long apply early. A replacement or expiry landing after any probe can
 * therefore never mutate a finding/round/association row, and can never mark
 * the publication applied.
 */
export async function applyPublishedLifecycle(
  db: D1Like,
  id: string,
  lease: Lease,
  nowMs: number,
  /**
   * Fresh clock for the per-chunk lease fence (§7.11.1: "every chunk of the
   * apply must prove the same live publication holder/epoch"). Defaults to
   * the call's fixed clock — a caller whose apply spans a real time window
   * (the M8 reconciler) passes its own clock so an expired lease is
   * observed between chunks instead of being assumed live.
   */
  clock?: () => number,
): Promise<boolean> {
  const nowAt = clock ?? (() => nowMs);
  const row = await db.prepare(`SELECT * FROM review_publications WHERE id = ?`).bind(id).first<ReviewPublicationRow>();
  if (row === null) return false;
  if (row.phase === "applied") return true; // idempotent replay — nothing left to apply
  // Live lease fence (holder + epoch + unexpired) and positive persisted proof.
  if (row.holder !== lease.holder || row.lease_epoch !== lease.epoch) return false;
  if (row.lease_until_ms === null || row.lease_until_ms <= nowAt()) return false;
  if (row.phase !== "confirmed" || row.proof_json === null) return false;

  const payload = JSON.parse(row.payload_json) as PublicationPayload;

  if (payload.kind === "degraded") {
    // Degraded payload: artifact/lifecycle null, empty line intents — no
    // normal review or lifecycle rows are created from it (spec §7.7).
    const applied = await markPublicationApplied(db, row.id, lease, nowMs).run();
    return applied.meta.changes > 0;
  }
  if (payload.kind !== "review" || payload.artifact === null || payload.lifecycle === null) {
    // A review-kind payload without its complete artifact/lifecycle is
    // malformed — fail closed, leave the confirmed row for inspection.
    return false;
  }

  // Step 1 — the existing atomic store.put (review kind only), a separate
  // idempotent step, never described as part of the lifecycle batch.
  // §7.11.1: skipped entirely when the review row already exists — the
  // UNIQUE(installation_id, owner, repo, pr_number, head_sha) row IS the
  // review, so the put would be a pure no-op batch.
  const stored = await db
    .prepare(
      `SELECT 1 AS present FROM reviews
       WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND head_sha = ?`,
    )
    .bind(payload.scope.installationId, payload.scope.owner, payload.scope.repo, payload.scope.prNumber, payload.headSha)
    .first<{ present: number }>();
  if (stored === null) {
    const store = createArtifactStore(db);
    await store.put(payload.artifact);
  }

  // Step 2 — the lifecycle writes in db.batches of at most
  // LIFECYCLE_APPLY_BATCH_STATEMENTS statements each (§7.11.1: "Local apply
  // batches ≤25 row transitions each; a larger payload is resumed
  // idempotently with applied-publication/association IDs, never marks
  // complete early"). Every statement is replay-safe (the guards above), so
  // a crash between batches resumes on the next recovery pass — applied
  // transitions skip and the applied mark stays the FINAL statement of the
  // FINAL batch, under the lease. Small payloads (the common case) still
  // run as ONE batch. The guard above narrowed `payload.lifecycle` to
  // non-null; it is passed explicitly so the helper's signature carries
  // that invariant.
  const statements = lifecycleApplyBatch(db, row, payload, payload.lifecycle, nowMs, lease);
  const results: D1BatchResult[] = [];
  for (let start = 0; start < statements.length; start += LIFECYCLE_APPLY_BATCH_STATEMENTS) {
    // Per-chunk fence (§7.11.1): the apply may span a real time window, and
    // once the 120s lease expires another invocation can claim a NEWER epoch.
    // Re-prove the SAME live holder/epoch before this chunk writes, so a
    // stale invocation stops instead of mutating findings/rounds/associations
    // under an ownership it no longer holds. The final chunk still carries
    // the applied mark as its last statement — its SQL re-checks the same
    // predicate, so a replacement mid-chunk can never mark complete.
    if (!(await publicationLeaseIsLive(db, id, lease, nowAt()))) return false;
    results.push(...(await db.batch(statements.slice(start, start + LIFECYCLE_APPLY_BATCH_STATEMENTS))));
  }
  const applied = results[results.length - 1]!;
  return applied.meta.changes > 0;
}

/**
 * The ATOMIC live-lease fence (§7.11.1: "All local updates require
 * `(id,holder,lease_epoch,lease_until_ms > now)`"). Every lifecycle
 * mutation statement of a chunked apply carries this predicate INLINE, so
 * the fence is evaluated by the same statement (and therefore the same
 * transaction) that performs the mutation. A read probe before the batch
 * cannot prove this: a replacement or expiry landing after the probe would
 * otherwise be invisible to the writes. Binds, in order:
 * `(publicationId, holder, leaseEpoch, now)`.
 */
const APPLY_LEASE_GUARD_SQL = `EXISTS (SELECT 1 FROM review_publications AS apply_lease
       WHERE apply_lease.id = ? AND apply_lease.holder = ? AND apply_lease.lease_epoch = ?
         AND apply_lease.lease_until_ms IS NOT NULL AND apply_lease.lease_until_ms > ?)`;

/**
 * The live-lease fence probe (§7.11.1) — the read twin of the applied
 * marker's SQL predicate: the publication row must still carry the SAME
 * holder and epoch with an UNEXPIRED lease at `nowMs`. Returns false when
 * the row is gone, replaced, or expired, which aborts the apply before the
 * next chunk writes. It is a chunk-boundary liveness check only; the
 * mutation statements carry the same predicate themselves.
 */
async function publicationLeaseIsLive(db: D1Like, id: string, lease: Lease, nowMs: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT holder, lease_epoch, lease_until_ms FROM review_publications WHERE id = ?`)
    .bind(id)
    .first<{ holder: string | null; lease_epoch: number; lease_until_ms: number | null }>();
  if (row === null) return false;
  return (
    row.holder === lease.holder &&
    row.lease_epoch === lease.epoch &&
    row.lease_until_ms !== null &&
    row.lease_until_ms > nowMs
  );
}

/**
 * The conditional applied-mark STATEMENT: requires the FULL live lease
 * (`holder` + `lease_epoch` + `lease_until_ms > now`, not holder/epoch
 * alone) AND a persisted proof AND the confirmed phase; clears the lease on
 * success. The expiry predicate is part of this statement, so an expired
 * same-holder lease — and a lease that expires or is replaced between the
 * pre-apply probe and this marker — can never mark the publication applied.
 */
function markPublicationApplied(db: D1Like, id: string, lease: Lease, nowMs: number): D1StatementLike {
  return db
    .prepare(
      `UPDATE review_publications
       SET phase = 'applied', applied_ms = ?, updated_ms = ?, recovery_state = 'done',
           holder = NULL, lease_until_ms = NULL
       WHERE id = ? AND holder = ? AND lease_epoch = ? AND phase = 'confirmed' AND proof_json IS NOT NULL
         AND lease_until_ms IS NOT NULL AND lease_until_ms > ?`,
    )
    .bind(nowMs, nowMs, id, lease.holder, lease.epoch, nowMs);
}

/**
 * The §7.2 state machine as ONE batch (knowledge `d1-batch-atomicity`).
 * Order inside the batch matters and is replay-safe:
 *   1. Seen upserts — new rows insert open at the current time; existing
 *      rows update last-seen tracking; a row closed (addressed/dismissed)
 *      under an OLDER publication reopens with reopen_count+1 ("retain
 *      original and assessment history"); rows already updated by THIS
 *      publication (replay) are skipped by the last_publication guard.
 *   2. Per assessment — state transition (addressed/dismissed closes,
 *      unverifiable/identity-drift keeps the row open) guarded by the
 *      rounds row NOT existing yet, then the round-history insert
 *      (ON CONFLICT DO NOTHING) as the durable replay marker.
 *   3. Per line intent — supersede all OLDER associations of that concern
 *      (marker only: their remote state is preserved, never
 *      unresolve/re-resolved), then insert the preallocated association
 *      intent (ON CONFLICT DO NOTHING).
 *   4. Per selected row — advance last_scheduled_ms (fair rotation),
 *      monotonic so a replay can never move a row backwards.
 *   5. Mark applied under the lease (final statement).
 *
 * EVERY statement above carries `APPLY_LEASE_GUARD_SQL` inline: the write
 * is conditional on the SAME live lease predicate in its own SQL, so a
 * replacement or expiry that lands after a read probe but before (or at)
 * the mutation cannot slip a finding/round/association write through. The
 * guard binds are the LAST four parameters of each statement, in the order
 * `(publicationId, holder, leaseEpoch, operationNow)`.
 */
function lifecycleApplyBatch(
  db: D1Like,
  row: ReviewPublicationRow,
  payload: PublicationPayload,
  /** The caller-narrowed non-null `payload.lifecycle` (review kind only). */
  lifecycle: LifecycleRound,
  nowMs: number,
  lease: Lease,
): D1StatementLike[] {
  const pubId = row.id;
  const headSha = payload.headSha;
  const round = payload.round;
  const scope = payload.scope;
  const guard = [pubId, lease.holder, lease.epoch, nowMs] as const;
  const statements: D1StatementLike[] = [];

  // 1. Seen upserts — recurrence reopen + last-seen tracking.
  for (const seen of lifecycle.seen) {
    statements.push(
      db
        .prepare(
          `INSERT INTO review_findings
             (id, app_id, installation_id, owner, repo, pr_number, finding_id, original_json,
              first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
              first_seen_round, last_seen_round, state, created_ms, updated_ms)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?
           WHERE ${APPLY_LEASE_GUARD_SQL}
           ON CONFLICT(app_id, installation_id, owner, repo, pr_number, finding_id) DO UPDATE SET
             last_publication_id = excluded.last_publication_id,
             last_seen_sha = excluded.last_seen_sha,
             last_seen_round = excluded.last_seen_round,
             updated_ms = excluded.updated_ms,
             state = CASE WHEN review_findings.state <> 'open' THEN 'open' ELSE review_findings.state END,
             reopen_count = CASE WHEN review_findings.state <> 'open'
                                 THEN review_findings.reopen_count + 1
                                 ELSE review_findings.reopen_count END,
             last_scheduled_ms = CASE WHEN review_findings.state <> 'open'
                                      THEN excluded.updated_ms
                                      ELSE review_findings.last_scheduled_ms END
           WHERE review_findings.last_publication_id <> excluded.last_publication_id`,
        )
        .bind(
          seen.rowId, scope.appId, scope.installationId, scope.owner, scope.repo,
          scope.prNumber, seen.findingId, JSON.stringify(seen.original),
          pubId, pubId, headSha, headSha, round, round, nowMs, nowMs,
          ...guard,
        ),
    );
  }

  // 2. Assessments — state transition + round history (replay marker).
  for (const assessment of lifecycle.assessments) {
    const assessmentJson = JSON.stringify(assessment);
    statements.push(
      db
        .prepare(
          `UPDATE review_findings
           SET state = CASE WHEN ? = 'addressed' THEN 'addressed'
                            WHEN ? = 'dismissed' THEN 'dismissed'
                            ELSE state END,
               last_assessment_json = ?, last_assessed_ms = ?
           WHERE id = ?
             AND NOT EXISTS (SELECT 1 FROM review_finding_rounds
                             WHERE finding_row_id = ? AND publication_id = ?)
             AND ${APPLY_LEASE_GUARD_SQL}`,
        )
        .bind(
          assessment.disposition, assessment.disposition,
          assessmentJson, nowMs, assessment.rowId, assessment.rowId, pubId,
          ...guard,
        ),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO review_finding_rounds
             (id, finding_row_id, publication_id, head_sha, round, assessment_json, created_ms)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE ${APPLY_LEASE_GUARD_SQL}
           ON CONFLICT(finding_row_id, publication_id) DO NOTHING`,
        )
        .bind(crypto.randomUUID(), assessment.rowId, pubId, headSha, round, assessmentJson, nowMs, ...guard),
    );
  }

  // 3. Association supersede + preallocated intent inserts.
  const supersededFindings = new Set<string>();
  for (const intent of payload.lineIntents) {
    if (supersededFindings.has(intent.findingRowId)) continue;
    supersededFindings.add(intent.findingRowId);
    statements.push(
      db
        .prepare(
          `UPDATE review_threads
           SET superseded_by_publication_id = ?, updated_ms = ?
           WHERE finding_row_id = ? AND publication_id <> ? AND superseded_by_publication_id IS NULL
             AND ${APPLY_LEASE_GUARD_SQL}`,
        )
        .bind(pubId, nowMs, intent.findingRowId, pubId, ...guard),
    );
  }
  for (const intent of payload.lineIntents) {
    statements.push(
      db
        .prepare(
          `INSERT INTO review_threads
             (id, finding_row_id, publication_id, app_id, installation_id, owner, repo, pr_number,
              original_sha, round, intent_json, resolution_state, created_ms, updated_ms)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
           WHERE ${APPLY_LEASE_GUARD_SQL}
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          intent.associationId, intent.findingRowId, pubId,
          scope.appId, scope.installationId, scope.owner, scope.repo, scope.prNumber,
          intent.originalSha, intent.round, JSON.stringify(intent), nowMs, nowMs,
          ...guard,
        ),
    );
  }

  // 4. Fair-rotation scheduling for every selected target (monotonic).
  for (const rowId of lifecycle.selectedRowIds) {
    statements.push(
      db
        .prepare(
          `UPDATE review_findings SET last_scheduled_ms = ?
           WHERE id = ? AND (last_scheduled_ms IS NULL OR last_scheduled_ms < ?)
             AND ${APPLY_LEASE_GUARD_SQL}`,
        )
        .bind(nowMs, rowId, nowMs, ...guard),
    );
  }

  // 5. Mark applied under the lease — final statement, atomic with the above.
  statements.push(markPublicationApplied(db, row.id, lease, nowMs));
  return statements;
}

// ---------------------------------------------------------------------------
// Recovery readers (spec §7.11.1) — M8-only surfaces
// ---------------------------------------------------------------------------

/**
 * Publication recovery selection (M8 only): recovery pending, due, lease
 * free/expired, attempts under the cap; ordered by due/created/id. Phase is
 * deliberately NOT filtered — the reconciler decides per phase (prepared →
 * send, sending/unknown → read-only discovery, confirmed → apply).
 */
export async function listPublicationRecovery(db: D1Like, nowMs: number, limit: number): Promise<PublicationRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM review_publications
       WHERE recovery_state = 'pending' AND attempts < ?
         AND (next_attempt_ms IS NULL OR next_attempt_ms <= ?)
         AND (lease_until_ms IS NULL OR lease_until_ms <= ?)
       ORDER BY COALESCE(next_attempt_ms, created_ms), id
       LIMIT ?`,
    )
    .bind(LIFECYCLE_MAX_ATTEMPTS, nowMs, nowMs, limit)
    .all<ReviewPublicationRow>();
  return rows.results.map(publicationRowOf);
}

/**
 * Resolution-queue selection (M8 only): associations with a stored verified
 * snapshot, not superseded, due, lease free, attempts under the cap —
 * oldest due/id first. Rows with no attempt yet (attempts = 0,
 * next_attempt_ms NULL) are due immediately: a crash before the first
 * resolve stays discoverable (spec §7.11.1).
 */
export async function listResolutionRecovery(
  db: D1Like,
  nowMs: number,
  limit: number,
): Promise<{ associationId: string; scope: Scope }[]> {
  const rows = await db
    .prepare(
      `SELECT id, app_id, installation_id, owner, repo, pr_number FROM review_threads
       WHERE resolution_state IN ('pending','retry') AND verified_json IS NOT NULL
         AND superseded_by_publication_id IS NULL AND attempts < ?
         AND (next_attempt_ms IS NULL OR next_attempt_ms <= ?)
         AND (lease_until_ms IS NULL OR lease_until_ms <= ?)
       ORDER BY COALESCE(next_attempt_ms, created_ms), id
       LIMIT ?`,
    )
    .bind(LIFECYCLE_MAX_ATTEMPTS, nowMs, nowMs, limit)
    .all<{ id: string; app_id: string; installation_id: number; owner: string; repo: string; pr_number: number }>();
  return rows.results.map(threadScope);
}

/**
 * Operator-only, row-scoped retry (spec §7.11.1): exactly ONE work ID with
 * the matching complete scope and no live lease; resets attempts/due/error
 * state while retaining payload, proof, remote IDs, the verified snapshot
 * and the lease epochs. Publication phase is retained (a definitively
 * failed send is not re-sent by recovery); a needs-recheck / abandoned /
 * resolved association is NOT resurrectable — that would waive the
 * ownership/HEAD/conversation gates.
 */
export async function retryLifecycleWork(
  db: D1Like,
  input: { scope: Scope; publicationId?: string; associationId?: string; nowMs: number },
): Promise<boolean> {
  const hasPublication = input.publicationId !== undefined;
  const hasAssociation = input.associationId !== undefined;
  if (hasPublication === hasAssociation) return false; // exactly one work ID required

  const scopeGuard = "app_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?";
  const scopeBinds = [input.scope.appId, input.scope.installationId, input.scope.owner, input.scope.repo, input.scope.prNumber];
  const freeLease = "(lease_until_ms IS NULL OR lease_until_ms <= ?)";

  if (hasPublication) {
    const result = await db
      .prepare(
        `UPDATE review_publications
         SET attempts = 0, next_attempt_ms = NULL, last_error = NULL, recovery_state = 'pending', updated_ms = ?
         WHERE id = ? AND ${scopeGuard} AND ${freeLease}`,
      )
      .bind(input.nowMs, input.publicationId!, ...scopeBinds, input.nowMs)
      .run();
    return result.meta.changes > 0;
  }

  const result = await db
    .prepare(
      `UPDATE review_threads
       SET attempts = 0, next_attempt_ms = NULL, last_error = NULL, resolution_state = 'retry', updated_ms = ?
       WHERE id = ? AND ${scopeGuard} AND ${freeLease}
         AND resolution_state IN ('pending','retry','local-error','suspended')`,
    )
    .bind(input.nowMs, input.associationId!, ...scopeBinds, input.nowMs)
    .run();
  return result.meta.changes > 0;
}

// ---------------------------------------------------------------------------
// §7.11.1 recovery bookkeeping writers (the M8 lane) — the
// post-failure state machine the reconciler drives: backoff after failed
// attempts, the terminal local-error at the attempt cap, supersede on
// newer-round evidence, App-lifecycle suspension and exact-App re-enable,
// and the needs-recheck stop state for the resolution lane. Bookkeeping
// NEVER resets `attempts` (§7.11.1: "resets attempts only for a genuinely
// new assessment, never for bookkeeping") and never deletes a row.
// ---------------------------------------------------------------------------

/** Bound a durable reason string — structured, no payload/secret content. */
function recoveryReason(reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim();
  return clean.length <= 300 ? clean : `${clean.slice(0, 299)}…`;
}

/**
 * Why a pair's recovery rows are suspended (spec §7.6 / P67-QC-007). The
 * distinction is load-bearing: a `disabled` App resumes automatically once
 * its row is active again (status-driven), while an `identity-mismatch`
 * pair must NOT return to `pending` until a successful exact-App identity
 * proof follows the credential correction — otherwise every cron pass
 * re-enables it, re-discovers the same mismatch and re-suspends it.
 */
export type SuspensionKind = "disabled" | "identity-mismatch" | "missing" | "deleted" | "decrypt-failed" | "unknown";

const SUSPENSION_PREFIX = "suspend:";
/** Token carrying the credential-envelope fingerprint inside the reason. */
const CREDENTIAL_TOKEN = "cred=";

/**
 * Encode the suspension kind in the durable `last_error` text. The column is
 * the only per-row reason carrier (§7.1 DDL), so the kind rides a stable,
 * machine-checkable prefix; the human-readable detail stays after it.
 * `credentialFingerprint` is a SHA-256 of the ENCRYPTED credential envelope
 * (never of the plaintext key) and carries no secret — it exists purely so a
 * later pass can tell "same credentials, same mismatch" from "the operator
 * corrected the credentials", which is what keeps identity-mismatch
 * suspension durable without re-proving it on every cron pass.
 */
export function suspensionReasonOf(kind: SuspensionKind, text: string, credentialFingerprint?: string): string {
  const suffix = credentialFingerprint === undefined ? "" : ` ${CREDENTIAL_TOKEN}${credentialFingerprint}`;
  return `${SUSPENSION_PREFIX}${kind}: ${text}${suffix}`;
}

/**
 * Read back the credential fingerprint recorded at suspension time, or null
 * when none was recorded (missing mapping, a legacy row, or a suspension
 * written before this encoding).
 */
export function suspensionCredentialOf(lastError: string | null): string | null {
  if (lastError === null) return null;
  const match = /(?:^|\s)cred=([0-9a-f]{64})(?:\s|$)/.exec(lastError);
  return match?.[1] ?? null;
}

/**
 * Read back the suspension kind from a durable reason. Anything unrecognized
 * (legacy rows written before this encoding, or free-text operator notes) is
 * `unknown` — treated exactly like a non-status-driven suspension, so an
 * unclassifiable pair never auto-re-enables without an identity proof.
 */
export function suspensionKindOf(lastError: string | null): SuspensionKind {
  if (lastError === null || !lastError.startsWith(SUSPENSION_PREFIX)) return "unknown";
  const rest = lastError.slice(SUSPENSION_PREFIX.length);
  const colon = rest.indexOf(":");
  const kind = colon === -1 ? rest : rest.slice(0, colon);
  switch (kind) {
    case "disabled":
    case "identity-mismatch":
    case "missing":
    case "deleted":
    case "decrypt-failed":
      return kind;
    default:
      return "unknown";
  }
}

/** Free-lease predicate bound to a now parameter position. */
const FREE_LEASE_SQL = "(lease_until_ms IS NULL OR lease_until_ms <= ?)";

/**
 * Degraded-cleanup gate (spec §7.7 step 11: "Cleanup must not delete the
 * only unconfirmed degraded-publication evidence"). The remote body match is
 * the ONLY recovery channel for a degraded send whose proof was lost
 * (`discoverUncertainPublication`), so deleting that comment while its
 * journal row is still non-terminal would make the publication permanently
 * unprovable. Returns true when ANY degraded row for this exact scope still
 * sits in `prepared`/`sending`/`unknown` without persisted proof — the
 * caller then SKIPS the delete and leaves the evidence in place.
 *
 * `phase='failed'` is excluded on purpose: a definitively rejected degraded
 * notice was never published, so it has no remote evidence to preserve.
 */
export async function hasUnprovenDegradedPublication(db: D1Like, scope: Scope): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM review_publications
       WHERE app_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
         AND kind = 'degraded' AND proof_json IS NULL
         AND phase IN ('prepared','sending','unknown')
       LIMIT 1`,
    )
    .bind(scope.appId, scope.installationId, scope.owner, scope.repo, scope.prNumber)
    .first<{ id: string }>();
  return row !== null;
}

/**
 * The `created_ms` of a publication row — the §7.11.1 prepared-send age gate.
 */
export async function getPublicationCreatedMs(db: D1Like, id: string): Promise<number | null> {
  const row = await db
    .prepare(`SELECT created_ms FROM review_publications WHERE id = ?`)
    .bind(id)
    .first<{ created_ms: number }>();
  return row?.created_ms ?? null;
}

/**
 * Release the live lease and schedule the next recovery attempt (backoff)
 * after a failed attempt on a CONFIRMED row (local-apply failure — the
 * phase is retained). Phase-preserving by design: a confirmed publication
 * that failed its local apply stays confirmed.
 */
export async function deferPublicationRecovery(
  db: D1Like,
  id: string,
  lease: Lease,
  nextAttemptMs: number,
  reason: string,
  nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE review_publications
       SET next_attempt_ms = ?, last_error = ?, holder = NULL, lease_until_ms = NULL, updated_ms = ?
       WHERE id = ? AND holder = ? AND lease_epoch = ?`,
    )
    .bind(nextAttemptMs, recoveryReason(reason), nowMs, id, lease.holder, lease.epoch)
    .run();
  return result.meta.changes > 0;
}

/**
 * Undo a claim whose send never reached GitHub (spec §7.11.1). The run
 * transport refuses a request BEFORE dispatch once the request allowance is
 * spent; when that refusal lands inside an already-claimed publication send,
 * the claim is pure bookkeeping (one attempt counted, phase moved
 * `prepared`→`sending`) wrapped around work that never happened. This
 * restores the exact pre-claim send state — `prepared` again, due (no
 * `next_attempt_ms`), lease released, the attempt returned — so the
 * publication stays retryable by the next run.
 *
 * The phase this row must NOT take is `unknown`: that means a send MAY have
 * landed and is reserved for post-attempt uncertainty (§7.7), so recording a
 * never-dispatched send there would strand a retryable publication behind
 * read-only discovery permanently. A budget refusal is likewise not one of
 * the 5 attempts: exhaustion is an admission outcome, not a failed send.
 *
 * Fenced on the live claim (`holder` + `lease_epoch`) and `phase='sending'`,
 * so a row another invocation already moved (confirmed/failed/unknown) is
 * left untouched — `false` tells the caller to report the unexpected state
 * instead of assuming the restore applied. `lease_epoch` is deliberately not
 * rewound: epochs are monotonic fencing tokens, and reusing one would let a
 * stale holder win a later claim.
 */
export async function releaseUnspentPublicationClaim(
  db: D1Like,
  id: string,
  lease: Lease,
  nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE review_publications
       SET phase = 'prepared', attempts = attempts - 1,
           holder = NULL, lease_until_ms = NULL, updated_ms = ?
       WHERE id = ? AND holder = ? AND lease_epoch = ?
         AND phase = 'sending' AND attempts > 0`,
    )
    .bind(nowMs, id, lease.holder, lease.epoch)
    .run();
  return result.meta.changes > 0;
}

/**
 * After an UNCERTAIN send/discovery attempt (spec §7.7 "Remote unknowns"):
 * the row becomes phase `unknown` (from `sending`) — the payload is retained
 * and ONLY read-only discovery may touch it — plus backoff and the released
 * lease. An already-`unknown` row stays unknown.
 */
export async function markPublicationUnknown(
  db: D1Like,
  id: string,
  lease: Lease,
  nextAttemptMs: number,
  reason: string,
  nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE review_publications
       SET phase = CASE WHEN phase = 'sending' THEN 'unknown' ELSE phase END,
           next_attempt_ms = ?, last_error = ?, holder = NULL, lease_until_ms = NULL, updated_ms = ?
       WHERE id = ? AND holder = ? AND lease_epoch = ?`,
    )
    .bind(nextAttemptMs, recoveryReason(reason), nowMs, id, lease.holder, lease.epoch)
    .run();
  return result.meta.changes > 0;
}

/**
 * The definitive pre-send rejection (spec §7.7 "A known definitive rejection
 * before any successful/unknown send is failed, not published"): the staged
 * row is marked `phase='failed'` under the live lease, which is exactly what
 * separates it from the post-attempt `unknown`. The complete payload, its
 * digest, the attempt count and the epoch history are RETAINED so operator
 * inspection still works; only the lease is released. Recovery never re-sends
 * a failed row (`reconcilePublications` skips the phase) — a re-send would be
 * the blind second create §7.7 forbids. Returns whether the transition
 * applied.
 */
export async function markPublicationFailed(
  db: D1Like,
  id: string,
  lease: Lease,
  reason: string,
  nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE review_publications
       SET phase = 'failed', last_error = ?, holder = NULL, lease_until_ms = NULL, updated_ms = ?
       WHERE id = ? AND holder = ? AND lease_epoch = ?
         AND phase IN ('prepared','sending','unknown')`,
    )
    .bind(recoveryReason(reason), nowMs, id, lease.holder, lease.epoch)
    .run();
  return result.meta.changes > 0;
}

/**
 * The attempt cap (spec §7.11.1: "at 5 failures → local-error/unknown
 * retained with structured warning containing App/scope/work ID and reason,
 * no payload/secret"): the row is retained for operator inspection with a
 * durable local-error, lease released, phase unchanged (unknown stays
 * unknown; prepared/confirmed stay theirs — the operator sees the real
 * phase).
 */
export async function markPublicationLocalError(
  db: D1Like,
  id: string,
  lease: Lease,
  reason: string,
  nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE review_publications
       SET recovery_state = 'local-error', last_error = ?, holder = NULL, lease_until_ms = NULL, updated_ms = ?
       WHERE id = ? AND holder = ? AND lease_epoch = ?`,
    )
    .bind(recoveryReason(reason), nowMs, id, lease.holder, lease.epoch)
    .run();
  return result.meta.changes > 0;
}

/**
 * A newer publication round already owns the PR surface (read-only
 * pre-send evidence): "Never send a stale initial publication over a newer
 * round" (§7.11.1). The row becomes phase `superseded` — terminal, no
 * publication, no closure — with recovery `done` (nothing left to recover)
 * and its lease released. Guarded to non-terminal phases and a FREE lease:
 * a row another invocation holds is never yanked mid-send.
 */
export async function supersedePublication(db: D1Like, id: string, reason: string, nowMs: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE review_publications
       SET phase = 'superseded', recovery_state = 'done', last_error = ?,
           holder = NULL, lease_until_ms = NULL, updated_ms = ?
       WHERE id = ? AND phase IN ('prepared','sending','unknown','confirmed') AND ${FREE_LEASE_SQL}`,
    )
    .bind(recoveryReason(reason), nowMs, id, nowMs)
    .run();
  return result.meta.changes > 0;
}

/**
 * Durable App-lifecycle suspension (spec §7.6/§7.11.1): missing mapping,
 * disabled or deleted App — every pending recovery row of the EXACT
 * `(app_id, installation_id)` pair stops (no cross-App substitution), lease
 * released, attempts untouched. Returns the number of suspended rows.
 */
export async function suspendPublicationRecovery(
  db: D1Like,
  pair: { appId: string; installationId: number },
  input: { kind: SuspensionKind; reason: string; credentialFingerprint?: string },
  nowMs: number,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE review_publications
       SET recovery_state = 'suspended', last_error = ?, holder = NULL, lease_until_ms = NULL, updated_ms = ?
       WHERE app_id = ? AND installation_id = ? AND recovery_state IN ('pending','suspended') AND ${FREE_LEASE_SQL}`,
    )
    .bind(
      suspensionReasonOf(input.kind, recoveryReason(input.reason), input.credentialFingerprint),
      nowMs,
      pair.appId,
      pair.installationId,
      nowMs,
    )
    .run();
  return result.meta.changes;
}

/** The thread-lane twin of `suspendPublicationRecovery`. */
export async function suspendResolutionRecovery(
  db: D1Like,
  pair: { appId: string; installationId: number },
  input: { kind: SuspensionKind; reason: string; credentialFingerprint?: string },
  nowMs: number,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE review_threads
       SET resolution_state = 'suspended', last_error = ?, holder = NULL, lease_until_ms = NULL, updated_ms = ?
       WHERE app_id = ? AND installation_id = ? AND resolution_state IN ('pending','retry','suspended') AND ${FREE_LEASE_SQL}`,
    )
    .bind(
      suspensionReasonOf(input.kind, recoveryReason(input.reason), input.credentialFingerprint),
      nowMs,
      pair.appId,
      pair.installationId,
      nowMs,
    )
    .run();
  return result.meta.changes;
}

/**
 * Distinct suspended `(app_id, installation_id)` pairs across both lanes,
 * bounded — the re-enable probe input (§7.11.1: "Suspended rows are checked
 * for exact-App re-enable before returning to pending"). `requiresIdentityProof`
 * is true when ANY of the pair's suspended rows was suspended for a reason
 * other than a disabled App (identity mismatch, missing mapping, deleted App,
 * decrypt failure, or a legacy/unclassifiable reason): the §7.6 policy allows
 * the status-driven resume for a genuinely re-enabled App, but every other
 * kind must stay suspended until a successful exact-App identity proof
 * (P67-QC-007) — otherwise each pass re-enables the pair, rediscovers the same
 * mismatch and re-suspends it.
 *
 * `credentialFingerprint` is the encrypted-envelope digest recorded when the
 * pair was suspended, or null when none was recorded / the rows disagree. It
 * lets the caller skip the identity probe entirely while the credentials are
 * demonstrably unchanged (no remote work, no churn) and prove identity only
 * after an operator credential correction.
 */
export async function listSuspendedLifecycleApps(
  db: D1Like,
  limit: number,
): Promise<
  { appId: string; installationId: number; requiresIdentityProof: boolean; credentialFingerprint: string | null }[]
> {
  const pubs = await db
    .prepare(
      `SELECT DISTINCT app_id, installation_id, last_error FROM review_publications
       WHERE recovery_state = 'suspended' LIMIT ?`,
    )
    .bind(limit)
    .all<{ app_id: string; installation_id: number; last_error: string | null }>();
  const threads = await db
    .prepare(
      `SELECT DISTINCT app_id, installation_id, last_error FROM review_threads
       WHERE resolution_state = 'suspended' LIMIT ?`,
    )
    .bind(limit)
    .all<{ app_id: string; installation_id: number; last_error: string | null }>();
  type Merged = {
    appId: string;
    installationId: number;
    requiresIdentityProof: boolean;
    credentialFingerprint: string | null;
    conflicting: boolean;
  };
  const merged = new Map<string, Merged>();
  for (const row of [...pubs.results, ...threads.results]) {
    const key = `${row.app_id}:${row.installation_id}`;
    const existing = merged.get(key);
    const recorded = suspensionCredentialOf(row.last_error);
    let credentialFingerprint = existing?.credentialFingerprint ?? null;
    let conflicting = existing?.conflicting ?? false;
    if (recorded !== null) {
      if (credentialFingerprint === null) credentialFingerprint = recorded;
      else if (credentialFingerprint !== recorded) conflicting = true;
    }
    merged.set(key, {
      appId: row.app_id,
      installationId: row.installation_id,
      requiresIdentityProof: (existing?.requiresIdentityProof ?? false) || suspensionKindOf(row.last_error) !== "disabled",
      credentialFingerprint,
      conflicting,
    });
  }
  return [...merged.values()].slice(0, limit).map((entry) => ({
    appId: entry.appId,
    installationId: entry.installationId,
    requiresIdentityProof: entry.requiresIdentityProof,
    // Disagreeing records prove nothing about the current credentials —
    // null forces the identity proof instead of allowing a status-only resume.
    credentialFingerprint: entry.conflicting ? null : entry.credentialFingerprint,
  }));
}

/**
 * Exact-App re-enable (spec §7.6: "Re-enable allows due suspended rows to
 * resume with the same IDs and fresh fencing"): the caller has re-verified
 * the pair's App is active and not deleted. Rows resume with cleared leases
 * and due immediately; payloads/proofs/remote ids/verified snapshots are
 * retained. Threads resume as `retry`, publications as `pending`.
 */
export async function reenableLifecycleForApps(
  db: D1Like,
  pairs: { appId: string; installationId: number }[],
  nowMs: number,
): Promise<void> {
  for (const pair of pairs) {
    await db
      .prepare(
        `UPDATE review_publications
         SET recovery_state = 'pending', next_attempt_ms = NULL, last_error = NULL,
             holder = NULL, lease_until_ms = NULL, updated_ms = ?
         WHERE app_id = ? AND installation_id = ? AND recovery_state = 'suspended'`,
      )
      .bind(nowMs, pair.appId, pair.installationId)
      .run();
    await db
      .prepare(
        `UPDATE review_threads
         SET resolution_state = 'retry', next_attempt_ms = NULL, last_error = NULL,
             holder = NULL, lease_until_ms = NULL, updated_ms = ?
         WHERE app_id = ? AND installation_id = ? AND resolution_state = 'suspended'`,
      )
      .bind(nowMs, pair.appId, pair.installationId)
      .run();
  }
}

/**
 * The full recovery-relevant view of one resolution-queue row (M8): the
 * stored verified snapshot to re-drive §7.5 with, the attempts counter for
 * backoff/give-up decisions, and the authenticated scope. Null when the row
 * is gone.
 */
export async function getResolutionRecoveryRow(
  db: D1Like,
  id: string,
): Promise<{ scope: Scope; verifiedJson: string; attempts: number } | null> {
  const row = await db
    .prepare(
      `SELECT app_id, installation_id, owner, repo, pr_number, verified_json, attempts
       FROM review_threads WHERE id = ?`,
    )
    .bind(id)
    .first<{
      app_id: string; installation_id: number; owner: string; repo: string;
      pr_number: number; verified_json: string | null; attempts: number;
    }>();
  if (row === null || row.verified_json === null) return null;
  return {
    scope: {
      appId: row.app_id, installationId: row.installation_id,
      owner: row.owner, repo: row.repo, prNumber: row.pr_number,
    },
    verifiedJson: row.verified_json,
    attempts: row.attempts,
  };
}

/**
 * A needs-recheck resolve outcome (HEAD/conversation/context mismatch —
 * spec §7.11.1: "no blind retry at a new snapshot"): the association stops
 * cycling through the recovery selectors while the old concern stays
 * untouched for the next real review. The next real review's fresh
 * assessment re-enqueues it with a new publication id.
 */
export async function recordNeedsRecheck(db: D1Like, id: string, reason: string, nowMs: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE review_threads
       SET resolution_state = 'needs-recheck', last_error = ?, next_attempt_ms = NULL,
           holder = NULL, lease_until_ms = NULL, updated_ms = ?
       WHERE id = ? AND resolution_state IN ('pending','retry') AND ${FREE_LEASE_SQL}`,
    )
    .bind(recoveryReason(reason), nowMs, id, nowMs)
    .run();
  return result.meta.changes > 0;
}

/**
 * Backoff after a failed resolve attempt (the §7.5 surface already released
 * the lease and retained `retry`): schedule the next attempt, keep the
 * durable reason. Bookkeeping only — attempts are never reset here.
 */
export async function deferResolutionRecovery(
  db: D1Like,
  id: string,
  nextAttemptMs: number,
  reason: string,
  nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE review_threads
       SET next_attempt_ms = ?, last_error = ?, holder = NULL, lease_until_ms = NULL, updated_ms = ?
       WHERE id = ? AND resolution_state IN ('pending','retry') AND ${FREE_LEASE_SQL}`,
    )
    .bind(nextAttemptMs, recoveryReason(reason), nowMs, id, nowMs)
    .run();
  return result.meta.changes > 0;
}

/**
 * The resolution-lane attempt cap (spec §7.11.1): a terminal, VISIBLE
 * local-error with the structured App/scope/work-ID + reason line — the row
 * is retained (never deleted); only the operator retry reopens it.
 */
export async function markResolutionLocalError(db: D1Like, id: string, reason: string, nowMs: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE review_threads
       SET resolution_state = 'local-error', last_error = ?, next_attempt_ms = NULL,
           holder = NULL, lease_until_ms = NULL, updated_ms = ?
       WHERE id = ? AND resolution_state IN ('pending','retry') AND ${FREE_LEASE_SQL}`,
    )
    .bind(recoveryReason(reason), nowMs, id, nowMs)
    .run();
  return result.meta.changes > 0;
}

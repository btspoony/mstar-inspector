/**
 * Finding lifecycle store (plan 67 Task 1, spec review-lifecycle §7.1/§7.2/
 * §7.7/§7.11.1) — durable lifecycle rows, fair rotation, the private
 * pre-publication journal and the resolution-queue accessors.
 *
 * Module boundary (the artifact-store precedent): `db` is the narrow D1
 * face (`D1Like`); imports are the store layer (types / artifact-store) and
 * the zero-dependency recheck wire contract only — NO worker/pipeline
 * dependencies. Every query binds the complete authenticated scope
 * `(appId, installationId, owner, repo, prNumber)` (spec §7.0); every
 * multi-row transition is ONE `db.batch` (knowledge `d1-batch-atomicity`:
 * D1 batch is the transaction primitive); claims use conditional SQL and
 * inspect `meta.changes` — no KV CAS assumption. Timestamps are integer
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
 * `parseLineMarker` / discovery / resolution) belong to plan 67 Task 2's
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
 * does not duplicate findings), then (2) ONE `db.batch` upserting
 * `review_findings` / `review_finding_rounds` / `review_threads` with the
 * §7.2 state machine, whose FINAL statement marks the publication applied
 * under the lease (atomic with the batch). Degraded proof creates no
 * normal review/lifecycle rows — it only marks applied. Rows absent from
 * `seen` are never deleted. Returns false (and writes nothing) when the
 * row is unknown, the lease is not live, proof is missing, or the payload
 * is not a complete review publication; the previously-applied row
 * short-circuits to true (idempotent replay).
 */
export async function applyPublishedLifecycle(db: D1Like, id: string, lease: Lease, nowMs: number): Promise<boolean> {
  const row = await db.prepare(`SELECT * FROM review_publications WHERE id = ?`).bind(id).first<ReviewPublicationRow>();
  if (row === null) return false;
  if (row.phase === "applied") return true; // idempotent replay — nothing left to apply
  // Live lease fence (holder + epoch + unexpired) and positive persisted proof.
  if (row.holder !== lease.holder || row.lease_epoch !== lease.epoch) return false;
  if (row.lease_until_ms === null || row.lease_until_ms <= nowMs) return false;
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
  const store = createArtifactStore(db);
  await store.put(payload.artifact);

  // Step 2 — ONE lifecycle batch, ending with the applied mark under the
  // lease (all-or-nothing with the lifecycle writes it guards).
  const statements = lifecycleApplyBatch(db, row, payload, nowMs, lease);
  const results = await db.batch(statements);
  const applied = results[results.length - 1]!;
  return applied.meta.changes > 0;
}

/** The conditional applied-mark STATEMENT: requires the live lease AND a
 *  persisted proof AND the confirmed phase; clears the lease on success. */
function markPublicationApplied(db: D1Like, id: string, lease: Lease, nowMs: number): D1StatementLike {
  return db
    .prepare(
      `UPDATE review_publications
       SET phase = 'applied', applied_ms = ?, updated_ms = ?, recovery_state = 'done',
           holder = NULL, lease_until_ms = NULL
       WHERE id = ? AND holder = ? AND lease_epoch = ? AND phase = 'confirmed' AND proof_json IS NOT NULL`,
    )
    .bind(nowMs, nowMs, id, lease.holder, lease.epoch);
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
 */
function lifecycleApplyBatch(
  db: D1Like,
  row: ReviewPublicationRow,
  payload: PublicationPayload,
  nowMs: number,
  lease: Lease,
): D1StatementLike[] {
  const pubId = row.id;
  const headSha = payload.headSha;
  const round = payload.round;
  const scope = payload.scope;
  const lifecycle = payload.lifecycle;
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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
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
                             WHERE finding_row_id = ? AND publication_id = ?)`,
        )
        .bind(
          assessment.disposition, assessment.disposition,
          assessmentJson, nowMs, assessment.rowId, assessment.rowId, pubId,
        ),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO review_finding_rounds
             (id, finding_row_id, publication_id, head_sha, round, assessment_json, created_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(finding_row_id, publication_id) DO NOTHING`,
        )
        .bind(crypto.randomUUID(), assessment.rowId, pubId, headSha, round, assessmentJson, nowMs),
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
           WHERE finding_row_id = ? AND publication_id <> ? AND superseded_by_publication_id IS NULL`,
        )
        .bind(pubId, nowMs, intent.findingRowId, pubId),
    );
  }
  for (const intent of payload.lineIntents) {
    statements.push(
      db
        .prepare(
          `INSERT INTO review_threads
             (id, finding_row_id, publication_id, app_id, installation_id, owner, repo, pr_number,
              original_sha, round, intent_json, resolution_state, created_ms, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          intent.associationId, intent.findingRowId, pubId,
          scope.appId, scope.installationId, scope.owner, scope.repo, scope.prNumber,
          intent.originalSha, intent.round, JSON.stringify(intent), nowMs, nowMs,
        ),
    );
  }

  // 4. Fair-rotation scheduling for every selected target (monotonic).
  for (const rowId of lifecycle.selectedRowIds) {
    statements.push(
      db
        .prepare(
          `UPDATE review_findings SET last_scheduled_ms = ?
           WHERE id = ? AND (last_scheduled_ms IS NULL OR last_scheduled_ms < ?)`,
        )
        .bind(nowMs, rowId, nowMs),
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

/**
 * invariant: Finding lifecycle store (spec review-lifecycle §7.1/§7.2/
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
 * publication phase, and makes BOTH halves replay-safe (the artifact's review
 * and public-finding inserts are `ON CONFLICT DO NOTHING`; rounds and
 * association intents `ON CONFLICT DO NOTHING`; the seen upsert and the
 * scheduling update skip already-applied publications), so a replay — mid
 * artifact, after the artifact but before the lifecycle, or after the applied
 * marker — never duplicates a row and never increments `reopen_count` twice.
 */

import type { Assessment, Coverage, OriginalFinding, RecheckTarget, ThreadSnapshot } from "../../packages/shared/src/recheck-wire";
import { ASSESSMENT_TARGET_CAP } from "../../packages/shared/src/recheck-wire";
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
export type { Scope } from "../../packages/shared/src/recheck-wire";
import type { Scope } from "../../packages/shared/src/recheck-wire";

// note: §7.7 journal types — single normative copy lives in spec §7.7; this is the
// single CODE copy (the wire subset of §7.3 is exported from
// packages/shared/src/recheck-wire.ts instead — do not restate either).

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
  /** note: First line of a multi-line anchor; absent/null = the single-line anchor at `line`. */
  lineStart?: number | null;
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
  /**
   * note: The attempt that staged this publication (migration 0087's report uses it
   * to end that attempt's interval when a recovery lane completes the apply).
   * Optional: rows staged before this field existed carry none, and a recovery
   * completing one has no attempt to settle.
   */
  attemptId?: string;
  /**
   * invariant: §7.9a binding: the attempt this publication was ADMITTED under (the launch
   * row id), frozen into the staged payload. Later lanes resolve the launch
   * row's frozen `(attempt_key, generation)` from it — never "the newest Check
   * linked to the publication" — so send and recovery name the same identity.
   * Absent only on rows staged before this field existed; recovery refuses
   * those rather than falling back to a second identity.
   */
  admittedAttemptId?: string;
};

/** The phases a claimer may resume for: terminal rows are never claimable. */
export type PublicationClaimPhase = 'prepared' | 'sending' | 'unknown' | 'confirmed';

export type PublicationPhase = PublicationClaimPhase | 'applied' | 'failed' | 'superseded';

export type PublicationRow = {
  id: string; payload: PublicationPayload; proof: PublicationProof | null;
  phase: 'prepared' | 'sending' | 'confirmed' | 'applied' | 'failed' | 'unknown' | 'superseded';
  lease: Lease | null; attempts: number; nextAttemptMs: number | null;
  recoveryState: 'pending' | 'done' | 'local-error' | 'suspended';
};

// note: --- Constants (spec §7.7 step 8, §7.11.1, §7.3) ---

/** Publication lease duration (spec §7.7 step 8: "120s, epoch-fenced"). */
export const PUBLICATION_LEASE_MS = 120_000;

/** `line_dispatch_ms` value for a row that predates the column: its intent is
 *  UNKNOWN (the batch may have been sent), so it is discovery-only forever. */
export const LINE_DISPATCH_UNKNOWN = -1;
/** Recovery attempt cap — rows at/after this count leave the selectors. The
 *  line batch's discovery bound reuses it: a readback that captured nothing is
 *  the same kind of attempt as any other lifecycle recovery. */
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

// note: --- Row mapping helpers ---

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

function threadScope(row: { id: string; bot_id: string; installation_id: number; owner: string; repo: string; pr_number: number }): {
  associationId: string; scope: Scope;
} {
  return {
    associationId: row.id,
    scope: {
      appId: row.bot_id, installationId: row.installation_id,
      owner: row.owner, repo: row.repo, prNumber: row.pr_number,
    },
  };
}

// note: --- Fair rotation (spec §7.2) ---

/**
 * invariant: The RECHECKABLE predicate (spec §7.2/§7.4) — ONE copy shared by the
 * selector and the coverage count, so `selected <= totalOpen` cannot drift
 * into a lying `capped` remainder. Binds the scope tuple TWICE (the finding
 * row, then its association probe): bind it with `recheckableScopeBinds`.
 */
const RECHECKABLE_WHERE_SQL = `f.bot_id = ? AND f.installation_id = ? AND f.owner = ? AND f.repo = ? AND f.pr_number = ?
         AND (
           f.state = 'open'
           OR (
             f.state = 'addressed'
             AND EXISTS (
               SELECT 1 FROM review_threads t
               WHERE t.bot_id = ? AND t.installation_id = ? AND t.owner = ? AND t.repo = ? AND t.pr_number = ?
                 AND t.finding_row_id = f.id
                 AND t.superseded_by_publication_id IS NULL
                 AND t.resolution_state IN ('pending','retry','needs-recheck','local-error')
             )
           )
         )`;

/** note: The ten binds `RECHECKABLE_WHERE_SQL` expects, in placeholder order. */
function recheckableScopeBinds(scope: Scope): [string, number, string, string, number, string, number, string, string, number] {
  return [
    scope.appId, scope.installationId, scope.owner, scope.repo, scope.prNumber,
    scope.appId, scope.installationId, scope.owner, scope.repo, scope.prNumber,
  ];
}

/**
 * Recheckable-row selection for the recheck seat (spec §7.2): OPEN rows plus
 * ADDRESSED rows that still own a non-superseded association in a non-terminal
 * state (`pending`/`retry`/`needs-recheck`/`local-error`). The second class is
 * how a solved-but-unresolved conversation gets another real round: the seat
 * re-verifies the concern against the CURRENT head and discussion and the
 * ordinary resolution path (this round's own verified snapshot) resolves it.
 * Once that association reaches `resolved`/`abandoned` the finding drops back
 * out, so the rotation keeps only genuinely open rows.
 *
 * Ordered by `COALESCE(last_scheduled_ms, created_ms), id` (oldest waiting
 * first — no newest-updated or permanent never-assessed priority) and capped
 * at `ASSESSMENT_TARGET_CAP` (25) regardless of the caller's `limit` so a
 * misbehaving caller cannot break the rotation fairness. Every selected row
 * advances `last_scheduled_ms` when the publication applies, so a row that
 * can never be re-proved rotates out instead of starving the ones behind it.
 * Association IDs list the row's ACTIVE (non-superseded) thread associations
 * — superseded ones are dead and never offered again. Unselected rows are NOT
 * returned here; the caller represents them via the aggregate cap count in
 * the round coverage (spec §7.2/§7.4).
 */
export async function selectAssessmentTargets(db: D1Like, scope: Scope, limit: number): Promise<RecheckTarget[]> {
  const capped = Math.max(0, Math.min(limit, ASSESSMENT_TARGET_CAP));
  if (capped === 0) return [];
  const rows = await db
    .prepare(
      `SELECT f.* FROM review_findings f
       WHERE ${RECHECKABLE_WHERE_SQL}
       ORDER BY COALESCE(f.last_scheduled_ms, f.created_ms), f.id
       LIMIT ?`,
    )
    .bind(...recheckableScopeBinds(scope), capped)
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

/**
 * Aggregate count of RECHECKABLE rows for the scope — the `totalOpen` the
 * round coverage reports (spec §7.4). It binds the SAME predicate as
 * `selectAssessmentTargets`, so `selected <= totalOpen` always holds and
 * `capped` stays the honest remainder instead of going negative.
 */
export async function countRecheckableFindings(db: D1Like, scope: Scope): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM review_findings f WHERE ${RECHECKABLE_WHERE_SQL}`)
    .bind(...recheckableScopeBinds(scope))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// note: --- Private pre-publication journal (spec §7.7) ---

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
         (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
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
    // note: Conflict: the existing immutable payload wins (same-id replay OR a
    // second model result for the same scope+SHA+kind).
    const existing =
      (await db.prepare(`SELECT * FROM review_publications WHERE id = ?`).bind(input.id).first<ReviewPublicationRow>()) ??
      (await db
        .prepare(
          `SELECT * FROM review_publications
           WHERE bot_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
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
 * The STAGED journal row by id — the authority `publish` reads rather than any
 * in-memory copy of the payload: a restart after staging must publish exactly
 * what was staged, including the body, the target comment, the line intents and
 * the lifecycle it carries. `null` means the id has no row (nothing to send).
 */
export async function readPublication(db: D1Like, id: string): Promise<PublicationRow | null> {
  const row = await db.prepare(`SELECT * FROM review_publications WHERE id = ?`).bind(id).first<ReviewPublicationRow>();
  return row === null ? null : publicationRowOf(row);
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
export async function claimPublication(
  db: D1Like,
  id: string,
  holder: string,
  nowMs: number,
  /**
   * invariant: The phase this caller RESUMED for. The READ and the claim are separated by
   * an unbounded wait, so a row that moved on in between (another lane took the
   * expired claim, or the work completed) must not be taken by this caller: the
   * conditional write re-checks the phase in the same statement that dispatches.
   */
  expectPhase: PublicationPhase,
): Promise<Lease | null> {
  const claim = await db
    .prepare(
      `UPDATE review_publications
       SET holder = ?, lease_epoch = lease_epoch + 1, lease_until_ms = ?, updated_ms = ?,
           attempts = attempts + 1,
           phase = CASE WHEN phase = 'prepared' THEN 'sending' ELSE phase END
       WHERE id = ? AND phase = ?
         AND phase IN ('prepared','sending','unknown','confirmed')
         AND (lease_until_ms IS NULL OR lease_until_ms <= ?)
       RETURNING holder, lease_epoch, lease_until_ms`,
    )
    .bind(holder, nowMs + PUBLICATION_LEASE_MS, nowMs, id, expectPhase, nowMs)
    .run<{ holder: string; lease_epoch: number; lease_until_ms: number | null }>();
  // note: The statement RETURNS the row it wrote: no later lookup can hand this
  // claimant a row a same-holder acquisition took after it.
  const written = claim.results[0];
  if (
    written === undefined ||
    written.holder !== holder ||
    written.lease_until_ms !== nowMs + PUBLICATION_LEASE_MS
  ) {
    return null;
  }
  return { holder, epoch: written.lease_epoch, untilMs: written.lease_until_ms };
}

// note: --- §7.9 publication lease — authority over ONE action, not over the attempt ---

/** What a publication acquisition is for. Not part of the key: a `recover`
 *  contends with a live `send` of the same action instead of bypassing it. */
export type PublicationLeaseMode = "send" | "recover";

/** The durable identity of one publishable action on one attempt. `actionKey`
 *  is the mutation (`check:complete`, `comment:<publicationId>`), never a
 *  caller or a delivery. */
export type PublicationAction = { attemptId: string; actionKey: string };

/**
 * Claim the publication lease of ONE action (spec §7.9): its own row, its own
 * epoch, a fresh `PUBLICATION_LEASE_MS` window — independent of the attempt's
 * execution lease, which may be live, renewed or expired throughout. One
 * conditional write takes a free or expired row and increments the epoch;
 * `null` means another holder owns a live one. Acquiring does not imply (and
 * does not touch) execution; it says only "this holder may perform THIS
 * mutation now".
 */
export async function claimPublicationLease(
  db: D1Like,
  input: PublicationAction & { holder: string; mode: PublicationLeaseMode; nowMs: number },
): Promise<Lease | null> {
  if (input.holder.length === 0) {
    throw new Error("finding-lifecycle: publication lease requires a nonblank holder identity");
  }
  const claim = await db
    .prepare(
      `INSERT INTO publication_leases
         (attempt_id, action_key, holder, lease_epoch, lease_until_ms, mode, updated_ms)
       VALUES (?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (attempt_id, action_key) DO UPDATE
         SET holder = excluded.holder,
             lease_epoch = publication_leases.lease_epoch + 1,
             lease_until_ms = excluded.lease_until_ms,
             mode = excluded.mode,
             updated_ms = excluded.updated_ms
       WHERE publication_leases.lease_until_ms IS NULL OR publication_leases.lease_until_ms <= ?
       RETURNING holder, lease_epoch, lease_until_ms`,
    )
    .bind(
      input.attemptId, input.actionKey, input.holder,
      input.nowMs + PUBLICATION_LEASE_MS, input.mode, input.nowMs,
      input.nowMs,
    )
    .run<{ holder: string; lease_epoch: number; lease_until_ms: number | null }>();
  // invariant: The statement RETURNS the row it wrote, so the claim carries the identity it
  // established instead of re-reading a row a delayed caller could no longer
  // own. Zero rows = the guard refused (a live holder). A row that is not the
  // fence this call wrote — another holder, or an expiry other than the one
  // bound here — is a refusal, never a live lease.
  const written = claim.results[0];
  if (
    written === undefined ||
    written.holder !== input.holder ||
    written.lease_until_ms !== input.nowMs + PUBLICATION_LEASE_MS
  ) {
    return null;
  }
  return { holder: written.holder, epoch: written.lease_epoch, untilMs: written.lease_until_ms };
}

/**
 * Release the publication lease of ONE action under the epoch it was granted
 * with: holder and expiry clear, the epoch stays (a late release of an older
 * acquisition can never clear a newer one). Deliberately not gated on
 * `lease_until_ms > now` — a holder whose window lapsed still owns its own row
 * by epoch, and a lapsed publication right is not evidence about the remote
 * effect. Releases nothing else: execution, the Check row and the journal are
 * untouched.
 */
export async function releasePublicationLease(
  db: D1Like,
  input: PublicationAction & { lease: Lease; nowMs: number },
): Promise<boolean> {
  const released = await db
    .prepare(
      `UPDATE publication_leases
          SET holder = NULL, lease_until_ms = NULL, updated_ms = ?
        WHERE attempt_id = ? AND action_key = ? AND holder = ? AND lease_epoch = ?`,
    )
    .bind(input.nowMs, input.attemptId, input.actionKey, input.lease.holder, input.lease.epoch)
    .run();
  return released.meta.changes === 1;
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
         AND bot_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
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
       WHERE bot_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
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
 * The journal phases a DELIVERY hands off (spec §7.7 step 2): everything that
 * is not terminal for this scope/head, `confirmed` included — its proof is
 * about to be applied and this delivery still must not re-review the head.
 */
export const PUBLICATION_HANDOFF_PHASES: readonly PublicationRow["phase"][] = [
  "prepared",
  "sending",
  "unknown",
  "confirmed",
];

/**
 * The phases the Check lane's proof wait may attribute to an attempt (§7.11.2):
 * the delivery hand-off set plus `applied`. A publication that already applied
 * its proof is exactly the abandoned-attempt case — the attempt was released
 * with no `publication_id` link while its own review published, so `applied`
 * is the state its proof is normally found in.
 */
export const PUBLICATION_PROOF_WAIT_PHASES: readonly PublicationRow["phase"][] = [
  ...PUBLICATION_HANDOFF_PHASES,
  "applied",
];

/**
 * The publication-journal row for this exact scope/head in any of `phases`,
 * with whether that row's OWN proof is readable. ONE predicate, shared by the
 * delivery hand-off (§7.7 step 2, `order: "oldest"`) and the Check recovery
 * lane's wait-for-proof probe (§7.11.2, `order: "newest"`) — two copies of the
 * same SQL would be free to drift apart.
 *
 * `hasProof` is deliberately the STRICT condition (`proof_json` present AND
 * valid JSON): a present-but-corrupt envelope must not end the wait, or the
 * conclusion path would freeze the unconfirmed failure on a publication whose
 * real proof is still arriving.
 */
export async function findPublicationJournal(
  db: D1Like,
  input: {
    scope: Scope;
    headSha: string;
    phases: readonly PublicationRow["phase"][];
    /**
     * note: Which row wins when the head holds more than one (a normal row plus a
     * degraded one). `oldest` is the delivery hand-off's order (first in flight
     * wins); `newest` is the Check wait's (the LATEST publication is the one
     * whose proof is still owed).
     */
    order?: "oldest" | "newest";
    /**
     * invariant: Only rows whose LAST WRITE is at or after this instant are reported.
     * The Check wait passes the attempt's own admission time: one row exists
     * per scope/head/kind, and the writer reuses an existing row for a
     * re-triggered head, so a row INSERTED earlier still belongs to this
     * attempt when this attempt's stage/claim/proof write stamped it
     * afterwards. The conflict-reuse path itself writes nothing, so a reused
     * row with no post-admission write is never reported.
     */
    writtenAtOrAfterMs?: number;
  },
): Promise<{ id: string; phase: PublicationRow["phase"]; hasProof: boolean } | null> {
  if (input.phases.length === 0) return null;
  const placeholders = input.phases.map(() => "?").join(", ");
  const order = input.order === "newest" ? "created_ms DESC, id DESC" : "created_ms, id";
  const writeFloor =
    input.writtenAtOrAfterMs === undefined ? "" : "AND updated_ms >= ?";
  const row = await db
    .prepare(
      `SELECT id, phase, (proof_json IS NOT NULL AND json_valid(proof_json)) AS has_proof FROM review_publications
       WHERE bot_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
         AND head_sha = ? AND phase IN (${placeholders}) ${writeFloor}
       ORDER BY ${order} LIMIT 1`,
    )
    .bind(
      input.scope.appId,
      input.scope.installationId,
      input.scope.owner,
      input.scope.repo,
      input.scope.prNumber,
      input.headSha,
      ...input.phases,
      ...(input.writtenAtOrAfterMs === undefined ? [] : [input.writtenAtOrAfterMs]),
    )
    .first<{ id: string; phase: string; has_proof: number }>();
  return row === null
    ? null
    : { id: row.id, phase: row.phase as PublicationRow["phase"], hasProof: row.has_proof === 1 };
}

/**
 * Proof-gated idempotent apply — the frozen §7.7 step 9 local sequence, run
 * as two separately-chunked halves that NEVER share a chunk:
 *
 *   (1) the artifact half — the review INSERT and one INSERT per public
 *       finding, composed by `createArtifactStore().statementsFor()` on EVERY
 *       attempt. The review row's `id` IS the apply's idempotency key, so the
 *       first attempt and every retry compute the same id and `ON CONFLICT DO
 *       NOTHING` keeps the first-written row. A public finding's own id is
 *       `<key>#<envelope index>` and it attaches to the review that ACTUALLY
 *       exists for that head — the natural-key lookup first (a historically
 *       written review carries a UUID id; the UNIQUE admits at most one
 *       candidate), else this attempt's derived id — with `ON CONFLICT DO
 *       NOTHING`. A retry therefore writes the missing findings and re-runs a
 *       complete artifact as a no-op. Its statements carry the same inline
 *       lease fence as the lifecycle's, and they are emitted as their own
 *       leading chunk(s), so a failed LIFECYCLE chunk never leaves a
 *       partially written artifact.
 *   (2) the lifecycle half — batches of at most 25 row transitions (§7.11.1),
 *       each preceded by a lease-fence probe, whose FINAL statement marks the
 *       publication applied under the lease.
 *
 * A retry therefore CONVERGES: the artifact half no-ops or completes, the
 * lifecycle half resumes, and the applied marker is only ever written last.
 * Within one attempt the review row and the new findings rows resolve the
 * live binding with the same expression, so they agree. Degraded proof creates no
 * normal review/lifecycle rows — it only marks applied. Rows absent from
 * `seen` are never deleted and never rewritten: `review_findings.target_id`
 * and `reviews.target_id` are set when the row is FIRST recorded and are not
 * migrated afterwards. Within one apply the two agree by construction — the
 * new review row (step 1) and the new findings rows (step 2) both take the
 * live installation binding, falling back to the artifact's target only when
 * nothing is bound. A rebind therefore affects future publications only —
 * each target keeps the history it actually reviewed — which is also why the
 * ledger's `(target_id, owner, repo, pr_number)` key stays correct. The
 * binding is resolved in-batch (a scalar subquery in the inserting statement)
 * so a concurrent unbind/claim cannot be frozen; the frozen
 * `payload.artifact.targetId` is only the hint a NEW row takes when nothing is
 * bound, never a migration instruction. Returns false (and writes nothing)
 * when the row is unknown, the lease is not live, proof is missing, or the
 * payload is not a complete review publication; the previously-applied row
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
   * invariant: Fresh clock for the per-chunk lease fence (§7.11.1: "every chunk of the
   * apply must prove the same live publication holder/epoch"). Defaults to
   * the call's fixed clock — a caller whose apply spans a real time window
   * (the M8 reconciler) passes its own clock so an expired lease is
   * observed between chunks instead of being assumed live.
   */
  clock?: () => number,
  /**
   * invariant: Statements appended to the SAME atomic apply as the applied mark, after it:
   * a caller that must record a completion fact (the attempt's settlement) can
   * never observe an applied publication with that fact missing. The mark runs
   * first, so a tail predicate can require `phase = 'applied'`. An idempotent
   * replay (row already applied) runs the tail alone — it is the only work left.
   */
  tail?: (payload: PublicationPayload) => D1StatementLike[],
): Promise<boolean> {
  const nowAt = clock ?? (() => nowMs);
  const row = await db.prepare(`SELECT * FROM review_publications WHERE id = ?`).bind(id).first<ReviewPublicationRow>();
  if (row === null) return false;
  if (row.phase === "applied") {
    // note: Idempotent replay: nothing left to apply, but a caller's completion fact
    // may still be owed.
    const tailStatements = tail?.(JSON.parse(row.payload_json) as PublicationPayload) ?? [];
    if (tailStatements.length > 0) await db.batch(tailStatements);
    return true;
  }
  // note: Live lease fence (holder + epoch + unexpired) and positive persisted proof.
  if (row.holder !== lease.holder || row.lease_epoch !== lease.epoch) return false;
  if (row.lease_until_ms === null || row.lease_until_ms <= nowAt()) return false;
  if (row.phase !== "confirmed" || row.proof_json === null) return false;

  const payload = JSON.parse(row.payload_json) as PublicationPayload;
  const tailStatements = tail?.(payload) ?? [];

  if (payload.kind === "degraded") {
    // note: Degraded payload: artifact/lifecycle null, empty line intents — no
    // normal review or lifecycle rows are created from it (spec §7.7).
    if (tailStatements.length === 0) {
      const applied = await markPublicationApplied(db, row.id, lease, nowMs).run();
      return applied.meta.changes > 0;
    }
    const [applied] = await db.batch([markPublicationApplied(db, row.id, lease, nowMs), ...tailStatements]);
    return (applied?.meta.changes ?? 0) > 0;
  }
  if (payload.kind !== "review" || payload.artifact === null || payload.lifecycle === null) {
    // safety: A review-kind payload without its complete artifact/lifecycle is
    // malformed — fail closed, leave the confirmed row for inspection.
    return false;
  }

  // invariant: Step 1 — the review artifact's statements, composed on EVERY attempt and
  // emitted as their own leading chunk(s), never mixed with the lifecycle's.
  // The review id is DERIVED from the apply key and a finding is
  // `<key>#<index>`; a finding attaches to the review that exists for the head
  // (a historically written UUID row, else this attempt's derived id), so a
  // retry computes the same rows and `ON CONFLICT … DO NOTHING` repairs a
  // partial artifact instead of skipping it. They carry the same inline lease
  // guard as the lifecycle statements, so a superseded holder cannot commit
  // them, and a failed lifecycle chunk leaves them complete rather than
  // half-written.
  const leaseGuard = [row.id, lease.holder, lease.epoch, nowMs] as const;
  const artifactStatements = createArtifactStore(db)
    .statementsFor(
      { ...payload.artifact, round: payload.round },
      {
        targetIdExpression: {
          sql: `COALESCE(${LIVE_BINDING_TARGET_SQL}, ?)`,
          binds: [payload.scope.appId, payload.scope.owner, payload.scope.repo, payload.artifact.targetId],
        },
        guard: { sql: APPLY_LEASE_GUARD_SQL, binds: [...leaseGuard] },
      },
    )
    .map((statement) => db.prepare(statement.sql).bind(...statement.binds));

  // safety: Step 2 — the lifecycle writes in db.batches of at most
  // LIFECYCLE_APPLY_BATCH_STATEMENTS statements each (§7.11.1: "Local apply
  // batches ≤25 row transitions each; a larger payload is resumed
  // idempotently with applied-publication/association IDs, never marks
  // complete early"). Every statement is replay-safe (the guards above), so
  // a crash between batches resumes on the next recovery pass — applied
  // transitions skip and the applied mark stays the FINAL statement of the
  // FINAL batch, under the lease. Small payloads (the common case) still
  // run as ONE batch. The guard above narrowed `payload.lifecycle` to
  // non-null; it is passed explicitly so the helper's signature carries that
  // invariant. Attribution: the live binding is resolved INSIDE the batch by
  // every INSERTING statement (a scalar subquery in this review row's INSERT
  // and in the findings insert); the artifact's own `targetId` is only the
  // hint a new row falls back to when nothing is bound.
  // The artifact's chunk(s) come FIRST and never mix with the lifecycle's:
  // a failed lifecycle chunk therefore leaves a COMPLETE, idempotent artifact
  // (the next attempt no-ops it), and a failed artifact chunk is repaired by
  // the next attempt because composition is unconditional.
  const chunks = [
    ...chunkStatements(artifactStatements, LIFECYCLE_APPLY_BATCH_STATEMENTS),
    ...chunkStatements(
      lifecycleApplyBatch(db, row, payload, payload.lifecycle, payload.artifact.targetId, nowMs, lease),
      LIFECYCLE_APPLY_BATCH_STATEMENTS,
    ),
  ];
  // note: The caller's completion facts ride the FINAL chunk, after the applied mark:
  // same transaction, so neither fact can land without the other.
  if (tailStatements.length > 0) chunks[chunks.length - 1]!.push(...tailStatements);
  const results: D1BatchResult[] = [];
  for (const chunk of chunks) {
    // invariant: Per-chunk fence (§7.11.1): the apply may span a real time window, and
    // once the 120s lease expires another invocation can claim a NEWER epoch.
    // Re-prove the SAME live holder/epoch before this chunk writes, so a
    // stale invocation stops instead of mutating findings/rounds/associations
    // under an ownership it no longer holds. The final chunk's applied mark
    // still re-checks the same predicate in its own SQL, so a replacement
    // mid-chunk can never mark complete (nor satisfy a tail's `applied` guard).
    if (!(await publicationLeaseIsLive(db, id, lease, nowAt()))) return false;
    results.push(...(await db.batch(chunk)));
  }
  const applied = results[results.length - 1 - tailStatements.length]!;
  return applied.meta.changes > 0;
}

/**
 * invariant: The ATOMIC live-lease fence (§7.11.1: "All local updates require
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
 * invariant: The live-binding scalar subquery — the attribution source for a NEWLY
 * recorded row. It is embedded in the inserting statement, so the binding is
 * read when that statement runs, inside the same batch and transaction as the
 * write it feeds: a read taken before the batch could be stranded by a
 * concurrent delete/claim. It is never used to rewrite an existing row's
 * `target_id` — a row's tenant is fixed when it is first recorded. Binds, in
 * order: `(botId, repoOwner, repoName)`; it yields NULL when the bot holds no
 * live target for that repository. A target IS a repository (migration 0067),
 * so exactly one live row matches per (bot, repository) in a workspace; the
 * `ORDER BY` only makes a duplicate row deterministic. Owner/name compare
 * NOCASE: GitHub repository identities are case-insensitive and the stored
 * spelling may differ from the payload's.
 */
const LIVE_BINDING_TARGET_SQL = `(SELECT id FROM review_targets
       WHERE bot_id = ? AND repo_owner = ? COLLATE NOCASE AND repo_name = ? COLLATE NOCASE
         AND deleted_at IS NULL
       ORDER BY created_at, id LIMIT 1)`;

/**
 * invariant: The live-lease fence probe (§7.11.1) — the read twin of the applied
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
 * invariant: The conditional applied-mark STATEMENT: requires the FULL live lease
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

/** invariant: Split statements into chunks of at most `size`, order preserved. */
function chunkStatements<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

/**
 * invariant: The §7.2 state machine as ONE batch (knowledge `d1-batch-atomicity`).
 * Order inside the batch matters and is replay-safe:
 *   0. Attribution — fixed at FIRST record. A statement that INSERTS a row
 *      embeds `LIVE_BINDING_TARGET_SQL`, the scalar subquery for the bot's
 *      live target for this repository (read in-batch, so a concurrent
 *      delete/claim cannot be frozen into an applied state), falling back to
 *      the payload's `artifact.targetId` as a hint when no target is bound. The review row this apply inserts is
 *      composed into the same batch with the same expression, so one apply
 *      never files a review under one tenant and its findings under another. No statement rewrites `target_id` on an existing row: a rebind
 *      moves FUTURE publications, never history — each target's ledger is the
 *      record of what that target reviewed.
 *   1. Seen upserts — new rows insert open at the current time; existing rows
 *      update last-seen tracking only. A row closed (addressed/dismissed)
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
 *
 * Attribution is fixed at FIRST record. A newly inserted row is stamped with
 * the live binding for the bot and repository — resolved by a scalar subquery
 * inside the inserting statement, so a concurrent delete/claim cannot be
 * frozen — and `hintTargetId` is only the fallback a new row takes when no
 * target resolves. No statement here rewrites `target_id` on an existing
 * row.
 */
function lifecycleApplyBatch(
  db: D1Like,
  row: ReviewPublicationRow,
  payload: PublicationPayload,
  /** invariant: The caller-narrowed non-null `payload.lifecycle` (review kind only). */
  lifecycle: LifecycleRound,
  /** note: The payload's own target — the hint a NEW row takes when nothing is bound. */
  hintTargetId: string,
  nowMs: number,
  lease: Lease,
): D1StatementLike[] {
  const pubId = row.id;
  const headSha = payload.headSha;
  const round = payload.round;
  const scope = payload.scope;
  const guard = [pubId, lease.holder, lease.epoch, nowMs] as const;
  const statements: D1StatementLike[] = [];

  // note: 1. Seen upserts — recurrence reopen + last-seen tracking.
  for (const seen of lifecycle.seen) {
    statements.push(
      db
        .prepare(
          `INSERT INTO review_findings
             (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
              first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
              first_seen_round, last_seen_round, state, created_ms, updated_ms, target_id)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?,
                  COALESCE(${LIVE_BINDING_TARGET_SQL}, ?)
           WHERE ${APPLY_LEASE_GUARD_SQL}
           ON CONFLICT(bot_id, installation_id, owner, repo, pr_number, finding_id) DO UPDATE SET
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
          // note: The INSERT's target: the binding read in this statement, else the
          // payload hint.
          scope.appId, scope.owner, scope.repo, hintTargetId,
          ...guard,
        ),
    );
  }

  // note: 2. Assessments — state transition + round history (replay marker).
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

  // note: 3. Association supersede + preallocated intent inserts.
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
             (id, finding_row_id, publication_id, bot_id, installation_id, owner, repo, pr_number,
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

  // note: 4. Fair-rotation scheduling for every selected target (monotonic).
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

  // note: 5. Mark applied under the lease — final statement, atomic with the above.
  statements.push(markPublicationApplied(db, row.id, lease, nowMs));
  return statements;
}

// note: --- Recovery readers (spec §7.11.1) — M8-only surfaces ---

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
      `SELECT id, bot_id, installation_id, owner, repo, pr_number FROM review_threads
       WHERE resolution_state IN ('pending','retry') AND verified_json IS NOT NULL
         AND superseded_by_publication_id IS NULL AND attempts < ?
         AND (next_attempt_ms IS NULL OR next_attempt_ms <= ?)
         AND (lease_until_ms IS NULL OR lease_until_ms <= ?)
       ORDER BY COALESCE(next_attempt_ms, created_ms), id
       LIMIT ?`,
    )
    .bind(LIFECYCLE_MAX_ATTEMPTS, nowMs, nowMs, limit)
    .all<{ id: string; bot_id: string; installation_id: number; owner: string; repo: string; pr_number: number }>();
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
  if (hasPublication === hasAssociation) return false; // invariant: exactly one work ID required

  const scopeGuard = "bot_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?";
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

// invariant: §7.11.1 recovery bookkeeping writers (the M8 lane) — the
// post-failure state machine the reconciler drives: backoff after failed
// attempts, the terminal local-error at the attempt cap, supersede on
// newer-round evidence, App-lifecycle suspension and exact-App re-enable,
// and the needs-recheck stop state for the resolution lane. Bookkeeping
// NEVER resets `attempts` (§7.11.1: "resets attempts only for a genuinely
// new assessment, never for bookkeeping") and never deletes a row.

/** safety: Bound a durable reason string — structured, no payload/secret content. */
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
/** safety: Token carrying the credential-envelope fingerprint inside the reason. */
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

/** note: Free-lease predicate bound to a now parameter position. */
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
       WHERE bot_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
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

/** One applied publication's post-apply line batch: is work still pending, has
 *  a dispatch intent already been recorded (the batch may have been sent), and
 *  how many of its associations carry a captured comment id. */
export type LineBatchState = { pending: boolean; dispatched: boolean; captures: number };

/**
 * Read the batch's durable state. `dispatched` is the §7.9a evidence question:
 * an intent means some lane took the send right for this exact batch, so the
 * only remaining work is read-only discovery — never a second send. A row that
 * predates the column carries `LINE_DISPATCH_UNKNOWN` and is treated the same
 * way: its intent is unknown, not absent. `captures` is the optimistic token a
 * failure observation carries: it must still match when the failure is
 * recorded, or a concurrent capture (full or partial) invalidates it. It is
 * DERIVED from the thread rows, so re-writing an already-captured id moves it
 * not at all — only a NEW id does.
 */
export async function readLineBatchState(db: D1Like, id: string): Promise<LineBatchState> {
  const row = await db
    .prepare(`SELECT line_dispatch_ms FROM review_publications WHERE id = ?`)
    .bind(id)
    .first<{ line_dispatch_ms: number | null }>();
  if (row === null) return { pending: false, dispatched: false, captures: 0 };
  const counts = await db
    .prepare(
      `SELECT SUM(CASE WHEN review_id IS NULL THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN review_id IS NOT NULL THEN 1 ELSE 0 END) AS captures
         FROM review_threads WHERE publication_id = ?`,
    )
    .bind(id)
    .first<{ pending: number | null; captures: number | null }>();
  return {
    pending: (counts?.pending ?? 0) > 0,
    dispatched: row.line_dispatch_ms !== null,
    captures: counts?.captures ?? 0,
  };
}

/**
 * §7.9a condition 2: the applied mark cleared the journal claim, so the no-Check
 * lane's line batch takes a FRESH claim of its own — and records the DISPATCH
 * INTENT in that same conditional transition. One statement decides who may
 * send this exact batch: the row must be `applied`, carry no prior intent, hold
 * a free/expired lease, and still have an uncaptured line intent. `null` means
 * the batch was already dispatched (discovery only), another lane owns it, or
 * nothing is pending.
 */
export async function recordLineDispatchIntent(
  db: D1Like,
  id: string,
  holder: string,
  nowMs: number,
): Promise<Lease | null> {
  if (holder.length === 0) throw new Error("finding-lifecycle: line-batch claim requires a nonblank holder identity");
  const claim = await db
    .prepare(
      `UPDATE review_publications
          SET holder = ?, lease_epoch = lease_epoch + 1, lease_until_ms = ?,
              line_dispatch_ms = ?, updated_ms = ?
        WHERE id = ? AND phase = 'applied' AND line_dispatch_ms IS NULL
          AND (lease_until_ms IS NULL OR lease_until_ms <= ?)
          AND EXISTS (SELECT 1 FROM review_threads t WHERE t.publication_id = ? AND t.review_id IS NULL)
        RETURNING holder, lease_epoch, lease_until_ms`,
    )
    .bind(holder, nowMs + PUBLICATION_LEASE_MS, nowMs, nowMs, id, nowMs, id)
    .run<{ holder: string; lease_epoch: number; lease_until_ms: number | null }>();
  const written = claim.results[0];
  if (
    written === undefined ||
    written.holder !== holder ||
    written.lease_until_ms !== nowMs + PUBLICATION_LEASE_MS
  ) {
    return null;
  }
  return { holder: written.holder, epoch: written.lease_epoch, untilMs: written.lease_until_ms };
}

/**
 * Hand the line-batch send right back under the exact epoch it was granted with.
 * `sent: true` (the batch landed, or may have) KEEPS the durable intent — from
 * then on the work is discovery. `sent: false` is a definitive pre-send refusal:
 * nothing left the Worker, so the intent is cleared and a later lane may record
 * a new one. `phase` stays `applied` in both cases.
 */
export async function releaseLineDispatch(
  db: D1Like,
  id: string,
  lease: Lease,
  nowMs: number,
  sent: boolean,
): Promise<boolean> {
  const released = await db
    .prepare(
      `UPDATE review_publications
          SET holder = NULL, lease_until_ms = NULL,
              line_dispatch_ms = CASE WHEN ? THEN line_dispatch_ms ELSE NULL END,
              updated_ms = ?
        WHERE id = ? AND holder = ? AND lease_epoch = ? AND phase = 'applied'`,
    )
    .bind(sent ? 1 : 0, nowMs, id, lease.holder, lease.epoch)
    .run();
  return released.meta.changes > 0;
}

/** One discovery pass's durable outcome: the failed-readback count after it,
 *  and whether that pass left the batch unresolvable. */
export type LineDiscoveryOutcome = { attempts: number; unresolvable: boolean };

/**
 * ONE discovery pass that persisted no progress, recorded durably on the batch.
 * The count therefore means CONSECUTIVE discovery attempts that saved nothing
 * (not lifetime attempts, and not attempts that merely left comments missing);
 * a write that threw saved nothing and counts. The count is monotone because a
 * clock-based bound would re-admit the row on every slow pass; at `bound`
 * failures the batch leaves the eligible set with the reason the LAST pass
 * observed, so an operator can see why recovery stopped. The row, its count
 * and its reason stay (leaving the set is not deletion), and a row already
 * unresolvable returns `null` — the caller has nothing new to report.
 *
 * The write is OPTIMISTIC on the capture state this attempt observed
 * (`readLineBatchState().captures`, derived from the thread rows): a concurrent
 * pass that saved a NEW comment id moves it, so this stale observation changes
 * nothing — not the count, not the marker — instead of retiring a batch that is
 * still making progress. The same predicate keeps a completed batch unmarkable.
 *
 * It deliberately does NOT stamp `updated_ms`. Attribution of a reused
 * same-head journal row is that column's LAST WRITE (the Check wait's probe),
 * and a bookkeeping count is not a write by any attempt: stamping it would let
 * a recovery pass hand an old publication's proof to a newer generation.
 */
export async function recordLineDiscoveryFailure(
  db: D1Like,
  id: string,
  reason: string,
  observedCaptures: number,
  nowMs: number,
  bound: number = LIFECYCLE_MAX_ATTEMPTS,
): Promise<LineDiscoveryOutcome | null> {
  const result = await db
    .prepare(
      `UPDATE review_publications
          SET line_discovery_attempts = line_discovery_attempts + 1,
              line_unresolvable_ms =
                CASE WHEN line_discovery_attempts + 1 >= ? THEN ? ELSE line_unresolvable_ms END,
              line_unresolvable_reason =
                CASE WHEN line_discovery_attempts + 1 >= ? THEN ? ELSE line_unresolvable_reason END
        WHERE id = ? AND phase = 'applied' AND line_unresolvable_ms IS NULL
          AND (SELECT COUNT(*) FROM review_threads t WHERE t.publication_id = ? AND t.review_id IS NOT NULL) = ?
          AND EXISTS (SELECT 1 FROM review_threads t WHERE t.publication_id = ? AND t.review_id IS NULL)
        RETURNING line_discovery_attempts, line_unresolvable_ms`,
    )
    .bind(bound, nowMs, bound, reason, id, id, observedCaptures, id)
    .run<{ line_discovery_attempts: number; line_unresolvable_ms: number | null }>();
  const written = result.results[0];
  if (written === undefined) return null;
  return {
    attempts: written.line_discovery_attempts,
    unresolvable: written.line_unresolvable_ms !== null,
  };
}

/**
 * A discovery pass that PERSISTED at least one NEW comment id clears the count —
 * a partial capture is progress, even while other comments stay missing, so the
 * batch must not carry earlier misses toward a cap it no longer deserves. Only
 * the counter moves (no `updated_ms` stamp — see `recordLineDiscoveryFailure`);
 * an unresolvable batch is never selected, so its marker columns cannot be
 * cleared from here.
 */
export async function resetLineDiscoveryFailures(db: D1Like, id: string): Promise<void> {
  await db
    .prepare(
      `UPDATE review_publications
          SET line_discovery_attempts = 0
        WHERE id = ? AND line_discovery_attempts > 0 AND line_unresolvable_ms IS NULL`,
    )
    .bind(id)
    .run();
}

/**
 * Persist the captured line-comment ids against their associations (the §7.7
 * step 10 capture). Replay-safe and scoped to the publication, so a discovery
 * pass in another lane can complete what a send could not read back.
 *
 * Only an UNC captured association is written: a re-listed id is not progress,
 * and rewriting it must not look like any. Returns how many associations this
 * call NEWLY captured — the caller's only "progress" signal, and the value the
 * derived capture count (the optimistic token) moves by. The publication row is
 * deliberately not touched: this is not a write any attempt should be
 * attributed by (see `recordLineDiscoveryFailure`).
 */
export async function captureLineComments(
  db: D1Like,
  publicationId: string,
  reviewId: number | null,
  posted: readonly { associationId: string; commentId: number }[],
  nowMs: number,
): Promise<number> {
  if (posted.length === 0) return 0;
  const results = await db.batch(
    posted.map((p) =>
      db
        .prepare(
          `UPDATE review_threads
              SET review_id = ?, comment_id = ?, updated_ms = ?
            WHERE id = ? AND publication_id = ? AND review_id IS NULL`,
        )
        .bind(reviewId, p.commentId, nowMs, p.associationId, publicationId),
    ),
  );
  return results.reduce((captured, result) => captured + result.meta.changes, 0);
}

/**
 * The post-apply line lane's selection: applied rows that still carry an
 * uncaptured line intent and no live holder. `line_dispatch_ms` is deliberately
 * not filtered — a dispatched row is returned so the recovery lane can run the
 * read-only discovery the intent allows. A batch marked UNRESOLVABLE by the
 * discovery bound is not returned at all: it can never resolve, so leaving it
 * in the bounded selection would only starve newer batches. Within the
 * resolvable set the order stays oldest-first.
 */
export async function listLineBatchRecovery(db: D1Like, nowMs: number, limit: number): Promise<PublicationRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM review_publications p
        WHERE p.phase = 'applied'
          AND p.line_unresolvable_ms IS NULL
          AND (p.lease_until_ms IS NULL OR p.lease_until_ms <= ?)
          AND EXISTS (SELECT 1 FROM review_threads t WHERE t.publication_id = p.id AND t.review_id IS NULL)
        ORDER BY COALESCE(p.applied_ms, p.updated_ms), p.id
        LIMIT ?`,
    )
    .bind(nowMs, limit)
    .all<ReviewPublicationRow>();
  return rows.results.map(publicationRowOf);
}

// note: --- §7.9a condition 3 — one authority over ONE degraded target comment ---

/** The exact degraded comment a cleanup and its publishers contend on. */
export type DegradedTargetRef = { scope: Scope; commentId: number };

const DEGRADED_TARGET_COLUMNS = "bot_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND comment_id = ?";

function degradedTargetBinds({ scope, commentId }: DegradedTargetRef): [string, number, string, string, number, number] {
  return [scope.appId, scope.installationId, scope.owner, scope.repo, scope.prNumber, commentId];
}

/**
 * Claim writer exclusion for ONE degraded target comment (spec §7.9a condition
 * 3). The cleanup takes it before DELETE; a degraded publisher (its staging AND
 * its recovery send) takes it before an UPDATE of that comment. One conditional
 * row, one epoch: a live holder refuses the other side, and a target whose last
 * DELETE is UNRESOLVED (`unresolved_ms` set) refuses every writer until a fresh
 * complete observation proves the outcome — there is no time bound that quietly
 * re-opens it.
 */
export async function claimDegradedTarget(
  db: D1Like,
  input: DegradedTargetRef & { holder: string; nowMs: number; deleting?: boolean },
): Promise<Lease | null> {
  if (input.holder.length === 0) throw new Error("finding-lifecycle: degraded target claim requires a nonblank holder identity");
  // invariant: A DELETE records its unresolved intent IN the acquiring statement: from the
  // moment the target is held, every writer is refused — and a crash before the
  // DELETE even starts leaves the intent durable once the lease lapses.
  const unresolvedMs = input.deleting === true ? input.nowMs : null;
  const claim = await db
    .prepare(
      `INSERT INTO degraded_target_leases
         (bot_id, installation_id, owner, repo, pr_number, comment_id,
          holder, lease_epoch, lease_until_ms, unresolved_ms, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (bot_id, installation_id, owner, repo, pr_number, comment_id) DO UPDATE
         SET holder = excluded.holder,
             lease_epoch = degraded_target_leases.lease_epoch + 1,
             lease_until_ms = excluded.lease_until_ms,
             unresolved_ms = excluded.unresolved_ms,
             updated_ms = excluded.updated_ms
         WHERE (degraded_target_leases.lease_until_ms IS NULL
                OR degraded_target_leases.lease_until_ms <= ?)
           AND degraded_target_leases.unresolved_ms IS NULL
       RETURNING holder, lease_epoch, lease_until_ms`,
    )
    .bind(
      ...degradedTargetBinds(input),
      input.holder,
      input.nowMs + PUBLICATION_LEASE_MS,
      unresolvedMs,
      input.nowMs,
      input.nowMs,
    )
    .run<{ holder: string; lease_epoch: number; lease_until_ms: number | null }>();
  // invariant: The statement RETURNS the row it wrote: a same-holder acquisition that took
  // a later epoch can never be mistaken for this one (no read-back).
  const written = claim.results[0];
  if (
    written === undefined ||
    written.holder !== input.holder ||
    written.lease_until_ms !== input.nowMs + PUBLICATION_LEASE_MS
  ) {
    return null;
  }
  return { holder: written.holder, epoch: written.lease_epoch, untilMs: written.lease_until_ms };
}

/**
 * Hand the target exclusion back under the exact epoch it was granted with.
 * `keep: true` leaves the UNRESOLVED marker set (a DELETE that may have landed):
 * no writer and no new delete may use the target again — there is no observation
 * that can prove a late DELETE will not land, so this is a permanent exclusion
 * (the plan's boundary note). `keep: false` is a known response, which is proof,
 * and frees the target.
 */
export async function releaseDegradedTarget(
  db: D1Like,
  input: DegradedTargetRef & { lease: Lease; nowMs: number; keep: boolean },
): Promise<boolean> {
  const released = await db
    .prepare(
      `UPDATE degraded_target_leases
          SET holder = NULL, lease_until_ms = NULL,
              unresolved_ms = CASE WHEN ? THEN ? ELSE NULL END,
              updated_ms = ?
        WHERE ${DEGRADED_TARGET_COLUMNS} AND holder = ? AND lease_epoch = ?`,
    )
    .bind(
      input.keep ? 1 : 0,
      input.nowMs,
      input.nowMs,
      ...degradedTargetBinds(input),
      input.lease.holder,
      input.lease.epoch,
    )
    .run();
  return released.meta.changes === 1;
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
 * `(bot_id, installation_id)` pair stops (no cross-bot substitution), lease
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
       WHERE bot_id = ? AND installation_id = ? AND recovery_state IN ('pending','suspended') AND ${FREE_LEASE_SQL}`,
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
       WHERE bot_id = ? AND installation_id = ? AND resolution_state IN ('pending','retry','suspended') AND ${FREE_LEASE_SQL}`,
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
 * Distinct suspended `(bot_id, installation_id)` pairs across both lanes,
 * bounded and durably rotated by exact pair, including unavailable pairs.
 * All reasons for each selected pair are read before deciding proof policy.
 * This advances the scan cursor before returning the re-enable probe input
 * (§7.11.1: "Suspended rows are checked
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
  if (limit <= 0) return [];
  const cursor = await db
    .prepare(
      `SELECT bot_id, installation_id FROM lifecycle_recovery_cursor WHERE id = 1`,
    )
    .first<{ bot_id: string; installation_id: number }>();
  const rows = await db
    .prepare(
      `WITH reasons AS (
         SELECT bot_id, installation_id, last_error FROM review_publications
         WHERE recovery_state = 'suspended'
         UNION
         SELECT bot_id, installation_id, last_error FROM review_threads
         WHERE resolution_state = 'suspended'
       ), pairs AS (
         SELECT DISTINCT bot_id, installation_id FROM reasons
       ), page AS (
         SELECT bot_id, installation_id,
                CASE WHEN (bot_id, installation_id) > (?, ?) THEN 0 ELSE 1 END AS wrapped
         FROM pairs
         ORDER BY wrapped, bot_id, installation_id LIMIT ?
       )
       SELECT r.bot_id, r.installation_id, r.last_error
       FROM page p JOIN reasons r
         ON r.bot_id = p.bot_id AND r.installation_id = p.installation_id
       ORDER BY p.wrapped, p.bot_id, p.installation_id`,
    )
    .bind(cursor?.bot_id ?? "", cursor?.installation_id ?? -1, limit)
    .all<{ bot_id: string; installation_id: number; last_error: string | null }>();
  type Merged = {
    appId: string;
    installationId: number;
    requiresIdentityProof: boolean;
    credentialFingerprint: string | null;
    conflicting: boolean;
  };
  const merged = new Map<string, Merged>();
  for (const row of rows.results) {
    const key = `${row.bot_id}:${row.installation_id}`;
    const existing = merged.get(key);
    const recorded = suspensionCredentialOf(row.last_error);
    let credentialFingerprint = existing?.credentialFingerprint ?? null;
    let conflicting = existing?.conflicting ?? false;
    if (recorded !== null) {
      if (credentialFingerprint === null) credentialFingerprint = recorded;
      else if (credentialFingerprint !== recorded) conflicting = true;
    }
    merged.set(key, {
      appId: row.bot_id,
      installationId: row.installation_id,
      requiresIdentityProof: (existing?.requiresIdentityProof ?? false) || suspensionKindOf(row.last_error) !== "disabled",
      credentialFingerprint,
      conflicting,
    });
  }
  const selected = [...merged.values()];
  const last = selected.at(-1);
  if (last) {
    // invariant: Advance even when routing/proof fails, so unchanged failures cannot
    // monopolize the next cron's bounded batch. The scan wraps at the end.
    await db.prepare(
      `INSERT INTO lifecycle_recovery_cursor (id, bot_id, installation_id) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET bot_id = excluded.bot_id, installation_id = excluded.installation_id`,
    ).bind(last.appId, last.installationId).run();
  }
  return selected.map((entry) => ({
    appId: entry.appId,
    installationId: entry.installationId,
    requiresIdentityProof: entry.requiresIdentityProof,
    // safety: Disagreeing records prove nothing about the current credentials —
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
         WHERE bot_id = ? AND installation_id = ? AND recovery_state = 'suspended'`,
      )
      .bind(nowMs, pair.appId, pair.installationId)
      .run();
    await db
      .prepare(
        `UPDATE review_threads
         SET resolution_state = 'retry', next_attempt_ms = NULL, last_error = NULL,
             holder = NULL, lease_until_ms = NULL, updated_ms = ?
         WHERE bot_id = ? AND installation_id = ? AND resolution_state = 'suspended'`,
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
      `SELECT bot_id, installation_id, owner, repo, pr_number, verified_json, attempts
       FROM review_threads WHERE id = ?`,
    )
    .bind(id)
    .first<{
      bot_id: string; installation_id: number; owner: string; repo: string;
      pr_number: number; verified_json: string | null; attempts: number;
    }>();
  if (row === null || row.verified_json === null) return null;
  return {
    scope: {
      appId: row.bot_id, installationId: row.installation_id,
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

import type { D1Like, D1StatementLike } from "./types";

/**
 * The per-PR identity plus the tenant the caps are counted against. `owner` /
 * `repo` are accepted in any case: the store folds them to lower case before
 * binding (GitHub is case-insensitive, the row's PRIMARY KEY is not).
 */
export type InflightKey = {
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  workspace_id: string;
};

/** Why an acquire refused (spec §1.3). `error` = storage failure, always refused. */
export type InflightRefusal = "pr-held" | "system-cap" | "workspace-cap" | "error";

/**
 * Why an `error` refusal happened. Both answers stay fail-closed; the
 * distinction is what the operator needs, because a dead D1 binding and a
 * capacity released between the two statements are the same refusal code but
 * not the same problem.
 */
export type InflightErrorCause =
  | { kind: "fault"; detail: string }
  | { kind: "released-between-statements" };

export type InflightAcquireResult =
  | { ok: true }
  | { ok: false; reason: "system-cap" | "workspace-cap" }
  | { ok: false; reason: "pr-held"; heldHeadSha: string; heldAttemptId: string; heldExpired: boolean }
  | { ok: false; reason: "error"; cause: InflightErrorCause };

/** The operator-facing text of an `error` refusal (log field, drop row). */
export function describeInflightError(cause: InflightErrorCause): string {
  return cause.kind === "fault"
    ? `fault: ${cause.detail}`
    : "capacity released between statements — no listed refusal reason applies";
}

export type AcquireInflightOptions = {
  systemCap: number;
  workspaceCap: number;
  attemptId: string;
  ttlSeconds: number;
  headSha: string | null;
  now: string;
  priorStopped?: { attemptId: string };
};

const PAID_STATE_UNKNOWN = `EXISTS (SELECT 1 FROM review_launches l
           WHERE l.attempt_id = r.attempt_id
             AND l.state = 'launched' AND l.result_outcome IS NULL)`;

/**
 * Whether this row still counts against the caps. A live lease does; so does a
 * paid state nobody can read; and so does an EXPIRED lease whose attempt is
 * activated, not revoked, and could still be doing paid work — a `persisted`
 * result may still be publishing, and an unreadable outcome is fail-closed.
 *
 * A FAILED attempt is the exception, and it is the settlement's side of the
 * bargain: its outcome is terminal (the paid step returned), the release that
 * wrote it also shortened the lease (`expireInflightStatement`), and keeping the
 * row counted would leave unrelated reviews queued behind a slot nobody will
 * release. The row itself STAYS, so a same-PR successor still has to prove the
 * container's stop before it takes the PR.
 */
const HOLDS_CAP_SQL = `(r.expires_at > ? OR ${PAID_STATE_UNKNOWN}
          OR (r.expires_at <= ? AND EXISTS (
                SELECT 1 FROM review_launches l
                 WHERE l.attempt_id = r.attempt_id
                   AND l.activated_ms IS NOT NULL
                   AND l.revoked_ms IS NULL
                   AND (l.result_outcome IS NULL OR l.result_outcome = 'persisted'))))`;

const ACQUIRE_SQL = `
INSERT INTO review_inflight
  (installation_id, owner, repo, pr_number, workspace_id, attempt_id, head_sha, acquired_at, expires_at)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE (SELECT COUNT(*) FROM review_inflight r
        WHERE ${HOLDS_CAP_SQL}) < ?
  AND (SELECT COUNT(*) FROM review_inflight r
        WHERE r.workspace_id = ? AND ${HOLDS_CAP_SQL}) < ?
ON CONFLICT (installation_id, owner, repo, pr_number) DO UPDATE SET
  workspace_id = excluded.workspace_id,
  attempt_id   = excluded.attempt_id,
  head_sha     = excluded.head_sha,
  acquired_at  = excluded.acquired_at,
  expires_at   = excluded.expires_at
WHERE review_inflight.expires_at <= ?
  AND NOT EXISTS (SELECT 1 FROM review_launches l
                   WHERE l.attempt_id = review_inflight.attempt_id
                     AND l.state = 'launched' AND l.result_outcome IS NULL)
  AND (review_inflight.attempt_id = ?
       OR (review_inflight.attempt_id = ?
           AND NOT EXISTS (SELECT 1 FROM review_launches l
                            WHERE l.attempt_id = review_inflight.attempt_id
                              AND l.revoked_ms IS NULL)))
`;

const REFUSAL_SQL = `
SELECT
  (SELECT COUNT(*) FROM review_inflight r
    WHERE r.installation_id = ? AND r.owner = ? AND r.repo = ? AND r.pr_number = ?
      AND (r.expires_at > ? OR ${PAID_STATE_UNKNOWN})) AS held,
  (SELECT r.head_sha FROM review_inflight r
    WHERE r.installation_id = ? AND r.owner = ? AND r.repo = ? AND r.pr_number = ?) AS held_head_sha,
  (SELECT COUNT(*) FROM review_inflight r WHERE ${HOLDS_CAP_SQL}) AS total,
  (SELECT COUNT(*) FROM review_inflight r
    WHERE r.workspace_id = ? AND ${HOLDS_CAP_SQL}) AS workspace_total,
  (SELECT r.attempt_id FROM review_inflight r
    WHERE r.installation_id = ? AND r.owner = ? AND r.repo = ? AND r.pr_number = ?) AS held_attempt_id,
  (SELECT r.expires_at FROM review_inflight r
    WHERE r.installation_id = ? AND r.owner = ? AND r.repo = ? AND r.pr_number = ?) AS held_expires_at
`;

const RELEASE_SQL = `
DELETE FROM review_inflight
WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND attempt_id = ?
`;

function isoInstant(ms: number): string {
  return new Date(ms).toISOString();
}

function normalizeKey(key: InflightKey): InflightKey {
  return { ...key, owner: key.owner.toLowerCase(), repo: key.repo.toLowerCase() };
}

export async function acquireInflight(
  db: D1Like,
  rawKey: InflightKey,
  opts: AcquireInflightOptions,
): Promise<InflightAcquireResult> {
  const key = normalizeKey(rawKey);
  try {
    const nowMs = Date.parse(opts.now);
    const ttlMs = opts.ttlSeconds * 1000;
    if (!Number.isFinite(nowMs) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      return {
        ok: false,
        reason: "error",
        cause: { kind: "fault", detail: "malformed now or non-positive/non-finite TTL" },
      };
    }
    const now = isoInstant(nowMs);
    const expiresAt = isoInstant(nowMs + ttlMs);
    const acquire = db
      .prepare(ACQUIRE_SQL)
      .bind(
        key.installation_id,
        key.owner,
        key.repo,
        key.pr_number,
        key.workspace_id,
        opts.attemptId,
        opts.headSha ?? "",
        now,
        expiresAt,
        now,
        now,
        opts.systemCap,
        key.workspace_id,
        now,
        now,
        opts.workspaceCap,
        now,
        opts.attemptId,
        opts.priorStopped?.attemptId ?? "",
      );
    const written = await acquire.run();
    if (written.meta.changes === 1) return { ok: true };

    const row = await db
      .prepare(REFUSAL_SQL)
      .bind(
        key.installation_id,
        key.owner,
        key.repo,
        key.pr_number,
        now,
        key.installation_id,
        key.owner,
        key.repo,
        key.pr_number,
        now,
        now,
        key.workspace_id,
        now,
        now,
        key.installation_id,
        key.owner,
        key.repo,
        key.pr_number,
        key.installation_id,
        key.owner,
        key.repo,
        key.pr_number,
      )
      .first<{
        held: number;
        held_head_sha: string | null;
        total: number;
        workspace_total: number;
        held_attempt_id: string | null;
        held_expires_at: string | null;
      }>();
    if (row === null) {
      return { ok: false, reason: "error", cause: { kind: "fault", detail: "refusal read returned no row" } };
    }
    if (row.held > 0 || row.held_attempt_id !== null) {
      return {
        ok: false,
        reason: "pr-held",
        heldHeadSha: row.held_head_sha ?? "",
        heldAttemptId: row.held_attempt_id ?? "",
        heldExpired: row.held_expires_at !== null && Date.parse(row.held_expires_at) <= nowMs,
      };
    }
    if (row.total >= opts.systemCap) return { ok: false, reason: "system-cap" };
    if (row.workspace_total >= opts.workspaceCap) return { ok: false, reason: "workspace-cap" };
    return { ok: false, reason: "error", cause: { kind: "released-between-statements" } };
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      cause: { kind: "fault", detail: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Extend the lease of the row THIS attempt wrote (scoped by `attempt_id`, so a
 * newer owner's row is never touched). Needed when the attempt ends up
 * executing under a LATER settled instant than the candidate its admission was
 * sized from: the lease and the attempt's hard stop must cover one value.
 * Monotonic — an already-longer row is left alone, so a replay never shortens a
 * lease.
 */
export async function extendInflightTtl(
  db: D1Like,
  rawKey: InflightKey,
  attemptId: string,
  ttlSeconds: number,
): Promise<void> {
  const key = normalizeKey(rawKey);
  const nowMs = Date.now();
  const expiresAt = isoInstant(nowMs + ttlSeconds * 1000);
  await db
    .prepare(
      `UPDATE review_inflight SET expires_at = ?
        WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND attempt_id = ?
          AND expires_at < ?`,
    )
    .bind(expiresAt, key.installation_id, key.owner, key.repo, key.pr_number, attemptId, expiresAt)
    .run();
}

/**
 * End this attempt's lease as part of the settlement that recorded its outcome:
 * the release shortens `expires_at` to now, so the row stops counting against
 * the caps at once instead of holding a slot until a TTL nobody will shorten.
 *
 * The row is NOT deleted. It still records who held the PR, so a successor on
 * the same pull request reaches the ordinary `pr-held` refusal and must provide
 * the container's stop proof before it takes over — the same guard the cleanup's
 * own `releaseInflight` removes along with the row.
 *
 * `extraGuard` is the caller's own precondition on `?1` (the attempt); the
 * release batch passes its launch condition, so a row whose launch was
 * terminalized another way keeps its full lease.
 */
export function expireInflightStatement(
  db: D1Like,
  key: Pick<InflightKey, "installation_id" | "owner" | "repo" | "pr_number">,
  attemptId: string,
  nowMs: number,
  extraGuard = "",
): D1StatementLike {
  return db
    .prepare(
      `UPDATE review_inflight SET expires_at = ?2
        WHERE attempt_id = ?1 AND installation_id = ?3 AND owner = ?4 AND repo = ?5 AND pr_number = ?6
          ${extraGuard === "" ? "" : `AND ${extraGuard}`}`,
    )
    .bind(attemptId, isoInstant(nowMs), key.installation_id, key.owner.toLowerCase(), key.repo.toLowerCase(), key.pr_number);
}

/**
 * Release this attempt's row (spec §1.4). Scoped by `attempt_id`, so the
 * previous attempt can never delete a row a newer attempt reclaimed. A
 * storage failure propagates: the row still expires by TTL, and the caller's
 * `finally` owns the warn.
 */
export async function releaseInflight(
  db: D1Like,
  rawKey: InflightKey,
  attemptId: string,
): Promise<void> {
  const key = normalizeKey(rawKey);
  await db
    .prepare(RELEASE_SQL)
    .bind(key.installation_id, key.owner, key.repo, key.pr_number, attemptId)
    .run();
}

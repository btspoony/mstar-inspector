/**
 * In-flight review store (iteration spec review-concurrency §1) — the per-PR
 * lock and capacity reservation for one queue message (migration 0041:
 * `review_inflight`).
 *
 * One row per review in flight is BOTH the mutex and the reservation, so
 * acquisition is ONE statement (`ACQUIRE_SQL`): the conditional `INSERT …
 * SELECT … WHERE counts < caps` never reads before it writes, and D1's
 * single-writer serialization is what makes the check-and-insert atomic. The
 * caller inspects `meta.changes` (the repo's claim convention, see
 * src/store/finding-lifecycle.ts) and nothing else.
 *
 * Expiry reclaim: a plain `INSERT OR IGNORE` would refuse forever after a row
 * expired, because the PRIMARY KEY still conflicts. The upsert branch
 * (`ON CONFLICT … DO UPDATE … WHERE review_inflight.expires_at <= now`)
 * replaces an EXPIRED row in place and refuses a live one; expired rows are
 * excluded from both cap counts, so a reclaimed row never counts twice.
 *
 * A zero-row result carries no cause, so a refusal costs exactly one follow-up
 * read (spec §1.3 lists the four reasons). The read is diagnostic only — it
 * never decides admission; a raced read whose numbers no longer explain the
 * refusal answers `error` (defer), never `ok`. That read also returns the
 * `heldHeadSha` of the row holding the PR: a `pr-held` refusal is only benign
 * while the live review covers the same commit, and the caller cannot tell
 * without it.
 *
 * Any storage failure answers `error` (spec §1.3: a storage failure is `error`
 * and never admits). The exception itself is not dropped: it rides the result
 * as an `InflightErrorCause` so the caller's warn line and its terminal drop row
 * name the fault, which is otherwise indistinguishable from the benign
 * released-between-statements race (the same refusal code, a different problem).
 *
 * Key normalization: GitHub treats `owner`/`repo` case-insensitively, while
 * SQLite compares the PRIMARY KEY's TEXT columns case-SENSITIVELY. Both
 * functions therefore fold `owner` and `repo` to lower case at this one
 * boundary (`normalizeKey`) before binding them, so `Acme/Repo` and
 * `acme/repo` are the same lock row for the insert, the refusal read and the
 * release — the three statements that must agree for the lock to hold. No
 * caller normalizes; a second normalization site would be a second truth.
 *
 * Module boundary (the artifact-store precedent): `db` is the narrow D1 face
 * (`D1Like`); no worker/pipeline import, so this store can be unit-tested over
 * the real migration DDL.
 */
import type { D1Like } from "./types";

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
  /**
   * `heldHeadSha` is the sha the live row was taken for (`""` = a
   * comment-triggered review carried none): the terminal drop record needs it
   * to tell a duplicate of that review from a commit it never covers.
   */
  | { ok: false; reason: "pr-held"; heldHeadSha: string }
  | { ok: false; reason: "error"; cause: InflightErrorCause };

/** The operator-facing text of an `error` refusal (log field, drop row). */
export function describeInflightError(cause: InflightErrorCause): string {
  return cause.kind === "fault"
    ? `fault: ${cause.detail}`
    : "capacity released between statements — no listed refusal reason applies";
}

export type AcquireInflightOptions = {
  /** System-wide live-row ceiling (the per-message system cap the caller read). */
  systemCap: number;
  /** This workspace's live-row ceiling (the per-message workspace cap the caller read). */
  workspaceCap: number;
  /** This attempt's release fence; release only deletes the row it wrote. */
  attemptId: string;
  /** Row lifetime (seconds, must be > 0) — callers pass `reviewGuardTtlSeconds(level)`. */
  ttlSeconds: number;
  /**
   * The commit this attempt reviews; `null` for a comment trigger, which
   * resolves the head in-sandbox and carries none. Stored as `""` (the
   * `review_failures` convention) so the column stays single-valued.
   */
  headSha: string | null;
  /** ISO-8601 instant the acquisition is evaluated at. */
  now: string;
};

/**
 * Acquire the PR's lock and a capacity slot in ONE conditional insert.
 *
 * `meta.changes === 1` is the only success signal: it means the anchor row was
 * new (or its expired predecessor was replaced). `0` means the PR is held, a
 * cap is reached, or the row raced away — disambiguated below.
 */
const ACQUIRE_SQL = `
INSERT INTO review_inflight
  (installation_id, owner, repo, pr_number, workspace_id, attempt_id, head_sha, acquired_at, expires_at)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE (SELECT COUNT(*) FROM review_inflight WHERE expires_at > ?) < ?
  AND (SELECT COUNT(*) FROM review_inflight WHERE workspace_id = ? AND expires_at > ?) < ?
ON CONFLICT (installation_id, owner, repo, pr_number) DO UPDATE SET
  workspace_id = excluded.workspace_id,
  attempt_id   = excluded.attempt_id,
  head_sha     = excluded.head_sha,
  acquired_at  = excluded.acquired_at,
  expires_at   = excluded.expires_at
WHERE review_inflight.expires_at <= ?
`;

/** The one follow-up read a zero-row acquire owes (diagnostic only). */
const REFUSAL_SQL = `
SELECT
  (SELECT COUNT(*) FROM review_inflight
    WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
      AND expires_at > ?) AS held,
  (SELECT head_sha FROM review_inflight
    WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
      AND expires_at > ?) AS held_head_sha,
  (SELECT COUNT(*) FROM review_inflight WHERE expires_at > ?) AS total,
  (SELECT COUNT(*) FROM review_inflight
    WHERE workspace_id = ? AND expires_at > ?) AS workspace_total
`;

const RELEASE_SQL = `
DELETE FROM review_inflight
WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND attempt_id = ?
`;

/** ISO-8601 with milliseconds — the ONE text form `expires_at > now` compares correctly. */
function isoInstant(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * The key as it is written and compared. GitHub's owner/repo are
 * case-insensitive; the row's PRIMARY KEY is not. Folding here — the one
 * key-building boundary — keeps insert, refusal read and release on the same
 * row for `Acme/Repo` and `acme/repo`.
 */
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
    // Conversions live inside the try: a malformed `now` (RangeError) or a
    // non-positive/non-finite TTL must answer `error` like any other
    // storage-layer refusal, never escape as a throw. A TTL of zero or less
    // would write an ALREADY-EXPIRED row: it holds no PR and reserves no
    // slot, yet `meta.changes === 1` would report `ok` — a lock that admits.
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
    const written = await db
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
        // System cap: live rows overall.
        now,
        opts.systemCap,
        // Workspace cap: live rows of this tenant.
        key.workspace_id,
        now,
        opts.workspaceCap,
        // Reclaim guard: only an EXPIRED row may be replaced.
        now,
      )
      .run();
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
      )
      .first<{ held: number; held_head_sha: string; total: number; workspace_total: number }>();
    if (row === null) {
      return { ok: false, reason: "error", cause: { kind: "fault", detail: "refusal read returned no row" } };
    }
    if (row.held > 0) return { ok: false, reason: "pr-held", heldHeadSha: row.held_head_sha };
    if (row.total >= opts.systemCap) return { ok: false, reason: "system-cap" };
    if (row.workspace_total >= opts.workspaceCap) return { ok: false, reason: "workspace-cap" };
    // The capacity this attempt was refused on was released between the two
    // statements. No listed reason explains it, and guessing would admit a
    // message the insert already refused.
    return { ok: false, reason: "error", cause: { kind: "released-between-statements" } };
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      // Threaded, never swallowed: a dead binding and a raced release are the
      // same refusal code, and only this string tells them apart downstream.
      cause: { kind: "fault", detail: err instanceof Error ? err.message : String(err) },
    };
  }
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

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
 * refusal answers `error` (defer), never `ok`.
 *
 * Any storage failure answers `error` (spec §1.3: a storage failure is `error`
 * and never admits) — the exception is swallowed here because the caller has
 * the log channel and the retry schedule.
 *
 * Module boundary (the artifact-store precedent): `db` is the narrow D1 face
 * (`D1Like`); no worker/pipeline import, so this store can be unit-tested over
 * the real migration DDL.
 */
import type { D1Like } from "./types";

/** The per-PR identity plus the tenant the caps are counted against. */
export type InflightKey = {
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  workspace_id: string;
};

/** Why an acquire refused (spec §1.3). `error` = storage failure, always refused. */
export type InflightRefusal = "pr-held" | "system-cap" | "workspace-cap" | "error";

export type InflightAcquireResult = { ok: true } | { ok: false; reason: InflightRefusal };

export type AcquireInflightOptions = {
  /** System-wide live-row ceiling (plan 309's effective system cap). */
  systemCap: number;
  /** This workspace's live-row ceiling (plan 309's effective workspace cap). */
  workspaceCap: number;
  /** This attempt's release fence; release only deletes the row it wrote. */
  attemptId: string;
  /** Row lifetime (seconds) — callers pass `reviewGuardTtlSeconds(level)`. */
  ttlSeconds: number;
  /** ISO-8601 instant the acquisition is evaluated at. */
  now: string;
};

/**
 * Level-less fallback TTL (seconds): the `default` level's guard budget
 * (`reviewGuardTtlSeconds("default")` — 10min runner + five 120s git steps +
 * 120s slack). It is written as a literal rather than imported because the
 * consumer imports THIS module, and a module-scope call back into consumer.ts
 * would read its not-yet-initialized budget table (circular-import TDZ). The
 * equality is pinned by the test file; callers that know the review level must
 * pass `reviewGuardTtlSeconds(level)` instead.
 */
export const INFLIGHT_DEFAULT_TTL_SECONDS = 1320;

/**
 * Acquire the PR's lock and a capacity slot in ONE conditional insert.
 *
 * `meta.changes === 1` is the only success signal: it means the anchor row was
 * new (or its expired predecessor was replaced). `0` means the PR is held, a
 * cap is reached, or the row raced away — disambiguated below.
 */
const ACQUIRE_SQL = `
INSERT INTO review_inflight
  (installation_id, owner, repo, pr_number, workspace_id, attempt_id, acquired_at, expires_at)
SELECT ?, ?, ?, ?, ?, ?, ?, ?
WHERE (SELECT COUNT(*) FROM review_inflight WHERE expires_at > ?) < ?
  AND (SELECT COUNT(*) FROM review_inflight WHERE workspace_id = ? AND expires_at > ?) < ?
ON CONFLICT (installation_id, owner, repo, pr_number) DO UPDATE SET
  workspace_id = excluded.workspace_id,
  attempt_id   = excluded.attempt_id,
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
  (SELECT COUNT(*) FROM review_inflight WHERE expires_at > ?) AS total,
  (SELECT COUNT(*) FROM review_inflight
    WHERE workspace_id = ? AND expires_at > ?) AS workspace_total
`;

const RELEASE_SQL = `
DELETE FROM review_inflight
WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND attempt_id = ?
`;

/**
 * Diagnostics: live rows now, and how many workspaces hold at least one of
 * them (`byWorkspace`) — the headroom view for tuning the caps.
 */
const COUNT_SQL = `
SELECT
  (SELECT COUNT(*) FROM review_inflight WHERE expires_at > ?) AS total,
  (SELECT COUNT(DISTINCT workspace_id) FROM review_inflight WHERE expires_at > ?) AS by_workspace
`;

/** ISO-8601 with milliseconds — the ONE text form `expires_at > now` compares correctly. */
function isoInstant(ms: number): string {
  return new Date(ms).toISOString();
}

export async function acquireInflight(
  db: D1Like,
  key: InflightKey,
  opts: AcquireInflightOptions,
): Promise<InflightAcquireResult> {
  const now = isoInstant(Date.parse(opts.now));
  const expiresAt = isoInstant(Date.parse(opts.now) + opts.ttlSeconds * 1000);
  try {
    const written = await db
      .prepare(ACQUIRE_SQL)
      .bind(
        key.installation_id,
        key.owner,
        key.repo,
        key.pr_number,
        key.workspace_id,
        opts.attemptId,
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
      .bind(key.installation_id, key.owner, key.repo, key.pr_number, now, now, key.workspace_id, now)
      .first<{ held: number; total: number; workspace_total: number }>();
    if (row === null) return { ok: false, reason: "error" };
    if (row.held > 0) return { ok: false, reason: "pr-held" };
    if (row.total >= opts.systemCap) return { ok: false, reason: "system-cap" };
    if (row.workspace_total >= opts.workspaceCap) return { ok: false, reason: "workspace-cap" };
    // The capacity this attempt was refused on was released between the two
    // statements. No listed reason explains it, and guessing would admit a
    // message the insert already refused.
    return { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "error" };
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
  key: InflightKey,
  attemptId: string,
): Promise<void> {
  await db
    .prepare(RELEASE_SQL)
    .bind(key.installation_id, key.owner, key.repo, key.pr_number, attemptId)
    .run();
}

/** Diagnostics only — never an admission decision (that is `ACQUIRE_SQL`). */
export async function countInflight(
  db: D1Like,
  now: string,
): Promise<{ total: number; byWorkspace: number }> {
  const instant = isoInstant(Date.parse(now));
  const row = await db
    .prepare(COUNT_SQL)
    .bind(instant, instant)
    .first<{ total: number; by_workspace: number }>();
  return { total: Number(row?.total ?? 0), byWorkspace: Number(row?.by_workspace ?? 0) };
}

/**
 * Usage ledger leaf (migration 0031) — the single write authority for
 * `usage_events`. One row per STARTED execution of a review; `seq` is the
 * attempt number within one `review_id`, minted by the ledger itself so
 * concurrent writers cannot agree on the same value.
 *
 * The insert is ONE statement (`INSERT … SELECT MAX(seq)+1`): the read and
 * the write happen inside the same statement, so there is no read-then-write
 * window. `review_id` has no FK on purpose (an attempt can outlive a review
 * row that rolled back); `workspace_id` does, and an unknown workspace is
 * refused by the schema.
 *
 * Module boundary (compass contracts A): type imports from ./types only — no
 * worker/pipeline/session dependencies (same contract as failure-store.ts).
 */

import type { D1Like } from "./types";

/**
 * Which key source paid for a started execution. The same vocabulary as
 * `QuotaSource` in `./quota-store` (this leaf declares its own copy so the
 * ledger keeps its "type imports from ./types only" boundary).
 */
export type UsageSource = "byok" | "shared";

/** The usage row input. `occurredAt` is an ISO-8601 string supplied by the caller. */
export type UsageEventInput = {
  reviewId: string;
  /**
   * One per STARTED execution attempt, minted by the producer before it writes
   * (UNIQUE in the table). It is the identity a failed insert is read back by:
   * earlier attempts for the same review must never answer for this one.
   */
  executionToken: string;
  workspaceId: string;
  occurredAt: string;
  /**
   * The RP this started execution costs, from `rpFor(level, source, profile)`.
   * `0` is reserved for rows written before migration 0064 metered the ledger:
   * `rpFor` is >= 1 by construction, so a metered row can never read as 0.
   */
  rp: number;
  /**
   * The source that price was computed from — `shared` for the shared bot,
   * `byok` for the workspace's own App (D7: BYOK is metered too). Stored
   * beside `rp` because the product of the two factors cannot be decomposed
   * back into them once a profile chooses its own multipliers.
   */
  source: UsageSource;
};

/**
 * This workspace's started executions at or after `sinceIso` — the
 * month-to-date read behind the settings surface. `occurred_at` is an
 * ISO-8601 UTC string, so the string comparison is the time comparison.
 */
export async function countUsageEventsSince(
  db: D1Like,
  workspaceId: string,
  sinceIso: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE workspace_id = ? AND occurred_at >= ?`)
    .bind(workspaceId, sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** One workspace's month in RP, with the source split the card shows. */
export type MonthlyRpUsage = {
  workspaceId: string;
  /** `SUM(rp)` — the ceiling's own number, never the parts re-added. */
  total: number;
  sharedRp: number;
  byokRp: number;
};

/**
 * THE month aggregation over `usage_events.rp`: one row per workspace that
 * spent RP in the half-open window, with the `source` split of the same rows.
 * Both faces bind this one expression — the tenant face through
 * {@link readMonthlyRp}, the operator preview through
 * {@link readMonthlyRpByWorkspace} — so `sharedRp + byokRp === total` (for rows
 * written since migration 0065) and no face can invent a second definition.
 *
 * Two statement texts, one aggregate, and two DIFFERENT indexes — chosen by
 * predicate, not by taste:
 *
 * - the tenant form leads `workspace_id = ?` and rides
 *   `usage_events_workspace_occurred (workspace_id, occurred_at)` (migration
 *   0031), so the enqueue's read — this is the pre-enqueue path of every
 *   review — stays a seek;
 * - the preview binds no workspace at all, so its predicate is the window, and
 *   it rides `idx_usage_events_occurred_rp (occurred_at, workspace_id, rp,
 *   source)` (migration 0066), which also covers the three aggregated columns.
 *
 * Spelling the tenant form as `(?1 IS NULL OR workspace_id = ?1)` to reach both
 * shapes from one text would make SQLite scan the whole index — it cannot fold
 * a parameter-only OR branch into the seek.
 *
 * `rp` is 0 on every row written before migration 0064 and `source` is NULL on
 * every row written before 0065, so a pre-metering row contributes to nothing.
 */
const MONTH_RP_AGGREGATE = `SELECT workspace_id AS workspaceId,
              COALESCE(SUM(rp), 0) AS total,
              COALESCE(SUM(CASE WHEN source = 'shared' THEN rp ELSE 0 END), 0) AS sharedRp,
              COALESCE(SUM(CASE WHEN source = 'byok' THEN rp ELSE 0 END), 0) AS byokRp
         FROM usage_events`;

function monthlyRpRow(row: MonthlyRpUsage): MonthlyRpUsage {
  return {
    workspaceId: row.workspaceId,
    total: Number(row.total),
    sharedRp: Number(row.sharedRp),
    byokRp: Number(row.byokRp),
  };
}

/** One workspace's month — the tenant card's read and the ceiling's own read. */
export async function readMonthlyRp(
  db: D1Like,
  workspaceId: string,
  startIso: string,
  endIso: string,
): Promise<MonthlyRpUsage[]> {
  const res = await db
    .prepare(
      `${MONTH_RP_AGGREGATE}
        WHERE workspace_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3
        GROUP BY workspace_id`,
    )
    .bind(workspaceId, startIso, endIso)
    .all<MonthlyRpUsage>();
  return res.results.map(monthlyRpRow);
}

/** Every workspace's month in one statement — the operator's impact preview. */
export async function readMonthlyRpByWorkspace(
  db: D1Like,
  startIso: string,
  endIso: string,
): Promise<MonthlyRpUsage[]> {
  const res = await db
    .prepare(
      `${MONTH_RP_AGGREGATE}
        WHERE occurred_at >= ?1 AND occurred_at < ?2
        GROUP BY workspace_id`,
    )
    .bind(startIso, endIso)
    .all<MonthlyRpUsage>();
  return res.results.map(monthlyRpRow);
}

/**
 * The RP this workspace spent in the half-open window — the ceiling's own read
 * and the number the tenant card shows. It answers from
 * {@link readMonthlyRp} rather than a second `SUM`, so it cannot disagree with
 * the split beside it. A workspace with no row in the window spent nothing.
 */
export async function sumMonthlyRp(
  db: D1Like,
  workspaceId: string,
  startIso: string,
  endIso: string,
): Promise<number> {
  const rows = await readMonthlyRp(db, workspaceId, startIso, endIso);
  return rows[0]?.total ?? 0;
}

/** Append one started-execution row, minting the attempt `seq`. */
export async function recordUsageEvent(db: D1Like, input: UsageEventInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at, rp, source)
       SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3, ?4, ?5, ?6 FROM usage_events WHERE review_id = ?1`,
    )
    .bind(
      input.reviewId,
      input.executionToken,
      input.workspaceId,
      input.occurredAt,
      input.rp,
      input.source,
    )
    .run();
}

/**
 * Whether THIS execution attempt's row landed — the read-back that tells a
 * PRE-commit insert failure apart from an ambiguous one (the write landed, the
 * driver threw). It asks by `execution_token`, never by a row count: a review
 * may already hold earlier attempts, and a count would mislabel a failed second
 * attempt as applied. Only `false` is backfillable.
 */
export async function hasUsageEventForExecutionToken(
  db: D1Like,
  executionToken: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS present FROM usage_events WHERE execution_token = ?`)
    .bind(executionToken)
    .first<{ present: number }>();
  return row !== null;
}

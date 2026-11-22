
import type { D1Like } from "./types";

/**
 * note: Which key source paid for a started execution. The same vocabulary as
 * `QuotaSource` in `./quota-store` (this leaf declares its own copy so the
 * ledger keeps its "type imports from ./types only" boundary).
 */
export type UsageSource = "byok" | "shared";

/** The usage row input. `occurredAt` is an ISO-8601 string supplied by the caller. */
export type UsageEventInput = {
  reviewId: string;
  executionToken: string;
  workspaceId: string;
  occurredAt: string;
  rp: number;
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
  total: number;
  sharedRp: number;
  byokRp: number;
};

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

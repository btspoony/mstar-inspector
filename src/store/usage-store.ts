
import type { ReviewLevel } from "../../packages/shared/src/runtime";
import type { D1Like } from "./types";

/**
 * note: Which key source paid for a started execution. The same vocabulary as
 * `QuotaSource` in `./quota-store` (this leaf declares its own copy so the
 * ledger keeps its "type imports from ./types only" boundary).
 */
export type UsageSource = "byok" | "shared";

/** The inputs of one metering call. `occurredAt` is an ISO-8601 instant. */
export type ChargeUsageInput = {
  reviewId: string;
  executionToken: string;
  workspaceId: string;
  occurredAt: string;
  /** The UTC `YYYY-MM` label `quotaMonth` produces — the binding's key. */
  month: string;
  level: ReviewLevel;
  /** The executing bot's price factor (D11). */
  multiplier: number;
  source: UsageSource;
  // The executing bot (`botRef.botId`). REQUIRED on every write: the column
  // stays nullable for pre-split history, but no production row may be written
  // unattributed — an unwired caller is a compile error, never a NULL.
  botId: string;
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

/** The price column a review level reads. A FIXED allow-list, never input. */
const LEVEL_BASE_COLUMN: Record<ReviewLevel, string> = {
  quick: "base_quick",
  default: "base_standard",
  deep: "base_deep",
};

/**
 * One metering call: bind the month's version, price the review and append the
 * usage row — ALL in one batch, so the three can never disagree.
 *
 * The two statements are ONE write, and that is the whole design:
 *
 *  - **Statement 1** binds `(workspace, month)` to the profile in force at
 *    `occurredAt`, `INSERT OR IGNORE` so a concurrent first metering keeps one
 *    row, and only `WHERE NOT EXISTS` a usage row for this token. A replayed
 *    token therefore binds NOTHING — including a replay in a new month, which is
 *    what closes I1.
 *  - **Statement 2** appends the usage row, priced by JOINing the binding
 *    statement 1 (or a concurrent statement 1) actually left in the table — so
 *    the price follows the BINDING, never a resolve the caller did beforehand —
 *    and again only when this token has not been charged.
 *
 * Because they are one batch: a failed bot lookup or an insert error rolls the
 * binding back with the row (no premature binding), and a concurrent first
 * metering cannot leave a binding without its matching usage row.
 *
 * Pricing happens in SQL because the two statements must be atomic. `rp` is
 * `max(1, ceil(base * multiplier))` — the same rule `rpFor` states for callers
 * that price outside a batch. The ceiling is spelled portably as
 * `CAST(x AS INTEGER) + CASE WHEN x > CAST(x AS INTEGER) THEN 1 ELSE 0 END`:
 * `ceil()` is available in this engine, but the spelled-out form is the one
 * this repo can rely on if a driver or target lacks it, and it is exact for
 * positive products (all factors are > 0 by DDL CHECK).
 *
 * `seq` is minted inside the same statement, so the attempt ordinal is a
 * property of the write, not of a prior read.
 */
export async function chargeUsage(
  db: D1Like,
  input: ChargeUsageInput,
): Promise<{ charged: boolean }> {
  const baseColumn = LEVEL_BASE_COLUMN[input.level];
  if (baseColumn === undefined) {
    throw new Error(`chargeUsage: unknown review level '${input.level}'`);
  }
  const results = await db.batch([
    db
      .prepare(
        // The SAME rule as `resolveQuotaProfile`: the latest profile at or
        // before the instant, else the EARLIEST (a month that precedes every
        // profile is still resolvable). Expressed as one statement so the bind
        // and the price below it read one table state.
        `INSERT OR IGNORE INTO workspace_quota_binding (workspace_id, month, profile_id)
         SELECT ?1, ?2, p.id
           FROM quota_profiles p
          WHERE NOT EXISTS (SELECT 1 FROM usage_events u WHERE u.execution_token = ?4)
          ORDER BY CASE WHEN p.effective_from <= ?3 THEN 0 ELSE 1 END,
                   CASE WHEN p.effective_from <= ?3 THEN p.effective_from END DESC,
                   p.effective_from ASC
          LIMIT 1`,
      )
      .bind(input.workspaceId, input.month, input.occurredAt, input.executionToken),
    db
      .prepare(
        `INSERT INTO usage_events
           (review_id, seq, execution_token, workspace_id, occurred_at, rp, source, bot_id)
         SELECT ?5,
                (SELECT COALESCE(MAX(seq), 0) + 1 FROM usage_events WHERE review_id = ?5),
                ?4, ?1, ?6,
                max(1, CAST(p.${baseColumn} * ?7 AS INTEGER)
                       + CASE WHEN p.${baseColumn} * ?7 > CAST(p.${baseColumn} * ?7 AS INTEGER)
                              THEN 1 ELSE 0 END),
                ?8, ?9
           FROM workspace_quota_binding b
           JOIN quota_profiles p ON p.id = b.profile_id
          WHERE b.workspace_id = ?1
            AND b.month = ?2
            AND NOT EXISTS (SELECT 1 FROM usage_events u WHERE u.execution_token = ?4)`,
      )
      .bind(
        input.workspaceId,
        input.month,
        input.occurredAt,
        input.executionToken,
        input.reviewId,
        input.occurredAt,
        input.multiplier,
        input.source,
        input.botId,
      ),
  ]);
  // The usage insert is the last statement: its change count says whether this
  // call charged anything. A token already charged, or a workspace with no
  // profile, appends nothing and the caller must not log a phantom charge.
  return { charged: (results[1]?.meta.changes ?? 0) > 0 };
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

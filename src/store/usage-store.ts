
import type { ReviewLevel } from "../../packages/shared/src/runtime";
import { isBotMultiplier, isRpCeiling, isRpPrice, QUOTA_BASE_MAX, RP_CEILING_MAX } from "../contracts/rp-limits";
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
  botId?: string,
): Promise<number> {
  // A bot's own month is the same sum with one more predicate on the index
  // `usage_events` already carries for the window.
  if (botId !== undefined) {
    const row = await db
      .prepare(
        `SELECT COALESCE(SUM(rp), 0) AS total FROM usage_events
          WHERE workspace_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3 AND bot_id = ?4`,
      )
      .bind(workspaceId, startIso, endIso, botId)
      .first<{ total: number }>();
    return Number(row?.total ?? 0);
  }
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
 * The price expression, spelled ONCE: `max(1, ceil(base × multiplier))`, with
 * the multiplier's placeholder named by the caller so each statement numbers
 * its own parameters without a surplus bind (D1 rejects those). The ceiling is
 * written portably as `CAST(x AS INTEGER) + CASE WHEN x > CAST(x AS INTEGER)
 * THEN 1 ELSE 0 END` — `ceil()` exists in this engine, but the spelled-out form
 * is what this repo can rely on if a driver or target lacks it, and it is exact
 * for positive products. `rpFor` states the same rule for callers that price
 * outside a batch.
 */
function priceOf(baseColumn: string, multiplierParam: string): string {
  const product = `p.${baseColumn} * ${multiplierParam}`;
  return `max(1, CAST(${product} AS INTEGER) + CASE WHEN ${product} > CAST(${product} AS INTEGER) THEN 1 ELSE 0 END)`;
}

/** Why a charge was refused: the stored factors price outside the RP domain. */
export type ChargeRefusal = "price-out-of-domain";

/**
 * One metering call: bind the month's version, price the review and append the
 * usage row — ALL in one batch, so the three can never disagree.
 *
 * The statements are ONE write, and that is the whole design:
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
 *  - **Statement 3** reports the factors statement 2 would have priced with, so
 *    a refusal can be NAMED. It reads the same table state in the same batch and
 *    writes nothing.
 *
 * Because they are one batch: a failed bot lookup or an insert error rolls the
 * binding back with the row (no premature binding), and a concurrent first
 * metering cannot leave a binding without its matching usage row.
 *
 * THE RP DOMAIN IS ENFORCED HERE, at the charge — for EVERY path, own-bot and
 * self-hosted included. The relay refuses an out-of-domain bot before a
 * delivery is admitted, but it is not the only way a row reaches this write, and
 * a stored multiplier or profile that some other writer admitted must never
 * produce an out-of-range charge. Statement 2 therefore admits a price only when
 * all three of its factors are inside the shared domain `src/contracts/rp-limits`
 * defines — the multiplier, the profile's base weight for this level, and the
 * computed product — and refuses (appends nothing, reports `price-out-of-domain`)
 * otherwise. The base weight must also be a WHOLE positive number: the column is
 * declared INTEGER, but the engine's affinity stores a REAL in it, and a stored
 * `1.5` would otherwise bind the month and price a charge from a weight no writer
 * admitted. Refusing to record an unrepresentable charge is the only safe
 * answer: a charge no ceiling can bound would be unpayable AND unrefundable.
 *
 * `seq` is minted inside the same statement, so the attempt ordinal is a
 * property of the write, not of a prior read.
 */
export async function chargeUsage(
  db: D1Like,
  input: ChargeUsageInput,
): Promise<{ charged: boolean; refused?: ChargeRefusal }> {
  const baseColumn = LEVEL_BASE_COLUMN[input.level];
  if (baseColumn === undefined) {
    throw new Error(`chargeUsage: unknown review level '${input.level}'`);
  }
  // The one factor the caller supplies, so it is checked without a read: an
  // unbounded multiplier is refused before this write can even bind a month.
  // A REPLAY is the exception — a token that already paid is benign even if its
  // bot's row has since left the domain, and reporting it as a refusal would
  // raise a failure row for a run that was charged correctly.
  if (!isBotMultiplier(input.multiplier)) {
    if (await hasUsageEventForExecutionToken(db, input.executionToken)) return { charged: false };
    return { charged: false, refused: "price-out-of-domain" };
  }
  const results = await db.batch([
    db
      .prepare(
        // The SAME rule as `resolveQuotaProfile`: the latest profile at or
        // before the instant, else the EARLIEST (a month that precedes every
        // profile is still resolvable). Expressed as one statement so the bind
        // and the price below it read one table state.
        //
        // The resolved profile is then put THROUGH THE DOMAIN before it may be
        // pinned: a month bound to a profile that cannot price this review would
        // be a binding with no matching row — the invariant the batch exists to
        // keep. A governing profile outside the domain therefore binds nothing,
        // exactly as if no profile covered the instant.
        `INSERT OR IGNORE INTO workspace_quota_binding (workspace_id, month, profile_id)
         SELECT ?1, ?2, chosen.id
           FROM (SELECT p.id AS id, p.${baseColumn} AS base
                   FROM quota_profiles p
                  WHERE NOT EXISTS (SELECT 1 FROM usage_events u WHERE u.execution_token = ?4)
                  ORDER BY CASE WHEN p.effective_from <= ?3 THEN 0 ELSE 1 END,
                           CASE WHEN p.effective_from <= ?3 THEN p.effective_from END DESC,
                           p.effective_from ASC
                  LIMIT 1) chosen
          -- A whole, positive RP weight: the column is DECLARED INTEGER but the
          -- engine's affinity does not reject a REAL, so 1.5 would otherwise bind.
          WHERE chosen.base > 0
            AND chosen.base = CAST(chosen.base AS INTEGER)
            AND chosen.base <= ${QUOTA_BASE_MAX}`,
      )
      .bind(input.workspaceId, input.month, input.occurredAt, input.executionToken),
    db
      .prepare(
        `INSERT INTO usage_events
           (review_id, seq, execution_token, workspace_id, occurred_at, rp, source, bot_id)
         SELECT ?5,
                (SELECT COALESCE(MAX(seq), 0) + 1 FROM usage_events WHERE review_id = ?5),
                ?4, ?1, ?6,
                ${priceOf(baseColumn, "?7")},
                ?8, ?9
           FROM workspace_quota_binding b
           JOIN quota_profiles p ON p.id = b.profile_id
          WHERE b.workspace_id = ?1
            AND b.month = ?2
            AND NOT EXISTS (SELECT 1 FROM usage_events u WHERE u.execution_token = ?4)
            AND ${priceOf(baseColumn, "?7")} <= ${RP_CEILING_MAX}
            AND p.${baseColumn} > 0
            AND p.${baseColumn} = CAST(p.${baseColumn} AS INTEGER)
            AND p.${baseColumn} <= ${QUOTA_BASE_MAX}`,
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
    // The factors the statements above would have used, so a refusal can be
    // NAMED. It follows the same rule as statement 1 — the month's binding when
    // one exists, else the profile the resolver would pick — but WITHOUT the
    // domain filter, because an out-of-domain profile is exactly what it must
    // report. Gated on the token so a replay reports no factors rather than a
    // price that belongs to the run that already paid.
    db
      .prepare(
        `SELECT p.${baseColumn} AS base, ${priceOf(baseColumn, "?3")} AS rp
           FROM quota_profiles p
          WHERE p.id = COALESCE(
                  (SELECT b.profile_id FROM workspace_quota_binding b
                    WHERE b.workspace_id = ?1 AND b.month = ?2),
                  (SELECT q.id FROM quota_profiles q
                    ORDER BY CASE WHEN q.effective_from <= ?5 THEN 0 ELSE 1 END,
                             CASE WHEN q.effective_from <= ?5 THEN q.effective_from END DESC,
                             q.effective_from ASC
                    LIMIT 1))
            AND NOT EXISTS (SELECT 1 FROM usage_events u WHERE u.execution_token = ?4)`,
      )
      .bind(input.workspaceId, input.month, input.multiplier, input.executionToken, input.occurredAt),
  ]);
  // The usage insert is the second statement: its change count says whether this
  // call charged anything. A token already charged, or a workspace with no
  // profile, appends nothing and the caller must not log a phantom charge.
  if ((results[1]?.meta.changes ?? 0) > 0) return { charged: true };
  const [observed] = (results[2]?.results ?? []) as Array<{ base: number; rp: number }>;
  // A profile DID resolve and its price is outside the domain: the charge was
  // refused, not merely absent. Anything else is the caller's to interpret.
  // `isRpCeiling` is the shared whole-positive-integer test: a stored REAL base
  // (the INTEGER column's affinity admits one) fails it exactly as a too-large
  // weight does, and neither may record a row.
  if (observed !== undefined && (!isRpPrice(observed.rp) || !isRpCeiling(observed.base) || observed.base > QUOTA_BASE_MAX)) {
    return { charged: false, refused: "price-out-of-domain" };
  }
  return { charged: false };
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

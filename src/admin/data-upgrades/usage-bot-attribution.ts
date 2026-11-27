import type { DashboardD1 } from "../../dashboard/users";
import type {
  DataUpgradeItem,
  UpgradeBatch,
  UpgradeCounts,
  UpgradeCursor,
} from "../data-upgrades";

/**
 * Rows this batch may attribute: an unattributed usage row whose review names
 * a bot, where that bot belongs to the SAME workspace that paid. The workspace
 * guard is the whole point — attributing a row to another tenant's bot would
 * report one workspace's spend on another's bot, and the per-bot month cell
 * would show it.
 *
 * `rp > 0` is the report's scope, not a filter on the write: a pre-metering row
 * (rp = 0) spends nothing, so leaving it unattributed changes no number anyone
 * reads, and counting it would drown the real signal. The WRITE still leaves
 * those rows alone, which keeps this item's blast radius to rows that carry a
 * charge.
 *
 * shortcut: the cursor is the row's `occurred_at || rowid`, an expression, so
 * each batch scans for the first N matching rows rather than seeking.
 * upgrade: when a stored, indexed attribution column exists to range over.
 */
const UNATTRIBUTED = `
  SELECT u.rowid AS row_id, r.bot_id AS bot_id
    FROM usage_events u
    JOIN reviews r ON r.id = u.review_id
   WHERE u.bot_id IS NULL
     AND r.bot_id IS NOT NULL
     AND u.rp > 0`;

const ATTRIBUTED_COUNT = `
  SELECT COUNT(*) AS n FROM usage_events u
   WHERE u.bot_id IS NOT NULL AND u.rp > 0`;

/**
 * The work queue: charged rows this item can still attribute. This one must
 * reach zero.
 */
const ATTRIBUTABLE_COUNT = `
  SELECT COUNT(*) AS n FROM usage_events u
    JOIN reviews r ON r.id = u.review_id
    JOIN review_bots b ON b.id = r.bot_id AND b.deleted_at IS NULL
   WHERE u.bot_id IS NULL AND u.rp > 0 AND b.workspace_id = u.workspace_id`;

/** Unattributed rows whose review names a bot of ANOTHER workspace: never touched. */
const CROSS_WORKSPACE_COUNT = `
  SELECT COUNT(*) AS n FROM usage_events u
    JOIN reviews r ON r.id = u.review_id
    JOIN review_bots b ON b.id = r.bot_id
   WHERE u.bot_id IS NULL AND u.rp > 0 AND b.workspace_id <> u.workspace_id`;

/** Unattributed rows whose review names no bot at all: nothing to infer. */
const NO_EVIDENCE_COUNT = `
  SELECT COUNT(*) AS n FROM usage_events u
    JOIN reviews r ON r.id = u.review_id
   WHERE u.bot_id IS NULL AND u.rp > 0 AND r.bot_id IS NULL`;

/** Unattributed rows whose review's bot was soft-deleted: the bot is gone. */
const BOT_GONE_COUNT = `
  SELECT COUNT(*) AS n FROM usage_events u
    JOIN reviews r ON r.id = u.review_id
    JOIN review_bots b ON b.id = r.bot_id AND b.deleted_at IS NOT NULL
   WHERE u.bot_id IS NULL AND u.rp > 0`;

/**
 * Unattributed rows whose review is NOT IN `reviews` at all — a ledger row
 * orphaned from its review. Easy to forget, and forgetting it is how a charged
 * row escapes every count: it joins no review, so every other predicate above
 * skips it.
 */
const UNMATCHED_REVIEW_COUNT = `
  SELECT COUNT(*) AS n FROM usage_events u
   WHERE u.bot_id IS NULL AND u.rp > 0
     AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.id = u.review_id)`;

/**
 * Every charged row that can NEVER be attributed, counted by reason in ONE
 * statement. `verify` reports the total beside the work queue so an operator
 * sees the ceiling risk instead of reading a zero.
 */
const PERMANENTLY_UNATTRIBUTABLE_SQL = `
  SELECT
    -- DISJOINT buckets, tested in this order: no review, then no bot evidence,
    -- then a bot gone or foreign, then a bot of this workspace that the write
    -- guard still refused (it can only be a race, and it re-enters the queue).
    COALESCE(SUM(CASE WHEN r.id IS NULL THEN 1 ELSE 0 END), 0) AS unmatched_review,
    COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND r.bot_id IS NULL THEN 1 ELSE 0 END), 0) AS no_evidence,
    COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND r.bot_id IS NOT NULL AND b.id IS NULL
                      THEN 1 ELSE 0 END), 0) AS bot_gone,
    COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND b.id IS NOT NULL
                       AND b.deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS bot_deleted,
    COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND b.id IS NOT NULL
                       AND b.deleted_at IS NULL AND b.workspace_id <> u.workspace_id
                      THEN 1 ELSE 0 END), 0) AS cross_workspace
  FROM usage_events u
  LEFT JOIN reviews r ON r.id = u.review_id
  LEFT JOIN review_bots b ON b.id = r.bot_id
  WHERE u.bot_id IS NULL AND u.rp > 0`;

type UnattributableCounts = {
  cross_workspace: number;
  no_evidence: number;
  bot_gone: number;
  bot_deleted: number;
  unmatched_review: number;
};

/**
 * The named reasons, one row each. The four DISJOINT buckets sum to the number
 * of charged rows that no run of this item can ever attribute.
 *
 * `unmatched_review` exists because a row whose review is missing joins no
 * other bucket: forgetting it is exactly how a charged row escapes every count.
 */
async function unattributable(db: DashboardD1): Promise<UnattributableCounts> {
  const row = await db.prepare(PERMANENTLY_UNATTRIBUTABLE_SQL).first<UnattributableCounts>();
  return {
    cross_workspace: Number(row?.cross_workspace ?? 0),
    no_evidence: Number(row?.no_evidence ?? 0),
    bot_gone: Number(row?.bot_gone ?? 0),
    bot_deleted: Number(row?.bot_deleted ?? 0),
    unmatched_review: Number(row?.unmatched_review ?? 0),
  };
}

/** The four buckets are disjoint, so the total is their sum. */
function unattributableTotal(counts: UnattributableCounts): number {
  return (
    counts.cross_workspace +
    counts.no_evidence +
    counts.bot_gone +
    counts.bot_deleted +
    counts.unmatched_review
  );
}

const BATCH_ROWS = 200;

type Candidate = { rowId: number; botId: string };

async function countRows(db: DashboardD1, sql: string): Promise<number> {
  // shortcut: tenant-bypass — every count in this file is a workspace-scoped
  // aggregate or the guard itself; none projects a tenant-visible column.
  return (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
}

/**
 * The page of unattributed rows a batch walks, ordered by row id. It pages over
 * EVERY unattributed charged row, not just the attributable ones: the UPDATE's
 * own guard refuses a cross-workspace row, and the cursor must still advance
 * past it or the item would re-read it forever.
 */
async function nextPage(db: DashboardD1, cursor: UpgradeCursor | null): Promise<Candidate[]> {
  const after = typeof cursor?.after === "number" ? cursor.after : 0;
  const res = await db
    // shortcut: tenant-bypass — the workspace equality IS the guard.
    .prepare(`${UNATTRIBUTED} AND u.rowid > ?1 ORDER BY u.rowid LIMIT ${BATCH_ROWS}`)
    .bind(after)
    .all<{ row_id: number; bot_id: string }>();
  return res.results.map((row) => ({ rowId: row.row_id, botId: row.bot_id }));
}

/**
 * Attribute `usage_events.bot_id` from `reviews.bot_id` (app-bot-split Task 3
 * wrote the review's bot; the ledger's own column shipped nullable in 0117).
 *
 * Bot ceilings stay NULL until this item's report is checked: a per-bot cap
 * enforced against half-attributed history would cap the wrong bot, so 0121
 * shipped every `review_bots.monthly_rp` as NULL and only this report's numbers
 * justify setting one.
 */
export const orphanLedgerAttributionBot: DataUpgradeItem = {
  id: "usage-bot-attribution",
  title: "Usage bot attribution",
  impact:
    "Gives every charged usage row (rp > 0) the bot its review executed, when that bot belongs to the SAME workspace that paid. Rows whose review names a bot of another workspace, or no bot at all, are left NULL and counted — they are evidence a review predates the split or crossed a tenant, and attributing them would report one workspace's spend on another's bot. Idempotent and resumable in batches of 200 by row id. Per-bot monthly ceilings stay NULL until this report is checked: a cap enforced against unattributed history would cap the wrong bot.",
  requiresDowntime: false,
  order: 30,

  async preflight(db: DashboardD1): Promise<UpgradeCounts> {
    const blockers = await unattributable(db);
    return {
      attributed_rows: await countRows(db, ATTRIBUTED_COUNT),
      attributable_rows: await countRows(db, ATTRIBUTABLE_COUNT),
      permanently_unattributable_rows: unattributableTotal(blockers),
      ...blockers,
    };
  },

  async runBatch(db: DashboardD1, cursor: UpgradeCursor | null): Promise<UpgradeBatch> {
    const page = await nextPage(db, cursor);
    if (page.length === 0) {
      return { cursor: null, processed: 0, done: true, log: { attributed: 0, remaining: 0 } };
    }

    // ONE batch: every write in this page commits together, so a failure leaves
    // the cursor where it was and the whole page is retried — never half a page.
    const results = await db.batch(
      page.map((row) =>
        db
          // shortcut: tenant-bypass — the UPDATE carries the same-workspace guard.
          .prepare(
            `UPDATE usage_events
                SET bot_id = ?1
              WHERE rowid = ?2
                AND bot_id IS NULL
                AND workspace_id = (SELECT b.workspace_id FROM review_bots b
                                     WHERE b.id = ?1 AND b.deleted_at IS NULL)`,
          )
          .bind(row.botId, row.rowId),
      ),
    );
    const attributed = results.reduce((sum, result) => sum + (result?.meta.changes ?? 0), 0);
    const remaining = await countRows(db, ATTRIBUTABLE_COUNT);
    return {
      // The cursor advances even when a row did not change: those rows are
      // permanently unattributable (the guard refused them), and re-reading them
      // forever would never finish.
      cursor: { after: page[page.length - 1]!.rowId },
      processed: page.length,
      done: remaining === 0,
      log: { attributed, remaining },
    };
  },

  // Every PERMANENT bucket is advisory: inspect-and-accept. Only
  // `attributable_rows` gates, because no run of this item can ever repair a row
  // whose review is missing, names no bot, or names a bot of another workspace —
  // failing on those would make the upgrade fail forever. The operator still sees
  // them, which is the point: charged history nobody can attribute is a ceiling
  // risk, not a defect this item can fix.
  advisoryChecks: [
    "permanently_unattributable_rows",
    "cross_workspace",
    "no_evidence",
    "bot_gone",
    "bot_deleted",
    "unmatched_review",
  ],

  /**
   * BOTH numbers, always. A zero work queue with a non-zero permanent total means
   * charged history is unattributable — the operator must see that before setting
   * any per-bot ceiling, because a cap enforced against it would cap the wrong bot.
   */
  async verify(db: DashboardD1): Promise<UpgradeCounts> {
    const blockers = await unattributable(db);
    return {
      attributable_rows: await countRows(db, ATTRIBUTABLE_COUNT),
      permanently_unattributable_rows: unattributableTotal(blockers),
      ...blockers,
    };
  },
};

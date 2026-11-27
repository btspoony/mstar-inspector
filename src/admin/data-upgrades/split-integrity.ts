import { orphanInstallStateSql } from "../../dashboard/apps-store";
import type { DashboardD1 } from "../../dashboard/users";
import type {
  DataUpgradeItem,
  UpgradeBatch,
  UpgradeCounts,
  UpgradeCursor,
} from "../data-upgrades";

/**
 * The install-state count reads the sweep's own predicate verbatim —
 * `orphanInstallStateSql` is exported so this report and `installStateSweep`
 * cannot disagree about what "orphan" means. The other three counts are one
 * statement each, all read-only: this item repairs nothing, it reports.
 *
 * All four counts are advisory. None gates:
 * - `apps_without_bot` — the only repair is creating a Bot row, and no batch in
 *   the registry does that, so a gate would fail an item no run can complete.
 * - `chain_rows_with_deleted_bot` — the writers allow it and the relay reads
 *   past it (`CHAIN_SQL` joins `deleted_at IS NULL`): a fact, not a repair.
 * - `install_states_orphaned` — 0118 materialised states for workspaces that
 *   merely held a live target, a source the sweep does not recognise, so a
 *   migrated database legitimately reports non-zero until the next sweep.
 * - `unattributed_usage_rows` — `usage-bot-attribution`'s queue; a read-only
 *   report does not gate on another item's work. The duplication is held honest
 *   by one pinned identity: at any read instant it equals that item's
 *   `attributable_rows + permanently_unattributable_rows`, because every one of
 *   its buckets carries this same `bot_id IS NULL AND rp > 0` prefix and they
 *   exhaust it.
 */

const INSTALL_STATES_ORPHANED_COUNT = `
  SELECT COUNT(*) AS n FROM app_installations s
   WHERE ${orphanInstallStateSql("s")}`;

const UNATTRIBUTED_USAGE_COUNT = `
  SELECT COUNT(*) AS n FROM usage_events u
   WHERE u.bot_id IS NULL AND u.rp > 0`;

async function countRows(db: DashboardD1, sql: string): Promise<number> {
  return (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
}

async function counts(db: DashboardD1): Promise<UpgradeCounts> {
  const appsWithoutBot = await db
    // shortcut: tenant-bypass — a maintenance count over every workspace's Apps;
    // the projection is COUNT(*), no tenant-visible column.
    .prepare(
      `SELECT COUNT(*) AS n FROM github_apps g
        WHERE g.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM review_bots b
                           WHERE b.id = g.id AND b.deleted_at IS NULL)`,
    )
    .first<{ n: number }>();
  const chainRowsWithDeletedBot = await db
    // shortcut: tenant-bypass — a maintenance count over chain rows pointing at
    // a soft-deleted or missing Bot; the projection is COUNT(*), no tenant-visible column.
    .prepare(
      `SELECT COUNT(*) AS n FROM app_install_bots ib
        WHERE NOT EXISTS (SELECT 1 FROM review_bots b
                           WHERE b.id = ib.bot_id AND b.deleted_at IS NULL)`,
    )
    .first<{ n: number }>();
  return {
    apps_without_bot: appsWithoutBot?.n ?? 0,
    chain_rows_with_deleted_bot: chainRowsWithDeletedBot?.n ?? 0,
    install_states_orphaned: await countRows(db, INSTALL_STATES_ORPHANED_COUNT),
    unattributed_usage_rows: await countRows(db, UNATTRIBUTED_USAGE_COUNT),
  };
}

export const splitIntegrity: DataUpgradeItem = {
  id: "split-integrity",
  title: "Split integrity report",
  impact:
    "Reports the four integrity facts the app-bot split's migration-time CHECK guards cannot keep reporting: a live App with no live same-id Bot (it cannot execute), chain rows pointing at a deleted Bot (the relay reads past them), orphaned install states the sweep has not yet retired, and charged usage rows the attribution left unattributed. Verify-only: preflight and verify read, runBatch performs zero work, and every count is advisory — none of these is a state a batch in this registry can repair.",
  requiresDowntime: false,
  order: 31,

  async preflight(db: DashboardD1): Promise<UpgradeCounts> {
    return counts(db);
  },

  async runBatch(_db: DashboardD1, _cursor: UpgradeCursor | null): Promise<UpgradeBatch> {
    return { cursor: null, processed: 0, done: true };
  },

  advisoryChecks: [
    "apps_without_bot",
    "chain_rows_with_deleted_bot",
    "install_states_orphaned",
    "unattributed_usage_rows",
  ],

  async verify(db: DashboardD1): Promise<UpgradeCounts> {
    return counts(db);
  },
};

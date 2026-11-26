import type { DashboardD1 } from "../../dashboard/users";
import { bindRepository } from "./bind";
import type {
  DataUpgradeItem,
  UpgradeBatch,
  UpgradeCounts,
  UpgradeCursor,
  UpgradeRunContext,
} from "../data-upgrades";

const TARGETS_PER_BATCH = 50;

const UNCLAIMED_SQL = `
  SELECT id, app_id, repo_owner AS owner, repo_name AS repo
    FROM review_targets
   WHERE deleted_at IS NULL AND repo_id IS NULL
     AND repo_owner IS NOT NULL AND repo_name IS NOT NULL
     AND id > ?1
   ORDER BY id LIMIT ?2`;

const UNCLAIMED_COUNT = `
  SELECT COUNT(*) AS n FROM review_targets
   WHERE deleted_at IS NULL AND repo_id IS NULL
     AND repo_owner IS NOT NULL AND repo_name IS NOT NULL`;

type UnclaimedRow = {
  id: string;
  app_id: string;
  owner: string;
  repo: string;
};

async function countUnclaimed(db: DashboardD1): Promise<number> {
  const row = await db.prepare(UNCLAIMED_COUNT).first<{ n: number }>();
  return row?.n ?? 0;
}

export const repoIdClaim: DataUpgradeItem = {
  id: "repo-id-claim",
  title: "Repository id claim",
  impact:
    "Claims the numeric repository id for every live target that names a repository but has none, so the dashboard stops listing it as uninstalled. Asks the bot's live installation whether it still grants the repository; a target whose owner has no live installation, or a repository the installation no longer grants, is left unclaimed and counted. Never creates, retires or re-points a target, and never rewrites an id that is already set.",
  requiresDowntime: false,
  order: 22,

  async preflight(db: DashboardD1): Promise<UpgradeCounts> {
    return { unclaimed_targets: await countUnclaimed(db) };
  },

  async runBatch(
    db: DashboardD1,
    cursor: UpgradeCursor | null,
    _actor: string,
    context?: UpgradeRunContext,
  ): Promise<UpgradeBatch> {
    const after = typeof cursor?.last_target_id === "string" ? cursor.last_target_id : "";
    const read = await db.prepare(UNCLAIMED_SQL).bind(after, TARGETS_PER_BATCH).all<UnclaimedRow>();
    const rows = read.results;

    let bound = 0;
    let unbound = 0;
    let bindingFailed = 0;
    for (const row of rows) {
      const outcome = await bindRepository(
        db,
        { botId: row.app_id, owner: row.owner, repo: row.repo },
        context,
      );
      if (outcome === "bound") bound += 1;
      else if (outcome === "binding_failed") bindingFailed += 1;
      else unbound += 1;
    }

    return {
      cursor: rows.length === 0 ? null : { last_target_id: rows.at(-1)!.id },
      processed: bound,
      done: rows.length < TARGETS_PER_BATCH,
      log: {
        visited: rows.length,
        bound,
        unbound,
        binding_failed: bindingFailed,
      },
    };
  },

  advisoryChecks: ["unclaimed_targets"],

  async verify(db: DashboardD1): Promise<UpgradeCounts> {
    return { unclaimed_targets: await countUnclaimed(db) };
  },
};

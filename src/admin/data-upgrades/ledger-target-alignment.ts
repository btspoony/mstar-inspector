import type { DashboardD1, DashboardD1Statement } from "../../dashboard/users";
import { bindRepository } from "./bind";
import type {
  DataUpgradeItem,
  UpgradeBatch,
  UpgradeCounts,
  UpgradeCursor,
  UpgradeRunContext,
} from "../data-upgrades";

const GROUPS_PER_BATCH = 20;

const LEDGER_TABLES = ["pull_requests", "reviews", "review_findings", "review_failures"] as const;

const misaligned = (alias: string) => `t.deleted_at IS NULL
      AND t.repo_owner IS NOT NULL AND t.repo_name IS NOT NULL
      AND (t.repo_owner <> ${alias}.owner COLLATE NOCASE
           OR t.repo_name <> ${alias}.repo COLLATE NOCASE)`;

const prConflict = (alias: string) => `EXISTS (
  SELECT 1 FROM review_targets h JOIN pull_requests o ON o.target_id = h.id
   WHERE h.deleted_at IS NULL
     AND h.app_id = (SELECT b.app_id FROM review_targets b WHERE b.id = ${alias}.target_id)
     AND h.repo_owner = ${alias}.owner COLLATE NOCASE AND h.repo_name = ${alias}.repo COLLATE NOCASE
     AND o.owner = ${alias}.owner COLLATE NOCASE AND o.repo = ${alias}.repo COLLATE NOCASE
     AND o.pr_number = ${alias}.pr_number)`;

/**
 * Every misaligned ledger row, one row per ledger row, with the bot its CURRENT
 * target belongs to and the group key it is filed under. The target is the only
 * bot evidence: it is the tenant the row is visible in today, so aligning it
 * never moves a row into a workspace it was not already counted in. A group
 * whose rows sit on targets of different bots is therefore unattributable.
 *
 * shortcut: the cursor floor is an expression, so each table is still scanned
 * for misaligned rows rather than seeked; upgrade: when a stored/indexed
 * group-key column exists to range over.
 */
const misalignedRows = (after: string) => {
  const floor = (alias: string) =>
    ` AND lower(${alias}.owner) || '/' || lower(${alias}.repo) > ${after}`;
  return `
  SELECT 'pull_requests' AS src, p.id, t.app_id, p.owner, p.repo,
         lower(p.owner) || '/' || lower(p.repo) AS group_key
    FROM pull_requests p JOIN review_targets t ON t.id = p.target_id
   WHERE ${misaligned("p")} AND NOT (${prConflict("p")})${floor("p")}
  UNION ALL
  SELECT 'reviews', r.id, t.app_id, r.owner, r.repo,
         lower(r.owner) || '/' || lower(r.repo)
    FROM reviews r JOIN review_targets t ON t.id = r.target_id
   WHERE ${misaligned("r")}${floor("r")}
  UNION ALL
  SELECT 'review_findings', f.id, t.app_id, f.owner, f.repo,
         lower(f.owner) || '/' || lower(f.repo)
    FROM review_findings f JOIN review_targets t ON t.id = f.target_id
   WHERE ${misaligned("f")}${floor("f")}
  UNION ALL
  SELECT 'review_failures', x.id, t.app_id, x.owner, x.repo,
         lower(x.owner) || '/' || lower(x.repo)
    FROM review_failures x JOIN review_targets t ON t.id = x.target_id
   WHERE ${misaligned("x")}${floor("x")}`;
};

const alignmentGroups = (after: string) => `
  WITH live(src, id, app_id, owner, repo, group_key) AS (${misalignedRows(after)}),
  named(group_key, owner, repo) AS (
    SELECT group_key, MIN(owner), MIN(repo) FROM live GROUP BY group_key),
  claim(group_key, bots, app_id) AS (
    SELECT group_key, COUNT(DISTINCT app_id), MIN(app_id) FROM live GROUP BY group_key),
  homes(group_key, targets, repo_id) AS (
    SELECT c.group_key, COUNT(t.id), MIN(t.repo_id)
      FROM claim c
      JOIN named n ON n.group_key = c.group_key
      LEFT JOIN review_targets t
        ON t.deleted_at IS NULL
       AND t.app_id = CASE WHEN c.bots = 1 THEN c.app_id END
       AND t.repo_owner = n.owner COLLATE NOCASE AND t.repo_name = n.repo COLLATE NOCASE
     GROUP BY c.group_key),
  resolved AS (
    SELECT n.group_key, n.owner, n.repo,
           CASE WHEN c.bots = 1 THEN c.app_id END AS app_id,
           (SELECT w.workspace_id FROM app_workspaces w WHERE w.app_id = c.app_id) AS workspace_id,
           COALESCE(h.targets, 0) AS targets,
           h.repo_id AS repo_id,
           (c.bots = 1 AND COALESCE(h.targets, 0) <= 1
            AND (COALESCE(h.targets, 0) = 1
                 OR EXISTS (SELECT 1 FROM app_workspaces w WHERE w.app_id = c.app_id))
            AND (COALESCE(h.targets, 0) = 0 OR h.repo_id IS NULL)
            AND NOT EXISTS (SELECT 1 FROM github_app_installations i
                             WHERE i.app_id = c.app_id AND i.removed_at IS NULL
                               AND i.account_login = n.owner COLLATE NOCASE)) AS unbound
      FROM named n
      JOIN claim c ON c.group_key = n.group_key
      LEFT JOIN homes h ON h.group_key = n.group_key)`;

const actionable = (alias: string) =>
  `${alias}app_id IS NOT NULL AND ${alias}targets <= 1
   AND (${alias}targets = 1 OR ${alias}workspace_id IS NOT NULL)`;

const homeTarget = `SELECT t.id FROM review_targets t
   WHERE t.deleted_at IS NULL AND t.app_id = ?1
     AND t.repo_owner = ?2 COLLATE NOCASE AND t.repo_name = ?3 COLLATE NOCASE`;

const INSERT_TARGET = `
  INSERT INTO review_targets
    (id, workspace_id, app_id, name, repo_id, repo_owner, repo_name,
     follow_workspace_defaults, created_by, created_at, updated_at)
  SELECT ?4, w.workspace_id, ?1, ?5, NULL, ?2, ?3, 1, ?6, datetime('now'), datetime('now')
    FROM app_workspaces w
   WHERE w.app_id = ?1
     AND NOT EXISTS (${homeTarget})`;

const repointGroup = (table: string) => `
  UPDATE ${table} SET target_id = (${homeTarget})
   WHERE owner = ?2 COLLATE NOCASE AND repo = ?3 COLLATE NOCASE
     AND EXISTS (SELECT 1 FROM review_targets t
                  WHERE t.id = ${table}.target_id AND ${misaligned(table)})
     ${table === "pull_requests" ? `AND NOT (${prConflict(table)})` : ""}
     AND (SELECT COUNT(*) FROM review_targets t
           WHERE t.deleted_at IS NULL AND t.app_id = ?1
             AND t.repo_owner = ?2 COLLATE NOCASE AND t.repo_name = ?3 COLLATE NOCASE) = 1`;

type Group = {
  group_key: string;
  owner: string;
  repo: string;
  app_id: string | null;
  workspace_id: string | null;
  targets: number;
  repo_id: number | null;
  unbound: number;
};

type GroupWrite = { insert: number | null; updates: number[]; group: Group };

type Plan = {
  statements: DashboardD1Statement[];
  cursor: string | null;
  done: boolean;
  groups: number;
  ambiguous: number;
  unattributable: number;
  writes: GroupWrite[];
};

async function planBatch(
  db: DashboardD1,
  cursor: UpgradeCursor | null,
  actor: string | undefined,
): Promise<Plan> {
  const after = typeof cursor?.last_group === "string" ? cursor.last_group : "";
  const read = await db
    .prepare(
      `${alignmentGroups("?1")}
       SELECT group_key, owner, repo, app_id, workspace_id, targets, repo_id, unbound
         FROM resolved ORDER BY group_key LIMIT ?2`,
    )
    .bind(after, GROUPS_PER_BATCH)
    .all<Group>();
  const groups = read.results;

  const plan: Plan = {
    statements: [],
    cursor: groups.length === 0 ? null : groups.at(-1)!.group_key,
    done: groups.length < GROUPS_PER_BATCH,
    groups: groups.length,
    ambiguous: 0,
    unattributable: 0,
    writes: [],
  };

  for (const group of groups) {
    if (group.targets > 1) {
      plan.ambiguous += 1;
      continue;
    }
    if (group.app_id === null || (group.targets === 0 && group.workspace_id === null)) {
      plan.unattributable += 1;
      continue;
    }
    const write: GroupWrite = { insert: null, updates: [], group };
    if (group.targets === 0) {
      write.insert = plan.statements.length;
      plan.statements.push(
        db
          .prepare(INSERT_TARGET)
          .bind(
            group.app_id,
            group.owner,
            group.repo,
            crypto.randomUUID(),
            `${group.owner}/${group.repo}`,
            actor ?? "data-upgrade",
          ),
      );
    }
    for (const table of LEDGER_TABLES) {
      write.updates.push(plan.statements.length);
      plan.statements.push(
        db.prepare(repointGroup(table)).bind(group.app_id, group.owner, group.repo),
      );
    }
    plan.writes.push(write);
  }
  return plan;
}

/**
 * The registered item. No downtime: a delivery arriving mid-run writes its row
 * with the target its repository resolves to, and the worklist predicate is
 * "this row's target names another repository", which a correct write never is.
 */
export const ledgerTargetAlignment: DataUpgradeItem = {
  id: "ledger-target-alignment",
  title: "Ledger target alignment",
  impact:
    "Re-points ledger rows whose target names a different repository onto their own repository's live target, creating that target when the repository has none, and claims the numeric repository id from a live installation when GitHub still grants it. Never deletes a ledger row, never edits a review, finding or failure, and never changes an existing target's configuration; a repository two live targets name, or rows sitting on targets of different bots, is left alone and counted.",
  requiresDowntime: false,
  order: 21,

  async preflight(db: DashboardD1): Promise<UpgradeCounts> {
    const counts = await db
      .prepare(
        `${alignmentGroups("''")}
         SELECT COUNT(*) AS groups,
                COALESCE(SUM(${actionable("")} AND targets = 1), 0) AS groups_with_target,
                COALESCE(SUM(${actionable("")} AND targets = 0), 0) AS groups_needing_target,
                COALESCE(SUM(targets <= 1 AND NOT (${actionable("")})), 0)
                  AS unattributable_groups,
                COALESCE(SUM(targets > 1), 0) AS ambiguous_groups,
                COALESCE(SUM(unbound), 0) AS unbound_groups
           FROM resolved`,
      )
      .first<UpgradeCounts>();
    return {
      misaligned_rows:
        (await db
          .prepare(`SELECT COUNT(*) AS n FROM (${misalignedRows("''")})`)
          .first<{ n: number }>())?.n ?? 0,
      groups: counts?.groups ?? 0,
      groups_with_target: counts?.groups_with_target ?? 0,
      groups_needing_target: counts?.groups_needing_target ?? 0,
      unattributable_groups: counts?.unattributable_groups ?? 0,
      ambiguous_groups: counts?.ambiguous_groups ?? 0,
      unbound_groups: counts?.unbound_groups ?? 0,
    };
  },

  async runBatch(
    db: DashboardD1,
    cursor: UpgradeCursor | null,
    actor: string,
    context?: UpgradeRunContext,
  ): Promise<UpgradeBatch> {
    const plan = await planBatch(db, cursor, actor);
    let rows = 0;
    let aligned = 0;
    let created = 0;
    const moved: GroupWrite[] = [];
    if (plan.statements.length > 0) {
      const results = await db.batch(plan.statements);
      const changes = (index: number) => results[index]?.meta.changes ?? 0;
      for (const write of plan.writes) {
        if (write.insert !== null && changes(write.insert) > 0) created += 1;
        const touched = write.updates.reduce((sum, index) => sum + changes(index), 0);
        if (touched > 0) {
          aligned += 1;
          moved.push(write);
        }
        rows += touched;
      }
    }

    let bound = 0;
    let unbound = 0;
    let bindingFailed = 0;
    for (const { group } of moved) {
      if (group.targets === 1 && group.repo_id !== null) continue;
      if (group.app_id === null) {
        unbound += 1;
        continue;
      }
      const outcome = await bindRepository(
        db,
        { botId: group.app_id, owner: group.owner, repo: group.repo },
        context,
      );
      if (outcome === "bound") bound += 1;
      else if (outcome === "binding_failed") bindingFailed += 1;
      else unbound += 1;
    }

    return {
      cursor: plan.cursor === null ? null : { last_group: plan.cursor },
      processed: rows,
      done: plan.done,
      log: {
        groups: plan.groups,
        aligned,
        created,
        bound,
        unbound,
        binding_failed: bindingFailed,
        ambiguous: plan.ambiguous,
        unattributable: plan.unattributable,
      },
    };
  },

  advisoryChecks: ["ambiguous_groups", "unattributable_groups", "conflicting_ledger_rows"],

  async verify(db: DashboardD1): Promise<UpgradeCounts> {
    const row = await db
      .prepare(
        `${alignmentGroups("''")}
         SELECT (SELECT COUNT(*) FROM live l JOIN resolved r ON r.group_key = l.group_key
                  WHERE ${actionable("r.")}) AS misaligned_ledger_rows,
                COALESCE(SUM(targets > 1), 0) AS ambiguous_groups,
                COALESCE(SUM(targets <= 1 AND NOT (${actionable("")})), 0)
                  AS unattributable_groups,
                (SELECT COUNT(*) FROM pull_requests p
                   JOIN review_targets t ON t.id = p.target_id
                  WHERE ${misaligned("p")} AND ${prConflict("p")})
                  AS conflicting_ledger_rows
           FROM resolved`,
      )
      .first<UpgradeCounts>();
    return {
      misaligned_ledger_rows: row?.misaligned_ledger_rows ?? 0,
      ambiguous_groups: row?.ambiguous_groups ?? 0,
      unattributable_groups: row?.unattributable_groups ?? 0,
      conflicting_ledger_rows: row?.conflicting_ledger_rows ?? 0,
    };
  },
};

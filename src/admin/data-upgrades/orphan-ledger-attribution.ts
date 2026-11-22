import type { DashboardD1, DashboardD1Statement } from "../../dashboard/users";
import type {
  DataUpgradeItem,
  UpgradeBatch,
  UpgradeCounts,
  UpgradeCursor,
} from "../data-upgrades";

const GROUPS_PER_BATCH = 20;

const matchingTargets = (botId: string, owner: string, repo: string) => `
  SELECT t.id FROM review_targets t
   WHERE t.bot_id = ${botId} AND t.deleted_at IS NULL
     AND t.repo_owner = ${owner} COLLATE NOCASE AND t.repo_name = ${repo} COLLATE NOCASE`;

const groupStillUniform = (bot: string, owner: string, repo: string) => `
  NOT EXISTS (
    WITH g(bot_id, installation_id) AS (
      SELECT bot_id, NULL FROM pull_requests
       WHERE target_id IS NULL AND owner = ${owner} COLLATE NOCASE AND repo = ${repo} COLLATE NOCASE
      UNION ALL
      SELECT bot_id, installation_id FROM reviews
       WHERE target_id IS NULL AND owner = ${owner} COLLATE NOCASE AND repo = ${repo} COLLATE NOCASE
      UNION ALL
      SELECT bot_id, installation_id FROM review_findings
       WHERE target_id IS NULL AND owner = ${owner} COLLATE NOCASE AND repo = ${repo} COLLATE NOCASE
      UNION ALL
      SELECT NULL, installation_id FROM review_failures
       WHERE target_id IS NULL AND owner = ${owner} COLLATE NOCASE AND repo = ${repo} COLLATE NOCASE),
    shape(other, unknown, known) AS (
      SELECT SUM((g.bot_id IS NOT NULL AND g.bot_id <> ${bot})
                  OR EXISTS (SELECT 1 FROM bot_installations i
                              WHERE i.installation_id = g.installation_id AND i.bot_id <> ${bot})),
             SUM(g.bot_id IS NULL
                 AND NOT EXISTS (SELECT 1 FROM bot_installations i
                                  WHERE i.installation_id = g.installation_id)),
             SUM(g.bot_id = ${bot}
                 OR EXISTS (SELECT 1 FROM bot_installations i
                             WHERE i.installation_id = g.installation_id AND i.bot_id = ${bot}))
        FROM g)
    SELECT 1 FROM shape WHERE other > 0 OR (unknown > 0 AND known > 0))`;

/**
 * Every ledger row still holding no target, one row per ledger row, with the
 * bot it names itself and the group key it belongs to. `review_failures`
 * carries no bot of its own — it is attributed through `installation_id` alone.
 * `row_bot` is that resolution: the row's own `bot_id` when set, else the bot
 * its installation names (a removed installation row still resolves — it is
 * history, not absence).
 *
 * `group_key` is computed per ROW rather than from the group's aggregates, so
 * `after` — an SQL term, `''` for no floor — filters the base read by the
 * cursor instead of aggregating the groups the walk has already passed. Every
 * row of a group carries the same key, so the filter never splits a group.
 *
 * shortcut: the floor is an expression, so each table is still scanned for
 * NULL-target rows rather than seeked; upgrade: when a stored/indexed group-key
 * column exists to range over.
 */
const orphanRows = (after: string) => {
  const floor = ` AND lower(owner) || '/' || lower(repo) > ${after}`;
  return `
  SELECT 'pull_requests' AS src, id, bot_id, NULL AS installation_id, owner, repo,
         lower(owner) || '/' || lower(repo) AS group_key
    FROM pull_requests WHERE target_id IS NULL${floor}
  UNION ALL
  SELECT 'reviews', id, bot_id, installation_id, owner, repo,
         lower(owner) || '/' || lower(repo)
    FROM reviews WHERE target_id IS NULL${floor}
  UNION ALL
  SELECT 'review_findings', id, bot_id, installation_id, owner, repo,
         lower(owner) || '/' || lower(repo)
    FROM review_findings WHERE target_id IS NULL${floor}
  UNION ALL
  SELECT 'review_failures', id, NULL, installation_id, owner, repo,
         lower(owner) || '/' || lower(repo)
    FROM review_failures WHERE target_id IS NULL${floor}`;
};

const resolvedGroups = (after: string) => `
  WITH orphan(src, id, bot_id, installation_id, owner, repo, group_key) AS (${orphanRows(after)}),
  row_bot(src, id, bot_id) AS (
    SELECT src, id, bot_id FROM orphan WHERE bot_id IS NOT NULL
    UNION
    SELECT o.src, o.id, i.bot_id FROM orphan o
      JOIN bot_installations i ON i.installation_id = o.installation_id),
  named(group_key, owner, repo) AS (
    SELECT group_key, MIN(owner), MIN(repo) FROM orphan
     GROUP BY group_key),
  claim(group_key, owner, repo, unknown, bots, candidate_bot) AS (
    SELECT n.group_key, n.owner, n.repo,
           SUM(NOT EXISTS (SELECT 1 FROM row_bot rb WHERE rb.src = o.src AND rb.id = o.id)),
           COUNT(DISTINCT rb.bot_id), MIN(rb.bot_id)
      FROM named n
      JOIN orphan o ON o.group_key = n.group_key
      LEFT JOIN row_bot rb ON rb.src = o.src AND rb.id = o.id
     GROUP BY n.group_key, n.owner, n.repo),
  only_bot(bot_id) AS (
    SELECT CASE WHEN COUNT(DISTINCT bot_id) = 1 THEN MIN(bot_id) END FROM bot_workspaces),
  attributed(group_key, owner, repo, bot_id) AS (
    SELECT c.group_key, c.owner, c.repo,
           CASE WHEN c.unknown = 0 AND c.bots = 1 THEN c.candidate_bot
                WHEN c.bots = 0 THEN (SELECT bot_id FROM only_bot) END
      FROM claim c),
  resolved(group_key, owner, repo, bot_id, workspace_id, targets) AS (
    SELECT a.group_key, a.owner, a.repo, a.bot_id,
           (SELECT w.workspace_id FROM bot_workspaces w WHERE w.bot_id = a.bot_id),
           (SELECT COUNT(*) FROM (${matchingTargets("a.bot_id", "a.owner", "a.repo")}))
      FROM attributed a)`;

type ResolvedGroup = {
  owner: string;
  repo: string;
  bot_id: string | null;
  workspace_id: string | null;
  targets: number;
  sort_key: string;
};

type Plan = {
  statements: DashboardD1Statement[];
  cursor: string | null;
  done: boolean;
  groups: number;
  unattributable: number;
  ambiguous: number;
  writes: GroupWrite[];
};

const LEDGER_TABLES = ["pull_requests", "reviews", "review_findings", "review_failures"] as const;

const INSERT_TARGET = `
  INSERT INTO review_targets
    (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
     follow_workspace_defaults, created_by, created_at, updated_at)
  SELECT ?4, w.workspace_id, ?1, ?5, NULL, ?2, ?3, 1, ?6, datetime('now'), datetime('now')
    FROM bot_workspaces w
   WHERE w.bot_id = ?1
     AND NOT EXISTS (${matchingTargets("?1", "?2", "?3")})
     AND ${groupStillUniform("?1", "?2", "?3")}`;

const attributeGroup = (table: string) => `
  UPDATE ${table} SET target_id = (${matchingTargets("?1", "?2", "?3")})
   WHERE target_id IS NULL AND owner = ?2 COLLATE NOCASE AND repo = ?3 COLLATE NOCASE
     AND (SELECT COUNT(*) FROM (${matchingTargets("?1", "?2", "?3")})) = 1
     AND ${groupStillUniform("?1", "?2", "?3")}`;

async function countRows(db: DashboardD1, sql: string): Promise<number> {
  const row = await db.prepare(sql).first<{ n: number }>();
  return row?.n ?? 0;
}

const attributable = (alias: string) =>
  `${alias}bot_id IS NOT NULL AND ${alias}workspace_id IS NOT NULL AND ${alias}targets <= 1`;

type GroupWrite = { insert: number | null; updates: number[] };

async function planBatch(
  db: DashboardD1,
  cursor: UpgradeCursor | null,
  actor: string,
): Promise<Plan> {
  const after = typeof cursor?.last_group === "string" ? cursor.last_group : "";
  const read = await db
    .prepare(
      `${resolvedGroups("?1")}
       SELECT owner, repo, bot_id, workspace_id, targets, group_key AS sort_key FROM resolved
        ORDER BY sort_key LIMIT ?2`,
    )
    .bind(after, GROUPS_PER_BATCH)
    .all<ResolvedGroup>();
  const groups = read.results;

  const plan: Plan = {
    statements: [],
    groups: groups.length,
    cursor: groups.length === 0 ? null : groups.at(-1)!.sort_key,
    done: groups.length < GROUPS_PER_BATCH,
    unattributable: 0,
    ambiguous: 0,
    writes: [],
  };

  for (const group of groups) {
    if (group.bot_id === null || group.workspace_id === null || group.targets > 1) {
      plan.unattributable += 1;
      if (group.bot_id !== null && group.workspace_id !== null) plan.ambiguous += 1;
      continue;
    }
    const write: GroupWrite = { insert: null, updates: [] };
    if (group.targets === 0) {
      write.insert = plan.statements.length;
      plan.statements.push(
        db
          .prepare(INSERT_TARGET)
          .bind(
            group.bot_id,
            group.owner,
            group.repo,
            crypto.randomUUID(),
            `${group.owner}/${group.repo}`,
            actor,
          ),
      );
    }
    for (const table of LEDGER_TABLES) {
      write.updates.push(plan.statements.length);
      plan.statements.push(
        db.prepare(attributeGroup(table)).bind(group.bot_id, group.owner, group.repo),
      );
    }
    plan.writes.push(write);
  }
  return plan;
}

/**
 * The registered item. No downtime: an orphan row has no target to contradict,
 * and a delivery arriving mid-run writes its row with `target_id` already set,
 * so the worklist predicate can never pick it up.
 */
export const orphanLedgerAttribution: DataUpgradeItem = {
  id: "orphan-ledger-attribution",
  title: "Orphan ledger attribution",
  impact:
    "Attributes ledger rows that have no target, creating a target when their repository has none; rows whose bot cannot be established, or whose repository two live targets both name, are left alone and counted. Never rewrites a row that already has one. A completed run takes no further batch and this card then offers no reset: after repairing the mapping, POST /_internal_admin/api/data-upgrades/orphan-ledger-attribution/reset and start it again to pick up the groups that newly resolve.",
  requiresDowntime: false,
  order: 20,

  async preflight(db: DashboardD1): Promise<UpgradeCounts> {
    const counts = await db
      .prepare(
        `${resolvedGroups("''")}
         SELECT COUNT(*) AS groups,
                COALESCE(SUM(${attributable("")} AND targets = 1), 0) AS groups_with_target,
                COALESCE(SUM(${attributable("")} AND targets = 0), 0) AS groups_needing_target,
                COALESCE(SUM(NOT (${attributable("")})), 0) AS unattributable_groups,
                COALESCE(SUM(targets > 1), 0) AS ambiguous_groups
           FROM resolved`,
      )
      .first<UpgradeCounts>();
    return {
      orphan_rows: await countRows(db, `SELECT COUNT(*) AS n FROM (${orphanRows("''")})`),
      groups: counts?.groups ?? 0,
      groups_with_target: counts?.groups_with_target ?? 0,
      groups_needing_target: counts?.groups_needing_target ?? 0,
      unattributable_groups: counts?.unattributable_groups ?? 0,
      ambiguous_groups: counts?.ambiguous_groups ?? 0,
    };
  },

  async runBatch(
    db: DashboardD1,
    cursor: UpgradeCursor | null,
    actor: string,
  ): Promise<UpgradeBatch> {
    const plan = await planBatch(db, cursor, actor);
    const results = plan.statements.length > 0 ? await db.batch(plan.statements) : [];
    const moved = (index: number) => results[index]?.meta.changes ?? 0;

    let rows = 0;
    let attributed = 0;
    let created = 0;
    for (const write of plan.writes) {
      if (write.insert !== null && moved(write.insert) > 0) created += 1;
      const touched = write.updates.reduce((sum, index) => sum + moved(index), 0);
      if (touched > 0) attributed += 1;
      rows += touched;
    }
    const changed = plan.writes.length - attributed;
    return {
      cursor: plan.cursor === null ? null : { last_group: plan.cursor },
      processed: rows,
      done: plan.done,
      log: {
        groups: plan.groups,
        attributed,
        created,
        unattributable: plan.unattributable,
        ambiguous: plan.ambiguous,
        changed_shape: changed,
      },
    };
  },

  advisoryChecks: ["unattributable_groups"],

  async verify(db: DashboardD1): Promise<UpgradeCounts> {
    const row = await db
      .prepare(
        `${resolvedGroups("''")}
         SELECT (SELECT COUNT(*) FROM orphan o
                   JOIN resolved r ON r.group_key = o.group_key
                  WHERE ${attributable("r.")})
                  AS unattributed_ledger_rows,
                (SELECT COUNT(*) FROM resolved WHERE NOT (${attributable("")}))
                  AS unattributable_groups`,
      )
      .first<UpgradeCounts>();
    return {
      unattributed_ledger_rows: row?.unattributed_ledger_rows ?? 0,
      unattributable_groups: row?.unattributable_groups ?? 0,
    };
  },
};

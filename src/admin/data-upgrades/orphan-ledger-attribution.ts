/**
 * Orphan ledger attribution — the second registered operator data upgrade
 * (spec operator-data-upgrade § Orphan ledger attribution item).
 *
 * `reviews`, `review_failures` and the other ledger tables gained `target_id`
 * only when `review_targets` shipped (0057/0060). Rows written before that
 * carry `target_id = NULL`: their repository's detail page (which reads by
 * target) cannot see them, while the workspace-wide aggregate still counts
 * them. `repo-backfill` merges duplicate targets and cannot help — these rows
 * never had a target to merge.
 *
 * The worklist is every ledger row still holding no target, grouped by
 * `(owner, repo)` case-insensitively — the collation the store's own
 * resolution uses. Identity is the GROUP, not the table: the four tables hold
 * rows for one repository, and they must land on one target.
 *
 * Resolution, per group, entirely inside the batch:
 *   1. bot — a candidate bot is any `bot_id` a row carries, plus the bot each
 *      row's `installation_id` resolves to in `bot_installations` (a removed
 *      row still resolves: it is history, not absence). Exactly one distinct
 *      candidate is the group's bot; several are an ambiguity and zero falls
 *      back to the deployment's only bot, if it has exactly one.
 *   2. workspace — `bot_workspaces` by that bot. A bot without a row has no
 *      owner, so no target could be created for it.
 *   3. target — a live row of that bot naming the repository, else one created
 *      with `repo_id` NULL. The numeric id is not invented: 0067's first
 *      delivery claims it (`resolveByRepo`), exactly as it claims a migrated
 *      row.
 *   4. attribute — the four ledger tables' NULL rows of this group.
 *
 * A group whose bot or workspace does not resolve is left untouched and only
 * reported (`unattributable_groups`, advisory): guessing a workspace would
 * write a row into a tenant nobody chose. It never fails the item, because no
 * later pass could repair it — the operator fixes the bot mapping and re-runs.
 *
 * A batch is ONE `db.batch` transaction over at most GROUPS_PER_BATCH groups,
 * in a cursor over the case-folded group key. The worklist predicate is
 * `target_id IS NULL`, so a replay over finished work matches nothing; the
 * UPDATEs carry the same predicate, so a non-NULL target is never rewritten
 * and no row is ever deleted.
 */
import type { DashboardD1, DashboardD1Statement } from "../../dashboard/users";
import type {
  DataUpgradeItem,
  UpgradeBatch,
  UpgradeCounts,
  UpgradeCursor,
} from "../data-upgrades";

/** Repository groups per step. */
const GROUPS_PER_BATCH = 20;

/**
 * `review_targets.created_by` for a row this item creates. The item interface
 * carries no actor (the runner knows it, an item does not), so the creator is
 * named by its cause instead of borrowing an operator login it never saw.
 */
const CREATED_BY = "orphan-ledger-attribution";

/**
 * Every ledger row still holding no target. `review_failures` carries no bot
 * of its own — it is attributed through `installation_id` alone.
 */
const ORPHAN_ROWS = `
  SELECT bot_id, NULL AS installation_id, owner, repo FROM pull_requests WHERE target_id IS NULL
  UNION ALL
  SELECT bot_id, installation_id, owner, repo FROM reviews WHERE target_id IS NULL
  UNION ALL
  SELECT bot_id, installation_id, owner, repo FROM review_findings WHERE target_id IS NULL
  UNION ALL
  SELECT NULL, installation_id, owner, repo FROM review_failures WHERE target_id IS NULL`;

/**
 * One row per orphan group: the spelling to write, the resolved bot, its
 * workspace, the live target that already names the repository (if any), and
 * the cursor key. `unattributable_groups` and the attribute step both read it,
 * so preflight, verify and the batch can never disagree about what resolves.
 */
const RESOLVED_GROUPS = `
  WITH orphan(bot_id, installation_id, owner, repo) AS (${ORPHAN_ROWS}),
  candidate(owner, repo, bot_id) AS (
    SELECT owner, repo, bot_id FROM orphan WHERE bot_id IS NOT NULL
    UNION
    SELECT o.owner, o.repo, i.bot_id FROM orphan o
      JOIN bot_installations i ON i.installation_id = o.installation_id),
  named(owner, repo) AS (
    SELECT MIN(owner), MIN(repo) FROM orphan
     GROUP BY owner COLLATE NOCASE, repo COLLATE NOCASE),
  claim(owner, repo, bots, candidate_bot) AS (
    SELECT n.owner, n.repo, COUNT(DISTINCT c.bot_id), MIN(c.bot_id)
      FROM named n
      LEFT JOIN candidate c ON c.owner = n.owner COLLATE NOCASE
                           AND c.repo = n.repo COLLATE NOCASE
     GROUP BY n.owner, n.repo),
  only_bot(bot_id) AS (
    SELECT CASE WHEN COUNT(DISTINCT bot_id) = 1 THEN MIN(bot_id) END FROM bot_workspaces),
  attributed(owner, repo, bot_id) AS (
    SELECT owner, repo,
           CASE WHEN bots = 1 THEN candidate_bot
                WHEN bots = 0 THEN (SELECT bot_id FROM only_bot) END
      FROM claim),
  resolved(owner, repo, bot_id, workspace_id, target_id, sort_key) AS (
    SELECT a.owner, a.repo, a.bot_id,
           (SELECT w.workspace_id FROM bot_workspaces w WHERE w.bot_id = a.bot_id),
           (SELECT t.id FROM review_targets t
             WHERE t.bot_id = a.bot_id AND t.deleted_at IS NULL
               AND t.repo_owner = a.owner COLLATE NOCASE
               AND t.repo_name = a.repo COLLATE NOCASE
             ORDER BY t.created_at, t.id LIMIT 1),
           lower(a.owner) || '/' || lower(a.repo)
      FROM attributed a)`;

/** One group's read: its spelling, what it resolved to, and its cursor key. */
type ResolvedGroup = {
  owner: string;
  repo: string;
  bot_id: string | null;
  workspace_id: string | null;
  target_id: string | null;
  sort_key: string;
};

/** A planned batch: the statements to commit, and what they do. */
type Plan = {
  statements: DashboardD1Statement[];
  /** The last group key this batch walked; `null` when the walk ended. */
  cursor: string | null;
  done: boolean;
  groups: number;
  attributed: number;
  created: number;
  unattributable: number;
};

/**
 * The four tables that carry `target_id`, with the column set each one needs
 * for the group predicate (all four hold `owner`/`repo`).
 */
const LEDGER_TABLES = ["pull_requests", "reviews", "review_findings", "review_failures"] as const;

async function countRows(db: DashboardD1, sql: string): Promise<number> {
  const row = await db.prepare(sql).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Plan one batch. Every read happens here; the write half is the returned
 * statement list, so ONE `db.batch` commits the whole move.
 */
async function planBatch(db: DashboardD1, cursor: UpgradeCursor | null): Promise<Plan> {
  const after = typeof cursor?.last_group === "string" ? cursor.last_group : "";
  const read = await db
    .prepare(
      `${RESOLVED_GROUPS}
       SELECT owner, repo, bot_id, workspace_id, target_id, sort_key FROM resolved
        WHERE sort_key > ?1 ORDER BY sort_key LIMIT ?2`,
    )
    .bind(after, GROUPS_PER_BATCH)
    .all<ResolvedGroup>();
  const groups = read.results;

  const plan: Plan = {
    statements: [],
    cursor: groups.length === 0 ? null : groups.at(-1)!.sort_key,
    done: groups.length < GROUPS_PER_BATCH,
    groups: groups.length,
    attributed: 0,
    created: 0,
    unattributable: 0,
  };

  for (const group of groups) {
    // No bot, or a bot with no workspace: nothing names the tenant the rows
    // belong to. Left untouched, walked past (the cursor moves), reported.
    if (group.bot_id === null || group.workspace_id === null) {
      plan.unattributable += 1;
      continue;
    }
    let targetId = group.target_id;
    if (targetId === null) {
      targetId = crypto.randomUUID();
      plan.statements.push(
        db
          .prepare(
            `INSERT INTO review_targets
               (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
                follow_workspace_defaults, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, 0, ?7, datetime('now'), datetime('now'))`,
          )
          .bind(
            targetId,
            group.workspace_id,
            group.bot_id,
            `${group.owner}/${group.repo}`,
            group.owner,
            group.repo,
            CREATED_BY,
          ),
      );
      plan.created += 1;
    }
    // `pull_requests` is unique on `(target_id, owner, repo, pr_number)`, so two
    // NULL rows of ONE group naming the same PR would collide once both carry
    // this target. The pre-0057 ledger was unique per bot, and the group is one
    // bot's, so the shape needs a hand-edited row.
    // shortcut: such a duplicate aborts the whole batch and verify reports it
    // as `unattributed_ledger_rows`; deleting one is the operator's call, so the
    // item never guesses which PR row survives.
    for (const table of LEDGER_TABLES) {
      plan.statements.push(
        db
          .prepare(
            `UPDATE ${table} SET target_id = ?1
              WHERE target_id IS NULL AND owner = ?2 COLLATE NOCASE
                AND repo = ?3 COLLATE NOCASE`,
          )
          .bind(targetId, group.owner, group.repo),
      );
    }
    plan.attributed += 1;
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
  requiresDowntime: false,
  order: 20,

  /** Five counts the operator sees before starting: no writes. */
  async preflight(db: DashboardD1): Promise<UpgradeCounts> {
    const counts = await db
      .prepare(
        `${RESOLVED_GROUPS}
         SELECT COUNT(*) AS groups,
                COALESCE(SUM(target_id IS NOT NULL), 0) AS groups_with_target,
                COALESCE(SUM(target_id IS NULL AND bot_id IS NOT NULL
                             AND workspace_id IS NOT NULL), 0) AS groups_needing_target,
                COALESCE(SUM(bot_id IS NULL OR workspace_id IS NULL), 0) AS unattributable_groups
           FROM resolved`,
      )
      .first<UpgradeCounts>();
    return {
      orphan_rows: await countRows(db, `SELECT COUNT(*) AS n FROM (${ORPHAN_ROWS})`),
      groups: counts?.groups ?? 0,
      groups_with_target: counts?.groups_with_target ?? 0,
      groups_needing_target: counts?.groups_needing_target ?? 0,
      unattributable_groups: counts?.unattributable_groups ?? 0,
    };
  },

  /** ONE transaction per call; a replay over migrated rows processes nothing. */
  async runBatch(db: DashboardD1, cursor: UpgradeCursor | null): Promise<UpgradeBatch> {
    const plan = await planBatch(db, cursor);
    if (plan.statements.length > 0) await db.batch(plan.statements);
    return {
      cursor: plan.cursor === null ? null : { last_group: plan.cursor },
      processed: plan.attributed,
      done: plan.done,
      log: {
        groups: plan.groups,
        attributed: plan.attributed,
        created: plan.created,
        unattributable: plan.unattributable,
      },
    };
  },

  /**
   * Read-only checks. `unattributed_ledger_rows` is the crash residual: a NULL
   * row whose group DOES resolve is work a completed run should have moved.
   * A row whose group cannot resolve is not this item's failure — the operator
   * fixes the bot mapping and re-runs — so it is only counted, by group, in
   * the advisory `unattributable_groups`.
   */
  advisoryChecks: ["unattributable_groups"],

  async verify(db: DashboardD1): Promise<UpgradeCounts> {
    const row = await db
      .prepare(
        `${RESOLVED_GROUPS}
         SELECT (SELECT COUNT(*) FROM orphan o
                   JOIN resolved r ON r.owner = o.owner COLLATE NOCASE
                                  AND r.repo = o.repo COLLATE NOCASE
                  WHERE r.bot_id IS NOT NULL AND r.workspace_id IS NOT NULL)
                  AS unattributed_ledger_rows,
                (SELECT COUNT(*) FROM resolved
                  WHERE bot_id IS NULL OR workspace_id IS NULL)
                  AS unattributable_groups`,
      )
      .first<UpgradeCounts>();
    return {
      unattributed_ledger_rows: row?.unattributed_ledger_rows ?? 0,
      unattributable_groups: row?.unattributable_groups ?? 0,
    };
  },
};

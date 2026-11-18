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
 * Resolution, per group. Which groups are eligible (bot, tenant, at most one
 * live target naming the repository) is read when the groups are PLANNED; the
 * target itself — its match, its creation and its workspace — is decided by
 * each statement INSIDE the batch transaction, so a target an operator creates,
 * renames or retires between the two is what the batch acts on.
 *   1. bot — a candidate bot is any `bot_id` a row carries, plus the bot each
 *      row's `installation_id` resolves to in `bot_installations` (a removed
 *      row still resolves: it is history, not absence). EVERY row of the group
 *      must resolve and exactly one distinct bot may answer: a row nobody can
 *      name never borrows a sibling row's bot. Only a group with NO evidence
 *      at all falls back to the deployment's only bot, when it has one.
 *   2. workspace — `bot_workspaces` by that bot. A bot without a row has no
 *      owner, so no target could be created for it.
 *   3. target — exactly one live row of that bot naming the repository. The
 *      insert runs only when none does and the updates only when exactly one
 *      does, so two live rows naming it move nothing. The numeric id is not
 *      invented: 0067's first delivery claims it (`resolveByRepo`), exactly as
 *      it claims a migrated row.
 *   4. attribute — the four ledger tables' NULL rows of this group.
 *
 * A group whose bot or workspace does not resolve, or whose repository two
 * live targets both name, is left untouched and only reported
 * (`unattributable_groups`, advisory): guessing a tenant would write a row
 * into one nobody chose. It never fails the item, because no later pass could
 * repair it — the operator fixes the mapping and re-runs (which is why the
 * `impact` line states that a completed run takes no further batch).
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
 * The live targets of one bot that name the group's repository — the single
 * definition the insert, the updates and the read-only faces all agree on.
 * `repo_id IS NULL` rows are inside it: an unclaimed target IS the same
 * repository (0068's duplicate rule), so it is a candidate to adopt, and two of
 * them are ambiguity rather than a first-come claim. Arguments are SQL terms so
 * a correlated face can pass columns where the write path binds parameters.
 */
const matchingTargets = (botId: string, owner: string, repo: string) => `
  SELECT t.id FROM review_targets t
   WHERE t.bot_id = ${botId} AND t.deleted_at IS NULL
     AND t.repo_owner = ${owner} COLLATE NOCASE AND t.repo_name = ${repo} COLLATE NOCASE`;

/**
 * The group's own orphan rows, re-read INSIDE the batch transaction, tested for
 * "every row still resolves to the bound bot". A row that names no bot, names
 * another, or whose installation now resolves to another means the group's
 * shape changed between planning and commit — a mapping written mid-run, a
 * delivery arriving — and the statements below write nothing for that group.
 * The read is restricted to the one group, so the guard stays a seek.
 */
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
       WHERE target_id IS NULL AND owner = ${owner} COLLATE NOCASE AND repo = ${repo} COLLATE NOCASE)
    SELECT 1 FROM g
     WHERE (g.bot_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM bot_installations i
                             WHERE i.installation_id = g.installation_id))
        OR (g.bot_id IS NOT NULL AND g.bot_id <> ${bot})
        OR EXISTS (SELECT 1 FROM bot_installations i
                    WHERE i.installation_id = g.installation_id AND i.bot_id <> ${bot}))`;

/**
 * Every ledger row still holding no target, one row per ledger row, with the
 * bot it names itself. `review_failures` carries no bot of its own — it is
 * attributed through `installation_id` alone. `row_bot` is that resolution:
 * the row's own `bot_id` when set, else the bot its installation names (a
 * removed installation row still resolves — it is history, not absence).
 */
const ORPHAN_ROWS = `
  SELECT 'pull_requests' AS src, id, bot_id, NULL AS installation_id, owner, repo FROM pull_requests WHERE target_id IS NULL
  UNION ALL
  SELECT 'reviews', id, bot_id, installation_id, owner, repo FROM reviews WHERE target_id IS NULL
  UNION ALL
  SELECT 'review_findings', id, bot_id, installation_id, owner, repo FROM review_findings WHERE target_id IS NULL
  UNION ALL
  SELECT 'review_failures', id, NULL, installation_id, owner, repo FROM review_failures WHERE target_id IS NULL`;

/**
 * One row per orphan group: the spelling to write, the bot the group resolves
 * to, the live target that already names the repository, and the cursor key.
 *
 * A group is its `(owner, repo)` case-folded spelling. Its bot is decided by
 * EVERY ROW, never by the group's best row:
 *   - `unknown` counts rows naming no bot — a NULL `bot_id` whose
 *     `installation_id` resolves to nothing. One such row leaves the group
 *     unattributable: a sibling row's bot is not evidence about a row that has
 *     none, and two bots may review one repository.
 *   - `bots` counts the DISTINCT candidates. A row naming two (its own `bot_id`
 *     and an installation bound to another bot) counts both, so disagreement
 *     is ambiguity, not a tie to break.
 *   - The group resolves only when `unknown = 0` and `bots = 1`. With no
 *     evidence at all in the group it falls back to the deployment's only bot,
 *     and only when `bot_workspaces` names exactly one. A partially known group
 *     takes no fallback: its unknown row could belong to any bot.
 *
 * A bot with no `bot_workspaces` row has no tenant, so no target could be
 * created for it. `unattributable_groups` and the attribute step both read
 * this, so preflight, verify and the batch cannot disagree about what resolves.
 */
const RESOLVED_GROUPS = `
  WITH orphan(src, id, bot_id, installation_id, owner, repo) AS (${ORPHAN_ROWS}),
  row_bot(src, id, bot_id) AS (
    SELECT src, id, bot_id FROM orphan WHERE bot_id IS NOT NULL
    UNION
    SELECT o.src, o.id, i.bot_id FROM orphan o
      JOIN bot_installations i ON i.installation_id = o.installation_id),
  named(owner, repo) AS (
    SELECT MIN(owner), MIN(repo) FROM orphan
     GROUP BY owner COLLATE NOCASE, repo COLLATE NOCASE),
  claim(owner, repo, unknown, bots, candidate_bot) AS (
    SELECT n.owner, n.repo,
           SUM(NOT EXISTS (SELECT 1 FROM row_bot rb WHERE rb.src = o.src AND rb.id = o.id)),
           COUNT(DISTINCT rb.bot_id), MIN(rb.bot_id)
      FROM named n
      JOIN orphan o ON o.owner = n.owner COLLATE NOCASE
                   AND o.repo = n.repo COLLATE NOCASE
      LEFT JOIN row_bot rb ON rb.src = o.src AND rb.id = o.id
     GROUP BY n.owner, n.repo),
  only_bot(bot_id) AS (
    SELECT CASE WHEN COUNT(DISTINCT bot_id) = 1 THEN MIN(bot_id) END FROM bot_workspaces),
  attributed(owner, repo, bot_id) AS (
    SELECT c.owner, c.repo,
           CASE WHEN c.unknown = 0 AND c.bots = 1 THEN c.candidate_bot
                WHEN c.bots = 0 THEN (SELECT bot_id FROM only_bot) END
      FROM claim c),
  resolved(owner, repo, bot_id, workspace_id, targets, sort_key) AS (
    SELECT a.owner, a.repo, a.bot_id,
           (SELECT w.workspace_id FROM bot_workspaces w WHERE w.bot_id = a.bot_id),
           (SELECT COUNT(*) FROM (${matchingTargets("a.bot_id", "a.owner", "a.repo")})),
           lower(a.owner) || '/' || lower(a.repo)
      FROM attributed a)`;

/** One group's read: its spelling, what it resolved to, and its cursor key. */
type ResolvedGroup = {
  owner: string;
  repo: string;
  bot_id: string | null;
  workspace_id: string | null;
  /** Live targets of this bot naming the repository: 0 (create), 1 (adopt), 2+ (ambiguous). */
  targets: number;
  sort_key: string;
};

/** A planned batch: the statements to commit, and what they do. */
type Plan = {
  statements: DashboardD1Statement[];
  /** The last group key this batch walked; `null` when the walk ended. */
  cursor: string | null;
  done: boolean;
  groups: number;
  /** Groups left alone at planning time: no bot, no tenant, or ambiguous. */
  unattributable: number;
  /** Of those, the ones whose bot resolved but several live targets name the repository. */
  ambiguous: number;
  /** Statement positions per group this batch does write for. */
  writes: GroupWrite[];
};

/**
 * The four tables that carry `target_id`, with the column set each one needs
 * for the group predicate (all four hold `owner`/`repo`).
 */
const LEDGER_TABLES = ["pull_requests", "reviews", "review_findings", "review_failures"] as const;

/**
 * Insert the group's target — but ONLY when no live target names the
 * repository, judged INSIDE the batch transaction: an operator who added the
 * repository after the worklist read has already written the row this insert
 * would duplicate, and `repo_id IS NULL` sits outside 0068's unique index.
 *
 * The workspace comes from `bot_workspaces` inside the same statement, so a bot
 * re-homed between planning and commit writes into its current tenant, and a
 * bot that lost its tenant writes nothing at all.
 *
 * `created_by` is the operator actor, threaded in from the running step: the
 * row must name who caused it, and the actor is the one fact the runner knows
 * and an item does not.
 */
const INSERT_TARGET = `
  INSERT INTO review_targets
    (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
     follow_workspace_defaults, created_by, created_at, updated_at)
  SELECT ?4, w.workspace_id, ?1, ?5, NULL, ?2, ?3, 0, ?6, datetime('now'), datetime('now')
    FROM bot_workspaces w
   WHERE w.bot_id = ?1
     AND NOT EXISTS (${matchingTargets("?1", "?2", "?3")})
     AND ${groupStillUniform("?1", "?2", "?3")}`;

/**
 * Attribute the group's NULL rows to whichever target names the repository —
 * ONLY while exactly one live target does and the group's rows still resolve to
 * this bot. Both halves re-read inside the transaction, so a target created or
 * retired, or a mapping repaired elsewhere, after planning decides what this
 * writes instead of being written past; two matches write nothing at all rather
 * than the oldest one winning.
 */
const attributeGroup = (table: string) => `
  UPDATE ${table} SET target_id = (${matchingTargets("?1", "?2", "?3")})
   WHERE target_id IS NULL AND owner = ?2 COLLATE NOCASE AND repo = ?3 COLLATE NOCASE
     AND (SELECT COUNT(*) FROM (${matchingTargets("?1", "?2", "?3")})) = 1
     AND ${groupStillUniform("?1", "?2", "?3")}`;

async function countRows(db: DashboardD1, sql: string): Promise<number> {
  const row = await db.prepare(sql).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * A group this item can act on: its bot has a tenant AND at most one live
 * target names the repository. Everything else is left alone and reported —
 * `unattributable_groups` on the card, `advisoryChecks` on verify. Read from
 * the `resolved` CTE, so preflight, the batch and verify share one definition.
 * `{alias}` qualifies the columns where the CTE is joined to another one.
 */
const attributable = (alias: string) =>
  `${alias}bot_id IS NOT NULL AND ${alias}workspace_id IS NOT NULL AND ${alias}targets <= 1`;

/** One group's writes, as positions in `Plan.statements`. */
type GroupWrite = { insert: number | null; updates: number[] };

/**
 * Plan one batch: the groups to walk and the statements that move them.
 *
 * Only the BOT and its WORKSPACE are decided here. Which target a group lands
 * on is decided by the statements themselves, inside the batch transaction —
 * `INSERT_TARGET` and `attributeGroup` each re-read the live targets naming the
 * repository, so a target an operator created, renamed or retired between this
 * read and the commit is what the batch acts on rather than a stale plan.
 */
async function planBatch(
  db: DashboardD1,
  cursor: UpgradeCursor | null,
  actor: string,
): Promise<Plan> {
  const after = typeof cursor?.last_group === "string" ? cursor.last_group : "";
  const read = await db
    .prepare(
      `${RESOLVED_GROUPS}
       SELECT owner, repo, bot_id, workspace_id, targets, sort_key FROM resolved
        WHERE sort_key > ?1 ORDER BY sort_key LIMIT ?2`,
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
    // No bot / no tenant / two live targets naming the repository: nothing
    // names the one tenant these rows belong to. Left untouched, walked past
    // (the cursor moves), reported.
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
    // `pull_requests` is unique on `(target_id, owner, repo, pr_number)`, so two
    // NULL rows of ONE group naming the same PR would collide once both carry
    // this target. The pre-0057 ledger was unique per bot, and the group is one
    // bot's, so the shape needs a hand-edited row.
    // shortcut: such a duplicate aborts the whole batch and verify reports it
    // as `unattributed_ledger_rows`; deleting one is the operator's call, so the
    // item never guesses which PR row survives.
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

  /** Five counts the operator sees before starting: no writes. */
  async preflight(db: DashboardD1): Promise<UpgradeCounts> {
    const counts = await db
      .prepare(
        `${RESOLVED_GROUPS}
         SELECT COUNT(*) AS groups,
                COALESCE(SUM(${attributable("")} AND targets = 1), 0) AS groups_with_target,
                COALESCE(SUM(${attributable("")} AND targets = 0), 0) AS groups_needing_target,
                COALESCE(SUM(NOT (${attributable("")})), 0) AS unattributable_groups,
                COALESCE(SUM(targets > 1), 0) AS ambiguous_groups
           FROM resolved`,
      )
      .first<UpgradeCounts>();
    return {
      orphan_rows: await countRows(db, `SELECT COUNT(*) AS n FROM (${ORPHAN_ROWS})`),
      groups: counts?.groups ?? 0,
      groups_with_target: counts?.groups_with_target ?? 0,
      groups_needing_target: counts?.groups_needing_target ?? 0,
      unattributable_groups: counts?.unattributable_groups ?? 0,
      ambiguous_groups: counts?.ambiguous_groups ?? 0,
    };
  },

  /**
   * ONE transaction per call; a replay over migrated rows processes nothing.
   *
   * The counts come from the batch's own statement results, not from the plan:
   * a group whose target an operator retired between the read and the commit
   * had its guarded updates match nothing, and reporting it as attributed would
   * hide that from the operator until verify blocked on it.
   */
  async runBatch(
    db: DashboardD1,
    cursor: UpgradeCursor | null,
    actor: string,
  ): Promise<UpgradeBatch> {
    const plan = await planBatch(db, cursor, actor);
    const results = plan.statements.length > 0 ? await db.batch(plan.statements) : [];
    const moved = (index: number) => results[index]?.meta.changes ?? 0;

    let attributed = 0;
    let created = 0;
    for (const write of plan.writes) {
      if (write.insert !== null && moved(write.insert) > 0) created += 1;
      if (write.updates.some((index) => moved(index) > 0)) attributed += 1;
    }
    // A group whose statements all matched nothing changed shape between the
    // plan and the commit (a mapping repaired mid-run, or a target retired).
    // Reported, not hidden: the next step re-reads it under the new shape.
    const changed = plan.writes.length - attributed;
    return {
      cursor: plan.cursor === null ? null : { last_group: plan.cursor },
      processed: attributed,
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

  /**
   * Read-only checks. `unattributed_ledger_rows` is the crash residual: a NULL
   * row whose group the item CAN act on is work a completed run should have
   * moved, so it blocks. A group the item cannot act on is not its failure —
   * the operator fixes the bot mapping or the duplicate target and re-runs — so
   * it is only counted, by group, in the advisory `unattributable_groups`.
   */
  advisoryChecks: ["unattributable_groups"],

  async verify(db: DashboardD1): Promise<UpgradeCounts> {
    const row = await db
      .prepare(
        `${RESOLVED_GROUPS}
         SELECT (SELECT COUNT(*) FROM orphan o
                   JOIN resolved r ON r.owner = o.owner COLLATE NOCASE
                                  AND r.repo = o.repo COLLATE NOCASE
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

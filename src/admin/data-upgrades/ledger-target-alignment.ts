/**
 * Ledger target alignment — the third registered operator data upgrade
 * (spec operator-data-upgrade § Ledger target alignment item).
 *
 * Every ledger row carries `target_id`, and the repository detail page reads by
 * target: a row whose target names another repository is invisible on its own
 * repository's page while the workspace-wide aggregate still counts it.
 * Staging showed the shape this item exists for: 137 rows of
 * `btspoony/mstar-inspector` — and nine other repositories — pointed at the
 * `btspoony/mstar-harness` target, so the inspector page listed 3 rows.
 *
 * `orphan-ledger-attribution` cannot help (it fills NULL targets) and
 * `repo-backfill` cannot help either (it merges duplicate targets of one
 * repository, never re-points a row at a DIFFERENT repository).
 *
 * The worklist is every ledger row whose target names another repository,
 * grouped by `lower(owner) || '/' || lower(repo)` — the case-folded spelling the
 * store's own resolution uses. Identity is the GROUP: the four tables hold rows
 * for one repository and they must land on ONE target.
 *
 * The bot comes from the row's target: a mismatched row always has one, and it
 * names the tenant the row is visible in today — so aligning a row never moves
 * it into a workspace that did not already count it. Rows whose targets name
 * different bots are disagreement, not a tie to break, and the group is left
 * alone. Within the bot, the group's home is its one live target naming the
 * repository (case-insensitive); two of them are ambiguous and move nothing;
 * none of them means one is created in the bot's workspace with `repo_id` NULL,
 * the unclaimed shape 0067 documents.
 *
 * Binding. A target named only by owner/name waits for the repository's first
 * delivery to claim its `repo_id` (D15). When the repository's owner still has a
 * LIVE installation of that bot, this item asks GitHub instead of waiting: mint
 * an installation token, list that installation's repositories once, match
 * `owner/name`, and write the numeric id. No live installation (a removed one is
 * a genuine reason to stay unclaimed), a repository the installation does not
 * grant, or a GitHub failure leaves `repo_id` NULL and is counted — never thrown,
 * so the batch completes and the walk resumes.
 *
 * A batch is ONE `db.batch` transaction over at most GROUPS_PER_BATCH groups, in
 * a cursor over the case-folded group key. The binding calls run AFTER it
 * commits: a network call inside the transaction would hold the write lock for
 * its whole timeout. The worklist predicate is the mismatch itself and every
 * UPDATE re-tests it, so a replay over aligned rows writes nothing and no row is
 * ever deleted.
 */
import type { DashboardD1, DashboardD1Statement } from "../../dashboard/users";
import type {
  DataUpgradeItem,
  UpgradeBatch,
  UpgradeCounts,
  UpgradeCursor,
  UpgradeRunContext,
} from "../data-upgrades";

/** Repository groups per step. */
const GROUPS_PER_BATCH = 20;

/** The four tables that carry `target_id` (all four hold `owner`/`repo`). */
const LEDGER_TABLES = ["pull_requests", "reviews", "review_findings", "review_failures"] as const;

/**
 * The row's live target names another repository — the worklist predicate, and
 * the guard every UPDATE re-tests inside the transaction so a row another writer
 * just fixed is left as it is. A target with no identity (the 0067 leftover
 * shape) is NOT a mismatch: `repo-backfill` owns those rows and runs first.
 */
const misaligned = (alias: string) => `t.deleted_at IS NULL
      AND t.repo_owner IS NOT NULL AND t.repo_name IS NOT NULL
      AND (t.repo_owner <> ${alias}.owner COLLATE NOCASE
           OR t.repo_name <> ${alias}.repo COLLATE NOCASE)`;

/**
 * The group's home target already holds a `pull_requests` row at this number:
 * `idx_pull_requests_target_pr` is unique on `(target_id, owner, repo,
 * pr_number)`, so re-pointing this row would abort the whole batch. The row is
 * left where it is and reported (`conflicting_ledger_rows`) — deleting one of
 * the two copies is the operator's call, exactly as `repo-backfill` treats its
 * own duplicate losers. Only `pull_requests` can collide: the other three
 * ledgers are unique on their installation/app keys, not on the target.
 */
const prConflict = (alias: string) => `EXISTS (
  SELECT 1 FROM review_targets h JOIN pull_requests o ON o.target_id = h.id
   WHERE h.deleted_at IS NULL
     AND h.bot_id = (SELECT b.bot_id FROM review_targets b WHERE b.id = ${alias}.target_id)
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
 * for misaligned rows rather than seeked; upgrade when a stored/indexed
 * group-key column exists to range over.
 */
const misalignedRows = (after: string) => {
  const floor = (alias: string) =>
    ` AND lower(${alias}.owner) || '/' || lower(${alias}.repo) > ${after}`;
  return `
  SELECT 'pull_requests' AS src, p.id, t.bot_id, p.owner, p.repo,
         lower(p.owner) || '/' || lower(p.repo) AS group_key
    FROM pull_requests p JOIN review_targets t ON t.id = p.target_id
   WHERE ${misaligned("p")} AND NOT (${prConflict("p")})${floor("p")}
  UNION ALL
  SELECT 'reviews', r.id, t.bot_id, r.owner, r.repo,
         lower(r.owner) || '/' || lower(r.repo)
    FROM reviews r JOIN review_targets t ON t.id = r.target_id
   WHERE ${misaligned("r")}${floor("r")}
  UNION ALL
  SELECT 'review_findings', f.id, t.bot_id, f.owner, f.repo,
         lower(f.owner) || '/' || lower(f.repo)
    FROM review_findings f JOIN review_targets t ON t.id = f.target_id
   WHERE ${misaligned("f")}${floor("f")}
  UNION ALL
  SELECT 'review_failures', x.id, t.bot_id, x.owner, x.repo,
         lower(x.owner) || '/' || lower(x.repo)
    FROM review_failures x JOIN review_targets t ON t.id = x.target_id
   WHERE ${misaligned("x")}${floor("x")}`;
};

/**
 * One row per group: the spelling to write, the bot that owns it, the one live
 * target naming the repository, and whether GitHub could bind that target.
 *
 * `bots` counts the DISTINCT bots the group's rows' targets name: more than one
 * is disagreement, so `bot_id` stays NULL and nothing is written. `homes` is
 * scoped by the same CASE, so such a group matches no target rather than
 * adopting one across tenants.
 *
 * `unbound` predicts the binding outcome for preflight: the group is actionable,
 * its home target has no `repo_id`, and the owner has no live installation of
 * that bot — a removed installation is history, so the first delivery, not this
 * item, claims the id.
 */
const alignmentGroups = (after: string) => `
  WITH live(src, id, bot_id, owner, repo, group_key) AS (${misalignedRows(after)}),
  named(group_key, owner, repo) AS (
    SELECT group_key, MIN(owner), MIN(repo) FROM live GROUP BY group_key),
  claim(group_key, bots, bot_id) AS (
    SELECT group_key, COUNT(DISTINCT bot_id), MIN(bot_id) FROM live GROUP BY group_key),
  homes(group_key, targets, repo_id) AS (
    SELECT c.group_key, COUNT(t.id), MIN(t.repo_id)
      FROM claim c
      JOIN named n ON n.group_key = c.group_key
      LEFT JOIN review_targets t
        ON t.deleted_at IS NULL
       AND t.bot_id = CASE WHEN c.bots = 1 THEN c.bot_id END
       AND t.repo_owner = n.owner COLLATE NOCASE AND t.repo_name = n.repo COLLATE NOCASE
     GROUP BY c.group_key),
  resolved AS (
    SELECT n.group_key, n.owner, n.repo,
           CASE WHEN c.bots = 1 THEN c.bot_id END AS bot_id,
           (SELECT w.workspace_id FROM bot_workspaces w WHERE w.bot_id = c.bot_id) AS workspace_id,
           COALESCE(h.targets, 0) AS targets,
           h.repo_id AS repo_id,
           (c.bots = 1 AND COALESCE(h.targets, 0) <= 1
            AND (COALESCE(h.targets, 0) = 1
                 OR EXISTS (SELECT 1 FROM bot_workspaces w WHERE w.bot_id = c.bot_id))
            AND (COALESCE(h.targets, 0) = 0 OR h.repo_id IS NULL)
            AND NOT EXISTS (SELECT 1 FROM bot_installations i
                             WHERE i.bot_id = c.bot_id AND i.removed_at IS NULL
                               AND i.account_login = n.owner COLLATE NOCASE)) AS unbound
      FROM named n
      JOIN claim c ON c.group_key = n.group_key
      LEFT JOIN homes h ON h.group_key = n.group_key)`;

/**
 * A group this item can act on: one known bot, at most one live target naming
 * the repository, and — when none does — a tenant to create it in. Everything
 * else is left alone and reported; `{alias}` qualifies the columns where the CTE
 * is joined to another one.
 */
const actionable = (alias: string) =>
  `${alias}bot_id IS NOT NULL AND ${alias}targets <= 1
   AND (${alias}targets = 1 OR ${alias}workspace_id IS NOT NULL)`;

/** The group's one live target naming the repository. Bound as (bot, owner, repo). */
const homeTarget = `SELECT t.id FROM review_targets t
   WHERE t.deleted_at IS NULL AND t.bot_id = ?1
     AND t.repo_owner = ?2 COLLATE NOCASE AND t.repo_name = ?3 COLLATE NOCASE`;

/**
 * Create the group's target — ONLY when no live target of that bot names the
 * repository, judged INSIDE the batch transaction: an operator who added the
 * repository after the worklist read has already written the row this insert
 * would duplicate, and `repo_id IS NULL` sits outside 0068's unique index.
 *
 * The workspace comes from `bot_workspaces` inside the same statement, so a bot
 * re-homed between planning and commit writes into its current tenant, and a bot
 * that lost its tenant writes nothing at all.
 *
 * `follow_workspace_defaults = 1` is the UI-create rule (J4): a repository this
 * item creates is an ordinary repository, so it inherits the workspace's review
 * answers exactly as one added through the add-repository dialog does, and the
 * row's own policy columns stay inert placeholders until an operator overrides
 * them. Setting 0 here would permanently opt the repository out of the
 * workspace defaults without anyone choosing that.
 */
const INSERT_TARGET = `
  INSERT INTO review_targets
    (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
     follow_workspace_defaults, created_by, created_at, updated_at)
  SELECT ?4, w.workspace_id, ?1, ?5, NULL, ?2, ?3, 1, ?6, datetime('now'), datetime('now')
    FROM bot_workspaces w
   WHERE w.bot_id = ?1
     AND NOT EXISTS (${homeTarget})`;

/**
 * Re-point the group's rows — ONLY while the row's target still names another
 * repository and exactly one live target of this bot names the repository. Both
 * halves re-read inside the transaction, so a target created or retired after
 * planning decides what this writes instead of being written past; two matches
 * write nothing at all rather than the oldest one winning.
 */
const repointGroup = (table: string) => `
  UPDATE ${table} SET target_id = (${homeTarget})
   WHERE owner = ?2 COLLATE NOCASE AND repo = ?3 COLLATE NOCASE
     AND EXISTS (SELECT 1 FROM review_targets t
                  WHERE t.id = ${table}.target_id AND ${misaligned(table)})
     ${table === "pull_requests" ? `AND NOT (${prConflict(table)})` : ""}
     AND (SELECT COUNT(*) FROM review_targets t
           WHERE t.deleted_at IS NULL AND t.bot_id = ?1
             AND t.repo_owner = ?2 COLLATE NOCASE AND t.repo_name = ?3 COLLATE NOCASE) = 1`;

/**
 * Write the repository's numeric id onto the target. Guarded twice: only while
 * the claim is still absent, and never when another live target of the same bot
 * already holds that id — 0068's unique index would abort the whole batch on it.
 */
const BIND_REPO_ID = `
  UPDATE review_targets SET repo_id = ?1, updated_at = datetime('now')
   WHERE deleted_at IS NULL AND bot_id = ?2
     AND repo_owner = ?3 COLLATE NOCASE AND repo_name = ?4 COLLATE NOCASE
     AND repo_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM review_targets o
                      WHERE o.bot_id = ?2 AND o.repo_id = ?1 AND o.deleted_at IS NULL
                        AND o.id <> review_targets.id)`;

/** One resolved group, as the plan read states it. */
type Group = {
  group_key: string;
  owner: string;
  repo: string;
  bot_id: string | null;
  workspace_id: string | null;
  /** Live targets of this bot naming the repository: 0 (create), 1 (adopt), 2+ (ambiguous). */
  targets: number;
  repo_id: number | null;
  /** Preflight only: 1 when nothing live could bind the target's numeric id. */
  unbound: number;
};

/** One group's writes, as positions in `Plan.statements`. */
type GroupWrite = { insert: number | null; updates: number[]; group: Group };

/** A planned batch: the statements to commit, and what they do. */
type Plan = {
  statements: DashboardD1Statement[];
  /** The last group key this batch walked; `null` when the walk ended. */
  cursor: string | null;
  done: boolean;
  groups: number;
  ambiguous: number;
  unattributable: number;
  writes: GroupWrite[];
};

/** The bot's live installation whose account login is `owner`, if any. */
async function liveInstallation(
  db: DashboardD1,
  botId: string,
  owner: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT MIN(installation_id) AS n FROM bot_installations
        WHERE bot_id = ?1 AND removed_at IS NULL AND account_login = ?2 COLLATE NOCASE`,
    )
    .bind(botId, owner)
    .first<{ n: number | null }>();
  return row?.n ?? null;
}

/**
 * Plan one batch. The target a group lands on is decided by the STATEMENTS,
 * inside the transaction — each re-reads the bot's live targets naming the
 * repository, so a target an operator created, renamed or retired between this
 * read and the commit is what the batch acts on rather than a stale plan.
 */
async function planBatch(
  db: DashboardD1,
  cursor: UpgradeCursor | null,
  actor: string | undefined,
): Promise<Plan> {
  const after = typeof cursor?.last_group === "string" ? cursor.last_group : "";
  const read = await db
    .prepare(
      `${alignmentGroups("?1")}
       SELECT group_key, owner, repo, bot_id, workspace_id, targets, repo_id, unbound
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
    if (group.bot_id === null || (group.targets === 0 && group.workspace_id === null)) {
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
            group.bot_id,
            group.owner,
            group.repo,
            crypto.randomUUID(),
            `${group.owner}/${group.repo}`,
            // The row must name who caused it; the runner always supplies the operator.
            actor ?? "data-upgrade",
          ),
      );
    }
    for (const table of LEDGER_TABLES) {
      write.updates.push(plan.statements.length);
      plan.statements.push(
        db.prepare(repointGroup(table)).bind(group.bot_id, group.owner, group.repo),
      );
    }
    plan.writes.push(write);
  }
  return plan;
}

/**
 * Bind one group's target when the repository's owner still has a live
 * installation. The result is the batch log's bucket: `bound`, `unbound` (no
 * live installation, or a repository the installation does not grant) or
 * `binding_failed` (GitHub could not answer). Never throws.
 */
async function bindGroup(
  db: DashboardD1,
  group: Group,
  context: UpgradeRunContext | undefined,
): Promise<"bound" | "unbound" | "binding_failed"> {
  const botId = group.bot_id;
  const lookup = context?.repoLookup;
  if (botId === null || lookup === undefined) return "unbound";
  const installationId = await liveInstallation(db, botId, group.owner);
  // A removed installation is history: the first delivery claims the id.
  if (installationId === null) return "unbound";
  const found = await lookup(botId, installationId, group.owner, group.repo);
  if (found.kind === "failed") return "binding_failed";
  if (found.kind === "absent") return "unbound";
  const written = await db
    .prepare(BIND_REPO_ID)
    .bind(found.repoId, botId, group.owner, group.repo)
    .run();
  return written.meta.changes > 0 ? "bound" : "unbound";
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

  /** Six counts the operator sees before starting: no writes. */
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

  /**
   * ONE transaction per call; a replay over aligned rows processes nothing.
   *
   * The counts come from the batch's own statement results, not from the plan: a
   * group whose target an operator retired between the read and the commit had
   * its guarded updates match nothing, and reporting it as aligned would hide
   * that from the operator until verify blocked on it.
   *
   * `processed` is the LEDGER ROWS the batch moved (`UpgradeBatch.processed`'s
   * contract); `log.aligned` stays the count of groups, the unit the walk pages
   * in.
   */
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
        // The four updates are per-table and disjoint, so their sum is the rows
        // this group moved — zero when the guards stood the group down.
        const touched = write.updates.reduce((sum, index) => sum + changes(index), 0);
        if (touched > 0) {
          aligned += 1;
          moved.push(write);
        }
        rows += touched;
      }
    }

    // Bind AFTER the moves commit: a GitHub call inside the transaction would
    // hold the write lock for its whole timeout.
    let bound = 0;
    let unbound = 0;
    let bindingFailed = 0;
    for (const { group } of moved) {
      // An adopted target that already carries its id needs no call at all.
      if (group.targets === 1 && group.repo_id !== null) continue;
      const outcome = await bindGroup(db, group, context);
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

  /**
   * Read-only checks. `misaligned_ledger_rows` is the crash residual: a row
   * whose group the item CAN act on is work a completed run should have moved,
   * so it blocks. A group the item cannot act on — two live targets naming the
   * repository, or rows naming different bots — is not its failure: the operator
   * resolves that and re-runs, so it is only counted, by group, as advisory.
   */
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

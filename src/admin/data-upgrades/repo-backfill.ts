/**
 * Repository identity backfill — the first registered operator data upgrade
 * (spec operator-data-upgrade § Repository backfill item, D15/D22).
 *
 * 0067 keyed a review target by repository but moved no rows: every migrated
 * row keeps the 0067 leftover shape — `repo_id`, `repo_owner` and `repo_name`
 * all NULL — one row per BOT, while its `pull_requests` rows name the several
 * repositories that bot actually reviewed. This item splits such a row into
 * one live target per repository, repoints the ledger onto it and retires the
 * old row.
 *
 * The worklist predicate IS the leftover shape, and that is what makes a
 * replay over finished work move NOTHING: the rows a batch creates name their
 * repository, so they never re-enter the worklist. A target that already names
 * a repository is left alone, including one still awaiting its first
 * delivery's `repo_id` claim (D15).
 *
 * Merge rule D22: several old rows of one workspace naming the same
 * `(owner, repo)` collapse into ONE target. The winner is the row with the
 * newest `pull_requests.last_seen_at` for that repository, then the newest
 * `reviews.reviewed_at`, then the lowest id — a total order, so the item is
 * deterministic and its batches are replayable. Losers' configuration is
 * discarded and counted in the batch log; no user choice is ever surfaced.
 *
 * A batch is ONE `db.batch` transaction: the reads plan it, the write half
 * commits or rolls back as a whole, so a worker that dies leaves the previous
 * batch intact and the cursor resumes on work the worklist still names.
 */
import type { DashboardD1, DashboardD1Statement } from "../../dashboard/users";
import type { DataUpgradeItem, UpgradeBatch, UpgradeCounts, UpgradeCursor } from "../data-upgrades";

/** Targets per step (spec § Repository backfill item). */
const BATCH_SIZE = 20;

/** A live target of the 0067 leftover shape: no identity, no repository name. */
const LEFTOVER_TARGET = `t.deleted_at IS NULL
  AND t.repo_id IS NULL AND t.repo_owner IS NULL AND t.repo_name IS NULL`;

/** One worklist row: an old target and the workspace it belongs to. */
type WorklistRow = { id: string; workspace_id: string };

/** One old row's claim on a repository, with the D22 tie-breakers read in SQL. */
type MemberRow = { id: string; last_seen: string | null; last_reviewed: string | null };

/** One repository a batch collapses onto, and the rows it consumes. */
type Group = { workspaceId: string; owner: string; repo: string };

/** A planned batch: the statements to commit, and what they do. */
type Plan = {
  statements: DashboardD1Statement[];
  created: number;
  adopted: number;
  /** Old targets this batch retires — deduped across the groups sharing one. */
  consumed: Set<string>;
  discarded: number;
  repointed: number;
  cursor: string | null;
  done: boolean;
};

function emptyPlan(): Plan {
  return {
    statements: [],
    created: 0,
    adopted: 0,
    consumed: new Set(),
    discarded: 0,
    repointed: 0,
    cursor: null,
    done: true,
  };
}

/** `?, ?, …` — one placeholder per value (D1's bound-parameter list). */
function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

/** D22 over one member's two stamps: newest activity first, then the lowest id. */
function compareMembers(a: MemberRow, b: MemberRow): number {
  const bySeen = (b.last_seen ?? "").localeCompare(a.last_seen ?? "");
  if (bySeen !== 0) return bySeen;
  const byReviewed = (b.last_reviewed ?? "").localeCompare(a.last_reviewed ?? "");
  if (byReviewed !== 0) return byReviewed;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function countRows(db: DashboardD1, sql: string, ...values: unknown[]): Promise<number> {
  const stmt = db.prepare(sql);
  const row = await (values.length === 0 ? stmt : stmt.bind(...values)).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Every live leftover row of one workspace that holds ledger rows for
 * `owner/repo`, in D22 order. Members are resolved for the WHOLE workspace,
 * not just the current batch: two old rows naming the same repository may sit
 * in different batches, and the second batch must see that the first already
 * retired its sibling rather than create a second target for the same repo.
 */
async function readMembers(
  db: DashboardD1,
  workspaceId: string,
  owner: string,
  repo: string,
): Promise<MemberRow[]> {
  const res = await db
    .prepare(
      `SELECT t.id,
              (SELECT MAX(p.last_seen_at) FROM pull_requests p
                WHERE p.target_id = t.id AND p.owner = ?2 AND p.repo = ?3) AS last_seen,
              (SELECT MAX(r.reviewed_at) FROM reviews r
                WHERE r.target_id = t.id AND r.owner = ?2 AND r.repo = ?3) AS last_reviewed
         FROM review_targets t
        WHERE t.workspace_id = ?1 AND ${LEFTOVER_TARGET}
          AND EXISTS (SELECT 1 FROM pull_requests p
                       WHERE p.target_id = t.id AND p.owner = ?2 AND p.repo = ?3)`,
    )
    .bind(workspaceId, owner, repo)
    .all<MemberRow>();
  return res.results.slice().sort(compareMembers);
}

/** The live target that already names this repository, or null. */
async function findNamedTarget(
  db: DashboardD1,
  workspaceId: string,
  owner: string,
  repo: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM review_targets
        WHERE workspace_id = ?1 AND deleted_at IS NULL
          AND repo_owner = ?2 COLLATE NOCASE AND repo_name = ?3 COLLATE NOCASE
        ORDER BY created_at, id LIMIT 1`,
    )
    .bind(workspaceId, owner, repo)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * Plan one batch. Every read happens here; the write half is the returned
 * statement list, so ONE `db.batch` commits the whole move.
 */
async function planBatch(db: DashboardD1, cursor: UpgradeCursor | null): Promise<Plan> {
  const after = typeof cursor?.last_target_id === "string" ? cursor.last_target_id : "";
  const worklist = await db
    .prepare(
      `SELECT t.id, t.workspace_id FROM review_targets t
        WHERE t.id > ?1 AND ${LEFTOVER_TARGET}
          AND EXISTS (SELECT 1 FROM pull_requests p WHERE p.target_id = t.id)
        ORDER BY t.id LIMIT ?2`,
    )
    .bind(after, BATCH_SIZE)
    .all<WorklistRow>();
  const rows = worklist.results;
  if (rows.length === 0) return emptyPlan();

  // The distinct repositories this batch's old rows hold ledger rows for.
  const groups: Group[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const pairs = await db
      .prepare("SELECT DISTINCT owner, repo FROM pull_requests WHERE target_id = ?1")
      .bind(row.id)
      .all<{ owner: string; repo: string }>();
    for (const pair of pairs.results) {
      const key = JSON.stringify([row.workspace_id, pair.owner, pair.repo]);
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push({ workspaceId: row.workspace_id, owner: pair.owner, repo: pair.repo });
    }
  }

  const plan = emptyPlan();
  plan.cursor = rows[rows.length - 1]!.id;
  plan.done = rows.length < BATCH_SIZE;
  for (const group of groups) await planGroup(db, plan, group);

  // A leftover row with no ledger rows awaits its first delivery (待安装): it is
  // untouched apart from this flag, so its copied configuration keeps
  // answering instead of the workspace's (D16 — no live review changes).
  plan.statements.push(
    db.prepare(
      `UPDATE review_targets SET follow_workspace_defaults = 0, updated_at = datetime('now')
        WHERE deleted_at IS NULL AND repo_id IS NULL AND repo_owner IS NULL AND repo_name IS NULL
          AND follow_workspace_defaults = 1
          AND NOT EXISTS (SELECT 1 FROM pull_requests p WHERE p.target_id = review_targets.id)`,
    ),
  );

  // Retire the old rows LAST: one row may hold ledger rows for several
  // repositories, so it is repointed by every group before it is retired
  // (deleting it inside a group would hide it from the next group's reads).
  if (plan.consumed.size > 0) {
    const ids = [...plan.consumed];
    plan.statements.push(
      db
        .prepare(
          `UPDATE review_targets SET deleted_at = datetime('now'), updated_at = datetime('now')
            WHERE id IN (${placeholders(ids.length)})`,
        )
        .bind(...ids),
    );
  }
  return plan;
}

/** Append one group's statements to `plan` and count what they do. */
async function planGroup(db: DashboardD1, plan: Plan, group: Group): Promise<void> {
  const members = await readMembers(db, group.workspaceId, group.owner, group.repo);
  if (members.length === 0) return;
  const winner = members[0]!;

  // An already-named live target is the repository's home: repointing onto it
  // keeps one live target per repository instead of creating a duplicate the
  // store's own add path would refuse.
  const named = await findNamedTarget(db, group.workspaceId, group.owner, group.repo);
  const targetId = named ?? crypto.randomUUID();
  if (named === null) {
    const source = await db
      .prepare("SELECT * FROM review_targets WHERE id = ?1")
      .bind(winner.id)
      .first<Record<string, unknown>>();
    plan.statements.push(
      db
        .prepare(
          `INSERT INTO review_targets
             (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
              follow_workspace_defaults, review_enabled, review_trigger_mode, review_level,
              check_min_score, check_pass_verdicts, created_by, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11, ?12,
                   datetime('now'), datetime('now'))`,
        )
        .bind(
          targetId,
          group.workspaceId,
          source!.bot_id,
          `${group.owner}/${group.repo}`,
          group.owner,
          group.repo,
          source!.review_enabled,
          source!.review_trigger_mode,
          source!.review_level,
          source!.check_min_score,
          source!.check_pass_verdicts,
          source!.created_by,
        ),
    );
    plan.created += 1;
  } else {
    plan.adopted += 1;
  }
  // Losers' configuration goes with their rows; the count is the only record
  // the operator keeps of what the merge discarded.
  plan.discarded += members.length - 1;

  const memberIds = members.map((member) => member.id);
  const memberList = placeholders(memberIds.length);

  // `(target_id, owner, repo, pr_number)` is UNIQUE (0057:229-230): two old
  // rows of one group may hold the same PR. Keep the later `last_seen_at`
  // (then the lower id) and delete the rest BEFORE the repoint, so the update
  // cannot collide with itself.
  const prs = await db
    .prepare(
      `SELECT id, pr_number FROM pull_requests
        WHERE target_id IN (${memberList}) AND owner = ? AND repo = ?
        ORDER BY pr_number, last_seen_at DESC, id`,
    )
    .bind(...memberIds, group.owner, group.repo)
    .all<{ id: string; pr_number: number }>();
  const keepers = new Set<number>();
  const drops: string[] = [];
  for (const pr of prs.results) {
    if (keepers.has(pr.pr_number)) drops.push(pr.id);
    else keepers.add(pr.pr_number);
  }
  if (drops.length > 0) {
    plan.statements.push(
      db.prepare(`DELETE FROM pull_requests WHERE id IN (${placeholders(drops.length)})`).bind(...drops),
    );
  }

  for (const table of ["pull_requests", "reviews", "review_findings", "review_failures"]) {
    plan.statements.push(
      db
        .prepare(
          `UPDATE ${table} SET target_id = ?1
            WHERE target_id IN (${memberList}) AND owner = ? AND repo = ?`,
        )
        .bind(targetId, ...memberIds, group.owner, group.repo),
    );
  }
  plan.repointed += keepers.size;

  // Retired by `planBatch` after every group ran: this row may still hold
  // ledger rows for another repository of the same batch.
  for (const id of memberIds) plan.consumed.add(id);
}

/**
 * The registered item. `requiresDowntime` because a review that landed between
 * the repoint and the soft delete would write against a target this batch
 * retired.
 */
export const repoBackfill: DataUpgradeItem = {
  id: "repo-backfill",
  title: "Repository identity backfill",
  requiresDowntime: true,
  order: 10,

  /** Four counts the operator sees before starting: no writes. */
  async preflight(db: DashboardD1): Promise<UpgradeCounts> {
    return {
      // Every live row whose repository identity is still unset.
      unidentified_targets: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM review_targets t WHERE ${LEFTOVER_TARGET}`,
      ),
      // The (target, repository) pairs the split moves rows for.
      ledger_pairs: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM (
           SELECT p.target_id, p.owner, p.repo FROM pull_requests p
             JOIN review_targets t ON t.id = p.target_id AND t.deleted_at IS NULL
            GROUP BY p.target_id, p.owner, p.repo)`,
      ),
      // Repositories covered by more than one live row: D22 collapses them.
      conflicting_groups: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM (
           SELECT p.owner, p.repo FROM pull_requests p
             JOIN review_targets t ON t.id = p.target_id AND t.deleted_at IS NULL
            WHERE ${LEFTOVER_TARGET}
            GROUP BY t.workspace_id, p.owner, p.repo
           HAVING COUNT(DISTINCT t.id) > 1)`,
      ),
      // Awaiting-first-delivery rows: untouched except the follow flag.
      empty_targets: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM review_targets t
          WHERE t.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM pull_requests p WHERE p.target_id = t.id)`,
      ),
    };
  },

  /** ONE transaction per call; a replay over migrated rows processes nothing. */
  async runBatch(db: DashboardD1, cursor: UpgradeCursor | null): Promise<UpgradeBatch> {
    const plan = await planBatch(db, cursor);
    if (plan.statements.length > 0) await db.batch(plan.statements);
    return {
      cursor: plan.cursor === null ? null : { last_target_id: plan.cursor },
      processed: plan.consumed.size,
      done: plan.done,
      log: {
        groups: plan.created + plan.adopted,
        created: plan.created,
        adopted: plan.adopted,
        consumed: plan.consumed.size,
        discarded: plan.discarded,
        repointed: plan.repointed,
      },
    };
  },

  /**
   * Read-only checks, every one of which must read 0.
   *
   * The second is the crash residual, not a data-quality opinion: a ledger row
   * still naming a retired target WHILE a live target of the same workspace
   * already covers that repository is exactly a batch that created the
   * replacement and died before repointing every row. A target the user
   * deleted through the dashboard has no such live coverage and is not
   * counted — that history is not this item's to judge.
   */
  async verify(db: DashboardD1): Promise<UpgradeCounts> {
    return {
      // Identity is owner/name, not `repo_id`: a backfilled row names its
      // repository and legitimately awaits the first delivery's id claim (D15).
      unidentified_targets_with_ledger: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM review_targets t
          WHERE t.deleted_at IS NULL AND (t.repo_owner IS NULL OR t.repo_name IS NULL)
            AND EXISTS (SELECT 1 FROM pull_requests p WHERE p.target_id = t.id)`,
      ),
      unrepointed_ledger_rows: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM (
           SELECT target_id, owner, repo FROM pull_requests
           UNION ALL SELECT target_id, owner, repo FROM reviews
           UNION ALL SELECT target_id, owner, repo FROM review_findings
           UNION ALL SELECT target_id, owner, repo FROM review_failures) x
          JOIN review_targets d ON d.id = x.target_id AND d.deleted_at IS NOT NULL
         WHERE EXISTS (
           SELECT 1 FROM review_targets l
             JOIN pull_requests lp ON lp.target_id = l.id
            WHERE l.deleted_at IS NULL AND l.workspace_id = d.workspace_id
              AND l.repo_owner = x.owner COLLATE NOCASE
              AND l.repo_name = x.repo COLLATE NOCASE)`,
      ),
      duplicate_repository_groups: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM (
           SELECT t.workspace_id, t.repo_owner, t.repo_name FROM review_targets t
            WHERE t.deleted_at IS NULL AND t.repo_owner IS NOT NULL AND t.repo_name IS NOT NULL
              AND EXISTS (SELECT 1 FROM pull_requests p WHERE p.target_id = t.id)
            GROUP BY t.workspace_id, t.repo_owner, t.repo_name
           HAVING COUNT(*) > 1)`,
      ),
    };
  },
};

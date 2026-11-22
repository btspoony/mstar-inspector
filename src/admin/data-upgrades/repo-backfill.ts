/**
 * why: Repository identity backfill — the first registered operator data upgrade
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
 * Identity is BOT-scoped: 0068's uniqueness claim and `resolveByRepo` both key
 * a repository by `(bot_id, repo_id)`, so the group, its members, the
 * already-named lookup and the verify checks all key `(bot_id, owner, repo)` —
 * across workspaces. Two bots reviewing the same repository own two targets;
 * one bot's two workspaces collapse into ONE, created in the D22 winner's
 * workspace.
 *
 * Merge rule D22: several old rows of one bot naming the same
 * `(owner, repo)` collapse into ONE target. The winner is the row with the
 * newest `pull_requests.last_seen_at` for that repository, then the newest
 * `reviews.reviewed_at`, then the lowest id — a total order, so the item is
 * deterministic and its batches are replayable. Losers' configuration is
 * discarded and counted in the batch log; no user choice is ever surfaced.
 *
 * Owner and repository compare `COLLATE NOCASE` on every side — the store's
 * own add path and `resolveByRepo` are case-insensitive, so a case variant
 * spelling must join its group rather than create a second live target. The
 * JS side of that comparison folds ASCII `A-Z` only, exactly like `NOCASE`:
 * `toLowerCase()` would collapse `Ä` onto `ä`, which SQL keeps apart.
 *
 * One step is capped by GROUPS, not by worklist rows: a single target can name
 * hundreds of repositories, and a row cap would both wedge the cursor and fan
 * out unbounded reads. A target whose pairs did not all fit is left in the
 * worklist (its migrated pairs are gone, so the next step resumes on what is
 * left) — EXCEPT one this batch emptied of every pair it held: the worklist
 * finds a row only by a ledger row, so such a row is retired by the
 * same batch instead of stranding as a live row nobody will scan again.
 * `IN (…)` lists are chunked at IN_CHUNK values — D1 refuses a statement that
 * binds more than 100 parameters.
 *
 * A batch is ONE `db.batch` transaction: the reads plan it, the write half
 * commits or rolls back as a whole, so a worker that dies leaves the previous
 * batch intact and the cursor resumes on work the worklist still names.
 */
import type { DashboardD1, DashboardD1Statement } from "../../dashboard/users";
import type {
  DataUpgradeItem,
  UpgradeBatch,
  UpgradeCounts,
  UpgradeCursor,
  UpgradeVerifyContext,
} from "../data-upgrades";

/** note: Repository groups per step (spec § Repository backfill item). */
const GROUPS_PER_BATCH = 20;

/** note: Worklist rows scanned per step: the reads planning one batch are bounded too. */
const SCAN_LIMIT = 20;

/** note: Values per `IN (…)` list (D1's bound-parameter cap leaves room for the rest). */
const IN_CHUNK = 40;

/** note: A live target of the 0067 leftover shape: no identity, no repository name. */
const LEFTOVER_TARGET = `t.deleted_at IS NULL
  AND t.repo_id IS NULL AND t.repo_owner IS NULL AND t.repo_name IS NULL`;

/**
 * why: Every ledger row's claim on a repository. `pull_requests` is the only table
 * that carries `pr_number`/`last_seen_at`, but a target is leftover work while
 * ANY of the four tables still points at it: sweeping the PRs does not sweep
 * the reviews, findings or failures written for them.
 */
const LEDGER_IDENTITIES = `SELECT target_id, owner, repo FROM pull_requests
   UNION ALL SELECT target_id, owner, repo FROM reviews
   UNION ALL SELECT target_id, owner, repo FROM review_findings
   UNION ALL SELECT target_id, owner, repo FROM review_failures`;

/** note: Any ledger row at all on `target`: the eligibility predicate of every seam. */
function hasLedger(target: string): string {
  return `EXISTS (SELECT 1 FROM (${LEDGER_IDENTITIES}) x WHERE x.target_id = ${target})`;
}

/**
 * why: Ledger rows sitting on a soft-deleted target this item's worklist could not
 * visit again (a live target of the same bot already covers the repository,
 * wherever it lives — naming it is enough, it need not hold a PR). The split is
 * a TIME comparison, not a flag: retirement stamps `deleted_at`, and this run's
 * own start stamp is what separates its work from deletions that predate it.
 * `%s` is the time predicate on that stamp.
 */
const RETIRED_LEDGER_ROWS = `FROM (${LEDGER_IDENTITIES}) x
  JOIN review_targets d ON d.id = x.target_id AND d.deleted_at IS NOT NULL
 WHERE EXISTS (
   SELECT 1 FROM review_targets l
    WHERE l.deleted_at IS NULL AND l.bot_id = d.bot_id
      AND l.repo_owner = x.owner COLLATE NOCASE
      AND l.repo_name = x.repo COLLATE NOCASE)
   AND %s`;

/**
 * why: One retired-target count: `blocking` rows (retired at or after the run's
 * start, so this run could have stranded them) or `historical` ones (retired
 * before it). With no recorded run start nothing was retired by this item, so
 * every deleted target is history — and no row can block.
 *
 * `datetime()` on both sides: `deleted_at` is written as SQLite's
 * `datetime('now')` while the run start is an ISO-8601 stamp, and a lexical
 * comparison of those two shapes would be wrong.
 */
function retiredRowsSql(kind: "blocking" | "historical", runStart: string | null): string {
  if (runStart === null) {
    return RETIRED_LEDGER_ROWS.replace("%s", kind === "blocking" ? "0 = 1" : "1 = 1");
  }
  const op = kind === "blocking" ? ">=" : "<";
  return RETIRED_LEDGER_ROWS.replace("%s", `datetime(d.deleted_at) ${op} datetime(?1)`);
}

/** note: One worklist row: an old target and its bot. */
type WorklistRow = { id: string; bot_id: string };

/**
 * note: One old row's claim on a repository, with the D22 tie-breakers read in SQL.
 * The workspace travels with the row: it spans groups, so the winner's own
 * workspace is where the merged target is created.
 */
type MemberRow = {
  id: string;
  workspace_id: string;
  last_seen: string | null;
  last_reviewed: string | null;
};

/** note: One repository a batch collapses onto, and the rows it consumes. */
type Group = { botId: string; owner: string; repo: string };

/** note: A planned batch: the statements to commit, and what they do. */
type Plan = {
  statements: DashboardD1Statement[];
  created: number;
  adopted: number;
  /** note: Old targets this batch retires — deduped across the groups sharing one. */
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

/** note: `?, ?, …` — one placeholder per value (D1's bound-parameter list). */
function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

/** note: Split a bound list into D1-sized statements. */
function chunked<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < values.length; at += IN_CHUNK) out.push(values.slice(at, at + IN_CHUNK));
  return out;
}

/** note: D22 over one member's two stamps: newest activity first, then the lowest id. */
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
 * note: Every live leftover row of one bot that holds ledger rows for this group's
 * `owner/repo`, in D22 order, ACROSS the bot's workspaces. Members are resolved
 * for the WHOLE bot, not just the current batch: two old rows naming the same
 * repository may sit in different batches, and the second batch must see that
 * the first already retired its sibling rather than create a second target for
 * the same repo. Bot scope also spans workspaces, because 0068's claim and
 * `resolveByRepo` do: a repository a bot reviews is one target, not one per
 * workspace.
 *
 * A member is any ledger table's claim: a target whose PRs were swept but whose
 * reviews or findings remain still holds this repository's history. With no PR
 * row its `last_seen` is NULL — D22 falls through to the review stamp, not to
 * "no member".
 */
async function readMembers(db: DashboardD1, group: Group): Promise<MemberRow[]> {
  const res = await db
    .prepare(
      `SELECT t.id, t.workspace_id,
              (SELECT MAX(p.last_seen_at) FROM pull_requests p
                WHERE p.target_id = t.id AND p.owner = ?2 COLLATE NOCASE
                  AND p.repo = ?3 COLLATE NOCASE) AS last_seen,
              (SELECT MAX(r.reviewed_at) FROM reviews r
                WHERE r.target_id = t.id AND r.owner = ?2 COLLATE NOCASE
                  AND r.repo = ?3 COLLATE NOCASE) AS last_reviewed
         FROM review_targets t
        WHERE t.bot_id = ?1 AND ${LEFTOVER_TARGET}
          AND EXISTS (SELECT 1 FROM (${LEDGER_IDENTITIES}) x
                       WHERE x.target_id = t.id AND x.owner = ?2 COLLATE NOCASE
                         AND x.repo = ?3 COLLATE NOCASE)`,
    )
    .bind(group.botId, group.owner, group.repo)
    .all<MemberRow>();
  return res.results.slice().sort(compareMembers);
}

/** note: The live target of this bot that already names this repository, or null. */
async function findNamedTarget(db: DashboardD1, group: Group): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM review_targets
        WHERE bot_id = ?1 AND deleted_at IS NULL
          AND repo_owner = ?2 COLLATE NOCASE AND repo_name = ?3 COLLATE NOCASE
        ORDER BY created_at, id LIMIT 1`,
    )
    .bind(group.botId, group.owner, group.repo)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * why: Plan one batch. Every read happens here; the write half is the returned
 * statement list, so ONE `db.batch` commits the whole move.
 */
async function planBatch(db: DashboardD1, cursor: UpgradeCursor | null): Promise<Plan> {
  const after = typeof cursor?.last_target_id === "string" ? cursor.last_target_id : "";
  const worklist = await db
    .prepare(
      `SELECT t.id, t.bot_id FROM review_targets t
        WHERE t.id > ?1 AND ${LEFTOVER_TARGET}
          AND ${hasLedger("t.id")}
        ORDER BY t.id LIMIT ?2`,
    )
    .bind(after, SCAN_LIMIT)
    .all<WorklistRow>();
  const rows = worklist.results;
  if (rows.length === 0) return emptyPlan();

  const plan = emptyPlan();
  plan.done = false;
  plan.cursor = typeof cursor?.last_target_id === "string" ? cursor.last_target_id : null;
  const batch = new Set<string>();
  const groups: Group[] = [];
  const seen = new Set<string>();
  let complete = true;
  // why: The cursor may only advance past rows this batch retires: a row left live
  // sits behind it, so once one is left, the prefix is frozen.
  let frozen = false;

  // why: Collect up to GROUPS_PER_BATCH groups, batch row by batch row. A row whose
  // pairs did not all fit is left OUT of the batch and out of the cursor: the
  // next step re-reads it, and the pairs already migrated no longer show up.
  // The scan CONTINUES past it, though: a later row whose pairs were all
  // planned by an earlier row's group has no ledger rows left to keep it in
  // the worklist (`EXISTS (ledger)` is what finds a row), so this batch
  // must retire it — otherwise it strands as a live all-NULL ghost.
  for (const row of rows) {
    // note: `COLLATE NOCASE` inside DISTINCT: the pair set folds exactly as the
    // grouping below does — ASCII only, so `Ä` and `ä` stay two identities.
    const pairs = await db
      .prepare(
        `SELECT DISTINCT owner COLLATE NOCASE AS owner, repo COLLATE NOCASE AS repo
           FROM (${LEDGER_IDENTITIES}) x WHERE x.target_id = ?1`,
      )
      .bind(row.id)
      .all<{ owner: string; repo: string }>();
    let drained = true;
    for (const pair of pairs.results) {
      const group = { botId: row.bot_id, owner: pair.owner, repo: pair.repo };
      // note: Same fold as the SQL above: ASCII `A-Z` only. `Ä` and `ä` are two
      // identities to `NOCASE`, so they must stay two groups here.
      const key = JSON.stringify([
        group.botId,
        group.owner.replace(/[A-Z]/g, (char) => char.toLowerCase()),
        group.repo.replace(/[A-Z]/g, (char) => char.toLowerCase()),
      ]);
      if (seen.has(key)) continue;
      if (groups.length === GROUPS_PER_BATCH) {
        drained = false;
        break;
      }
      seen.add(key);
      groups.push(group);
    }
    if (!drained) {
      complete = false;
      frozen = true;
      continue;
    }
    batch.add(row.id);
    if (!frozen) plan.cursor = row.id;
  }

  for (const group of groups) await planGroup(db, plan, group, batch);

  // why: A leftover row with no ledger rows awaits its first delivery (待安装): it is
  // untouched apart from this flag, so its copied configuration keeps
  // answering instead of the workspace's (D16 — no live review changes).
  plan.statements.push(
    db.prepare(
      `UPDATE review_targets SET follow_workspace_defaults = 0, updated_at = datetime('now')
        WHERE deleted_at IS NULL AND repo_id IS NULL AND repo_owner IS NULL AND repo_name IS NULL
          AND follow_workspace_defaults = 1
          AND NOT ${hasLedger("review_targets.id")}`,
    ),
  );

  // why: Retire the batch's own old rows LAST: one row may hold ledger rows for
  // several repositories, so it is repointed by every group before it is
  // retired (deleting it inside a group would hide it from the next group's
  // reads). A member outside this batch stays live and is picked up later.
  for (const ids of chunked([...plan.consumed])) {
    plan.statements.push(
      db
        .prepare(
          `UPDATE review_targets SET deleted_at = datetime('now'), updated_at = datetime('now')
            WHERE id IN (${placeholders(ids.length)})`,
        )
        .bind(...ids),
    );
  }

  plan.done = complete && rows.length < SCAN_LIMIT;
  return plan;
}

/** note: Append one group's statements to `plan` and count what they do. */
async function planGroup(db: DashboardD1, plan: Plan, group: Group, batch: Set<string>): Promise<void> {
  const members = await readMembers(db, group);
  if (members.length === 0) return;
  const winner = members[0]!;

  // why: An already-named live target is the repository's home: repointing onto it
  // keeps one live target per repository instead of creating a duplicate the
  // store's own add path would refuse. It may live in the bot's other
  // workspace — the claim is bot-scoped, so it is still the same repository.
  const named = await findNamedTarget(db, group);
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
              follow_workspace_defaults, review_enabled, review_drafts, review_trigger_mode, review_level,
              check_min_score, check_pass_verdicts, created_by, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                   datetime('now'), datetime('now'))`,
        )
        .bind(
          targetId,
          // note: D22 winner: the merged row is born in the winner's own workspace.
          winner.workspace_id,
          group.botId,
          `${group.owner}/${group.repo}`,
          group.owner,
          group.repo,
          source!.review_enabled,
          source!.review_drafts,
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
  // note: Losers' configuration goes with their rows; the count is the only record
  // the operator keeps of what the merge discarded.
  plan.discarded += members.length - 1;

  const memberIds = members.map((member) => member.id);

  // why: `(target_id, owner, repo, pr_number)` is UNIQUE (0057:229-230): two old
  // rows of one group may hold the same PR. Keep the later `last_seen_at`
  // (then the lower id) and delete the rest BEFORE the repoint, so the update
  // cannot collide with itself. The read is chunked, so the order is applied
  // here over the merged result.
  const prs: Array<{ id: string; pr_number: number; last_seen_at: string | null }> = [];
  for (const ids of chunked(memberIds)) {
    const res = await db
      .prepare(
        `SELECT id, pr_number, last_seen_at FROM pull_requests
          WHERE target_id IN (${placeholders(ids.length)})
            AND owner = ? COLLATE NOCASE AND repo = ? COLLATE NOCASE`,
      )
      .bind(...ids, group.owner, group.repo)
      .all<{ id: string; pr_number: number; last_seen_at: string | null }>();
    prs.push(...res.results);
  }
  prs.sort(
    (a, b) =>
      a.pr_number - b.pr_number ||
      (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? "") ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  // why: An adopted destination may already hold a PR of its own: the repoint would
  // collide with it just the same. The destination's row wins only when its
  // `last_seen_at` is LATER; otherwise it is dropped and the member's row takes
  // its place. `reviews`/`review_findings`/`review_failures` key on
  // installation/bot plus PR identity, never on `target_id`, so only this
  // table's unique index can collide.
  const destination =
    named === null
      ? []
      : (
          await db
            .prepare(
              `SELECT id, pr_number, last_seen_at FROM pull_requests
                WHERE target_id = ?1 AND owner = ?2 COLLATE NOCASE AND repo = ?3 COLLATE NOCASE`,
            )
            .bind(named, group.owner, group.repo)
            .all<{ id: string; pr_number: number; last_seen_at: string | null }>()
        ).results;
  const destinationByPr = new Map(destination.map((pr) => [pr.pr_number, pr]));

  const keepers = new Set<number>();
  const drops: string[] = [];
  for (const pr of prs) {
    if (keepers.has(pr.pr_number)) {
      drops.push(pr.id);
      continue;
    }
    const home = destinationByPr.get(pr.pr_number);
    if (home !== undefined && (home.last_seen_at ?? "") > (pr.last_seen_at ?? "")) {
      drops.push(pr.id);
      continue;
    }
    keepers.add(pr.pr_number);
    if (home !== undefined) drops.push(home.id);
  }
  for (const ids of chunked(drops)) {
    plan.statements.push(
      db.prepare(`DELETE FROM pull_requests WHERE id IN (${placeholders(ids.length)})`).bind(...ids),
    );
  }

  for (const table of ["pull_requests", "reviews", "review_findings", "review_failures"]) {
    for (const ids of chunked(memberIds)) {
      plan.statements.push(
        db
          .prepare(
            `UPDATE ${table} SET target_id = ?1
              WHERE target_id IN (${placeholders(ids.length)})
                AND owner = ? COLLATE NOCASE AND repo = ? COLLATE NOCASE`,
          )
          .bind(targetId, ...ids, group.owner, group.repo),
      );
    }
  }
  plan.repointed += keepers.size;

  // why: Retired by `planBatch` after every group ran: this row may still hold
  // ledger rows for another repository of the same batch.
  for (const id of memberIds) if (batch.has(id)) plan.consumed.add(id);
}

/**
 * The registered item. `requiresDowntime` because a review that landed between
 * the repoint and the soft delete would write against a target this batch
 * retired.
 */
export const repoBackfill: DataUpgradeItem = {
  id: "repo-backfill",
  title: "Repository identity backfill",
  impact:
    "Merges duplicate review targets into one per repository and repoints their pull requests, reviews, findings and failures onto it, deleting the duplicate pull request rows a PR leaves behind on both sides. Never deletes reviews, findings or failures.",
  requiresDowntime: true,
  order: 10,

  /** note: Four counts the operator sees before starting: no writes. */
  async preflight(db: DashboardD1): Promise<UpgradeCounts> {
    return {
      // note: Every live row whose repository identity is still unset.
      unidentified_targets: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM review_targets t WHERE ${LEFTOVER_TARGET}`,
      ),
      // note: The (target, repository) pairs the split moves rows for — filtered to
      // the leftover shape, so the count is what a run will actually move.
      // Any of the four ledger tables contributes a pair: a swept PR row does
      // not take its reviews' repository with it.
      ledger_pairs: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM (
           SELECT x.target_id, x.owner, x.repo FROM (${LEDGER_IDENTITIES}) x
             JOIN review_targets t ON t.id = x.target_id
            WHERE ${LEFTOVER_TARGET}
            GROUP BY x.target_id, x.owner COLLATE NOCASE, x.repo COLLATE NOCASE)`,
      ),
      // why: Repositories covered by more than one live row: D22 collapses them.
      // Bot-scoped, matching 0068's `(bot_id, repo_id)` claim: the same
      // repository in two of a bot's workspaces is one duplicate, not two
      // independent homes.
      conflicting_groups: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM (
           SELECT x.owner, x.repo FROM (${LEDGER_IDENTITIES}) x
             JOIN review_targets t ON t.id = x.target_id
            WHERE ${LEFTOVER_TARGET}
            GROUP BY t.bot_id, x.owner COLLATE NOCASE, x.repo COLLATE NOCASE
           HAVING COUNT(DISTINCT t.id) > 1)`,
      ),
      // note: Leftover rows awaiting their first delivery: the batch leaves them in
      // place and only settles the follow flag. Filtered by the same leftover
      // predicate as the other counters, so a claimed target that simply has no
      // ledger rows yet is not reported as backfill work.
      leftover_without_ledger: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM review_targets t
          WHERE ${LEFTOVER_TARGET} AND NOT ${hasLedger("t.id")}`,
      ),
    };
  },

  /**
   * why: ONE transaction per call; a replay over migrated rows processes nothing.
   *
   * No `actor`: the only target this item creates inherits the D22 winner's
   * `created_by` (spec B5 — the merged row keeps that winner's configuration),
   * so naming the operator would misattribute a historical row.
   */
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
   * why: Read-only checks. Every blocking entry must read 0; `historical_rows` and
   * `ledger_rows_without_pr` are advisory — reported, never a failure.
   *
   * The unrepointed check is the crash residual, not a data-quality opinion: a
   * ledger row still naming a retired target WHILE a live target of the same bot
   * already covers that repository is a batch that created the replacement and
   * died before repointing every row. Only targets retired AT OR
   * AFTER this run started can be that residual; one retired earlier is history
   * the worklist can never visit again, so it is counted as `historical_rows`
   * and never fails the item. With no run start recorded, nothing was retired by
   * this run: every such row is history.
   */
  advisoryChecks: ["historical_rows", "ledger_rows_without_pr"],

  async verify(db: DashboardD1, context: UpgradeVerifyContext): Promise<UpgradeCounts> {
    const runStart = context.runStartedAt;
    const blockingSql = retiredRowsSql("blocking", runStart);
    const historicalSql = retiredRowsSql("historical", runStart);
    const blockingBinds = runStart === null ? [] : [runStart];
    return {
      // note: Identity is owner/name, not `repo_id`: a backfilled row names its
      // repository and legitimately awaits the first delivery's id claim (D15).
      unidentified_targets_with_ledger: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM review_targets t
          WHERE t.deleted_at IS NULL AND (t.repo_owner IS NULL OR t.repo_name IS NULL)
            AND ${hasLedger("t.id")}`,
      ),
      unrepointed_ledger_rows: await countRows(db, `SELECT COUNT(*) AS n ${blockingSql}`, ...blockingBinds),
      historical_rows: await countRows(db, `SELECT COUNT(*) AS n ${historicalSql}`, ...blockingBinds),
      duplicate_repository_groups: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM (
           SELECT t.bot_id, t.repo_owner, t.repo_name FROM review_targets t
            WHERE t.deleted_at IS NULL AND t.repo_owner IS NOT NULL AND t.repo_name IS NOT NULL
              AND ${hasLedger("t.id")}
            GROUP BY t.bot_id, t.repo_owner COLLATE NOCASE, t.repo_name COLLATE NOCASE
           HAVING COUNT(*) > 1)`,
      ),
      // note: Advisory, and exact: ledger ROWS outside `pull_requests` whose
      // repository has no PR row left — a swept PR does not sweep its reviews,
      // findings or failures. Not a failure: the row is still on a live named
      // target and nothing points at a retired one, so the item has no repair
      // to offer. An unidentified leftover still blocks above.
      ledger_rows_without_pr: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM (
           SELECT target_id, owner, repo FROM reviews
           UNION ALL SELECT target_id, owner, repo FROM review_findings
           UNION ALL SELECT target_id, owner, repo FROM review_failures) x
          WHERE NOT EXISTS (SELECT 1 FROM pull_requests p
                             WHERE p.target_id = x.target_id
                               AND p.owner = x.owner COLLATE NOCASE
                               AND p.repo = x.repo COLLATE NOCASE)`,
      ),
    };
  },
};

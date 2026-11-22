import type { DashboardD1, DashboardD1Statement } from "../../dashboard/users";
import type {
  DataUpgradeItem,
  UpgradeBatch,
  UpgradeCounts,
  UpgradeCursor,
  UpgradeVerifyContext,
} from "../data-upgrades";

const GROUPS_PER_BATCH = 20;

const SCAN_LIMIT = 20;

const IN_CHUNK = 40;

const LEFTOVER_TARGET = `t.deleted_at IS NULL
  AND t.repo_id IS NULL AND t.repo_owner IS NULL AND t.repo_name IS NULL`;

const LEDGER_IDENTITIES = `SELECT target_id, owner, repo FROM pull_requests
   UNION ALL SELECT target_id, owner, repo FROM reviews
   UNION ALL SELECT target_id, owner, repo FROM review_findings
   UNION ALL SELECT target_id, owner, repo FROM review_failures`;

function hasLedger(target: string): string {
  return `EXISTS (SELECT 1 FROM (${LEDGER_IDENTITIES}) x WHERE x.target_id = ${target})`;
}

const RETIRED_LEDGER_ROWS = `FROM (${LEDGER_IDENTITIES}) x
  JOIN review_targets d ON d.id = x.target_id AND d.deleted_at IS NOT NULL
 WHERE EXISTS (
   SELECT 1 FROM review_targets l
    WHERE l.deleted_at IS NULL AND l.bot_id = d.bot_id
      AND l.repo_owner = x.owner COLLATE NOCASE
      AND l.repo_name = x.repo COLLATE NOCASE)
   AND %s`;

function retiredRowsSql(kind: "blocking" | "historical", runStart: string | null): string {
  if (runStart === null) {
    return RETIRED_LEDGER_ROWS.replace("%s", kind === "blocking" ? "0 = 1" : "1 = 1");
  }
  const op = kind === "blocking" ? ">=" : "<";
  return RETIRED_LEDGER_ROWS.replace("%s", `datetime(d.deleted_at) ${op} datetime(?1)`);
}

type WorklistRow = { id: string; bot_id: string };

type MemberRow = {
  id: string;
  workspace_id: string;
  last_seen: string | null;
  last_reviewed: string | null;
};

type Group = { botId: string; owner: string; repo: string };

type Plan = {
  statements: DashboardD1Statement[];
  created: number;
  adopted: number;
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

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

function chunked<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < values.length; at += IN_CHUNK) out.push(values.slice(at, at + IN_CHUNK));
  return out;
}

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
  let frozen = false;

  for (const row of rows) {
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

  plan.statements.push(
    db.prepare(
      `UPDATE review_targets SET follow_workspace_defaults = 0, updated_at = datetime('now')
        WHERE deleted_at IS NULL AND repo_id IS NULL AND repo_owner IS NULL AND repo_name IS NULL
          AND follow_workspace_defaults = 1
          AND NOT ${hasLedger("review_targets.id")}`,
    ),
  );

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

async function planGroup(db: DashboardD1, plan: Plan, group: Group, batch: Set<string>): Promise<void> {
  const members = await readMembers(db, group);
  if (members.length === 0) return;
  const winner = members[0]!;

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
  plan.discarded += members.length - 1;

  const memberIds = members.map((member) => member.id);

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

  async preflight(db: DashboardD1): Promise<UpgradeCounts> {
    return {
      unidentified_targets: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM review_targets t WHERE ${LEFTOVER_TARGET}`,
      ),
      ledger_pairs: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM (
           SELECT x.target_id, x.owner, x.repo FROM (${LEDGER_IDENTITIES}) x
             JOIN review_targets t ON t.id = x.target_id
            WHERE ${LEFTOVER_TARGET}
            GROUP BY x.target_id, x.owner COLLATE NOCASE, x.repo COLLATE NOCASE)`,
      ),
      conflicting_groups: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM (
           SELECT x.owner, x.repo FROM (${LEDGER_IDENTITIES}) x
             JOIN review_targets t ON t.id = x.target_id
            WHERE ${LEFTOVER_TARGET}
            GROUP BY t.bot_id, x.owner COLLATE NOCASE, x.repo COLLATE NOCASE
           HAVING COUNT(DISTINCT t.id) > 1)`,
      ),
      leftover_without_ledger: await countRows(
        db,
        `SELECT COUNT(*) AS n FROM review_targets t
          WHERE ${LEFTOVER_TARGET} AND NOT ${hasLedger("t.id")}`,
      ),
    };
  },

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

  advisoryChecks: ["historical_rows", "ledger_rows_without_pr"],

  async verify(db: DashboardD1, context: UpgradeVerifyContext): Promise<UpgradeCounts> {
    const runStart = context.runStartedAt;
    const blockingSql = retiredRowsSql("blocking", runStart);
    const historicalSql = retiredRowsSql("historical", runStart);
    const blockingBinds = runStart === null ? [] : [runStart];
    return {
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

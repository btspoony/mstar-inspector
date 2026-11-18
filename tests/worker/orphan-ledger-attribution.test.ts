/**
 * The orphan ledger attribution item (spec operator-data-upgrade § Orphan
 * ledger attribution item).
 *
 * The fixture is the shape staging carries: ledger rows written before
 * `review_targets` existed, with `target_id IS NULL`, spread over three
 * repositories —
 *
 *   - `acme/alpha`: a live target of the bot already names it (adopt);
 *   - `acme/beta`: no target names it (create exactly one);
 *   - `ghost/gamma`: its failures name an installation no bot owns, and the
 *     deployment has two bots, so nothing names its tenant (leave, report).
 *
 * What is pinned:
 *
 *   - preflight counts rows, groups, existing/new/unattributable without writing;
 *   - one batch adopts one target and creates one, attributes every row of both
 *     groups, and leaves the unresolvable group's rows untouched;
 *   - a second run moves nothing;
 *   - verify reads zero unattributed rows after the run and the unresolvable
 *     group only as the advisory check, so the runner completes the item;
 *   - a batch stops at GROUPS_PER_BATCH groups and resumes from the cursor.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";
import { orphanLedgerAttribution } from "../../src/admin/data-upgrades/orphan-ledger-attribution";
import {
  DATA_UPGRADES,
  stepDataUpgrade,
  verifyDataUpgrade,
  type UpgradeCursor,
} from "../../src/admin/data-upgrades";

const BOT = "bot-1";
const OTHER_BOT = "bot-2";
const OPERATOR = "Support-Bot";
const RUN_START = "2026-11-18T00:00:00.000Z";

function seedBotWorkspace(db: TestD1, botId: string, workspaceId = "default"): void {
  db.raw
    .prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)")
    .run(botId, workspaceId);
}

function seedInstallation(
  db: TestD1,
  botId: string,
  installationId: number,
  removedAt: string | null = null,
): void {
  db.raw
    .prepare(
      `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
       VALUES (?, ?, ?, 'acme', '2026-08-01T00:00:00.000Z', ?)`,
    )
    .run(`inst-${botId}-${installationId}`, botId, installationId, removedAt);
}

/** An orphan review: no `target_id`, the bot known. */
function seedOrphanReview(
  db: TestD1,
  id: string,
  opts: { botId?: string | null; installationId?: number; owner?: string; repo?: string } = {},
): void {
  db.raw
    .prepare(
      `INSERT INTO reviews
         (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, bot_id)
       VALUES (?, ?, ?, ?, 1, ?, '2026-08-27T00:00:00.000Z', 'ship it', ?)`,
    )
    .run(
      id,
      opts.installationId ?? 1,
      opts.owner ?? "acme",
      opts.repo ?? "alpha",
      `sha-${id}`,
      opts.botId === undefined ? BOT : opts.botId,
    );
}

/** An orphan failure: no `bot_id` column at all — resolved through the installation. */
function seedOrphanFailure(
  db: TestD1,
  id: string,
  opts: { installationId?: number; owner?: string; repo?: string } = {},
): void {
  db.raw
    .prepare(
      `INSERT INTO review_failures
         (id, installation_id, owner, repo, pr_number, head_sha, stage, error, created_at)
       VALUES (?, ?, ?, ?, 1, 'sha', 'pipeline', 'boom', '2026-08-27T00:00:00.000Z')`,
    )
    .run(id, opts.installationId ?? 1, opts.owner ?? "acme", opts.repo ?? "alpha");
}

/** An orphan PR row: the bot is known, the target is not. */
function seedOrphanPr(db: TestD1, id: string, owner: string, repo: string, prNumber: number): void {
  db.raw
    .prepare(
      `INSERT INTO pull_requests
         (id, bot_id, owner, repo, pr_number, state, last_seen_at, target_id)
       VALUES (?, ?, ?, ?, ?, 'open', '2026-08-27T00:00:00.000Z', NULL)`,
    )
    .run(id, BOT, owner, repo, prNumber);
}

/**
 * Two bots (so the single-bot fallback stays silent), one workspace each, and
 * the three repositories described in the header.
 */
function fixture(): TestD1 {
  const db = createMigratedTestD1();
  seedBot(db, BOT, 7001);
  seedBot(db, OTHER_BOT, 7002);
  seedBotWorkspace(db, BOT);
  seedBotWorkspace(db, OTHER_BOT);
  seedInstallation(db, BOT, 1);
  // The bot's live home for `acme/alpha`, already naming it.
  seedTarget(db, BOT, { id: "target-alpha", repoOwner: "acme", repoName: "alpha" });

  seedOrphanReview(db, "rv-alpha", { repo: "alpha" });
  seedOrphanFailure(db, "fl-alpha", { repo: "alpha" });

  seedOrphanReview(db, "rv-beta", { repo: "beta" });
  seedOrphanPr(db, "pr-beta", "acme", "beta", 2);
  seedOrphanFailure(db, "fl-beta", { repo: "beta" });

  // Nothing names this installation's bot, and two bots exist: no guess.
  seedOrphanFailure(db, "fl-gamma", { installationId: 99, owner: "ghost", repo: "gamma" });
  return db;
}

function liveTargets(db: TestD1): Array<{ id: string; bot_id: string; repo_owner: string | null; repo_name: string | null }> {
  return db.raw
    .query(
      "SELECT id, bot_id, repo_owner, repo_name FROM review_targets WHERE deleted_at IS NULL ORDER BY id",
    )
    .all() as never;
}

function targetOf(db: TestD1, table: string, id: string): string | null {
  const row = db.raw.prepare(`SELECT target_id FROM ${table} WHERE id = ?`).get(id) as {
    target_id: string | null;
  };
  return row.target_id;
}

/** Step until the item reports done; returns every batch. */
async function drain(db: TestD1): Promise<Array<{ processed: number; done: boolean }>> {
  const batches: Array<{ processed: number; done: boolean }> = [];
  for (let cursor: UpgradeCursor | null = null; ; ) {
    const batch = await orphanLedgerAttribution.runBatch(db, cursor);
    batches.push({ processed: batch.processed, done: batch.done });
    if (batch.done) return batches;
    cursor = batch.cursor;
  }
}

describe("orphan-ledger-attribution item", () => {
  test("it is registered after the repository backfill, without downtime", () => {
    expect(DATA_UPGRADES.map((item) => item.id)).toContain("orphan-ledger-attribution");
    expect(orphanLedgerAttribution.requiresDowntime).toBe(false);
    expect(orphanLedgerAttribution.order).toBeGreaterThan(
      DATA_UPGRADES.find((item) => item.id === "repo-backfill")!.order,
    );
  });

  test("preflight counts rows and groups without writing", async () => {
    const db = fixture();
    const before = liveTargets(db);

    expect(await orphanLedgerAttribution.preflight(db)).toEqual({
      orphan_rows: 6,
      groups: 3,
      groups_with_target: 1,
      groups_needing_target: 1,
      unattributable_groups: 1,
    });
    expect(liveTargets(db)).toEqual(before);
    expect(targetOf(db, "reviews", "rv-alpha")).toBeNull();
  });

  test("one batch adopts, creates exactly one target and leaves the unresolvable group alone", async () => {
    const db = fixture();
    const batch = await orphanLedgerAttribution.runBatch(db, null);

    expect(batch.processed).toBe(2);
    expect(batch.done).toBe(true);
    expect(batch.log).toEqual({ groups: 3, attributed: 2, created: 1, unattributable: 1 });

    const live = liveTargets(db);
    expect(live).toHaveLength(2);
    const created = live.find((row) => row.id !== "target-alpha")!;
    expect(created).toMatchObject({ bot_id: BOT, repo_owner: "acme", repo_name: "beta" });
    const row = db.raw
      .prepare(
        "SELECT repo_id, follow_workspace_defaults, workspace_id, created_by FROM review_targets WHERE id = ?",
      )
      .get(created.id) as {
      repo_id: number | null;
      follow_workspace_defaults: number;
      workspace_id: string;
      created_by: string;
    };
    // No fabricated numeric id: the first delivery claims it (0067).
    expect(row).toEqual({
      repo_id: null,
      follow_workspace_defaults: 0,
      workspace_id: "default",
      created_by: "orphan-ledger-attribution",
    });

    expect(targetOf(db, "reviews", "rv-alpha")).toBe("target-alpha");
    expect(targetOf(db, "review_failures", "fl-alpha")).toBe("target-alpha");
    expect(targetOf(db, "reviews", "rv-beta")).toBe(created.id);
    expect(targetOf(db, "pull_requests", "pr-beta")).toBe(created.id);
    expect(targetOf(db, "review_failures", "fl-beta")).toBe(created.id);

    // The unresolvable group is untouched, not guessed into someone's tenant.
    expect(targetOf(db, "review_failures", "fl-gamma")).toBeNull();

    const replay = await orphanLedgerAttribution.runBatch(db, batch.cursor);
    expect(replay).toMatchObject({ processed: 0, done: true, cursor: null });
    expect(liveTargets(db)).toEqual(live);
  });

  test("verify blocks on an unattributed row and reports the unresolvable group as advisory", async () => {
    const db = fixture();
    // Every orphan row of a group that RESOLVES: the gamma group does not.
    expect(
      (await orphanLedgerAttribution.verify(db, { runStartedAt: null })).unattributed_ledger_rows,
    ).toBe(5);

    await drain(db);
    expect(await orphanLedgerAttribution.verify(db, { runStartedAt: null })).toEqual({
      unattributed_ledger_rows: 0,
      unattributable_groups: 1,
    });
    expect(orphanLedgerAttribution.advisoryChecks).toEqual(["unattributable_groups"]);
  });

  test("the runner completes the item while the advisory check is non-zero", async () => {
    const db = fixture();
    expect((await stepDataUpgrade(db, orphanLedgerAttribution, OPERATOR, RUN_START)).kind).toBe("ok");
    const verified = await verifyDataUpgrade(
      db,
      orphanLedgerAttribution,
      OPERATOR,
      "2026-11-18T00:05:00.000Z",
    );
    expect(verified.kind).toBe("ok");
    if (verified.kind !== "ok") return;
    expect(verified.state.status).toBe("completed");
    expect(verified.state.lastError).toBeNull();
    expect(verified.checks).toEqual({ unattributed_ledger_rows: 0, unattributable_groups: 1 });
  });

  test("a batch stops at GROUPS_PER_BATCH groups and resumes from the cursor", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedBotWorkspace(db, BOT);
    seedInstallation(db, BOT, 1);
    for (let index = 0; index < 21; index += 1) {
      seedOrphanReview(db, `rv-${index}`, { repo: `repo-${String(index).padStart(2, "0")}` });
    }

    const first = await orphanLedgerAttribution.runBatch(db, null);
    expect(first.processed).toBe(20);
    expect(first.done).toBe(false);
    expect(liveTargets(db)).toHaveLength(20);

    const second = await orphanLedgerAttribution.runBatch(db, first.cursor);
    expect(second).toMatchObject({ processed: 1, done: true });
    expect(liveTargets(db)).toHaveLength(21);
    // Past the last group the walk is empty: nothing more to move.
    expect(await orphanLedgerAttribution.runBatch(db, second.cursor)).toMatchObject({
      processed: 0,
      done: true,
      cursor: null,
    });
    expect(await orphanLedgerAttribution.verify(db, { runStartedAt: null })).toEqual({
      unattributed_ledger_rows: 0,
      unattributable_groups: 0,
    });
  });
});

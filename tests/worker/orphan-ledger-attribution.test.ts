import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";
import { orphanLedgerAttribution } from "../../src/admin/data-upgrades/orphan-ledger-attribution";
import {
  readEffectiveTargetSettings,
  type ReviewTargetRow,
} from "../../src/dashboard/targets-store";
import {
  DATA_UPGRADES,
  resetDataUpgrade,
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

function seedOrphanPr(db: TestD1, id: string, owner: string, repo: string, prNumber: number): void {
  db.raw
    .prepare(
      `INSERT INTO pull_requests
         (id, bot_id, owner, repo, pr_number, state, last_seen_at, target_id)
       VALUES (?, ?, ?, ?, ?, 'open', '2026-08-27T00:00:00.000Z', NULL)`,
    )
    .run(id, BOT, owner, repo, prNumber);
}

function fixture(): TestD1 {
  const db = createMigratedTestD1();
  seedBot(db, BOT, 7001);
  seedBot(db, OTHER_BOT, 7002);
  seedBotWorkspace(db, BOT);
  seedBotWorkspace(db, OTHER_BOT);
  seedInstallation(db, BOT, 1);
  seedTarget(db, BOT, { id: "target-alpha", repoOwner: "acme", repoName: "alpha" });

  seedOrphanReview(db, "rv-alpha", { repo: "alpha" });
  seedOrphanFailure(db, "fl-alpha", { repo: "alpha" });

  seedOrphanReview(db, "rv-beta", { repo: "beta" });
  seedOrphanPr(db, "pr-beta", "acme", "beta", 2);
  seedOrphanFailure(db, "fl-beta", { repo: "beta" });

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

async function drain(db: TestD1): Promise<Array<{ processed: number; done: boolean }>> {
  const batches: Array<{ processed: number; done: boolean }> = [];
  for (let cursor: UpgradeCursor | null = null; ; ) {
    const batch = await orphanLedgerAttribution.runBatch(db, cursor, OPERATOR);
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
      ambiguous_groups: 0,
    });
    expect(liveTargets(db)).toEqual(before);
    expect(targetOf(db, "reviews", "rv-alpha")).toBeNull();
  });

  test("one batch adopts, creates exactly one target and leaves the unresolvable group alone", async () => {
    const db = fixture();
    const batch = await orphanLedgerAttribution.runBatch(db, null, OPERATOR);

    expect(batch.processed).toBe(5);
    expect(batch.done).toBe(true);
    expect(batch.log).toEqual({
      groups: 3,
      attributed: 2,
      created: 1,
      unattributable: 1,
      ambiguous: 0,
      changed_shape: 0,
    });

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
    expect(row).toEqual({
      repo_id: null,
      follow_workspace_defaults: 1,
      workspace_id: "default",
      created_by: OPERATOR,
    });

    expect(targetOf(db, "reviews", "rv-alpha")).toBe("target-alpha");
    expect(targetOf(db, "review_failures", "fl-alpha")).toBe("target-alpha");
    expect(targetOf(db, "reviews", "rv-beta")).toBe(created.id);
    expect(targetOf(db, "pull_requests", "pr-beta")).toBe(created.id);
    expect(targetOf(db, "review_failures", "fl-beta")).toBe(created.id);

    expect(targetOf(db, "review_failures", "fl-gamma")).toBeNull();

    const replay = await orphanLedgerAttribution.runBatch(db, batch.cursor, OPERATOR);
    expect(replay).toMatchObject({ processed: 0, done: true, cursor: null });
    expect(liveTargets(db)).toEqual(live);
  });

  test("verify blocks on an unattributed row and reports the unresolvable group as advisory", async () => {
    const db = fixture();
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

    const first = await orphanLedgerAttribution.runBatch(db, null, OPERATOR);
    expect(first.processed).toBe(20);
    expect(first.done).toBe(false);
    expect(liveTargets(db)).toHaveLength(20);

    const second = await orphanLedgerAttribution.runBatch(db, first.cursor, OPERATOR);
    expect(second).toMatchObject({ processed: 1, done: true });
    expect(first.log).toMatchObject({ groups: 20 });
    expect(second.log).toMatchObject({ groups: 1 });
    expect(liveTargets(db)).toHaveLength(21);
    expect(await orphanLedgerAttribution.runBatch(db, second.cursor, OPERATOR)).toMatchObject({
      processed: 0,
      done: true,
      cursor: null,
    });
    expect(await orphanLedgerAttribution.verify(db, { runStartedAt: null })).toEqual({
      unattributed_ledger_rows: 0,
      unattributable_groups: 0,
    });
  });

  test("a row whose bot cannot be established never borrows a sibling row's bot", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedBot(db, OTHER_BOT, 7002);
    seedBotWorkspace(db, BOT);
    seedBotWorkspace(db, OTHER_BOT);
    seedInstallation(db, BOT, 1);
    seedInstallation(db, OTHER_BOT, 2);

    seedOrphanReview(db, "rv-mixed", { repo: "mixed" });
    seedOrphanFailure(db, "fl-mixed", { installationId: 99, repo: "mixed" });

    expect((await orphanLedgerAttribution.preflight(db)).unattributable_groups).toBe(1);
    const batch = await orphanLedgerAttribution.runBatch(db, null, OPERATOR);
    expect(batch).toMatchObject({ processed: 0, done: true });
    expect(liveTargets(db)).toHaveLength(0);
    expect(targetOf(db, "reviews", "rv-mixed")).toBeNull();
    expect(targetOf(db, "review_failures", "fl-mixed")).toBeNull();
    expect(await orphanLedgerAttribution.verify(db, { runStartedAt: null })).toEqual({
      unattributed_ledger_rows: 0,
      unattributable_groups: 1,
    });
  });

  test("a created target inherits the workspace's review defaults", async () => {
    const db = fixture();
    db.raw
      .prepare(
        `UPDATE workspaces SET default_review_trigger_mode = 'manual',
                               default_review_level = 'deep',
                               check_min_score = 90,
                               default_check_pass_verdicts = '["ship it","needs fixes"]'
          WHERE id = 'default'`,
      )
      .run();

    const batch = await orphanLedgerAttribution.runBatch(db, null, OPERATOR);
    expect(batch.log).toMatchObject({ created: 1 });
    const created = db.raw
      .prepare("SELECT * FROM review_targets WHERE id = ?")
      .get(liveTargets(db).find((row) => row.repo_name === "beta")!.id) as ReviewTargetRow;
    expect(created.follow_workspace_defaults).toBe(1);
    expect(await readEffectiveTargetSettings(db, created)).toMatchObject({
      triggerMode: "manual",
      level: "deep",
      checkMinScore: 90,
      checkPassVerdicts: ["ship it", "needs fixes"],
    });

    db.raw
      .prepare("UPDATE workspaces SET default_review_trigger_mode = 'open' WHERE id = 'default'")
      .run();
    expect((await readEffectiveTargetSettings(db, created)).triggerMode).toBe("open");
  });

  test("a group with no bot evidence falls back to the deployment's only bot and is attributed", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedBotWorkspace(db, BOT);
    seedOrphanFailure(db, "fl-fallback", { installationId: 99, repo: "alpha" });

    expect(await orphanLedgerAttribution.preflight(db)).toMatchObject({
      groups: 1,
      groups_needing_target: 1,
      unattributable_groups: 0,
    });

    const batch = await orphanLedgerAttribution.runBatch(db, null, OPERATOR);
    expect(batch).toMatchObject({ processed: 1, done: true });
    const target = liveTargets(db)[0]!;
    expect(target).toMatchObject({ bot_id: BOT, repo_owner: "acme", repo_name: "alpha" });
    expect(targetOf(db, "review_failures", "fl-fallback")).toBe(target.id);
    expect(await orphanLedgerAttribution.verify(db, { runStartedAt: null })).toEqual({
      unattributed_ledger_rows: 0,
      unattributable_groups: 0,
    });
  });

  test("two live targets naming the repository are ambiguous, not the oldest", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedBotWorkspace(db, BOT);
    seedInstallation(db, BOT, 1);
    seedTarget(db, BOT, { id: "target-old", repoOwner: "acme", repoName: "alpha" });
    db.raw
      .prepare(
        `INSERT INTO review_targets
           (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
            check_min_score, created_by, created_at, updated_at)
         VALUES ('target-new', 'default', ?, 'acme/alpha', NULL, 'acme', 'alpha',
                 80, 'fixture', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`,
      )
      .run(BOT);
    seedOrphanReview(db, "rv-alpha", { repo: "alpha" });

    expect(await orphanLedgerAttribution.preflight(db)).toMatchObject({
      groups: 1,
      unattributable_groups: 1,
      ambiguous_groups: 1,
    });
    const batch = await orphanLedgerAttribution.runBatch(db, null, OPERATOR);
    expect(batch).toMatchObject({ processed: 0, done: true });
    expect(batch.log).toMatchObject({ ambiguous: 1 });
    expect(targetOf(db, "reviews", "rv-alpha")).toBeNull();
    expect(liveTargets(db)).toHaveLength(2);
  });

  test("a group that becomes resolvable after a repair is picked up by a reset and a new run", async () => {
    const db = fixture();
    expect((await stepDataUpgrade(db, orphanLedgerAttribution, OPERATOR, RUN_START)).kind).toBe("ok");
    const done = await verifyDataUpgrade(db, orphanLedgerAttribution, OPERATOR, RUN_START);
    expect(done.kind === "ok" && done.state.status).toBe("completed");
    expect(targetOf(db, "review_failures", "fl-gamma")).toBeNull();

    seedInstallation(db, OTHER_BOT, 99);
    expect((await orphanLedgerAttribution.preflight(db)).groups_needing_target).toBe(1);

    expect((await stepDataUpgrade(db, orphanLedgerAttribution, OPERATOR, RUN_START)).kind).toBe(
      "refused",
    );
    expect((await resetDataUpgrade(db, orphanLedgerAttribution, OPERATOR, RUN_START)).kind).toBe("ok");
    expect((await stepDataUpgrade(db, orphanLedgerAttribution, OPERATOR, RUN_START)).kind).toBe("ok");

    const gamma = liveTargets(db).find((row) => row.repo_name === "gamma")!;
    expect(gamma).toMatchObject({ app_id: OTHER_BOT });
    expect(targetOf(db, "review_failures", "fl-gamma")).toBe(gamma.id);
    expect(targetOf(db, "reviews", "rv-alpha")).toBe("target-alpha");
    expect(await orphanLedgerAttribution.verify(db, { runStartedAt: null })).toEqual({
      unattributed_ledger_rows: 0,
      unattributable_groups: 0,
    });
  });

  test("a target an operator creates between planning and commit is adopted, not duplicated", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedBotWorkspace(db, BOT);
    seedInstallation(db, BOT, 1);
    seedOrphanReview(db, "rv-beta", { repo: "beta" });

    let raced = false;
    const racingDb = {
      ...db,
      prepare: (query: string) => db.prepare(query),
      async batch(statements: Parameters<typeof db.batch>[0]) {
        if (!raced) {
          raced = true;
          seedTarget(db, BOT, { id: "target-operator", repoOwner: "acme", repoName: "beta" });
        }
        return db.batch(statements);
      },
    };

    const batch = await orphanLedgerAttribution.runBatch(racingDb, null, OPERATOR);
    expect(batch.processed).toBe(1);
    expect(batch.log).toMatchObject({ created: 0, attributed: 1 });
    expect(liveTargets(db)).toEqual([
      { id: "target-operator", app_id: BOT, repo_owner: "acme", repo_name: "beta" },
    ]);
    expect(targetOf(db, "reviews", "rv-beta")).toBe("target-operator");
  });

  test("a target retired between planning and commit is not written into the ledger", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedBotWorkspace(db, BOT);
    seedInstallation(db, BOT, 1);
    seedTarget(db, BOT, { id: "target-alpha", repoOwner: "acme", repoName: "alpha" });
    seedOrphanReview(db, "rv-alpha", { repo: "alpha" });

    let raced = false;
    const racingDb = {
      ...db,
      prepare: (query: string) => db.prepare(query),
      async batch(statements: Parameters<typeof db.batch>[0]) {
        if (!raced) {
          raced = true;
          db.raw
            .prepare("UPDATE review_targets SET deleted_at = '2026-11-18T00:00:00.000Z' WHERE id = ?")
            .run("target-alpha");
        }
        return db.batch(statements);
      },
    };

    const batch = await orphanLedgerAttribution.runBatch(racingDb, null, OPERATOR);
    expect(batch).toMatchObject({ processed: 0, done: true });
    expect(batch.log).toMatchObject({ attributed: 0, created: 0 });
    expect(targetOf(db, "reviews", "rv-alpha")).toBeNull();
  });

  test("a group whose mapping changes between planning and commit writes nothing and is logged", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedBot(db, OTHER_BOT, 7002);
    seedBotWorkspace(db, BOT);
    seedInstallation(db, BOT, 1);
    seedOrphanFailure(db, "fl-only", { installationId: 1, repo: "alpha" });

    let raced = false;
    const racingDb = {
      ...db,
      prepare: (query: string) => db.prepare(query),
      async batch(statements: Parameters<typeof db.batch>[0]) {
        if (!raced) {
          raced = true;
          db.raw
            .prepare("UPDATE bot_installations SET bot_id = ? WHERE installation_id = 1")
            .run(OTHER_BOT);
        }
        return db.batch(statements);
      },
    };

    const batch = await orphanLedgerAttribution.runBatch(racingDb, null, OPERATOR);
    expect(batch).toMatchObject({ processed: 0, done: true });
    expect(batch.log).toMatchObject({ attributed: 0, created: 0, changed_shape: 1 });
    expect(targetOf(db, "review_failures", "fl-only")).toBeNull();
    expect(liveTargets(db)).toHaveLength(0);
  });
});

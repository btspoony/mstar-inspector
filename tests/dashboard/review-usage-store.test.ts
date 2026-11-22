import { describe, expect, test } from "bun:test";
import { readReviewUsage, reviewUsageMonth } from "../../src/dashboard/review-usage-store";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";

const NOVEMBER = reviewUsageMonth(new Date("2026-11-16T05:00:00Z"));
const DECEMBER_FIRST = "2026-12-01 00:00:00";
const NOVEMBER_FIRST = "2026-11-01 00:00:00";

function seedWorkspace(db: TestD1, id: string, name: string, deletedAt: string | null = null): void {
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
       VALUES (?, ?, ?, NULL, '2026-10-01T00:00:00.000Z', ?)`,
    )
    .run(id, id, name, deletedAt);
}

function seedReview(
  db: TestD1,
  row: {
    id: string;
    prNumber: number;
    reviewedAt: string;
    targetId: string | null;
    botId: string | null;
  },
): void {
  db.raw
    .prepare(
      `INSERT INTO reviews
         (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, bot_id, target_id)
       VALUES (?, 1, 'acme', 'widgets', ?, ?, ?, 'pass', ?, ?)`,
    )
    .run(row.id, row.prNumber, row.id, row.reviewedAt, row.botId, row.targetId);
}

function fixture(): TestD1 {
  const db = createMigratedTestD1();
  seedWorkspace(db, "ws-alpha", "Alpha");
  seedWorkspace(db, "ws-beta", "Beta");
  seedWorkspace(db, "ws-gamma", "Gamma");

  seedBot(db, "bot-shared", 9001);
  db.raw.prepare("UPDATE review_bots SET scope = 'shared', shared_at = '2026-10-01 00:00:00' WHERE id = 'bot-shared'").run();
  db.raw
    .prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES ('bot-shared', 'ws-alpha')")
    .run();
  seedBot(db, "bot-own", 9002);
  seedBot(db, "bot-gamma", 9003);

  const sharedTarget = seedTarget(db, "bot-shared", { id: "t-alpha-shared", workspaceId: "ws-alpha" });
  const ownTarget = seedTarget(db, "bot-own", { id: "t-alpha-own", workspaceId: "ws-alpha" });
  const gammaTarget = seedTarget(db, "bot-gamma", { id: "t-gamma", workspaceId: "ws-gamma" });

  seedReview(db, { id: "r1", prNumber: 1, reviewedAt: "2026-11-02 09:00:00", targetId: sharedTarget, botId: "bot-shared" });
  seedReview(db, { id: "r2", prNumber: 2, reviewedAt: "2026-11-30 23:59:59", targetId: sharedTarget, botId: "bot-shared" });
  seedReview(db, { id: "r3", prNumber: 3, reviewedAt: "2026-10-31 23:59:59", targetId: sharedTarget, botId: "bot-shared" });
  seedReview(db, { id: "r4", prNumber: 4, reviewedAt: DECEMBER_FIRST, targetId: sharedTarget, botId: "bot-shared" });

  seedReview(db, { id: "r5", prNumber: 5, reviewedAt: "2026-11-15 12:00:00", targetId: ownTarget, botId: "bot-own" });
  seedReview(db, { id: "r6", prNumber: 6, reviewedAt: NOVEMBER_FIRST, targetId: ownTarget, botId: "bot-own" });

  seedReview(db, { id: "r7", prNumber: 7, reviewedAt: "2026-11-08 08:00:00", targetId: null, botId: null });

  seedReview(db, { id: "r8", prNumber: 8, reviewedAt: "2026-11-09 08:00:00", targetId: gammaTarget, botId: "bot-gamma" });
  seedReview(db, { id: "r9", prNumber: 9, reviewedAt: "2026-11-10 08:00:00", targetId: gammaTarget, botId: "bot-gamma" });
  seedReview(db, { id: "r10", prNumber: 10, reviewedAt: "2026-11-11 08:00:00", targetId: gammaTarget, botId: "bot-gamma" });
  return db;
}

type Counts = [workspaceId: string, sharedReviews: number, ownReviews: number];

function countsOf(rows: { workspaceId: string; sharedReviews: number; ownReviews: number }[]): Counts[] {
  return rows.map((row) => [row.workspaceId, row.sharedReviews, row.ownReviews]);
}

describe("reviewUsageMonth", () => {
  test("labels the UTC month and spans it half-open", () => {
    expect(NOVEMBER).toEqual({
      month: "2026-11",
      start: NOVEMBER_FIRST,
      end: DECEMBER_FIRST,
    });
  });

  test("rolls the bounds over at the year end", () => {
    expect(reviewUsageMonth(new Date("2026-12-31T23:59:59Z"))).toEqual({
      month: "2026-12",
      start: "2026-12-01 00:00:00",
      end: "2027-01-01 00:00:00",
    });
  });
});

describe("readReviewUsage", () => {
  test("splits shared from own by the bot's scope, in the month of reviewed_at", async () => {
    const db = fixture();
    expect(countsOf(await readReviewUsage(db, NOVEMBER, "ws-alpha"))).toEqual([["ws-alpha", 2, 2]]);
  });

  test("a workspace with no target, or only an unattributed review, counts zero", async () => {
    const db = fixture();
    expect(countsOf(await readReviewUsage(db, NOVEMBER, "ws-beta"))).toEqual([["ws-beta", 0, 0]]);
  });

  test("a target with no review this month contributes nothing", async () => {
    const db = fixture();
    seedWorkspace(db, "ws-idle", "Idle");
    seedTarget(db, "bot-own", { workspaceId: "ws-idle" });
    seedTarget(db, "bot-shared", { workspaceId: "ws-idle" });
    db.raw
      .prepare(
        "UPDATE review_targets SET deleted_at = '2026-11-05 00:00:00' WHERE workspace_id = 'ws-idle' AND bot_id = 'bot-shared'",
      )
      .run();

    expect(countsOf(await readReviewUsage(db, NOVEMBER, "ws-idle"))).toEqual([["ws-idle", 0, 0]]);
    expect(countsOf(await readReviewUsage(db, NOVEMBER, null))).toEqual([
      ["ws-alpha", 2, 2],
      ["ws-gamma", 0, 3],
      ["ws-beta", 0, 0],
      ["default", 0, 0],
      ["ws-idle", 0, 0],
    ]);
  });

  test("the operator face answers every live workspace in the decided order", async () => {
    const db = fixture();
    expect(countsOf(await readReviewUsage(db, NOVEMBER, null))).toEqual([
      ["ws-alpha", 2, 2],
      ["ws-gamma", 0, 3],
      ["ws-beta", 0, 0],
      ["default", 0, 0],
    ]);
  });

  test("two same-named workspaces keep a stable order: the id closes the last key", async () => {
    const db = fixture();
    seedWorkspace(db, "ws-twin-b", "Twin");
    seedWorkspace(db, "ws-twin-a", "Twin");
    const twins = async () =>
      (await readReviewUsage(db, NOVEMBER, null))
        .map((row) => row.workspaceId)
        .filter((id) => id.startsWith("ws-twin"));
    expect(await twins()).toEqual(["ws-twin-a", "ws-twin-b"]);
    expect(await twins()).toEqual(["ws-twin-a", "ws-twin-b"]);
  });

  test("a retired workspace disappears; a parked target keeps its month", async () => {
    const db = fixture();
    seedWorkspace(db, "ws-retired", "Retired", "2026-11-20T00:00:00.000Z");
    db.raw.prepare("UPDATE review_targets SET deleted_at = '2026-11-20 00:00:00' WHERE id = 't-alpha-own'").run();
    db.raw.prepare("UPDATE review_bots SET deleted_at = '2026-11-20 00:00:00' WHERE id = 'bot-gamma'").run();

    expect(countsOf(await readReviewUsage(db, NOVEMBER, null))).toEqual([
      ["ws-alpha", 2, 2],
      ["ws-gamma", 0, 3],
      ["ws-beta", 0, 0],
      ["default", 0, 0],
    ]);
  });
});

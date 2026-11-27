import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, createTestD1, execMigrationScript } from "./helpers";
import { rpFor } from "../../src/store/quota-store";
import { REVIEW_LEVELS } from "../../packages/shared/src/runtime";
import {
  chargeUsage,
  hasUsageEventForExecutionToken,
  readMonthlyRp,
  readMonthlyRpByWorkspace,
  sumMonthlyRp,
} from "../../src/store/usage-store";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
const AT = "2026-10-24T00:00:00.000Z";

/**
 * The bot the metering fixtures execute as. `recordUsageEvent` requires
 * `botId: string` and the column references `review_bots`, so every write
 * through the production API needs this row; legacy-shape usage rows are
 * written with raw SQL in the migration-history fixtures, never through the
 * API.
 */
function seedUsageBot(db: ReturnType<typeof createMigratedTestD1>, id = "bot-usage"): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots (id, workspace_id, name, multiplier, created_at, updated_at)
       VALUES (?, 'default', ?, 1, ?, ?)`,
    )
    .run(id, id, AT, AT);
}

const USAGE = {
  reviewId: "review-a",
  workspaceId: "default",
  occurredAt: AT,
  month: "2026-10",
  level: "deep" as const,
  multiplier: 1,
  source: "shared" as const,
  botId: "bot-usage",
};

describe("chargeUsage — bind, price and append in ONE batch", () => {
  test("same review mints 1 then 2; distinct reviews each start at 1", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    await chargeUsage(db, { ...USAGE, executionToken: "token-a1" });
    await chargeUsage(db, { ...USAGE, executionToken: "token-a2", level: "quick", source: "byok" });
    await chargeUsage(db, { ...USAGE, reviewId: "review-b", executionToken: "token-b1", level: "quick" });

    const rows = db.raw
      .query(
        "SELECT review_id, seq, execution_token, workspace_id, occurred_at, rp, source FROM usage_events ORDER BY review_id, seq",
      )
      .all();
    // v1 base is quick 1 / standard 2 / deep 6, multiplier 1 (D11 ceil).
    expect(rows).toEqual([
      {
        review_id: "review-a",
        seq: 1,
        execution_token: "token-a1",
        workspace_id: "default",
        occurred_at: AT,
        rp: 6,
        source: "shared",
      },
      {
        review_id: "review-a",
        seq: 2,
        execution_token: "token-a2",
        workspace_id: "default",
        occurred_at: AT,
        rp: 1,
        source: "byok",
      },
      {
        review_id: "review-b",
        seq: 1,
        execution_token: "token-b1",
        workspace_id: "default",
        occurred_at: AT,
        rp: 1,
        source: "shared",
      },
    ]);
  });

  test("a replay is a no-op and reports charged: false; the next token still mints seq 2", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    expect(await chargeUsage(db, { ...USAGE, executionToken: "token-a1" })).toEqual({ charged: true });
    expect(await chargeUsage(db, { ...USAGE, executionToken: "token-a1" })).toEqual({ charged: false });
    expect(await chargeUsage(db, { ...USAGE, executionToken: "token-a2", level: "quick" })).toEqual({
      charged: true,
    });

    expect(
      db.raw.query("SELECT seq, execution_token FROM usage_events WHERE review_id = 'review-a' ORDER BY seq").all(),
    ).toEqual([
      { seq: 1, execution_token: "token-a1" },
      { seq: 2, execution_token: "token-a2" },
    ]);
  });

  test("the price follows the BINDING: a bound month ignores a newer profile", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    // Bind October to v1 while it is in force…
    await chargeUsage(db, { ...USAGE, executionToken: "bind-first" });
    // …then a second call in the SAME month whose instant would resolve to the
    // shipped large-base version if it were re-resolved. The binding wins, so it
    // is still priced under v1.
    const later = await chargeUsage(db, {
      ...USAGE,
      executionToken: "later-call",
      occurredAt: "2027-06-01T00:00:00.000Z",
    });
    expect(later).toEqual({ charged: true });
    expect(
      db.raw.query("SELECT execution_token, rp FROM usage_events ORDER BY execution_token").all(),
    ).toEqual([
      // deep 6 × 1 under v1, not 300 under the large base.
      { execution_token: "bind-first", rp: 6 },
      { execution_token: "later-call", rp: 6 },
    ]);
    expect(
      db.raw.query("SELECT profile_id FROM workspace_quota_binding WHERE month = '2026-10'").all(),
    ).toEqual([{ profile_id: "quota-v1" }]);
  });

  test("an unknown workspace is rejected by the FK and nothing is bound", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    await expect(
      chargeUsage(db, { ...USAGE, executionToken: "token-x", workspaceId: "no-such-workspace" }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM workspace_quota_binding").get()).toEqual({ n: 0 });
  });

  test("an unknown review level is refused before any statement runs", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    await expect(
      chargeUsage(db, { ...USAGE, executionToken: "t", level: "nope" as never }),
    ).rejects.toThrow(/unknown review level/);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 0 });
  });
});

describe("the three interleavings the atomic charge closes", () => {
  test("I1 — a cross-month replay of one token binds NOTHING in the new month", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    // The attempt was charged in October.
    await chargeUsage(db, { ...USAGE, executionToken: "cross-month" });
    // The same token replays after the month rolled over: the new month must not
    // be pinned for a workspace that never metered in it, and nothing appends.
    const replay = await chargeUsage(db, {
      ...USAGE,
      executionToken: "cross-month",
      occurredAt: "2026-11-05T00:00:00.000Z",
      month: "2026-11",
    });
    expect(replay).toEqual({ charged: false });
    expect(db.raw.query("SELECT month FROM workspace_quota_binding ORDER BY month").all()).toEqual([
      { month: "2026-10" },
    ]);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 1 });
  });

  test("premature binding — the price statement failing rolls the binding back with it", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    // A DB whose USAGE insert fails: the bot row the row's FK points at is
    // absent, so statement 2 throws and the whole batch rolls back.
    await expect(
      chargeUsage(db, { ...USAGE, executionToken: "fails", botId: "no-such-bot" }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    // The binding statement 1 already ran inside the same batch — and is gone.
    expect(db.raw.query("SELECT COUNT(*) AS n FROM workspace_quota_binding").get()).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 0 });
  });

  test("cross-month race — a binding never survives without its matching usage row", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    // Two first meterings of ONE month, back to back. Whichever binds, both rows
    // price from the same bound version, and every binding has its row.
    await chargeUsage(db, { ...USAGE, executionToken: "race-a", occurredAt: "2026-10-01T00:00:00.000Z" });
    await chargeUsage(db, {
      ...USAGE,
      reviewId: "review-b",
      executionToken: "race-b",
      level: "quick",
      occurredAt: "2026-10-02T00:00:00.000Z",
    });
    expect(db.raw.query("SELECT month FROM workspace_quota_binding").all()).toEqual([{ month: "2026-10" }]);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 2 });
    // Both rows were priced under the bound v1: deep 6 and quick 1.
    expect(
      db.raw.query("SELECT execution_token, rp FROM usage_events ORDER BY execution_token").all(),
    ).toEqual([
      { execution_token: "race-a", rp: 6 },
      { execution_token: "race-b", rp: 1 },
    ]);
  });

  test("no profile at the instant — nothing binds, nothing appends, charged: false", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    db.raw.prepare("DELETE FROM quota_profile_plans").run();
    db.raw.prepare("DELETE FROM quota_profiles").run();
    expect(await chargeUsage(db, { ...USAGE, executionToken: "no-profile" })).toEqual({ charged: false });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM workspace_quota_binding").get()).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 0 });
  });
});

describe("Q10 — the large base preserves every existing price", () => {
  const OLD_TOTAL = 1 + 2 + 6;
  const NEW_TOTAL = 50 + 100 + 300;
  const oldBase: Record<string, number> = { quick: 1, default: 2, deep: 6 };
  const newBase: Record<string, number> = { quick: 50, default: 100, deep: 300 };
  const RATIO = NEW_TOTAL / OLD_TOTAL;

  test("the ratio is integral, so an integral product scales exactly", () => {
    expect(NEW_TOTAL % OLD_TOTAL).toBe(0);
    expect(RATIO).toBe(50);

    for (const level of REVIEW_LEVELS) {
      for (const multiplier of [1, 2, 3, 5, 10, 25, 0.5, 1.5, 2.5]) {
        const oldExact = oldBase[level]! * multiplier;
        if (!Number.isInteger(oldExact)) continue;
        expect({ level, multiplier, new: Math.ceil(newBase[level]! * multiplier) }).toEqual({
          level,
          multiplier,
          new: oldExact * RATIO,
        });
      }
    }
  });

  test("a fractional product differs by less than one old-RP unit, never more", () => {
    // STATE THE RULE: `ceil` does not commute with scaling, so a fractional
    // product's new price is not exactly 50× the old rounded price. The error is
    // bounded by the CEILING itself: the new price never exceeds 50× the old
    // rounded price, and never falls more than one old-RP unit (50 new RP) below
    // it. That is the whole point of D12 — a large base bounds the loss.
    for (const level of REVIEW_LEVELS) {
      for (const multiplier of [1.1, 1.25, 1.5, 2.25, 2.5, 3.75, 7.5, 0.5 * 3]) {
        const oldExact = oldBase[level]! * multiplier;
        if (Number.isInteger(oldExact)) continue;
        const oldRounded = Math.ceil(oldExact);
        const newPrice = Math.ceil(newBase[level]! * multiplier);
        const scaledOld = oldRounded * RATIO;
        expect({ level, multiplier, ok: newPrice <= scaledOld }).toEqual({
          level,
          multiplier,
          ok: true,
        });
        expect({ level, multiplier, ok: newPrice > scaledOld - RATIO }).toEqual({
          level,
          multiplier,
          ok: true,
        });
      }
    }
  });

  test("a product below 1 RP stays at the 1-RP floor on both scales, not 50×", () => {
    // The ledger's pre-metering sentinel is 0, so no charge may be 0. The floor
    // is a price rule, not a scaling rule, so it applies to each scale on its own.
    // On the small base the floor bites: 6 × 0.001 = 0.006 → 1 RP.
    expect(Math.ceil(oldBase.deep! * 0.001)).toBe(1);
    // On the large base the same multiplier is a real price, so the floor is not
    // reached — the price scales instead of being clamped.
    expect(Math.ceil(newBase.deep! * 0.001)).toBe(1);
    expect(Math.ceil(newBase.deep! * 0.01)).toBe(3);
    expect(Math.ceil(newBase.deep! * 0.1)).toBe(30);
  });

  test("rpFor itself keeps the floor and the ceiling", () => {
    const oldProfile = { id: "o", version: 1, effectiveFrom: AT, base: { quick: 1, default: 2, deep: 6 }, rpPerCredit: 20 };
    const newProfile = { id: "n", version: 2, effectiveFrom: AT, base: { quick: 50, default: 100, deep: 300 }, rpPerCredit: 1000 };
    for (const level of REVIEW_LEVELS) {
      for (const multiplier of [0.001, 0.5, 1, 1.5, 2.25, 10]) {
        expect(rpFor(level, multiplier, newProfile)).toBe(
          Math.max(1, Math.ceil(newProfile.base[level] * multiplier)),
        );
        if (Number.isInteger(oldProfile.base[level] * multiplier)) {
          expect(rpFor(level, multiplier, newProfile)).toBe(rpFor(level, multiplier, oldProfile)! * RATIO);
        }
      }
    }
  });
});

describe("usage_events.rp (migration 0064)", () => {
  const MONTH = { startIso: "2026-10-01T00:00:00.000Z", endIso: "2026-11-01T00:00:00.000Z" };

  test("the column is NOT NULL, defaults to 0 and is an INTEGER", () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    expect(
      db.raw.prepare(`SELECT type, "notnull", dflt_value FROM pragma_table_info('usage_events') WHERE name = 'rp'`).get(),
    ).toEqual({ type: "INTEGER", notnull: 1, dflt_value: "0" });
  });

  test("the charge lands beside the seq the same statement minted", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    await chargeUsage(db, {
      ...USAGE,
      executionToken: "token-a1",
      occurredAt: "2026-10-05T00:00:00.000Z",
      level: "deep",
      multiplier: 10,
      source: "shared",
    });
    await chargeUsage(db, {
      ...USAGE,
      executionToken: "token-a2",
      occurredAt: "2026-10-06T00:00:00.000Z",
      level: "quick",
      source: "byok",
    });

    expect(db.raw.query("SELECT seq, rp FROM usage_events ORDER BY seq").all()).toEqual([
      { seq: 1, rp: 60 },
      { seq: 2, rp: 1 },
    ]);
    expect(await sumMonthlyRp(db, "default", MONTH.startIso, MONTH.endIso)).toBe(61);
  });

  test("a pre-metering row defaults to 0 and contributes nothing", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    db.raw
      .prepare(
        `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at)
         VALUES ('old-review', 1, 'old-token', 'default', '2026-10-02T00:00:00.000Z')`,
      )
      .run();
    expect(db.raw.query("SELECT rp FROM usage_events").get()).toEqual({ rp: 0 });
    expect(await sumMonthlyRp(db, "default", MONTH.startIso, MONTH.endIso)).toBe(0);
  });

  test("the window is half-open and per workspace", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_at) VALUES ('other', 'other', 'Other', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    for (const [reviewId, workspaceId, occurredAt, rp] of [
      ["at-start", "default", "2026-10-01T00:00:00.000Z", 1],
      ["after-end", "default", "2026-11-01T00:00:00.000Z", 100],
      ["other-ws", "other", "2026-10-10T00:00:00.000Z", 10],
    ] as const) {
      db.raw
        .prepare(
          `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at, rp)
           VALUES (?, 1, ?, ?, ?, ?)`,
        )
        .run(reviewId, `token-${reviewId}`, workspaceId, occurredAt, rp);
    }
    expect(await sumMonthlyRp(db, "default", MONTH.startIso, MONTH.endIso)).toBe(1);
  });
});

describe("usage_events.source (migration 0065)", () => {
  const MONTH = { startIso: "2026-10-01T00:00:00.000Z", endIso: "2026-11-01T00:00:00.000Z" };

  test("one shared and one BYOK event split into the two rows, and the parts are the total", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    await chargeUsage(db, {
      reviewId: "shared-deep",
      executionToken: "token-shared",
      workspaceId: "default",
      occurredAt: "2026-10-05T00:00:00.000Z",
      month: "2026-10",
      level: "deep",
      multiplier: 10,
      source: "shared",
      botId: "bot-usage",
    });
    await chargeUsage(db, {
      reviewId: "byok-standard",
      executionToken: "token-byok",
      workspaceId: "default",
      occurredAt: "2026-10-06T00:00:00.000Z",
      month: "2026-10",
      level: "default",
      multiplier: 1,
      source: "byok",
      botId: "bot-usage",
    });

    const [usage] = await readMonthlyRp(db, "default", MONTH.startIso, MONTH.endIso);
    expect(usage).toEqual({ workspaceId: "default", total: 62, sharedRp: 60, byokRp: 2 });
    expect(await sumMonthlyRp(db, "default", MONTH.startIso, MONTH.endIso)).toBe(usage!.total);
  });

  test("a pre-column row counts in the total and in neither split", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    db.raw
      .prepare(
        `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at, rp)
         VALUES ('unrecorded', 1, 'token-unrecorded', 'default', '2026-10-07T00:00:00.000Z', 6)`,
      )
      .run();
    await chargeUsage(db, {
      reviewId: "byok-quick",
      executionToken: "token-byok",
      workspaceId: "default",
      occurredAt: "2026-10-08T00:00:00.000Z",
      month: "2026-10",
      level: "quick",
      multiplier: 1,
      source: "byok",
      botId: "bot-usage",
    });

    const [usage] = await readMonthlyRp(db, "default", MONTH.startIso, MONTH.endIso);
    expect(usage).toEqual({ workspaceId: "default", total: 7, sharedRp: 0, byokRp: 1 });
    expect(usage!.sharedRp + usage!.byokRp).toBeLessThan(usage!.total);
  });

  test("the operator form answers every workspace in one statement", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_at) VALUES ('other', 'other', 'Other', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    for (const [reviewId, workspaceId, source] of [
      ["a", "default", "shared"],
      ["b", "other", "byok"],
    ] as const) {
      db.raw
        .prepare(
          `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at, rp, source)
           VALUES (?, 1, ?, ?, '2026-10-10T00:00:00.000Z', 3, ?)`,
        )
        .run(reviewId, `token-${reviewId}`, workspaceId, source);
    }
    expect(await readMonthlyRpByWorkspace(db, MONTH.startIso, MONTH.endIso)).toEqual([
      { workspaceId: "default", total: 3, sharedRp: 3, byokRp: 0 },
      { workspaceId: "other", total: 3, sharedRp: 0, byokRp: 3 },
    ]);
    expect(await readMonthlyRp(db, "default", MONTH.startIso, MONTH.endIso)).toEqual([
      { workspaceId: "default", total: 3, sharedRp: 3, byokRp: 0 },
    ]);
  });
});

function usageByWorkspaceSql(extraWhere = ""): string {
  return `SELECT workspace_id AS workspaceId, COALESCE(SUM(rp), 0) AS total
            FROM usage_events
           WHERE ${extraWhere === "" ? "" : `${extraWhere} AND `}occurred_at >= '2026-10-01T00:00:00.000Z' AND occurred_at < '2026-11-01T00:00:00.000Z'
           GROUP BY workspace_id`;
}

describe("migration 0066 (the preview's month index)", () => {
  test("occurred_at leads and the aggregated columns are carried", () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    expect(db.raw.prepare(`PRAGMA index_info('idx_usage_events_occurred_rp')`).all()).toEqual([
      { seqno: 0, cid: expect.any(Number), name: "occurred_at" },
      { seqno: 1, cid: expect.any(Number), name: "workspace_id" },
      { seqno: 2, cid: expect.any(Number), name: "rp" },
      { seqno: 3, cid: expect.any(Number), name: "source" },
    ]);
  });

  test("both month reads are index-served: the preview by the window, the tenant by its workspace", () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    const plan = (sql: string) =>
      (db.raw.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join(" | ");
    expect(plan(usageByWorkspaceSql())).toContain("idx_usage_events_occurred_rp");
    expect(plan(usageByWorkspaceSql("workspace_id = 'default'"))).toContain("usage_events_workspace_occurred");
  });
});

describe("usage_events.bot_id (migration 0117)", () => {
  test("the column exists, is nullable and references review_bots", () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    const column = (db.raw.query("PRAGMA table_info(usage_events)").all() as Array<{ name: string; notnull: number }>)
      .find((entry) => entry.name === "bot_id");
    expect(column).toBeDefined();
    // Nullable by design: historical rows stay NULL — no backfill is forced,
    // quota-relay-repair Task 4 owns the one backfill and its operator report.
    expect(column!.notnull).toBe(0);
    const fk = (db.raw.query("PRAGMA foreign_key_list(usage_events)").all() as Array<{ from: string; table: string }>)
      .find((entry) => entry.from === "bot_id");
    expect(fk?.table).toBe("review_bots");
  });

  test("a real usage row written before 0117 survives the column addition with bot_id IS NULL", () => {
    // The pre-column world is the migration chain through 0116 — the raw SQL
    // fixture is the only honest writer of a legacy-shape row; the production
    // API requires botId exactly so this shape can never be re-created.
    const db = createTestD1();
    for (const name of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql") && name >= "0003" && name < "0117_usage_events_bot_id.sql")
      .sort()) {
      execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }
    db.raw
      .prepare(
        `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at, rp, source)
         VALUES ('pre-column-review', 1, 'pre-column-token', 'default', ?, 42, 'shared')`,
      )
      .run(AT);

    execMigrationScript(
      db.raw,
      readFileSync(join(MIGRATIONS_DIR, "0117_usage_events_bot_id.sql"), "utf8"),
    );

    const row = db.raw
      .query("SELECT review_id, rp, source, bot_id FROM usage_events WHERE review_id = 'pre-column-review'")
      .get() as { review_id: string; rp: number; source: string; bot_id: string | null };
    // The migration preserves the row — the charge and its source survive —
    // and history stays NULL by design: quota-relay-repair Task 4 owns the
    // one backfill, so no block of historical rows is forced non-NULL.
    expect(row).toEqual({ review_id: "pre-column-review", rp: 42, source: "shared", bot_id: null });
  });

  test("a new usage row carries the executing bot id", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    // The FK target: one bot row, the shape the split created.
    db.raw
      .prepare(
        `INSERT INTO review_bots (id, workspace_id, name, multiplier, created_at, updated_at)
         VALUES ('bot-metering', 'default', 'bot-metering', 1, ?, ?)`,
      )
      .run(AT, AT);
    await chargeUsage(db, {
      reviewId: "review-metered",
      executionToken: "token-metered",
      workspaceId: "default",
      occurredAt: AT,
      month: "2026-10",
      level: "deep",
      multiplier: 10,
      source: "shared",
      botId: "bot-metering",
    });
    const row = db.raw
      .query("SELECT bot_id, rp, source FROM usage_events WHERE review_id = 'review-metered'")
      .get() as { bot_id: string; rp: number; source: string };
    expect(row).toEqual({ bot_id: "bot-metering", rp: 60, source: "shared" });
  });

  test("a bot id that names no review_bots row is rejected by the FK", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    await expect(
      chargeUsage(db, {
        reviewId: "review-orphan",
        executionToken: "token-orphan",
        workspaceId: "default",
        occurredAt: AT,
        month: "2026-10",
        level: "quick",
        multiplier: 1,
        source: "byok",
        botId: "no-such-bot",
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});

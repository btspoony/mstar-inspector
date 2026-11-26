import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, createTestD1, execMigrationScript } from "./helpers";
import { bindWorkspaceQuotaProfile, rpFor } from "../../src/store/quota-store";
import { REVIEW_LEVELS } from "../../packages/shared/src/runtime";
import {
  hasUsageEventForExecutionToken,
  readMonthlyRp,
  readMonthlyRpByWorkspace,
  recordUsageEvent,
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

describe("recordUsageEvent", () => {
  test("same review mints 1 then 2; distinct reviews each start at 1", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    await recordUsageEvent(db, {
      reviewId: "review-a",
      executionToken: "token-a1",
      workspaceId: "default",
      occurredAt: AT,
      rp: 60,
      source: "shared",
      botId: "bot-usage",
    });
    await recordUsageEvent(db, {
      reviewId: "review-a",
      executionToken: "token-a2",
      workspaceId: "default",
      occurredAt: AT,
      rp: 2,
      source: "byok",
      botId: "bot-usage",
    });
    await recordUsageEvent(db, {
      reviewId: "review-b",
      executionToken: "token-b1",
      workspaceId: "default",
      occurredAt: AT,
      rp: 1,
      source: "byok",
      botId: "bot-usage",
    });

    const rows = db.raw
      .query(
        "SELECT review_id, seq, execution_token, workspace_id, occurred_at, rp, source FROM usage_events ORDER BY review_id, seq",
      )
      .all();
    expect(rows).toEqual([
      {
        review_id: "review-a",
        seq: 1,
        execution_token: "token-a1",
        workspace_id: "default",
        occurred_at: AT,
        rp: 60,
        source: "shared",
      },
      {
        review_id: "review-a",
        seq: 2,
        execution_token: "token-a2",
        workspace_id: "default",
        occurred_at: AT,
        rp: 2,
        source: "byok",
      },
      {
        review_id: "review-b",
        seq: 1,
        execution_token: "token-b1",
        workspace_id: "default",
        occurred_at: AT,
        rp: 1,
        source: "byok",
      },
    ]);
  });

  test("the same execution token is recorded once: a replay is a no-op, the next token still mints seq 2", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    const input = {
      reviewId: "review-a",
      executionToken: "token-a1",
      workspaceId: "default",
      occurredAt: AT,
      rp: 60,
      source: "shared" as const,
      botId: "bot-usage",
    };
    await recordUsageEvent(db, input);
    await recordUsageEvent(db, input);
    await recordUsageEvent(db, { ...input, executionToken: "token-a2", rp: 2 });

    const rows = db.raw
      .query("SELECT seq, execution_token FROM usage_events WHERE review_id = 'review-a' ORDER BY seq")
      .all();
    expect(rows).toEqual([
      { seq: 1, execution_token: "token-a1" },
      { seq: 2, execution_token: "token-a2" },
    ]);
  });

  test("an unknown workspace is rejected by the FK", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    await expect(
      recordUsageEvent(db, {
        reviewId: "review-a",
        executionToken: "token-x",
        workspaceId: "no-such-workspace",
        occurredAt: AT,
        rp: 1,
        source: "byok",
        botId: "bot-usage",
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    const count = db.raw.query("SELECT COUNT(*) AS n FROM usage_events").get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("bindWorkspaceQuotaProfile (D36: bind first, then price)", () => {
  test("the first metering of a month pins the profile in force at that instant", async () => {
    const db = createMigratedTestD1();
    const bound = await bindWorkspaceQuotaProfile(db, {
      workspaceId: "default",
      month: "2026-10",
      at: "2026-10-24T00:00:00.000Z",
    });
    expect(bound.id).toBe("quota-v1");
    expect(db.raw.query("SELECT workspace_id, month, profile_id FROM workspace_quota_binding").all()).toEqual([
      { workspace_id: "default", month: "2026-10", profile_id: "quota-v1" },
    ]);
    db.raw.close();
  });

  test("a later call of the same month answers the WINNER, never its own resolve", async () => {
    const db = createMigratedTestD1();
    // Bound first, while v1 was in force.
    const first = await bindWorkspaceQuotaProfile(db, {
      workspaceId: "default",
      month: "2026-11",
      at: "2026-11-01T00:00:00.000Z",
    });
    expect(first.id).toBe("quota-v1");
    // A concurrent call resolving on the far side of the boundary: `at` now
    // selects the shipped large-base profile, but the binding already exists, so
    // it must answer v1 — the version the month is actually priced under.
    const second = await bindWorkspaceQuotaProfile(db, {
      workspaceId: "default",
      month: "2026-11",
      at: "2027-06-01T00:00:00.000Z",
    });
    expect(second.id).toBe(first.id);
    expect(db.raw.query("SELECT profile_id FROM workspace_quota_binding WHERE month = '2026-11'").all()).toEqual([
      { profile_id: "quota-v1" },
    ]);
    db.raw.close();
  });

  test("a new month binds its own row, leaving the previous month pinned", async () => {
    const db = createMigratedTestD1();
    await bindWorkspaceQuotaProfile(db, {
      workspaceId: "default",
      month: "2026-11",
      at: "2026-11-30T23:00:00.000Z",
    });
    await bindWorkspaceQuotaProfile(db, {
      workspaceId: "default",
      month: "2026-12",
      at: "2026-12-01T00:00:01.000Z",
    });
    expect(db.raw.query("SELECT month, profile_id FROM workspace_quota_binding ORDER BY month").all()).toEqual([
      { month: "2026-11", profile_id: "quota-v1" },
      { month: "2026-12", profile_id: "quota-v2-large-base" },
    ]);
    db.raw.close();
  });

  test("a replayed execution token creates no binding — the caller returns early", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    const input = {
      reviewId: "review-replay",
      executionToken: "token-replay",
      workspaceId: "default",
      occurredAt: "2026-10-24T00:00:00.000Z",
      rp: 50,
      source: "shared" as const,
      botId: "bot-usage",
    };
    await recordUsageEvent(db, input);
    expect(await hasUsageEventForExecutionToken(db, "token-replay")).toBe(true);
    // The metering path's first step: a replay stops here, so the NEW month is
    // never bound for a workspace that did not meter in it (I1).
    expect(db.raw.query("SELECT COUNT(*) AS n FROM workspace_quota_binding").get()).toEqual({ n: 0 });
    db.raw.close();
  });
});

describe("C1 — two first-metering calls racing an effective_from boundary", () => {
  /**
   * The interleaving, simulated exactly: call A resolves while v1 is in force
   * and binds v1; call B resolves on the far side of the boundary (its `at`
   * selects the shipped large-base profile) but runs AFTER A's insert has landed.
   * Without the read-back, B would price `ceil(base × m)` from v2 and append a
   * differently priced row for the same month. With bind-then-read-back, B reads
   * A's binding and charges A's version.
   */
  test("the loser of the race charges the winner's version, not its own resolve", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);

    // A: first metering of November, inside v1's interval.
    const a = await bindWorkspaceQuotaProfile(db, {
      workspaceId: "default",
      month: "2026-11",
      at: "2026-11-02T00:00:00.000Z",
    });
    expect(a.id).toBe("quota-v1");

    // B: same month, but its `at` is past v2's effective_from. It must still
    // price v1, because that is what the month is bound to.
    const b = await bindWorkspaceQuotaProfile(db, {
      workspaceId: "default",
      month: "2026-11",
      at: "2027-06-01T00:00:00.000Z",
    });
    expect(b.id).toBe(a.id);

    // Both price the same version, so both charge the same RP.
    expect(rpFor("deep", 1, a)).toBe(rpFor("deep", 1, b));
    // And the table still holds exactly one binding for the month.
    expect(db.raw.query("SELECT COUNT(*) AS n FROM workspace_quota_binding").get()).toEqual({ n: 1 });
    db.raw.close();
  });

  test("no row is appended twice for one execution token across a race", async () => {
    const db = createMigratedTestD1();
    seedUsageBot(db);
    const input = {
      reviewId: "review-race",
      executionToken: "token-race",
      workspaceId: "default",
      occurredAt: "2026-11-02T00:00:00.000Z",
      rp: 300,
      source: "shared" as const,
      botId: "bot-usage",
    };
    // The second call is the loser of a duplicate delivery: it sees the token,
    // returns early, and writes nothing — the guard `recordUsageEvent` keeps.
    await recordUsageEvent(db, input);
    expect(await hasUsageEventForExecutionToken(db, input.executionToken)).toBe(true);
    await recordUsageEvent(db, input);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM usage_events WHERE execution_token = 'token-race'").get()).toEqual({
      n: 1,
    });
    db.raw.close();
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
          expect(rpFor(level, multiplier, newProfile)).toBe(rpFor(level, multiplier, oldProfile) * RATIO);
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
    await recordUsageEvent(db, {
      reviewId: "review-a",
      executionToken: "token-a1",
      workspaceId: "default",
      occurredAt: "2026-10-05T00:00:00.000Z",
      rp: 60,
      source: "shared",
      botId: "bot-usage",
    });
    await recordUsageEvent(db, {
      reviewId: "review-a",
      executionToken: "token-a2",
      workspaceId: "default",
      occurredAt: "2026-10-06T00:00:00.000Z",
      rp: 1,
      source: "byok",
      botId: "bot-usage",
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
    await recordUsageEvent(db, {
      reviewId: "shared-deep",
      executionToken: "token-shared",
      workspaceId: "default",
      occurredAt: "2026-10-05T00:00:00.000Z",
      rp: 60,
      source: "shared",
      botId: "bot-usage",
    });
    await recordUsageEvent(db, {
      reviewId: "byok-standard",
      executionToken: "token-byok",
      workspaceId: "default",
      occurredAt: "2026-10-06T00:00:00.000Z",
      rp: 2,
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
    await recordUsageEvent(db, {
      reviewId: "byok-quick",
      executionToken: "token-byok",
      workspaceId: "default",
      occurredAt: "2026-10-08T00:00:00.000Z",
      rp: 1,
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
    await recordUsageEvent(db, {
      reviewId: "review-metered",
      executionToken: "token-metered",
      workspaceId: "default",
      occurredAt: AT,
      rp: 60,
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
      recordUsageEvent(db, {
        reviewId: "review-orphan",
        executionToken: "token-orphan",
        workspaceId: "default",
        occurredAt: AT,
        rp: 1,
        source: "byok",
        botId: "no-such-bot",
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});

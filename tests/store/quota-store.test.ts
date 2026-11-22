/**
 * why: Migration 0063 (versioned quota profiles) and its read module.
 *
 * The migration is the product for the schema half: interval overlap must be
 * unrepresentable (a second row at an existing `effective_from` is refused by
 * the UNIQUE index, with no application-layer check in the path), the v1 seed
 * must be byte-identical everywhere, and the two superseded plan columns must
 * be gone. The module half pins the month judgement (D5) — the profile judging
 * a month is the one covering that month's FIRST day — and the RP arithmetic.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "./helpers";
import {
  quotaMonth,
  resolveMonthlyQuota,
  quotaSpent,
  resolveQuotaProfile,
  rpFor,
  type QuotaProfile,
  type QuotaSource,
} from "../../src/store/quota-store";
import { resolveWorkspacePlan } from "../../src/dashboard/entitlement";
import { REVIEW_LEVELS, type ReviewLevel } from "../../packages/shared/src/runtime";

const V1_AT = "2026-10-24T00:00:00.000Z";

/** note: One extra profile in a later month, so "which profile judges this" is observable. */
function insertProfile(
  db: TestD1,
  row: { id: string; version: number; effectiveFrom: string; baseStandard?: number },
): void {
  db.raw
    .prepare(
      `INSERT INTO quota_profiles (
         id, version, effective_from, base_quick, base_standard, base_deep,
         source_byok, source_shared, rp_per_credit, notes, created_at, created_by
       ) VALUES (?, ?, ?, 1, ?, 6, 1, 10, 20, NULL, ?, 'test')`,
    )
    .run(row.id, row.version, row.effectiveFrom, row.baseStandard ?? 2, row.effectiveFrom);
  for (const planId of ["free", "pro", "unlimited"]) {
    db.raw
      .prepare(`INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp) VALUES (?, ?, ?)`)
      .run(row.id, planId, planId === "unlimited" ? null : 1000);
  }
}

describe("migration 0063 (quota_profiles + quota_profile_plans)", () => {
  test("the v1 seed is one profile with the catalogue's own instant and three plan ceilings", () => {
    const db = createMigratedTestD1();
    expect(
      db.raw
        .query(
          `SELECT id, version, effective_from, base_quick, base_standard, base_deep,
                  source_byok, source_shared, rp_per_credit, created_at
             FROM quota_profiles`,
        )
        .all(),
    ).toEqual([
      {
        id: "quota-v1",
        version: 1,
        effective_from: V1_AT,
        base_quick: 1,
        base_standard: 2,
        base_deep: 6,
        source_byok: 1,
        source_shared: 10,
        rp_per_credit: 20,
        created_at: V1_AT,
      },
    ]);
    // invariant: `unlimited` keeps its ROW with a NULL ceiling: an absent row would read as
    // "no ceiling" for a plan this profile never considered.
    expect(
      db.raw.query("SELECT plan_id, monthly_rp FROM quota_profile_plans ORDER BY plan_id").all(),
    ).toEqual([
      { plan_id: "free", monthly_rp: 2000 },
      { plan_id: "pro", monthly_rp: 20000 },
      { plan_id: "unlimited", monthly_rp: null },
    ]);
    db.raw.close();
  });

  test("a second profile at an existing effective_from is refused by the database", () => {
    const db = createMigratedTestD1();
    const insertAt = (id: string, version: number, effectiveFrom: string) =>
      db.raw
        .prepare(
          `INSERT INTO quota_profiles (
             id, version, effective_from, base_quick, base_standard, base_deep,
             source_byok, source_shared, rp_per_credit, notes, created_at, created_by
           ) VALUES (?, ?, ?, 1, 2, 6, 1, 10, 20, NULL, ?, 'operator')`,
        )
        .run(id, version, effectiveFrom, V1_AT);

    expect(() => insertAt("quota-v2", 2, V1_AT)).toThrow(/UNIQUE constraint failed/);
    // invariant: Same refusal through the version ordinal: two creates cannot mint one.
    expect(() => insertAt("quota-v2", 1, "2026-11-15T00:00:00.000Z")).toThrow(
      /UNIQUE constraint failed/,
    );
    // note: A genuinely new endpoint is accepted — overlap is what is unrepresentable,
    // not further profiles.
    expect(() => insertAt("quota-v2", 2, "2026-11-15T00:00:00.000Z")).not.toThrow();
    expect(
      db.raw.query("SELECT COUNT(*) AS n FROM quota_profiles").get(),
    ).toEqual({ n: 2 });
    db.raw.close();
  });

  test("a profile's ceilings must be a positive number or NULL, never zero", () => {
    const db = createMigratedTestD1();
    expect(() =>
      db.raw
        .prepare(`UPDATE quota_profile_plans SET monthly_rp = 0 WHERE plan_id = 'free'`)
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.raw
        .prepare(`UPDATE quota_profile_plans SET monthly_rp = -1 WHERE plan_id = 'free'`)
        .run(),
    ).toThrow(/CHECK constraint failed/);
    // why: A ceiling needs a real profile: the FK holds the profile's plan set closed.
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp) VALUES ('no-such-profile', 'free', 1)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    db.raw.close();
  });

  test("the app cap is seeded per plan, and the two superseded columns are gone", () => {
    const db = createMigratedTestD1();
    expect(
      db.raw.query("SELECT id, apps_per_workspace FROM plans ORDER BY id").all(),
    ).toEqual([
      { id: "free", apps_per_workspace: 1 },
      { id: "pro", apps_per_workspace: 10 },
      { id: "unlimited", apps_per_workspace: null },
    ]);
    const columns = (db.raw.query("PRAGMA table_info(plans)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(columns).not.toContain("platform_key_limit");
    expect(columns).not.toContain("reviews_included");
    db.raw.close();
  });
});

describe("resolveQuotaProfile", () => {
  test("answers the profile whose effective_from is the greatest <= the instant", async () => {
    const db = createMigratedTestD1();
    insertProfile(db, { id: "quota-v2", version: 2, effectiveFrom: "2026-11-15T00:00:00.000Z" });

    expect((await resolveQuotaProfile(db, V1_AT)).id).toBe("quota-v1");
    expect((await resolveQuotaProfile(db, "2026-11-14T23:59:59.999Z")).id).toBe("quota-v1");
    // invariant: The instant itself belongs to the new profile: effective_from is inclusive.
    expect((await resolveQuotaProfile(db, "2026-11-15T00:00:00.000Z")).id).toBe("quota-v2");
    expect((await resolveQuotaProfile(db, "2030-01-01T00:00:00.000Z")).id).toBe("quota-v2");
    db.raw.close();
  });

  test("an instant before every profile answers the EARLIEST profile", async () => {
    const db = createMigratedTestD1();
    insertProfile(db, { id: "quota-v2", version: 2, effectiveFrom: "2026-11-15T00:00:00.000Z" });

    // why: The cutover month: nothing was configured yet, so the earliest configured
    // state is what judged it. Never throws, never answers the latest.
    expect((await resolveQuotaProfile(db, "2020-01-01T00:00:00.000Z")).id).toBe("quota-v1");
    db.raw.close();
  });

  test("an empty table throws — migration 0063 did not apply", async () => {
    const db = createMigratedTestD1();
    db.raw.prepare("DELETE FROM quota_profile_plans").run();
    db.raw.prepare("DELETE FROM quota_profiles").run();
    await expect(resolveQuotaProfile(db, V1_AT)).rejects.toThrow(/0063_quota_profiles\.sql/);
    db.raw.close();
  });
});

describe("resolveMonthlyQuota — the month is judged by the profile covering its 1st", () => {
  test("a profile published mid-month does not judge that month", async () => {
    const db = createMigratedTestD1();
    // note: Published 2026-11-15, so November (whose 1st is 2026-11-01) keeps v1;
    // December is the first month v2 judges.
    insertProfile(db, { id: "quota-v2", version: 2, effectiveFrom: "2026-11-15T00:00:00.000Z" });

    expect(await resolveMonthlyQuota(db, "2026-11-01T00:00:00.000Z", "pro")).toEqual({
      profile: expect.objectContaining({ id: "quota-v1", version: 1 }),
      monthlyRp: 20000,
    });
    expect(await resolveMonthlyQuota(db, "2026-12-01T00:00:00.000Z", "pro")).toEqual({
      profile: expect.objectContaining({ id: "quota-v2", version: 2 }),
      monthlyRp: 1000,
    });
    db.raw.close();
  });

  test("a month before every profile resolves to the earliest profile", async () => {
    const db = createMigratedTestD1();
    expect(await resolveMonthlyQuota(db, "2026-01-01T00:00:00.000Z", "free")).toEqual({
      profile: expect.objectContaining({ id: "quota-v1" }),
      monthlyRp: 2000,
    });
    db.raw.close();
  });

  test("unlimited has no ceiling — a null monthlyRp, never a zero limit", async () => {
    const db = createMigratedTestD1();
    const quota = await resolveMonthlyQuota(db, "2026-11-01T00:00:00.000Z", "unlimited");
    expect(quota.monthlyRp).toBeNull();
    db.raw.close();
  });

  test("a plan the profile has no row for throws instead of reading as unlimited", async () => {
    const db = createMigratedTestD1();
    db.raw.prepare("DELETE FROM quota_profile_plans WHERE plan_id = 'pro'").run();
    await expect(resolveMonthlyQuota(db, "2026-11-01T00:00:00.000Z", "pro")).rejects.toThrow(
      /no ceiling for plan 'pro'/,
    );
    db.raw.close();
  });
});

describe("rpFor", () => {
  const profile: QuotaProfile = {
    id: "quota-v1",
    version: 1,
    effectiveFrom: V1_AT,
    base: { quick: 1, default: 2, deep: 6 },
    source: { byok: 1, shared: 10 },
    rpPerCredit: 20,
  };

  test("1/2/6 RP for BYOK and 10/20/60 for the shared bot, at every plan", async () => {
    const db = createMigratedTestD1();
    const expected: Record<QuotaSource, Record<ReviewLevel, number>> = {
      byok: { quick: 1, default: 2, deep: 6 },
      shared: { quick: 10, default: 20, deep: 60 },
    };

    for (const planId of ["free", "pro", "unlimited"] as const) {
      const { profile: resolved } = await resolveMonthlyQuota(db, V1_AT, planId);
      for (const source of ["byok", "shared"] as const) {
        for (const level of REVIEW_LEVELS) {
          expect(rpFor(level, source, resolved)).toBe(expected[source]![level]);
        }
      }
    }
    db.raw.close();
  });

  test("reads the weights from the profile, so a later version re-prices without code", () => {
    const repriced: QuotaProfile = {
      ...profile,
      base: { quick: 2, default: 4, deep: 12 },
      source: { byok: 1, shared: 5 },
      rpPerCredit: 10,
    };
    expect(rpFor("deep", "shared", repriced)).toBe(60);
    expect(rpFor("quick", "byok", repriced)).toBe(2);
  });
});

describe("quotaMonth", () => {
  test("reports the UTC month with half-open ISO bounds", () => {
    expect(quotaMonth(new Date("2026-11-16T13:53:00.000Z"))).toEqual({
      month: "2026-11",
      startIso: "2026-11-01T00:00:00.000Z",
      endIso: "2026-12-01T00:00:00.000Z",
    });
    // note: The year boundary, and an instant that is already next month in UTC.
    expect(quotaMonth(new Date("2026-12-31T23:59:59.999Z"))).toEqual({
      month: "2026-12",
      startIso: "2026-12-01T00:00:00.000Z",
      endIso: "2027-01-01T00:00:00.000Z",
    });
    expect(quotaMonth(new Date("2026-11-01T00:30:00.000Z")).startIso).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("self-hosted resolves no quota without reading a table", () => {
  test("the mode answers unlimited before any query, so no profile read follows", async () => {
    let reads = 0;
    const neverRead = {
      prepare() {
        reads += 1;
        throw new Error("self-hosted must not read the quota tables");
      },
      batch: () => {
        reads += 1;
        throw new Error("self-hosted must not read the quota tables");
      },
    };

    const plan = await resolveWorkspacePlan(neverRead, "default", "self-hosted");
    expect(plan.id).toBe("unlimited");
    expect(reads).toBe(0);
  });
});

describe("quotaSpent", () => {
  test("a month already at its ceiling is spent, because the cheapest review costs 1 RP", () => {
    // why: The default cost is the smallest cell `rpFor` can produce, so the faces
    // answer "would even the cheapest review be refused?" — and the enqueue
    // refuses at `used + cost > limit`, which at `used == limit` is already true.
    expect(quotaSpent(2000, 2000)).toBe(true);
    expect(quotaSpent(1999, 2000)).toBe(false);
  });

  test("a known cost asks the enqueue's own question, so the two cannot disagree", () => {
    // note: At 1999 of 2000 a Quick BYOK review (1 RP) fits and a Deep one (6 RP) does
    // not — the card said "not spent" for both when it ignored the cost.
    expect(quotaSpent(1999, 2000, 1)).toBe(false);
    expect(quotaSpent(1999, 2000, 6)).toBe(true);
    // invariant: Exactly filling the headroom is admitted, one RP over is refused.
    expect(quotaSpent(1994, 2000, 6)).toBe(false);
    expect(quotaSpent(1995, 2000, 6)).toBe(true);
  });

  test("a NULL ceiling is unlimited and can never be spent, at any cost", () => {
    expect(quotaSpent(1_000_000, null)).toBe(false);
    expect(quotaSpent(1_000_000, null, 1_000_000)).toBe(false);
  });
});

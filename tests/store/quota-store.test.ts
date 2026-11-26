import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "./helpers";
import {
  quotaMonth,
  resolveWorkspaceMonthlyQuota,
  resolveWorkspaceQuotaProfile,
  quotaSpent,
  resolveQuotaProfile,
  rpFor,
  type QuotaProfile,
} from "../../src/store/quota-store";
import { resolveWorkspacePlan } from "../../src/dashboard/entitlement";
import { REVIEW_LEVELS, type ReviewLevel } from "../../packages/shared/src/runtime";

const V1_AT = "2026-10-24T00:00:00.000Z";

function insertProfile(
  db: TestD1,
  row: { id: string; version?: number; effectiveFrom: string; baseStandard?: number },
): void {
  const version =
    row.version ?? (db.raw.query("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM quota_profiles").get() as { n: number }).n;
  db.raw
    .prepare(
      `INSERT INTO quota_profiles (
         id, version, effective_from, base_quick, base_standard, base_deep,
         rp_per_credit, notes, created_at, created_by
       ) VALUES (?, ?, ?, 50, ?, 300, 1000, NULL, ?, 'test')`,
    )
    .run(row.id, version, row.effectiveFrom, row.baseStandard ?? 2, row.effectiveFrom);
  for (const planId of ["free", "pro", "unlimited"]) {
    db.raw
      .prepare(`INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp) VALUES (?, ?, ?)`)
      .run(row.id, planId, planId === "unlimited" ? null : 1000);
  }
}

describe("the seeded quota profiles", () => {
  test("v1 stays as recorded, and v2 ships the large base on the NEXT month's 1st", () => {
    const db = createMigratedTestD1();
    const profiles = db.raw
      .query(
        `SELECT id, version, effective_from, base_quick, base_standard, base_deep,
                rp_per_credit, created_at
           FROM quota_profiles ORDER BY version`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toEqual({
      id: "quota-v1",
      version: 1,
      effective_from: V1_AT,
      base_quick: 1,
      base_standard: 2,
      base_deep: 6,
      rp_per_credit: 20,
      created_at: V1_AT,
    });
    // D11/D12: base 50/100/300 with 1 credit = 1000 RP, effective on a month
    // boundary so no single month is priced on two scales.
    expect(profiles[1]).toMatchObject({
      id: "quota-v2-large-base",
      version: 2,
      base_quick: 50,
      base_standard: 100,
      base_deep: 300,
      rp_per_credit: 1000,
    });
    const effective = new Date(profiles[1]!.effective_from as string);
    expect(effective.getUTCDate()).toBe(1);
    expect(effective.getUTCMonth()).toBe((new Date().getUTCMonth() + 1) % 12);

    // The allowance scales with the price: 50× the v1 ceilings, unlimited stays NULL.
    expect(
      db.raw
        .query(
          `SELECT plan_id, monthly_rp FROM quota_profile_plans
            WHERE profile_id = 'quota-v2-large-base' ORDER BY plan_id`,
        )
        .all(),
    ).toEqual([
      { plan_id: "free", monthly_rp: 100_000 },
      { plan_id: "pro", monthly_rp: 1_000_000 },
      { plan_id: "unlimited", monthly_rp: null },
    ]);
    db.raw.close();
  });

  test("a second profile at an existing effective_from is refused by the database", () => {
    const db = createMigratedTestD1();
    const before = (db.raw.query("SELECT COUNT(*) AS n FROM quota_profiles").get() as { n: number }).n;
    const insertAt = (id: string, effectiveFrom: string) =>
      db.raw
        .prepare(
          `INSERT INTO quota_profiles (
             id, version, effective_from, base_quick, base_standard, base_deep,
             rp_per_credit, notes, created_at, created_by
           ) VALUES (?, (SELECT COALESCE(MAX(version), 0) + 1 FROM quota_profiles),
                     ?, 50, 100, 300, 1000, NULL, ?, 'operator')`,
        )
        .run(id, effectiveFrom, V1_AT);

    // `effective_from` already held by the v1 seed.
    expect(() => insertAt("quota-dup-instant", V1_AT)).toThrow(/UNIQUE constraint failed/);
    // A fresh instant is accepted once; the second attempt at it is refused.
    expect(() => insertAt("quota-dup-a", "2026-11-15T00:00:00.000Z")).not.toThrow();
    expect(() => insertAt("quota-dup-b", "2026-11-15T00:00:00.000Z")).toThrow(
      /UNIQUE constraint failed/,
    );
    expect(
      db.raw.query("SELECT COUNT(*) AS n FROM quota_profiles").get(),
    ).toEqual({ n: before + 1 });
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
    insertProfile(db, { id: "quota-v2", effectiveFrom: "2026-11-15T00:00:00.000Z" });

    expect((await resolveQuotaProfile(db, V1_AT)).id).toBe("quota-v1");
    expect((await resolveQuotaProfile(db, "2026-11-14T23:59:59.999Z")).id).toBe("quota-v1");
    expect((await resolveQuotaProfile(db, "2026-11-15T00:00:00.000Z")).id).toBe("quota-v2");
    // Far ahead: the newest profile of all, which is the shipped large-base seed.
    expect((await resolveQuotaProfile(db, "2030-01-01T00:00:00.000Z")).id).toBe("quota-v2-large-base");
    db.raw.close();
  });

  test("an instant before every profile answers the EARLIEST profile", async () => {
    const db = createMigratedTestD1();
    insertProfile(db, { id: "quota-v2", effectiveFrom: "2026-11-15T00:00:00.000Z" });

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

describe("resolveWorkspaceMonthlyQuota — the month is pinned per workspace (D13)", () => {
  function bind(db: TestD1, workspaceId: string, month: string, profileId: string): void {
    db.raw
      .prepare("INSERT INTO workspace_quota_binding (workspace_id, month, profile_id) VALUES (?, ?, ?)")
      .run(workspaceId, month, profileId);
  }

  test("a binding wins over the profile in force, mid-month publish included", async () => {
    const db = createMigratedTestD1();
    insertProfile(db, { id: "quota-v2", effectiveFrom: "2026-11-15T00:00:00.000Z" });
    bind(db, "default", "2026-11", "quota-v1");

    // Bound to v1: the version the month opened under, though v2 is in force now.
    expect(await resolveWorkspaceMonthlyQuota(db, "default", "pro", new Date("2026-11-20T00:00:00.000Z"))).toEqual({
      profile: expect.objectContaining({ id: "quota-v1", version: 1 }),
      monthlyRp: 20000,
    });
    db.raw.close();
  });

  test("no binding answers the profile in force NOW, so a new workspace adopts the latest at once", async () => {
    const db = createMigratedTestD1();
    insertProfile(db, { id: "quota-v2", effectiveFrom: "2026-11-15T00:00:00.000Z" });

    // Unbound and reading mid-month: the newest version, not the one covering the 1st.
    expect(await resolveWorkspaceMonthlyQuota(db, "default", "pro", new Date("2026-11-20T00:00:00.000Z"))).toEqual({
      profile: expect.objectContaining({ id: "quota-v2", version: 3 }),
      monthlyRp: 1000,
    });
    db.raw.close();
  });

  test("the resolver never writes: a read leaves no binding behind", async () => {
    const db = createMigratedTestD1();
    await resolveWorkspaceQuotaProfile(db, "default", "2026-11", "2026-11-20T00:00:00.000Z");
    await resolveWorkspaceMonthlyQuota(db, "default", "pro", new Date("2026-11-20T00:00:00.000Z"));
    expect(db.raw.query("SELECT COUNT(*) AS n FROM workspace_quota_binding").get()).toEqual({ n: 0 });
    db.raw.close();
  });

  test("a month before every profile resolves to the earliest profile", async () => {
    const db = createMigratedTestD1();
    expect(await resolveWorkspaceMonthlyQuota(db, "default", "free", new Date("2026-01-01T00:00:00.000Z"))).toEqual({
      profile: expect.objectContaining({ id: "quota-v1" }),
      monthlyRp: 2000,
    });
    db.raw.close();
  });

  test("unlimited has no ceiling — a null monthlyRp, never a zero limit", async () => {
    const db = createMigratedTestD1();
    const quota = await resolveWorkspaceMonthlyQuota(db, "default", "unlimited", new Date("2026-11-01T00:00:00.000Z"));
    expect(quota.monthlyRp).toBeNull();
    db.raw.close();
  });

  test("a plan the profile has no row for throws instead of reading as unlimited", async () => {
    const db = createMigratedTestD1();
    db.raw.prepare("DELETE FROM quota_profile_plans WHERE plan_id = 'pro'").run();
    await expect(
      resolveWorkspaceMonthlyQuota(db, "default", "pro", new Date("2026-11-01T00:00:00.000Z")),
    ).rejects.toThrow(/no ceiling for plan 'pro'/);
    db.raw.close();
  });
});

describe("rpFor — ceil(base × multiplier)", () => {
  const profile: QuotaProfile = {
    id: "quota-v1",
    version: 1,
    effectiveFrom: V1_AT,
    base: { quick: 50, default: 100, deep: 300 },
    rpPerCredit: 1000,
  };

  const cases: Array<{ base: number; multiplier: number; rp: number; why: string }> = [
    { base: 50, multiplier: 1, rp: 50, why: "an integer multiplier is exact" },
    { base: 50, multiplier: 1.5, rp: 75, why: "half the base adds half" },
    { base: 100, multiplier: 1.5, rp: 150, why: "standard at 1.5" },
    { base: 300, multiplier: 1.5, rp: 450, why: "deep at 1.5" },
    { base: 50, multiplier: 0.01, rp: 1, why: "a product under 1 RP still costs 1: 0 marks pre-metering" },
    { base: 50, multiplier: 0.1, rp: 5, why: "a tenth of the base" },
    { base: 100, multiplier: 0.333, rp: 34, why: "33.3 rounds UP to 34, never down to 33" },
    { base: 300, multiplier: 0.333, rp: 100, why: "99.9 rounds up to 100" },
    { base: 50, multiplier: 2.5, rp: 125, why: "above 1 the multiplier scales up" },
    { base: 100, multiplier: 0.001, rp: 1, why: "the floor of 1 RP holds at any tiny product" },
  ];

  for (const row of cases) {
    test(`${row.base} × ${row.multiplier} = ${row.rp} RP — ${row.why}`, () => {
      const scaled: QuotaProfile = {
        ...profile,
        base: { quick: row.base, default: row.base, deep: row.base },
      };
      expect(rpFor("quick", row.multiplier, scaled)).toBe(row.rp);
    });
  }

  test("the level picks the base weight; every product is a whole RP >= 1", () => {
    for (const level of REVIEW_LEVELS) {
      for (const multiplier of [0.001, 0.5, 1, 1.5, 2.25, 7]) {
        const rp = rpFor(level, multiplier, profile);
        expect(Number.isInteger(rp)).toBe(true);
        expect(rp).toBeGreaterThanOrEqual(1);
        expect(rp).toBe(Math.ceil(profile.base[level] * multiplier));
      }
    }
  });

  test("the weights come from the profile, so a later version re-prices without code", () => {
    const repriced: QuotaProfile = {
      ...profile,
      base: { quick: 60, default: 120, deep: 360 },
      rpPerCredit: 500,
    };
    expect(rpFor("deep", 1.5, repriced)).toBe(540);
    expect(rpFor("quick", 1.5, repriced)).toBe(90);
  });
});

describe("quotaMonth", () => {
  test("reports the UTC month with half-open ISO bounds", () => {
    expect(quotaMonth(new Date("2026-11-16T13:53:00.000Z"))).toEqual({
      month: "2026-11",
      startIso: "2026-11-01T00:00:00.000Z",
      endIso: "2026-12-01T00:00:00.000Z",
    });
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
    expect(quotaSpent(2000, 2000)).toBe(true);
    expect(quotaSpent(1999, 2000)).toBe(false);
  });

  test("a known cost asks the enqueue's own question, so the two cannot disagree", () => {
    expect(quotaSpent(1999, 2000, 1)).toBe(false);
    expect(quotaSpent(1999, 2000, 6)).toBe(true);
    expect(quotaSpent(1994, 2000, 6)).toBe(false);
    expect(quotaSpent(1995, 2000, 6)).toBe(true);
  });

  test("a NULL ceiling is unlimited and can never be spent, at any cost", () => {
    expect(quotaSpent(1_000_000, null)).toBe(false);
    expect(quotaSpent(1_000_000, null, 1_000_000)).toBe(false);
  });
});

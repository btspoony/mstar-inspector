import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applyMigration, execMigrationScript, migrationsAfter } from "./helpers";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
const script = (name: string): string => readFileSync(join(MIGRATIONS_DIR, name), "utf8");

const PROFILE_BEFORE = "2026-10-24T00:00:00.000Z";

/**
 * The world as it stood at 0118: every migration strictly before 0119. The
 * handle is the raw bun:sqlite one — these tests drive migrations and read rows
 * directly, never through the D1 face.
 */
function preBindingDb(): Database {
  const db = new Database(":memory:");
  applyMigration(db, migrationsAfter(0).filter((name) => Number.parseInt(name, 10) < 119));
  return db;
}

function seedWorkspace(db: Database, id: string): void {
  db
    .prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(id, id, id, PROFILE_BEFORE);
}

function seedUsage(
  db: Database,
  workspaceId: string,
  occurredAt: string,
  token: string,
): void {
  db
    .prepare(
      `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at, rp, source)
       VALUES (?, 1, ?, ?, ?, 7, 'shared')`,
    )
    .run(`review-${token}`, token, workspaceId, occurredAt);
}

/** Publish one operator version, the way the console does. */
function publishProfile(
  db: Database,
  row: {
    id: string;
    version: number;
    effectiveFrom: string;
    base?: [number | null, number | null, number | null];
    ceilings?: Record<string, number | null>;
  },
): void {
  const [quick, standard, deep] = row.base ?? [1, 2, 6];
  // Two worlds: before 0120 the profile still carries the two source rates, and
  // after it they are gone. The fixture follows whichever schema is present.
  const hasSource = (db.query("PRAGMA table_info(quota_profiles)").all() as Array<{ name: string }>).some(
    (column) => column.name === "source_byok",
  );
  if (hasSource) {
    db.prepare(
      `INSERT INTO quota_profiles
         (id, version, effective_from, base_quick, base_standard, base_deep,
          source_byok, source_shared, rp_per_credit, notes, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, 10, 20, NULL, ?, 'operator')`,
    ).run(row.id, row.version, row.effectiveFrom, quick, standard, deep, row.effectiveFrom);
  } else {
    db.prepare(
      `INSERT INTO quota_profiles
         (id, version, effective_from, base_quick, base_standard, base_deep, rp_per_credit, notes, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 20, NULL, ?, 'operator')`,
    ).run(row.id, row.version, row.effectiveFrom, quick, standard, deep, row.effectiveFrom);
  }
  for (const [planId, rp] of Object.entries(row.ceilings ?? { free: 111, pro: 222, unlimited: null })) {
    db
      .prepare("INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp) VALUES (?, ?, ?)")
      .run(row.id, planId, rp);
  }
}

describe("C2 — 0119 binds the workspaces that already metered this month", () => {
  test("pre-migration usage pins the profile in force at THAT month's first day", () => {
    const db = preBindingDb();
    seedWorkspace(db, "ws-old");
    // A profile published mid-month: under the old rule it does NOT judge the
    // month, and the usage rows already priced under v1 must stay at v1.
    publishProfile(db, {
      id: "quota-mid-month",
      version: 2,
      effectiveFrom: "2026-11-15T00:00:00.000Z",
    });
    seedUsage(db, "ws-old", "2026-11-03T00:00:00.000Z", "old-1");
    seedUsage(db, "ws-old", "2026-11-20T00:00:00.000Z", "old-2");

    // The cutover migration.
    execMigrationScript(db, script("0119_workspace_quota_binding.sql"));

    expect(
      db.query("SELECT workspace_id, month, profile_id FROM workspace_quota_binding ORDER BY month").all(),
    ).toEqual([{ workspace_id: "ws-old", month: "2026-11", profile_id: "quota-v1" }]);
    db.close();
  });

  test("a workspace with no usage is left unbound, so its first metering decides", () => {
    const db = preBindingDb();
    seedWorkspace(db, "ws-fresh");
    seedWorkspace(db, "ws-used");
    seedUsage(db, "ws-used", "2026-11-05T00:00:00.000Z", "used-1");

    execMigrationScript(db, script("0119_workspace_quota_binding.sql"));

    expect(db.query("SELECT workspace_id FROM workspace_quota_binding").all()).toEqual([
      { workspace_id: "ws-used" },
    ]);
    db.close();
  });

  test("each month binds its own version: the same workspace gets one row per metered month", () => {
    const db = preBindingDb();
    seedWorkspace(db, "ws-two-months");
    publishProfile(db, {
      id: "quota-december",
      version: 2,
      effectiveFrom: "2026-12-01T00:00:00.000Z",
    });
    seedUsage(db, "ws-two-months", "2026-11-20T00:00:00.000Z", "m11");
    seedUsage(db, "ws-two-months", "2026-12-20T00:00:00.000Z", "m12");

    execMigrationScript(db, script("0119_workspace_quota_binding.sql"));

    expect(
      db.query("SELECT month, profile_id FROM workspace_quota_binding ORDER BY month").all(),
    ).toEqual([
      { month: "2026-11", profile_id: "quota-v1" },
      { month: "2026-12", profile_id: "quota-december" },
    ]);
    db.close();
  });
});

/** The world just before 0121: 0120 has dropped the source columns. */
function preLargeBaseDb(): Database {
  const db = new Database(":memory:");
  applyMigration(db, migrationsAfter(0).filter((name) => Number.parseInt(name, 10) < 121));
  return db;
}

describe("0121 C3 — the cutover instant never collides with a scheduled version", () => {
  test("an operator version at next month's midnight pushes the cutover one second later", () => {
    const db = preLargeBaseDb();
    const nextMonth = nextMonthMidnight();
    publishProfile(db, { id: "quota-operator", version: 2, effectiveFrom: nextMonth });

    execMigrationScript(db, script("0121_quota_base_large.sql"));

    const row = db
      .query("SELECT effective_from FROM quota_profiles WHERE id = 'quota-v2-large-base'")
      .get() as { effective_from: string };
    expect(row.effective_from).toBe(oneSecondAfter(nextMonth));
    // The operator's row is untouched.
    expect(
      db.query("SELECT version, effective_from FROM quota_profiles WHERE id = 'quota-operator'").get(),
    ).toEqual({ version: 2, effective_from: nextMonth });
    db.close();
  });

  test("a run of occupied instants is walked past, not overwritten", () => {
    const db = preLargeBaseDb();
    const nextMonth = nextMonthMidnight();
    const t1 = oneSecondAfter(nextMonth);
    const t2 = oneSecondAfter(t1);
    publishProfile(db, { id: "quota-op-a", version: 2, effectiveFrom: nextMonth });
    publishProfile(db, { id: "quota-op-b", version: 3, effectiveFrom: t1 });
    publishProfile(db, { id: "quota-op-c", version: 4, effectiveFrom: t2 });

    execMigrationScript(db, script("0121_quota_base_large.sql"));

    expect(
      db
        .query("SELECT effective_from FROM quota_profiles WHERE id = 'quota-v2-large-base'")
        .get(),
    ).toEqual({ effective_from: oneSecondAfter(t2) });
    expect(db.query("SELECT COUNT(*) AS n FROM quota_profiles WHERE id LIKE 'quota-op-%'").get()).toEqual({
      n: 3,
    });
    db.close();
  });

  test("with next month free the cutover lands exactly on its first day", () => {
    const db = preLargeBaseDb();
    execMigrationScript(db, script("0121_quota_base_large.sql"));
    expect(
      db.query("SELECT effective_from FROM quota_profiles WHERE id = 'quota-v2-large-base'").get(),
    ).toEqual({ effective_from: nextMonthMidnight() });
    db.close();
  });
});

describe("0121 C4 — ceilings scale from the profile in force, by ITS OWN base total", () => {
  test("a superseded profile with a different base scales by its own ratio, not a fixed 50", () => {
    const db = preLargeBaseDb();
    // v1 here prices at base 1/2/6 (total 9) with ceilings 1000 / 10000.
    db.prepare("UPDATE quota_profile_plans SET monthly_rp = 1000 WHERE profile_id = 'quota-v1' AND plan_id = 'free'").run();
    db.prepare("UPDATE quota_profile_plans SET monthly_rp = 10000 WHERE profile_id = 'quota-v1' AND plan_id = 'pro'").run();

    execMigrationScript(db, script("0121_quota_base_large.sql"));

    // factor = (50 + 100 + 300) / (1 + 2 + 6) = 450 / 9 = 50
    expect(ceilingsOf(db, "quota-v2-large-base")).toEqual({ free: 50000, pro: 500000 });
    db.close();
  });

  test("the DDL makes a NULL base weight impossible, so the NULL branch is defensive only", () => {
    const db = preLargeBaseDb();
    // 0063 declares all three base weights NOT NULL: a profile that cannot price
    // a level cannot be stored, so the migration's NULL guard is unreachable on
    // any real deployment. Asserting the constraint is the honest test — a
    // fabricated NULL row would be a world the schema forbids.
    for (const column of ["base_quick", "base_standard", "base_deep"]) {
      expect(() =>
        db.prepare(`UPDATE quota_profiles SET ${column} = NULL WHERE id = 'quota-v1'`).run(),
      ).toThrow(/NOT NULL constraint failed/);
    }
    db.close();
  });

  test("a future-scheduled operator version is neither the source nor rewritten", () => {
    const db = preLargeBaseDb();
    // Operator scheduled a version two months out with its own small ceilings.
    const far = twoMonthsOut();
    publishProfile(db, {
      id: "quota-future",
      version: 2,
      effectiveFrom: far,
      base: [10, 20, 30],
      ceilings: { free: 777, pro: 888, unlimited: null },
    });

    execMigrationScript(db, script("0121_quota_base_large.sql"));

    // The cutover lands next month, so the source is v1 (total 9) — never the
    // future row, whose own ceilings stay exactly as the operator set them.
    const row = db
      .query("SELECT effective_from FROM quota_profiles WHERE id = 'quota-v2-large-base'")
      .get() as { effective_from: string };
    expect(row.effective_from < far).toBe(true);
    // v1's seeded ceilings are 2000 / 20000, scaled by v1's own total (9) into
    // the new total (450): factor 50.
    expect(ceilingsOf(db, "quota-v2-large-base")).toEqual({ free: 100000, pro: 1000000 });
    expect(ceilingsOf(db, "quota-future")).toEqual({ free: 777, pro: 888 });
    db.close();
  });
});

function ceilingsOf(db: Database, profileId: string): Record<string, number> {
  const rows = db
    .query(
      `SELECT plan_id, monthly_rp FROM quota_profile_plans
        WHERE profile_id = ? AND monthly_rp IS NOT NULL ORDER BY plan_id`,
    )
    .all(profileId) as Array<{ plan_id: string; monthly_rp: number }>;
  return Object.fromEntries(rows.map((row) => [row.plan_id, row.monthly_rp]));
}

function nextMonthMidnight(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

function twoMonthsOut(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)).toISOString();
}

function oneSecondAfter(iso: string): string {
  return new Date(new Date(iso).getTime() + 1000).toISOString();
}

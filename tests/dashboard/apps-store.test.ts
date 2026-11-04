/**
 * Unit tests for the migration-0045 store face in
 * src/dashboard/apps-store.ts: the review gate, the owner allowlist and the
 * cached GitHub App visibility.
 *
 * Pinned here:
 *   - the DDL defaults are what an App reads before any save (80 / `ship it`
 *     / gate-relevant verdicts, allowlist off, visibility `unknown`), and an
 *     unreadable stored verdict array reads as `null`, never that default;
 *   - saveCheckGate validates BEFORE writing — a non-integer or out-of-range
 *     score and an off-vocabulary verdict leave the stored gate untouched;
 *   - saveAllowlist REPLACES the owner set in one batch (a removal is written
 *     by the same operation that adds), collapses duplicates and keeps an
 *     empty set meaningful;
 *   - both writers refuse an unknown or soft-deleted App with no rows written;
 *   - visibility round-trips and reads `unknown` for a never-probed row.
 *
 * The fixture is the fully migrated schema (tests/store/helpers), so the
 * assertions run against the real DDL rather than a hand-built table.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1 } from "../store/helpers";
import { createAppsStore } from "../../src/dashboard/apps-store";
import type { D1Like } from "../../src/store/types";
import type { TestD1 } from "../store/helpers";

/** One github_apps row of the post-0038 shape, without the store's crypto path. */
function seedApp(
  db: TestD1,
  id: string,
  options: { githubAppId: number; deleted?: boolean },
): void {
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
          status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', 'enc', 'acme', 'active',
               ${options.deleted ? "datetime('now')" : "NULL"}, datetime('now'), datetime('now'))`,
    )
    .run(id, options.githubAppId, id);
}

describe("review gate (migration 0045)", () => {
  test("reads the DDL defaults and round-trips a saved gate", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-gate", { githubAppId: 5001 });
    const store = createAppsStore(db);

    expect(await store.getCheckGate("app-gate")).toEqual({ minScore: 80, passVerdicts: ["ship it"] });

    expect(await store.saveCheckGate("app-gate", { minScore: 65, passVerdicts: ["ship it", "needs fixes"] })).toBe(
      true,
    );
    expect(await store.getCheckGate("app-gate")).toEqual({
      minScore: 65,
      passVerdicts: ["ship it", "needs fixes"],
    });

    // The second save overwrites both values; nothing accumulates.
    expect(await store.saveCheckGate("app-gate", { minScore: 0, passVerdicts: ["blocked"] })).toBe(true);
    expect(await store.getCheckGate("app-gate")).toEqual({ minScore: 0, passVerdicts: ["blocked"] });

    expect(await store.getCheckGate("unknown-app")).toBeNull();
  });

  test("rejects an out-of-range score and an off-vocabulary verdict before writing", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-invalid", { githubAppId: 5002 });
    const store = createAppsStore(db);

    for (const minScore of [-1, 101, 80.5]) {
      await expect(store.saveCheckGate("app-invalid", { minScore, passVerdicts: ["ship it"] })).rejects.toThrow(
        /check gate min score/,
      );
    }
    await expect(
      store.saveCheckGate("app-invalid", { minScore: 80, passVerdicts: ["ship it", "lgtm"] as never }),
    ).rejects.toThrow(/not on PR_VERDICTS/);

    // Zero rows written: the App still reads the untouched defaults.
    expect(await store.getCheckGate("app-invalid")).toEqual({ minScore: 80, passVerdicts: ["ship it"] });
  });

  test("a corrupt stored gate reads as null — unreadable configuration, never a default", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-corrupt", { githubAppId: 5004 });
    const store = createAppsStore(db);

    // Off-vocabulary array and valid-but-not-an-array are equally unreadable:
    // no gate is served at all, so every Check lane fails closed.
    for (const stored of ["{not json", '"ship it"', '["lgtm"]']) {
      db.raw
        .prepare(`UPDATE github_apps SET check_min_score = 55, check_pass_verdicts = ? WHERE id = 'app-corrupt'`)
        .run(stored);
      expect(await store.getCheckGate("app-corrupt")).toBeNull();
    }
  });

  test("refuses a soft-deleted App with no write", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-deleted", { githubAppId: 5003, deleted: true });
    const store = createAppsStore(db);

    expect(await store.saveCheckGate("app-deleted", { minScore: 10, passVerdicts: ["blocked"] })).toBe(false);
    expect(await store.getCheckGate("app-deleted")).toEqual({ minScore: 80, passVerdicts: ["ship it"] });
  });
});

describe("owner allowlist (migration 0045)", () => {
  test("starts off and empty, and each save replaces the owner set", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-allow", { githubAppId: 5101 });
    const store = createAppsStore(db);

    expect(await store.getAllowlist("app-allow")).toEqual({ enabled: false, owners: [] });

    // Duplicates collapse: the store writes a SET.
    expect(await store.saveAllowlist("app-allow", { enabled: true, owners: ["acme", "beta", "acme"] })).toBe(true);
    expect(await store.getAllowlist("app-allow")).toEqual({ enabled: true, owners: ["acme", "beta"] });

    // A removal is written by the same operation that adds: acme disappears.
    expect(await store.saveAllowlist("app-allow", { enabled: false, owners: ["beta"] })).toBe(true);
    expect(await store.getAllowlist("app-allow")).toEqual({ enabled: false, owners: ["beta"] });

    // Enabled with an empty list is legal to store — it refuses every owner.
    expect(await store.saveAllowlist("app-allow", { enabled: true, owners: [] })).toBe(true);
    expect(await store.getAllowlist("app-allow")).toEqual({ enabled: true, owners: [] });

    expect(await store.getAllowlist("unknown-app")).toBeNull();
  });

  test("refuses an unknown or soft-deleted App without writing owner rows", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-allow-deleted", { githubAppId: 5102, deleted: true });
    const store = createAppsStore(db);

    expect(await store.saveAllowlist("app-allow-deleted", { enabled: true, owners: ["acme"] })).toBe(false);
    expect(await store.saveAllowlist("unknown-app", { enabled: true, owners: ["acme"] })).toBe(false);
    const rows = db.raw.query("SELECT COUNT(*) AS n FROM app_owner_allowlist").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test("a soft-delete landing after the pre-read reports false and writes nothing at all", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-allow-race", { githubAppId: 5103 });
    // The pre-read cannot see a delete that lands before the batch, so the
    // batch's UPDATE repeats the predicate and its change count decides.
    const racing: D1Like = {
      prepare: (query) => db.prepare(query),
      batch: async (statements) => {
        db.raw.prepare(`UPDATE github_apps SET deleted_at = datetime('now') WHERE id = ?`).run("app-allow-race");
        return db.batch(statements);
      },
    };

    expect(await createAppsStore(racing).saveAllowlist("app-allow-race", { enabled: true, owners: ["acme"] })).toBe(
      false,
    );
    const row = db.raw.query("SELECT allowlist_enabled FROM github_apps WHERE id = ?").get("app-allow-race") as {
      allowlist_enabled: number;
    };
    expect(row.allowlist_enabled).toBe(0);
    // The DELETE and each INSERT repeat the liveness predicate, so the deleted
    // App is left with no orphan owner rows either.
    const owners = db.raw.query("SELECT COUNT(*) AS n FROM app_owner_allowlist").get() as { n: number };
    expect(owners.n).toBe(0);
  });
});

describe("GitHub App visibility (migration 0045)", () => {
  test("reads 'unknown' until probed and round-trips the stored value", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-visibility", { githubAppId: 5201 });
    const store = createAppsStore(db);

    expect(await store.getGithubVisibility("app-visibility")).toBe("unknown");

    expect(await store.saveGithubVisibility("app-visibility", "public")).toBe(true);
    expect(await store.getGithubVisibility("app-visibility")).toBe("public");

    expect(await store.saveGithubVisibility("app-visibility", "private")).toBe(true);
    expect(await store.getGithubVisibility("app-visibility")).toBe("private");

    expect(await store.getGithubVisibility("unknown-app")).toBeNull();
    expect(await store.saveGithubVisibility("unknown-app", "public")).toBe(false);
  });
});

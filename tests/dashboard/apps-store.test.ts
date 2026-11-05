/**
 * Unit tests for the migration-0045 store face in
 * src/dashboard/apps-store.ts: the review gate, the owner allowlist and the
 * cached GitHub App visibility.
 *
 * Pinned here:
 *   - the DDL defaults are what an App reads before any save (80 / `ship it`
 *     / gate-relevant verdicts, allowlist off, visibility `unknown`), an
 *     unreadable stored verdict array reads as `null`, never that default, and
 *     an EMPTY set is readable configuration no review can pass;
 *   - saveCheckGate validates BEFORE writing — a non-integer or out-of-range
 *     score and an off-vocabulary verdict leave the stored gate untouched;
 *   - saveAllowlist REPLACES the owner set in one batch (a removal is written
 *     by the same operation that adds), collapses duplicates and keeps an
 *     empty set meaningful; a deduped set past ALLOWLIST_MAX_OWNERS throws
 *     before any read;
 *   - both writers refuse an unknown or soft-deleted App with no rows written;
 *   - visibility round-trips and reads `unknown` for a never-probed row;
 *   - the per-App review level (migration 0047) has no backfill (every App
 *     reads NULL until it chooses), NULL is a first-class choice that writes
 *     back, and an off-vocabulary value reads as absent, never an error.
 *
 * The fixture is the fully migrated schema (tests/store/helpers), so the
 * assertions run against the real DDL rather than a hand-built table.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1 } from "../store/helpers";
import {
  ALLOWLIST_MAX_OWNERS,
  createAppsStore,
  parseAppReviewLevel,
} from "../../src/dashboard/apps-store";
import { getWorkspaceCheckMinScore } from "../../src/dashboard/runtime-config-store";
import { REVIEW_LEVELS } from "../../packages/shared/src/runtime";
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

    // `seedApp` is a raw INSERT, so this row carries 0045's column default
    // (80); the create-path default (`DEFAULT_CHECK_MIN_SCORE`, 60) is covered
    // by its own test below.
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

    // JSON well-formedness is a DDL CHECK, so the unreadable values that can
    // still exist are well-formed JSON that is not a verdict array: a JSON
    // string, and an array with an off-vocabulary entry. Both read as null —
    // no gate is served at all, so every Check lane fails closed.
    for (const stored of ['"ship it"', '["lgtm"]']) {
      db.raw
        .prepare(`UPDATE github_apps SET check_min_score = 55, check_pass_verdicts = ? WHERE id = 'app-corrupt'`)
        .run(stored);
      expect(await store.getCheckGate("app-corrupt")).toBeNull();
    }

    // Malformed JSON cannot even be stored: the column's CHECK rejects it.
    expect(() =>
      db.raw
        .prepare(`UPDATE github_apps SET check_pass_verdicts = '{not json' WHERE id = 'app-corrupt'`)
        .run(),
    ).toThrow();
    expect(await store.getCheckGate("app-corrupt")).toBeNull();
  });

  test("an empty verdict set is readable configuration that no review can pass", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-empty", { githubAppId: 5005 });
    const store = createAppsStore(db);

    // The settings route accepts an empty submission (every box unchecked), so
    // `[]` must round-trip as a gate — NOT the `null` an unreadable array reads
    // as — and stay empty rather than reverting to the DDL default.
    expect(await store.saveCheckGate("app-empty", { minScore: 0, passVerdicts: [] })).toBe(true);
    expect(await store.getCheckGate("app-empty")).toEqual({ minScore: 0, passVerdicts: [] });
  });

  test("refuses a soft-deleted App with no write", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-deleted", { githubAppId: 5003, deleted: true });
    const store = createAppsStore(db);

    expect(await store.saveCheckGate("app-deleted", { minScore: 10, passVerdicts: ["blocked"] })).toBe(false);
    expect(await store.getCheckGate("app-deleted")).toEqual({ minScore: 80, passVerdicts: ["ship it"] });
  });

  test("a new App inherits the workspace default the caller resolved", async () => {
    const db = createMigratedTestD1();
    db.raw.prepare("UPDATE workspaces SET check_min_score = 45 WHERE id = 'default'").run();
    const store = createAppsStore(db);
    // The route's shape: read the workspace default, then seed the App with it.
    const floor = await getWorkspaceCheckMinScore(db, "default");
    expect(floor).toEqual({ minScore: 45, degraded: false });

    await store.createApp({
      defaultCheckMinScore: floor.minScore,
      id: "app-inherit",
      githubAppId: 5011,
      githubSlug: null,
      name: "app-inherit",
      privateKeyEnc: "enc",
      webhookSecretEnc: "enc",
      createdBy: "acme",
      workspaceId: "default",
    });

    expect(await store.getCheckGate("app-inherit")).toEqual({ minScore: 45, passVerdicts: ["ship it"] });
  });

  test("a newly connected App starts at the product default floor (60)", async () => {
    const db = createMigratedTestD1();
    const store = createAppsStore(db);

    await store.createApp({
      id: "app-created",
      githubAppId: 5010,
      githubSlug: null,
      name: "app-created",
      privateKeyEnc: "enc",
      webhookSecretEnc: "enc",
      createdBy: "acme",
      workspaceId: "default",
    });

    // The creation path seeds the floor; the column's own default (80) is
    // 0045's historical value and never applies to a real App.
    expect(await store.getCheckGate("app-created")).toEqual({ minScore: 60, passVerdicts: ["ship it"] });
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

    // GitHub logins are case-insensitive, so a case variant is the SAME owner:
    // it collapses too, and the first submitted spelling is the one kept.
    expect(await store.saveAllowlist("app-allow", { enabled: true, owners: ["Acme", "acme", "beta"] })).toBe(true);
    expect(await store.getAllowlist("app-allow")).toEqual({ enabled: true, owners: ["Acme", "beta"] });

    // A removal is written by the same operation that adds: the Acme entry disappears.
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

  test("refuses an over-cap owner set before any read or write", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-allow-cap", { githubAppId: 5104 });
    const store = createAppsStore(db);
    const oversized = Array.from({ length: ALLOWLIST_MAX_OWNERS + 1 }, (_, index) => `owner-${index}`);

    // Thrown, not `false`: the caller asked for more than the method's
    // one-batch contract carries. It runs BEFORE the liveness pre-read, so an
    // unknown App throws the same error instead of reporting `false`.
    await expect(store.saveAllowlist("app-allow-cap", { enabled: true, owners: oversized })).rejects.toThrow(
      /ALLOWLIST_MAX_OWNERS/,
    );
    await expect(store.saveAllowlist("unknown-app", { enabled: true, owners: oversized })).rejects.toThrow(
      /ALLOWLIST_MAX_OWNERS/,
    );
    expect(await store.getAllowlist("app-allow-cap")).toEqual({ enabled: false, owners: [] });

    // Duplicates collapse first, so they never consume the batch budget.
    const atCap = oversized.slice(0, ALLOWLIST_MAX_OWNERS);
    expect(await store.saveAllowlist("app-allow-cap", { enabled: true, owners: [...atCap, ...atCap] })).toBe(true);
    const stored = await store.getAllowlist("app-allow-cap");
    expect(stored?.enabled).toBe(true);
    expect(stored?.owners).toHaveLength(ALLOWLIST_MAX_OWNERS);
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

describe("review level (migration 0047)", () => {
  /**
   * One App through the real creation path, so it is mapped to the 'default'
   * workspace and `getAppById` — the read `resolveCommenter` uses — resolves
   * it. The local `seedApp` above writes no mapping, so every tenant read
   * misses those rows.
   */
  async function seedMappedApp(db: TestD1, id: string, githubAppId: number): Promise<void> {
    await createAppsStore(db).createApp({
      id,
      githubAppId,
      githubSlug: null,
      name: id,
      privateKeyEnc: "enc",
      webhookSecretEnc: "enc",
      createdBy: "acme",
      workspaceId: "default",
    });
  }

  test("no backfill: an App reads NULL until it chooses, and NULL is a choice it can go back to", async () => {
    const db = createMigratedTestD1();
    await seedMappedApp(db, "app-level", 5401);
    const store = createAppsStore(db);

    // The creation path omits the column and nothing backfills it, so an
    // untouched App has no level of its own: NULL means "follow the operator
    // default".
    expect((await store.getAppById("app-level"))?.review_level).toBeNull();

    expect(await store.setReviewLevel("app-level", "deep")).toBe(true);
    const stored = await store.getAppById("app-level");
    expect(stored?.review_level).toBe("deep");
    expect(parseAppReviewLevel(stored?.review_level)).toBe("deep");

    // Choosing "follow the operator default" writes the column back to NULL.
    expect(await store.setReviewLevel("app-level", null)).toBe(true);
    expect((await store.getAppById("app-level"))?.review_level).toBeNull();
  });

  test("an off-vocabulary value reads as absent, never an error", async () => {
    const db = createMigratedTestD1();
    await seedMappedApp(db, "app-level-invalid", 5402);
    const store = createAppsStore(db);

    // The written vocabulary is closed: the DDL refuses anything else...
    expect(() =>
      db.raw.prepare(`UPDATE github_apps SET review_level = 'turbo' WHERE id = 'app-level-invalid'`).run(),
    ).toThrow();
    await expect(store.setReviewLevel("app-level-invalid", "turbo" as never)).rejects.toThrow(/review level/);

    // ...and the parser is the last line for a value that arrived another way:
    // an untrusted stored row falls back to the operator default instead of
    // failing the review.
    for (const level of REVIEW_LEVELS) {
      expect(parseAppReviewLevel(level)).toBe(level);
    }
    for (const value of [null, undefined, "turbo", "", "DEEP", 3, ["deep"]]) {
      expect(parseAppReviewLevel(value)).toBeNull();
    }
    expect((await store.getAppById("app-level-invalid"))?.review_level).toBeNull();
  });

  test("refuses a soft-deleted App with no write", async () => {
    const db = createMigratedTestD1();
    await seedMappedApp(db, "app-level-deleted", 5403);
    db.raw.prepare(`UPDATE github_apps SET deleted_at = datetime('now') WHERE id = 'app-level-deleted'`).run();
    const store = createAppsStore(db);

    expect(await store.setReviewLevel("app-level-deleted", "quick")).toBe(false);
    expect((await store.getAppById("app-level-deleted"))?.review_level).toBeNull();
  });
});

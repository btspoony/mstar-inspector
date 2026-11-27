import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, createTestD1, migrationNumber, migrationsAfter, seedBot, type TestD1 } from "./helpers";
import { applyMigrations } from "../helpers/migration-shapes";
import {
  createTargetsStore,
  readEffectiveTargetSettings,
} from "../../src/dashboard/targets-store";

const MIGRATION = "0070_draft_review_gate.sql";
const PREVIOUS = "0069_operator_data_upgrades.sql";

const BEFORE = migrationsAfter(2).filter((name) => migrationNumber(name) <= migrationNumber(PREVIOUS));

const WS = "default";

function dbAt0069(): TestD1 {
  const db = createTestD1();
  applyMigrations(db, BEFORE);
  seedBot(db, "bot-1", 7001);
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
          follow_workspace_defaults, review_trigger_mode, check_min_score,
          check_pass_verdicts, created_by, created_at, updated_at)
       VALUES ('target-1', 'default', 'bot-1', 'acme/widgets', 501, 'acme', 'widgets',
               1, 'open', 45, '["ship it"]',
               'acme', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  return db;
}

function reviewDraftsColumn(db: TestD1): { type: string; notnull: number; dflt_value: string | null } {
  const column = (
    db.raw.query("PRAGMA table_info(review_targets)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>
  ).find((entry) => entry.name === "review_drafts");
  if (column === undefined) throw new Error("review_targets.review_drafts is missing");
  return { type: column.type, notnull: column.notnull, dflt_value: column.dflt_value };
}

describe("migration 0070: the draft review gate", () => {
  test("adds a NOT NULL default-1 column; an existing target keeps reviewing drafts", () => {
    const db = dbAt0069();
    applyMigrations(db, [MIGRATION]);

    expect(reviewDraftsColumn(db)).toEqual({ type: "INTEGER", notnull: 1, dflt_value: "1" });
    expect(db.raw.query("SELECT review_drafts FROM review_targets WHERE id = 'target-1'").get()).toEqual({
      review_drafts: 1,
    });
    const workspaceColumns = (db.raw.query("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(workspaceColumns.some((name) => name.includes("draft"))).toBe(false);
  });

  test("a target created after the migration also starts at 1, and only 0/1 are storable", () => {
    const db = dbAt0069();
    applyMigrations(db, [MIGRATION]);

    db.raw
      .prepare(
        `INSERT INTO review_targets
           (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name, created_by, created_at, updated_at)
         VALUES ('target-new', 'default', 'bot-1', 'acme/gadgets', 502, 'acme', 'gadgets',
                 'acme', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
      )
      .run();
    expect(db.raw.query("SELECT review_drafts FROM review_targets WHERE id = 'target-new'").get()).toEqual({
      review_drafts: 1,
    });

    expect(() =>
      db.raw.prepare("UPDATE review_targets SET review_drafts = 2 WHERE id = 'target-1'").run(),
    ).toThrow();
    expect(() =>
      db.raw.prepare("UPDATE review_targets SET review_drafts = NULL WHERE id = 'target-1'").run(),
    ).toThrow();
  });
});

function seedStoreTarget(db: TestD1, id: string, repoId: number, follow: 0 | 1): void {
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, app_id, name, repo_id, repo_owner, repo_name,
          follow_workspace_defaults, review_trigger_mode, review_level, check_min_score,
          check_pass_verdicts, created_by, created_at, updated_at)
       VALUES (?, 'default', 'bot-store', ?, ?, 'acme', ?, ?, 'manual', 'deep', 70,
               '["ship it"]', 'acme', datetime('now'), datetime('now'))`,
    )
    .run(id, `acme/${id}`, repoId, id, follow);
}

describe("the store exposes the target-owned draft switch", () => {
  function db(): TestD1 {
    const db = createMigratedTestD1();
    seedBot(db, "bot-store", 7009);
    return db;
  }

  test("a draft-only save writes review_drafts and leaves follow and every other column alone", async () => {
    const d = db();
    seedStoreTarget(d, "t-follow", 11001, 1);
    seedStoreTarget(d, "t-own", 11002, 0);
    const store = createTargetsStore(d);

    expect(await store.setReviewConfig(WS, "t-follow", { reviewDrafts: false })).toBe(true);
    expect(
      d.raw
        .query(
          `SELECT review_drafts, follow_workspace_defaults, review_trigger_mode, review_level,
                  check_min_score, check_pass_verdicts
             FROM review_targets WHERE id = 't-follow'`,
        )
        .get(),
    ).toEqual({
      review_drafts: 0,
      follow_workspace_defaults: 1,
      review_trigger_mode: "manual",
      review_level: "deep",
      check_min_score: 70,
      check_pass_verdicts: '["ship it"]',
    });

    // 0108: the workspace default answers while inheriting, so the row's copy
    // is inert exactly like the policy columns.
    expect((await readEffectiveTargetSettings(d, (await store.getInWorkspace(WS, "t-follow"))!)).reviewDrafts).toBe(
      true,
    );
    expect((await readEffectiveTargetSettings(d, (await store.getInWorkspace(WS, "t-own"))!)).reviewDrafts).toBe(true);

    expect(await store.setReviewConfig(WS, "t-own", { reviewDrafts: false })).toBe(true);
    expect((await readEffectiveTargetSettings(d, (await store.getInWorkspace(WS, "t-own"))!)).reviewDrafts).toBe(false);
  });
});

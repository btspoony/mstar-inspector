/**
 * Migration equivalence for the custom-provider model-metadata overlay
 * (`app_custom_providers.models_meta`): the column is added by its own
 * migration, every existing declaration keeps its model ids verbatim, and the
 * overlay starts empty (`'{}'`) — the product never invents a size the owner
 * did not state.
 */
import { describe, expect, test } from "bun:test";
import { createTestD1, migrationNumber, migrationsAfter, type TestD1 } from "./helpers";
import { applyMigrations } from "../helpers/migration-shapes";
import { createAppConfigStore } from "../../src/dashboard/app-config-store";

const OVERLAY_MIGRATION = "0053_custom_provider_models_meta.sql";
const TEST_KEY = Buffer.alloc(32, 11).toString("base64");

/**
 * Every migration BEFORE the overlay one, in wrangler's apply order. Derived by
 * PREFIX, not by excluding one filename: a later migration (0054+) must be part
 * of the "after" half, or the production order this test replays would skip it.
 */
const BEFORE_OVERLAY = migrationsAfter(2).filter(
  (name) => migrationNumber(name) < migrationNumber(OVERLAY_MIGRATION),
);

/** One github_apps row of the post-0038 shape (no crypto path needed here). */
function seedApp(db: TestD1, id: string): void {
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
          status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', 'enc', 'acme', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, 7001, id);
}

/** One id-only declaration, written in the pre-overlay shape. */
function seedDeclaration(db: TestD1, appId: string): void {
  db.raw
    .prepare(
      `INSERT INTO app_custom_providers
         (app_id, provider_id, base_url, api, model_ids, created_at, updated_at)
       VALUES (?, 'my-custom', 'https://example.com/v1', 'openai-completions',
               '["deepseek-v4-flash","deepseek-r1"]', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    )
    .run(appId);
}

function columns(db: TestD1, table: string): Array<{ name: string; notnull: number; dflt_value: string | null }> {
  return db.raw.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
}

describe("migration: app_custom_providers.models_meta overlay", () => {
  test("adds the models_meta column with the '{}' default and rewrites no existing declaration", () => {
    const db = createTestD1();
    applyMigrations(db, BEFORE_OVERLAY);
    seedApp(db, "app-legacy");
    seedDeclaration(db, "app-legacy");
    const before = db.raw
      .query("SELECT model_ids, created_at, updated_at FROM app_custom_providers WHERE app_id = ?")
      .get("app-legacy") as { model_ids: string; created_at: string; updated_at: string };
    expect(columns(db, "app_custom_providers").some((c) => c.name === "models_meta")).toBe(false);

    applyMigrations(db, [OVERLAY_MIGRATION]);

    const overlay = columns(db, "app_custom_providers").find((c) => c.name === "models_meta");
    expect(overlay).toBeDefined();
    expect(overlay!.notnull).toBe(1);
    expect(overlay!.dflt_value).toBe("'{}'");
    // No backfill DML: the default carries the existing row, which keeps its
    // ids and its timestamps — a reordering or a dropped id would be a defect.
    const after = db.raw
      .query("SELECT model_ids, models_meta, created_at, updated_at FROM app_custom_providers WHERE app_id = ?")
      .get("app-legacy") as { model_ids: string; models_meta: string; created_at: string; updated_at: string };
    expect(after.model_ids).toBe(before!.model_ids);
    expect(after.created_at).toBe(before!.created_at);
    expect(after.updated_at).toBe(before!.updated_at);
    expect(after.models_meta).toBe("{}");
  });

  test("an id-only row reads back across the store face with its ids and no invented metadata", async () => {
    const db = createTestD1();
    applyMigrations(db, BEFORE_OVERLAY);
    seedApp(db, "app-legacy");
    seedDeclaration(db, "app-legacy");
    applyMigrations(db, [OVERLAY_MIGRATION]);

    await expect(createAppConfigStore(db, TEST_KEY).listCustomProviders("app-legacy")).resolves.toEqual([
      {
        provider_id: "my-custom",
        base_url: "https://example.com/v1",
        api: "openai-completions",
        model_ids: ["deepseek-v4-flash", "deepseek-r1"],
        has_keys: false,
      },
    ]);
  });
});

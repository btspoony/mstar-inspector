import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigration, createMigratedTestD1, execMigrationScript, migrationNumber, migrationsAfter, type TestD1 } from "./helpers";

const SCRIPT = readFileSync(join(import.meta.dir, "../../migrations/0125_index_names_after_split.sql"), "utf8");

/**
 * The migrated schema's index inventory, measured from `sqlite_master` after
 * every migration — not from the `CREATE INDEX` statements, three of which were
 * dropped and recreated under the same name later (0080→0113, 0057→0060).
 */
const RENAMED = [
  { table: "reviews", old: "idx_reviews_bot_id", now: "idx_reviews_app_id", columns: ["app_id"] },
  { table: "webhook_deliveries", old: "idx_webhook_deliveries_bot_created", now: "idx_webhook_deliveries_app_created", columns: ["app_id", "created_at"] },
  { table: "webhook_deliveries", old: "idx_webhook_deliveries_bot_health", now: "idx_webhook_deliveries_app_health", columns: ["app_id", null, "created_at"] },
  { table: "webhook_deliveries", old: "idx_webhook_deliveries_bot_outcome_created", now: "idx_webhook_deliveries_app_outcome_created", columns: ["app_id", "outcome", "created_at"] },
  { table: "review_targets", old: "idx_review_targets_bot_id", now: "idx_review_targets_app_id", columns: ["app_id"] },
  { table: "review_targets", old: "idx_review_targets_bot_repo", now: "idx_review_targets_app_repo", columns: ["app_id", "repo_id"] },
  { table: "review_targets", old: "idx_review_targets_bot_workspace", now: "idx_review_targets_app_workspace", columns: ["app_id", "workspace_id"] },
  { table: "review_targets", old: "idx_review_targets_bot_owner_name", now: "idx_review_targets_app_owner_name", columns: ["app_id", "repo_owner", "repo_name"] },
  { table: "review_targets", old: "review_targets_bot_repo_unique", now: "review_targets_app_repo_unique", columns: ["app_id", "repo_id"] },
  { table: "pull_requests", old: "idx_pull_requests_bot_pr", now: "idx_pull_requests_app_pr", columns: ["app_id", "owner", "repo", "pr_number"] },
  { table: "github_app_installations", old: "idx_bot_installations_installation", now: "idx_github_app_installations_installation", columns: ["installation_id"] },
  { table: "github_app_installations", old: "idx_bot_installations_bound_workspace", now: "idx_github_app_installations_bound_workspace", columns: ["app_id", "bound_workspace_id"] },
] as const;

/** Only indexes this schema created: the ten `sqlite_autoindex_*` entries are not renameable. */
function explicitIndexes(db: TestD1): Map<string, string> {
  const rows = db.raw
    .query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
    .all() as Array<{ name: string; sql: string }>;
  return new Map(rows.map((row) => [row.name, row.sql]));
}

function indexTable(db: TestD1, name: string): string | null {
  const row = db.raw
    .query("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ? AND sql IS NOT NULL")
    .get(name) as { tbl_name: string } | null;
  return row?.tbl_name ?? null;
}

function indexColumns(db: TestD1, name: string): ReadonlyArray<string | null> {
  const rows = db.raw.query(`PRAGMA index_info(${name})`).all() as Array<{ name: string | null }>;
  return rows.map((row) => row.name);
}

describe("migrations/0125_index_names_after_split.sql", () => {
  test("every renamed index lives on its table under its new name, over the same columns", () => {
    const db = createMigratedTestD1();
    const indexes = explicitIndexes(db);
    for (const { table, old, now, columns } of RENAMED) {
      expect(indexes.has(now), `${now} is missing`).toBe(true);
      expect(indexes.has(old), `${old} survived the rename`).toBe(false);
      expect(indexTable(db, now), now).toBe(table);
      expect(indexColumns(db, now), now).toEqual(columns);
    }
  });

  test("no index named after the pre-split column survives anywhere in the schema", () => {
    const db = createMigratedTestD1();
    const leftovers = [...explicitIndexes(db).keys()].filter((name) => name.toLowerCase().includes("bot"));
    expect(leftovers).toEqual([]);
  });

  test("the health index keeps 0113's four-verdict expression, 'refused' included", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/dashboard/apps-store.ts"), "utf8");
    const constant = source.match(/const DELIVERY_VERDICT_TIER_SQL = `([^`]+)`;/)?.[1];
    expect(constant).toBeDefined();
    const db = createMigratedTestD1();
    const sql = explicitIndexes(db).get("idx_webhook_deliveries_app_health")!;
    // The expression is the constant byte-for-byte; a narrower arm would keep the
    // name and column count right while silently dropping 'refused' into ELSE.
    expect(sql).toContain(`(${constant}) DESC`);
  });

  test("the owner/name index keeps COLLATE NOCASE on both name columns", () => {
    const db = createMigratedTestD1();
    const columns = db.raw
      .query("PRAGMA index_xinfo(idx_review_targets_app_owner_name)")
      .all() as Array<{ name: string | null; coll: string | null }>;
    expect(columns.filter((column) => column.name !== null).map((column) => [column.name, column.coll] as const)).toEqual([
      ["app_id", "BINARY"],
      ["repo_owner", "NOCASE"],
      ["repo_name", "NOCASE"],
    ]);
  });

  test("the repository claim stays unique and partial", () => {
    const db = createMigratedTestD1();
    const claim = (
      db.raw.query("PRAGMA index_list(review_targets)").all() as Array<{
        name: string;
        unique: number;
        partial: number;
      }>
    ).find((index) => index.name === "review_targets_app_repo_unique");
    expect(claim).toMatchObject({ unique: 1, partial: 1 });
    expect(explicitIndexes(db).get("review_targets_app_repo_unique")).toContain(
      "WHERE repo_id IS NOT NULL AND deleted_at IS NULL",
    );
  });

  test("the App-scoped target lookup uses the renamed covering index, not a scan", () => {
    const db = createMigratedTestD1();
    const plan = db.raw
      .query("EXPLAIN QUERY PLAN SELECT id FROM review_targets WHERE app_id = 'x'")
      .all() as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toMatch(/USING (COVERING )?INDEX idx_review_targets_app_(repo|id)\b/);
    expect(details).not.toContain("SCAN review_targets");
  });

  test("applies on the schema 0124 leaves, then replays", () => {
    const db = new Database(":memory:");
    applyMigration(
      db,
      migrationsAfter(0).filter((name) => migrationNumber(name) < 125),
    );
    for (let run = 0; run < 2; run++) execMigrationScript(db, SCRIPT);
    const names = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as Array<{
        name: string;
      }>).map((row) => row.name),
    );
    for (const { old, now } of RENAMED) {
      expect(names.has(now), now).toBe(true);
      expect(names.has(old), old).toBe(false);
    }
    db.close();
  });
});

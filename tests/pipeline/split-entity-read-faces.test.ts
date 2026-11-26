import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, seedBot, mapAppToDefaultWorkspace, seedTarget } from "../store/helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createTargetsStore } from "../../src/dashboard/targets-store";

/**
 * The five entity-split read faces the Task-3 conversion rewired, exercised on
 * the SPLIT schema (the migration chain fully applied): the Check gate's
 * target lookup, the publications and findings attribution queries, the
 * newer-head proof over review_checks, and the bot's sandbox write. The
 * pre-split fixture inventory cannot express this world; these tests run the
 * exact statement shapes the pipeline issues, against rows the split schema
 * accepts, so a regression of the column renames fails loudly here.
 */

const APP_ID = "app-readface";

async function seededSplitWorld() {
  const db = createMigratedTestD1();
  seedBot(db, APP_ID, 8801);
  await mapAppToDefaultWorkspace(db, APP_ID);
  seedTarget(db, APP_ID, { id: "target-readface", repoOwner: "acme", repoName: "widgets" });
  return db;
}

describe("the split-schema read faces (task 3 entity conversion)", () => {
  test("the Check gate resolves the target through review_targets.app_id", async () => {
    const db = await seededSplitWorld();
    // The exact statement shape createProcessDeps' getCheckGate issues.
    const row = db.raw
      .prepare(
        `SELECT * FROM review_targets
          WHERE app_id = ? AND repo_owner = ? COLLATE NOCASE AND repo_name = ? COLLATE NOCASE
            AND deleted_at IS NULL
          ORDER BY created_at, id LIMIT 1`,
      )
      .get(APP_ID, "acme", "widgets") as { id: string; app_id: string } | null;
    expect(row?.id).toBe("target-readface");
    expect(row?.app_id).toBe(APP_ID);
    // Case-insensitive collation keeps working on the renamed column.
    const upper = db.raw
      .prepare(
        `SELECT id FROM review_targets
          WHERE app_id = ? AND repo_owner = ? COLLATE NOCASE AND repo_name = ? COLLATE NOCASE
            AND deleted_at IS NULL LIMIT 1`,
      )
      .get(APP_ID, "ACME", "WIDGETS");
    expect(upper).not.toBeNull();
    db.raw.close();
  });

  test("the pending-publications and findings queries bind review_publications/review_findings.app_id", async () => {
    const db = await seededSplitWorld();
    db.raw.run(
      `INSERT INTO review_publications
         (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase, payload_json,
          recovery_state, lease_epoch, attempts, line_discovery_attempts, created_ms, updated_ms)
       VALUES ('pub-1', '${APP_ID}', 101, 'acme', 'widgets', 42,
               'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'review', 'confirmed', '{}', 'pending', 0, 0, 0, 1000, 1000);
       INSERT INTO review_findings
         (id, app_id, installation_id, owner, repo, pr_number, finding_id, original_json,
          first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
          first_seen_round, last_seen_round, state, reopen_count, created_ms, updated_ms, target_id)
       VALUES ('finding-1', '${APP_ID}', 101, 'acme', 'widgets', 42, 'fp-1', '{}', 'pub-1', 'pub-1',
               'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
               1, 1, 'open', 0, 1000, 1000, 'target-readface')`,
    );
    const pubs = db.raw
      .prepare(
        `SELECT id FROM review_publications
         WHERE app_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
           AND phase = 'confirmed' AND recovery_state = 'pending'
         ORDER BY created_ms, id LIMIT 10`,
      )
      .all(APP_ID, 101, "acme", "widgets", 42) as Array<{ id: string }>;
    expect(pubs.map((row) => row.id)).toEqual(["pub-1"]);
    const findings = db.raw
      .prepare(
        `SELECT id, finding_id FROM review_findings
         WHERE app_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
           AND finding_id IN (?)`,
      )
      .all(APP_ID, 101, "acme", "widgets", 42, "fp-1") as Array<{ id: string; finding_id: string }>;
    expect(findings).toEqual([{ id: "finding-1", finding_id: "fp-1" }]);
    db.raw.close();
  });

  test("the newer-head proof reads review_checks.app_id", async () => {
    const db = await seededSplitWorld();
    db.raw.run(
      `INSERT INTO review_checks
         (id, app_id, github_app_id, installation_id, owner, repo, pr_number, head_sha, triggered_by,
          action, attempt_key, generation, external_id, create_state, lease_epoch, execution_deadline_ms,
          desired, observed, recovery_state, attempts, created_ms, updated_ms)
       VALUES ('check-1', '${APP_ID}', 8801, 101, 'acme', 'widgets', 42,
               'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'pull_request', 'created', 'attempt-1', 1, 1,
               'known', 0, 2000, 'in_progress', 'in_progress', 'pending', 0, 1000, 1000)`,
    );
    const rows = db.raw
      .prepare(
        `SELECT check_run_id, triggered_by, attempt_key FROM review_checks
         WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND head_sha = ? AND terminal_ms IS NULL`,
      )
      .all(APP_ID, "acme", "widgets", 42, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") as Array<{ check_run_id: number | null; triggered_by: string; attempt_key: string }>;
    expect(rows).toEqual([{ check_run_id: null, triggered_by: "pull_request", attempt_key: "attempt-1" }]);
    db.raw.close();
  });

  test("the sandbox write targets a live review_bots row and a deleted bot refuses it", async () => {
    const db = await seededSplitWorld();
    const store = createReviewBotsStore(db);

    expect(await store.setSandboxImage(APP_ID, "omp")).toBe(true);
    expect(await store.getSandboxImageId(APP_ID)).toBe("omp");

    // An unknown or disabled registry entry writes zero rows (the fail-closed guard).
    expect(() => store.setSandboxImage(APP_ID, "no-such-image")).toThrow(/not an enabled registry entry/);

    // A soft-deleted bot is not writable and resolves no image.
    await store.softDeleteApp(APP_ID);
    const bot = db.raw.query("SELECT deleted_at FROM review_bots WHERE id = ?").get(APP_ID) as {
      deleted_at: string | null;
    };
    expect(bot.deleted_at).not.toBeNull();
    expect(await store.setSandboxImage(APP_ID, "omp")).toBe(false);
    expect(await store.getSandboxImageId(APP_ID)).toBeNull();
    // The pair died together, the invariant the migration backfills.
    const app = db.raw.query("SELECT deleted_at FROM github_apps WHERE id = ?").get(APP_ID) as {
      deleted_at: string | null;
    };
    expect(app.deleted_at).not.toBeNull();
    db.raw.close();
  });

  test("listLiveWithApp joins github_apps on app_id and reads the App's display name", async () => {
    const db = await seededSplitWorld();
    db.raw
      .prepare("UPDATE github_apps SET github_name = 'Split Bot' WHERE id = ?")
      .run(APP_ID);
    const rows = await createTargetsStore(db).listLiveWithApp("default");
    const hit = rows.find((row) => row.id === "target-readface") as { app_name: string | null } | undefined;
    expect(hit).toBeDefined();
    expect(hit!.app_name).toBe("Split Bot");
    db.raw.close();
  });
});

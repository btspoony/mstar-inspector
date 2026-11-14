/**
 * Unit tests for the bot-side face in src/dashboard/apps-store.ts: creation,
 * the user-facing delete and the cached GitHub App visibility.
 *
 * Pinned here:
 *   - the create path writes the bot, its `bot_workspaces` mapping and its ONE
 *     review target in one batch, with the target unbound and seeded from the
 *     caller's workspace floor (platform default 60 when the caller names
 *     none);
 *   - the user-facing delete stamps the bot AND its target, once, refusing to
 *     re-stamp either;
 *   - visibility round-trips and reads `unknown` for a never-probed row.
 *
 * The workspace-owned review configuration itself (trigger mode, depth, gate,
 * owner allowlist, business pause) lives on the target and is covered by
 * tests/dashboard/targets-store.test.ts.
 *
 * The fixture is the fully migrated schema (tests/store/helpers), so the
 * assertions run against the real DDL rather than a hand-built table.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1 } from "../store/helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createTargetsStore } from "../../src/dashboard/targets-store";
import { getWorkspaceCheckMinScore } from "../../src/dashboard/runtime-config-store";
import type { TestD1 } from "../store/helpers";

const WS = "default";

/** One review_bots row without the store's crypto path. */
function seedApp(
  db: TestD1,
  id: string,
  options: { githubAppId: number; deleted?: boolean },
): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
          status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', 'enc', 'acme', 'active',
               ${options.deleted ? "datetime('now')" : "NULL"}, datetime('now'), datetime('now'))`,
    )
    .run(id, options.githubAppId, id);
}

describe("review target pivot (create)", () => {
  test("creates one bot, its workspace mapping and one unbound target", async () => {
    const db = createMigratedTestD1();
    const store = createReviewBotsStore(db);

    await store.createApp({
      id: "app-created",
      githubAppId: 5010,
      githubSlug: null,
      name: "app-created",
      privateKeyEnc: "enc",
      webhookSecretEnc: "enc",
      createdBy: "acme",
      workspaceId: WS,
    });

    const targets = await createTargetsStore(db).list(WS);
    expect(targets).toHaveLength(1);
    const [target] = targets;
    expect(target!.bot_id).toBe("app-created");
    expect(target!.workspace_id).toBe(WS);
    expect(target!.installation_id).toBeNull();
    // The creation path seeds the floor; the column's own default (80) is
    // 0045's historical value and never applies to a real bot.
    expect(target!.check_min_score).toBe(60);
    expect(target!.review_trigger_mode).toBe("every_push");
    expect(target!.review_level).toBeNull();
    expect(target!.allowlist_enabled).toBe(0);
  });

  test("the target inherits the workspace floor the caller resolved", async () => {
    const db = createMigratedTestD1();
    db.raw.prepare("UPDATE workspaces SET check_min_score = 45 WHERE id = 'default'").run();
    const store = createReviewBotsStore(db);
    // The route's shape: read the workspace default, then seed the bot with it.
    const floor = await getWorkspaceCheckMinScore(db, WS);
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
      workspaceId: WS,
    });

    const [target] = await createTargetsStore(db).list(WS);
    expect(target!.check_min_score).toBe(45);
    expect(await createTargetsStore(db).getCheckGate(WS, target!.id)).toEqual({
      minScore: 45,
      passVerdicts: ["ship it"],
    });
  });
});

describe("review target pivot (delete)", () => {
  test("stamps the bot and its target, and the first delete wins on both", async () => {
    const db = createMigratedTestD1();
    const store = createReviewBotsStore(db);
    await store.createApp({
      id: "app-delete",
      githubAppId: 5020,
      githubSlug: null,
      name: "app-delete",
      privateKeyEnc: "enc",
      webhookSecretEnc: "enc",
      createdBy: "acme",
      workspaceId: WS,
    });
    const targets = createTargetsStore(db);
    const [target] = await targets.list(WS);

    expect(await store.softDeleteApp("app-delete")).toBe(true);
    expect((await store.getAppById("app-delete"))?.deleted_at).not.toBeNull();
    expect(await targets.getById(WS, target!.id)).toBeNull();

    // Idempotent: the first stamps are kept and the second call reports false.
    expect(await store.softDeleteApp("app-delete")).toBe(false);
    const stamped = db.raw
      .query("SELECT deleted_at FROM review_targets WHERE id = ?")
      .get(target!.id) as { deleted_at: string | null } | null;
    expect(stamped?.deleted_at).not.toBeNull();
  });
});

describe("GitHub App visibility (migration 0045)", () => {
  test("reads 'unknown' until probed and round-trips the stored value", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-visibility", { githubAppId: 5201 });
    const store = createReviewBotsStore(db);

    expect(await store.getGithubVisibility("app-visibility")).toBe("unknown");

    expect(await store.saveGithubVisibility("app-visibility", "public")).toBe(true);
    expect(await store.getGithubVisibility("app-visibility")).toBe("public");

    expect(await store.saveGithubVisibility("app-visibility", "private")).toBe(true);
    expect(await store.getGithubVisibility("app-visibility")).toBe("private");

    expect(await store.getGithubVisibility("unknown-app")).toBeNull();
    expect(await store.saveGithubVisibility("unknown-app", "public")).toBe(false);
  });
});

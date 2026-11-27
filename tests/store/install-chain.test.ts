import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";

const TS = "2026-10-24T00:00:00.000Z";

function seedWorkspace(db: TestD1, id: string): void {
  db.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(id, id, id, TS);
}

function seedApp(db: TestD1, appId: string): void {
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, scope, deleted_at, created_at, updated_at)
       VALUES (?, ?, 1, ?, 'k', 'w', 'tester', 'active', 'owned', NULL, ?, ?)`,
    )
    .run(appId, appId, appId, TS, TS);
}

function seedBot(db: TestD1, id: string, workspaceId: string, scope: "owned" | "shared"): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots (id, workspace_id, name, scope, multiplier, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(id, workspaceId, id, scope, TS, TS);
}

function seedInstall(db: TestD1, appId: string, workspaceId: string): void {
  db.raw
    .prepare("INSERT OR REPLACE INTO app_installations (github_app_id, workspace_id, created_at) VALUES (?, ?, ?)")
    .run(appId, workspaceId, TS);
}

function chainOf(db: TestD1, appId: string, workspaceId: string): Array<{ position: number; bot_id: string }> {
  return db.raw
    .query(
      "SELECT position, bot_id FROM app_install_bots WHERE github_app_id = ? AND workspace_id = ? ORDER BY position",
    )
    .all(appId, workspaceId) as Array<{ position: number; bot_id: string }>;
}

/** Count the batch() calls a store handle makes — the reorder's atomicity proof. */
function countingBatches(db: TestD1): { store: ReturnType<typeof createReviewBotsStore>; batches: () => number } {
  let count = 0;
  const wrapped = {
    ...db,
    async batch(statements: Parameters<TestD1["batch"]>[0]) {
      count += 1;
      return db.batch(statements);
    },
  } as TestD1;
  return { store: createReviewBotsStore(wrapped), batches: () => count };
}

describe("replaceInstallChain — the reorder's batch shape", () => {
  test("a reorder rewrites positions contiguously from 1 in ONE batch", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, "bot-a", "provider", "shared");
    seedBot(db, "bot-b", "provider", "shared");
    seedBot(db, "bot-own", "default", "owned");
    seedInstall(db, "app-1", "default");
    const { store, batches } = countingBatches(db);

    expect(
      await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: ["bot-b", "bot-own", "bot-a"] }),
    ).toBe("ok");

    expect(chainOf(db, "app-1", "default")).toEqual([
      { position: 1, bot_id: "bot-b" },
      { position: 2, bot_id: "bot-own" },
      { position: 3, bot_id: "bot-a" },
    ]);
    // ONE batch for the whole rewrite: DELETE plus one INSERT per bot.
    expect(batches()).toBe(1);
    db.raw.close();
  });

  test("a removal leaves the remaining positions contiguous — no hole", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, "bot-a", "provider", "shared");
    seedBot(db, "bot-b", "provider", "shared");
    seedBot(db, "bot-c", "provider", "shared");
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);
    await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: ["bot-a", "bot-b", "bot-c"] });

    await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: ["bot-a", "bot-c"] });

    expect(chainOf(db, "app-1", "default")).toEqual([
      { position: 1, bot_id: "bot-a" },
      { position: 2, bot_id: "bot-c" },
    ]);
    db.raw.close();
  });

  test("a workspace that is not the installer is refused and writes nothing", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedWorkspace(db, "stranger");
    seedApp(db, "app-1");
    seedBot(db, "bot-a", "provider", "shared");
    seedInstall(db, "app-1", "provider");
    const store = createReviewBotsStore(db);

    expect(
      await store.replaceInstallChain({ appId: "app-1", workspaceId: "stranger", botIds: ["bot-a"] }),
    ).toBe("not_installer");
    expect(chainOf(db, "app-1", "provider")).toEqual([]);
    db.raw.close();
  });

  test("a bot neither shared nor owned by the installer is refused and writes nothing", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedWorkspace(db, "other");
    seedApp(db, "app-1");
    seedBot(db, "bot-mine", "default", "owned");
    // Owned by a third workspace and NOT shared: unusable here.
    seedBot(db, "bot-foreign", "other", "owned");
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);

    // The availability check runs INSIDE the batch: the foreign bot inserts
    // nothing, the short count restores the previous chain, and the call refuses.
    expect(
      await store.replaceInstallChain({
        appId: "app-1",
        workspaceId: "default",
        botIds: ["bot-mine", "bot-foreign"],
      }),
    ).toBe("bot_unavailable");
    // The previous chain (empty here) is what the install still has — never the
    // half-written one this call would otherwise have left.
    expect(chainOf(db, "app-1", "default")).toEqual([]);
    db.raw.close();
  });

  /**
   * Archive stops the relay from selecting a bot, so an ARCHIVED bot is never a
   * NEW mount. A row the chain already holds is different: it stays mounted
   * (reorderable and removable) until an operator takes it out.
   */
  test("an archived bot is refused as a NEW mount, atomically", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, "bot-a", "provider", "shared");
    seedBot(db, "bot-archived", "provider", "shared");
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);
    await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: ["bot-a"] });

    db.raw.prepare("UPDATE review_bots SET archived_at = '2026-02-01T00:00:00.000Z' WHERE id = 'bot-archived'").run();
    expect(
      await store.replaceInstallChain({
        appId: "app-1",
        workspaceId: "default",
        botIds: ["bot-archived", "bot-a"],
      }),
    ).toBe("bot_unavailable");
    // The guard rolled the DELETE back with the rest: the previous chain stands.
    expect(chainOf(db, "app-1", "default")).toEqual([{ position: 1, bot_id: "bot-a" }]);
    db.raw.close();
  });

  test("a RETAINED archived row survives a reorder", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, "bot-a", "provider", "shared");
    seedBot(db, "bot-archived", "provider", "shared");
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);
    await store.replaceInstallChain({
      appId: "app-1",
      workspaceId: "default",
      botIds: ["bot-a", "bot-archived"],
    });

    // Archiving a bot an install ALREADY mounts must not silently unmount it.
    db.raw.prepare("UPDATE review_bots SET archived_at = '2026-02-01T00:00:00.000Z' WHERE id = 'bot-archived'").run();
    expect(
      await store.replaceInstallChain({
        appId: "app-1",
        workspaceId: "default",
        botIds: ["bot-archived", "bot-a"],
      }),
    ).toBe("ok");
    expect(chainOf(db, "app-1", "default")).toEqual([
      { position: 1, bot_id: "bot-archived" },
      { position: 2, bot_id: "bot-a" },
    ]);
    db.raw.close();
  });

  test("a bot that stops being shared BETWEEN the request and the batch is refused", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, "bot-a", "provider", "shared");
    seedBot(db, "bot-b", "provider", "shared");
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);
    // A chain the install already has: the restore path must bring THIS back.
    await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: ["bot-a"] });

    // The race: the caller has read the chain and chosen bot-b, but the owner
    // unshares it before the batch runs. A pre-batch availability read would have
    // admitted it; the guarded INSERT must not.
    const racing = {
      ...db,
      async batch(statements: Parameters<TestD1["batch"]>[0]) {
        db.raw.prepare("UPDATE review_bots SET scope = 'owned' WHERE id = 'bot-b'").run();
        return db.batch(statements);
      },
    } as TestD1;
    expect(
      await createReviewBotsStore(racing).replaceInstallChain({
        appId: "app-1",
        workspaceId: "default",
        botIds: ["bot-b", "bot-a"],
      }),
    ).toBe("bot_unavailable");
    // The previous chain survived intact — never the half-written one.
    expect(chainOf(db, "app-1", "default")).toEqual([{ position: 1, bot_id: "bot-a" }]);
    db.raw.close();
  });

  test("an unshare between the request and the batch leaves the chain BYTE-IDENTICAL", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, "bot-a", "provider", "shared");
    seedBot(db, "bot-b", "provider", "shared");
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);
    await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: ["bot-a"] });
    const before = chainOf(db, "app-1", "default");

    // bot-b is NEW to the chain and goes unavailable just before the batch runs.
    const racing = {
      ...db,
      async batch(statements: Parameters<TestD1["batch"]>[0]) {
        db.raw.prepare("UPDATE review_bots SET scope = 'owned' WHERE id = 'bot-b'").run();
        return db.batch(statements);
      },
    } as TestD1;
    expect(
      await createReviewBotsStore(racing).replaceInstallChain({
        appId: "app-1",
        workspaceId: "default",
        botIds: ["bot-a", "bot-b"],
      }),
    ).toBe("bot_unavailable");

    // The guard rolled the DELETE back with the skipped insert: nothing moved.
    expect(chainOf(db, "app-1", "default")).toEqual(before);
    expect(before).toEqual([{ position: 1, bot_id: "bot-a" }]);
    db.raw.close();
  });

  test("a concurrent successful edit is never deleted by this call", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, "bot-a", "provider", "shared");
    seedBot(db, "bot-b", "provider", "shared");
    seedBot(db, "bot-c", "provider", "shared");
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);
    await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: ["bot-a"] });

    // Another operator reorders first, and this call then loses a bot in the same
    // window. The failed batch must roll back; nothing restores a stale snapshot
    // over the winner.
    const racing = {
      ...db,
      async batch(statements: Parameters<TestD1["batch"]>[0]) {
        if (!(await db.raw.query("SELECT 1 AS n FROM app_install_bots WHERE bot_id = 'bot-c'").get())) {
          db.raw.run("DELETE FROM app_install_bots");
          db.raw.prepare("INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id) VALUES ('app-1','default',1,'bot-b')").run();
          db.raw.prepare("UPDATE review_bots SET scope = 'owned' WHERE id = 'bot-c'").run();
        }
        return db.batch(statements);
      },
    } as TestD1;
    expect(
      await createReviewBotsStore(racing).replaceInstallChain({
        appId: "app-1",
        workspaceId: "default",
        botIds: ["bot-a", "bot-c"],
      }),
    ).toBe("bot_unavailable");

    // The OTHER operator's chain stands.
    expect(chainOf(db, "app-1", "default")).toEqual([{ position: 1, bot_id: "bot-b" }]);
    db.raw.close();
  });

  test("a retained unshared row survives a rewrite; only a NEW id must be mountable", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, "bot-a", "provider", "shared");
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);
    await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: ["bot-a"] });
    // Its owner stops sharing it: the row stays mounted as a skipped row.
    db.raw.prepare("UPDATE review_bots SET scope = 'owned' WHERE id = 'bot-a'").run();
    seedBot(db, "bot-new", "provider", "shared");

    // Keeping bot-a AND adding a mountable bot succeeds.
    expect(
      await store.replaceInstallChain({
        appId: "app-1",
        workspaceId: "default",
        botIds: ["bot-a", "bot-new"],
      }),
    ).toBe("ok");
    expect(chainOf(db, "app-1", "default")).toEqual([
      { position: 1, bot_id: "bot-a" },
      { position: 2, bot_id: "bot-new" },
    ]);
    db.raw.close();
  });

  test("the chain the relay reads is the chain the editor wrote", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, "bot-a", "provider", "shared");
    seedBot(db, "bot-own", "default", "owned");
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);

    await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: ["bot-own", "bot-a"] });

    // `listInstallChainBots` is what `readChain`/`selectReviewBot` build on, so
    // this asserts the read side sees the write side's order.
    const chains = await store.listInstallChainBots("default");
    expect(chains.get("app-1")?.map((bot) => bot.botId)).toEqual(["bot-own", "bot-a"]);
    db.raw.close();
  });
});

describe("setBotQuotaOverride — the writer bot_quota_overrides was missing", () => {
  function world() {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedWorkspace(db, "tenant");
    seedApp(db, "app-1");
    seedBot(db, "bot-shared", "provider", "shared");
    seedInstall(db, "app-1", "provider");
    return db;
  }

  function overrides(db: TestD1, botId: string): Array<{ workspaceId: string; monthlyRp: number }> {
    return db.raw
      .query("SELECT workspace_id AS workspaceId, monthly_rp AS monthlyRp FROM bot_quota_overrides WHERE bot_id = ? ORDER BY workspace_id")
      .all(botId) as Array<{ workspaceId: string; monthlyRp: number }>;
  }

  test("the owner sets a per-workspace ceiling and the relay read sees it", async () => {
    const db = world();
    const store = createReviewBotsStore(db);
    expect(
      await store.setBotQuotaOverride({
        botId: "bot-shared",
        workspaceId: "tenant",
        ownerWorkspaceId: "provider",
        monthlyRp: 500,
        now: TS,
      }),
    ).toBe("ok");
    expect(overrides(db, "bot-shared")).toEqual([{ workspaceId: "tenant", monthlyRp: 500 }]);
    db.raw.close();
  });

  test("setting again replaces the value rather than duplicating the row", async () => {
    const db = world();
    const store = createReviewBotsStore(db);
    for (const rp of [500, 750]) {
      await store.setBotQuotaOverride({
        botId: "bot-shared",
        workspaceId: "tenant",
        ownerWorkspaceId: "provider",
        monthlyRp: rp,
        now: TS,
      });
    }
    expect(overrides(db, "bot-shared")).toEqual([{ workspaceId: "tenant", monthlyRp: 750 }]);
    db.raw.close();
  });

  test("null clears the override, returning the workspace to the bot's default", async () => {
    const db = world();
    const store = createReviewBotsStore(db);
    await store.setBotQuotaOverride({
      botId: "bot-shared",
      workspaceId: "tenant",
      ownerWorkspaceId: "provider",
      monthlyRp: 500,
      now: TS,
    });
    await store.setBotQuotaOverride({
      botId: "bot-shared",
      workspaceId: "tenant",
      ownerWorkspaceId: "provider",
      monthlyRp: null,
      now: TS,
    });
    expect(overrides(db, "bot-shared")).toEqual([]);
    db.raw.close();
  });

  test("a non-owner cannot write, and zero or a fraction is refused", async () => {
    const db = world();
    const store = createReviewBotsStore(db);
    expect(
      await store.setBotQuotaOverride({
        botId: "bot-shared",
        workspaceId: "tenant",
        ownerWorkspaceId: "tenant",
        monthlyRp: 500,
        now: TS,
      }),
    ).toBe("not_owner");
    for (const bad of [0, -5, 1.5]) {
      expect(
        await store.setBotQuotaOverride({
          botId: "bot-shared",
          workspaceId: "tenant",
          ownerWorkspaceId: "provider",
          monthlyRp: bad,
          now: TS,
        }),
      ).toBe("invalid");
    }
    expect(overrides(db, "bot-shared")).toEqual([]);
    db.raw.close();
  });
});

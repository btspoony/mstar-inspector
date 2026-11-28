import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { isServedChainProduct } from "../../src/contracts/rp-limits";

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

/**
 * A NEW mount may not push the chain's product past `CHAIN_MULTIPLIER_MAX` — the
 * most a storable ceiling can cover. That is a WRITE bound: the reader accepts
 * any positive finite product, because a legal price edit or a sub-1 removal
 * creates one without any write this guard sees. The refusal must leave the
 * previous chain byte-identical.
 */
describe("replaceInstallChain — a new mount stays inside the write bound", () => {
  function seedBotWithMultiplier(db: TestD1, id: string, multiplier: number): void {
    db.raw
      .prepare(
        `INSERT INTO review_bots (id, workspace_id, name, scope, multiplier, created_at, updated_at)
         VALUES (?, 'provider', ?, 'shared', ?, ?, ?)`,
      )
      .run(id, id, multiplier, TS, TS);
  }

  test("a chain whose product exceeds the bound is refused, and the old chain stands", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBotWithMultiplier(db, "bot-1000a", 1000);
    seedBotWithMultiplier(db, "bot-1000b", 1000);
    seedBotWithMultiplier(db, "bot-4", 4);
    seedBot(db, "bot-solo", "provider", "shared");
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);
    await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: ["bot-solo"] });

    // Every factor is inside the single-bot write bound (1000).
    // 1000 × 1000 × 4 = 4,000,000 > CHAIN_MULTIPLIER_MAX (3,333,333).
    expect(
      await store.replaceInstallChain({
        appId: "app-1",
        workspaceId: "default",
        botIds: ["bot-1000a", "bot-1000b", "bot-4"],
      }),
    ).toBe("chain_too_large");
    expect(chainOf(db, "app-1", "default")).toEqual([{ position: 1, bot_id: "bot-solo" }]);
    db.raw.close();
  });

  test("a chain of legally-writable bots near the bound is accepted, and the served product parses", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    // 1000 × 1000 × 3 = 3,000,000 < CHAIN_MULTIPLIER_MAX, and each factor is a
    // value `isBotMultiplier` admits, so a real operator can write this chain.
    seedBotWithMultiplier(db, "bot-1000a", 1000);
    seedBotWithMultiplier(db, "bot-1000b", 1000);
    seedBotWithMultiplier(db, "bot-3", 3);
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);

    expect(
      await store.replaceInstallChain({
        appId: "app-1",
        workspaceId: "default",
        botIds: ["bot-1000a", "bot-1000b", "bot-3"],
      }),
    ).toBe("ok");
    const chain = (await store.listInstallChainBots("default")).get("app-1") ?? [];
    const product = chain.reduce((total, bot) => total * bot.multiplier, 1);
    expect(product).toBe(3_000_000);
    expect(isServedChainProduct(product)).toBe(true);
    db.raw.close();
  });

  /**
   * A chain written before this bound existed can already be past it. The
   * operator's only repair is to REMOVE from it, and that rewrite mounts no new
   * id, so it is admitted — refusing it would strand the oversize chain on a
   * page no parser accepts.
   */
  test("an oversize chain is still repairable by removing from it", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBotWithMultiplier(db, "bot-1000a", 1000);
    seedBotWithMultiplier(db, "bot-1000b", 1000);
    seedBotWithMultiplier(db, "bot-4", 4);
    seedInstall(db, "app-1", "default");
    // A legacy chain written before the write bound: 4,000,000.
    const legacy = ["bot-1000a", "bot-1000b", "bot-4"];
    legacy.forEach((botId, index) => {
      db.raw
        .prepare("INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id) VALUES ('app-1', 'default', ?, ?)")
        .run(index + 1, botId);
    });
    const store = createReviewBotsStore(db);

    expect(
      await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: ["bot-4"] }),
    ).toBe("ok");
    expect(chainOf(db, "app-1", "default")).toEqual([{ position: 1, bot_id: "bot-4" }]);
    db.raw.close();
  });

  /**
   * The floor's other half: each factor was writable under the OLD predicate
   * (`> 0`, no floor), and two of them multiply to `0` in a double. The served
   * `month.multiplier` would be `0`, which `isServedChainProduct` refuses, so the
   * store must refuse the mount — and, like the ceiling case, leave the old
   * chain standing.
   */
  test("a chain whose product underflows to zero is refused, and the old chain stands", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    // Below today's floor, so refused at the writer now — but reachable from a
    // row written before it existed, which is exactly the state to repair.
    seedBotWithMultiplier(db, "bot-tiny-a", 1e-200);
    seedBotWithMultiplier(db, "bot-tiny-b", 1e-200);
    seedBot(db, "bot-solo", "provider", "shared");
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);
    await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: ["bot-solo"] });

    // 1e-200 × 1e-200 === 0 in IEEE-754 doubles.
    expect(1e-200 * 1e-200).toBe(0);
    expect(
      await store.replaceInstallChain({
        appId: "app-1",
        workspaceId: "default",
        botIds: ["bot-tiny-a", "bot-tiny-b"],
      }),
    ).toBe("chain_too_large");
    expect(chainOf(db, "app-1", "default")).toEqual([{ position: 1, bot_id: "bot-solo" }]);
    db.raw.close();
  });

  /**
   * A single below-floor row is NOT a broken chain: its product is still
   * positive, so the list parses and `rpFor` prices it at its 1-RP floor. This
   * is why the floor lives on the writers and not on the chain reader.
   */
  test("one legacy below-floor bot mounts alone, and its product is the served value", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBotWithMultiplier(db, "bot-tiny", 1e-200);
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);

    expect(
      await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: ["bot-tiny"] }),
    ).toBe("ok");
    const chain = (await store.listInstallChainBots("default")).get("app-1") ?? [];
    expect(isServedChainProduct(chain.reduce((product, bot) => product * bot.multiplier, 1))).toBe(true);
    db.raw.close();
  });

  /**
   * A retained row whose bot the reader may no longer price must count as `1`
   * in the guard, exactly as the read projection serves it. Otherwise the
   * foreign owner's private multiplier decides whether THIS workspace's mount is
   * admitted — a refusal that changes with a number the row masks is that number
   * disclosed.
   */
  test("a hidden foreign multiplier does not change the mount decision", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBotWithMultiplier(db, "bot-1000a", 1000);
    seedBotWithMultiplier(db, "bot-1000b", 1000);
    seedBot(db, "bot-solo", "provider", "shared");
    seedBot(db, "bot-foreign", "provider", "shared");
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);
    // Mount the foreign bot while it is still shared, then have its owner stop
    // sharing it: the row is RETAINED, and from here its price is invisible here.
    const baseline = ["bot-solo", "bot-foreign"];
    await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: baseline });
    db.raw.run("UPDATE review_bots SET scope = 'owned' WHERE id = 'bot-foreign'");
    const candidate = [...baseline, "bot-1000a", "bot-1000b"];

    // Both scenarios start from the SAME chain and each mounts the two 1000×
    // factors once — the candidate ids are NEW in both runs, so the price guard
    // actually evaluates the product. Reusing the first run's chain would leave
    // no new id and skip the guard entirely, which is not the rule under test.
    // The visible product is 1,000,000, inside the bound; the foreign row is a
    // `1`. Reading its hidden price would give 10^9 (refused) at one value and
    // 11,000 (admitted) at the other, so a matching pair of decisions is proof.
    const decisions: string[] = [];
    for (const hidden of [1000, 0.01]) {
      db.raw.prepare("UPDATE review_bots SET multiplier = ? WHERE id = 'bot-foreign'").run(hidden);
      // A removal mounts no new id, so it is always admitted — the reset itself
      // never depends on the number the case is about.
      await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: baseline });
      decisions.push(
        await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: candidate }),
      );
    }
    expect(decisions).toEqual(["ok", "ok"]);
    db.raw.close();
  });

  /**
   * The served factor counts what the relay RUNS, so an archived row is a `1`
   * there — and must be a `1` in the guard too, or a retired bot's price vetoes a
   * mount the reader never prices it in.
   */
  test("an archived row does not gate a new mount", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, "bot-x", "provider", "shared");
    seedBot(db, "bot-y", "provider", "shared");
    seedBot(db, "bot-w", "provider", "shared");
    seedBot(db, "bot-z", "provider", "shared");
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);
    // Retire `bot-z` WHILE it is live (a new mount may not be archived), then
    // price it high: a retained ARCHIVED row, exactly the state served as ×1.
    await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: ["bot-z"] });
    db.raw.prepare("UPDATE review_bots SET archived_at = ? WHERE id = 'bot-z'").run(TS);
    db.raw.run("UPDATE review_bots SET multiplier = 1000 WHERE id IN ('bot-z', 'bot-x', 'bot-y')");
    db.raw.run("UPDATE review_bots SET multiplier = 3 WHERE id = 'bot-w'");
    await store.replaceInstallChain({
      appId: "app-1",
      workspaceId: "default",
      botIds: ["bot-z", "bot-x", "bot-y"],
    });

    // The visible product is 1000 × 1000 × 3 = 3,000,000, inside the bound.
    // Counting the archived 1000 as well would make 3 × 10^9 and refuse.
    expect(
      await store.replaceInstallChain({
        appId: "app-1",
        workspaceId: "default",
        botIds: ["bot-z", "bot-x", "bot-y", "bot-w"],
      }),
    ).toBe("ok");
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

  test("an archive between the read and the write changes zero rows and reports archived", async () => {
    const db = world();
    let fired = false;
    // The seam: this request already read the bot as live. The archive lands
    // immediately before the mutation statement executes.
    const racing = {
      ...db,
      prepare(query: string) {
        if (!fired && /(INSERT INTO|DELETE FROM) bot_quota_overrides/.test(query)) {
          fired = true;
          db.raw.prepare("UPDATE review_bots SET archived_at = ? WHERE id = 'bot-shared'").run(TS);
        }
        return db.prepare(query);
      },
    } as TestD1;

    expect(
      await createReviewBotsStore(racing).setBotQuotaOverride({
        botId: "bot-shared",
        workspaceId: "tenant",
        ownerWorkspaceId: "provider",
        monthlyRp: 500,
        now: TS,
      }),
    ).toBe("archived");
    expect(fired).toBe(true);
    expect(overrides(db, "bot-shared")).toEqual([]);
    db.raw.close();
  });

  test("an archive the write's own batch saw reports archived even if the bot is restored before the call returns", async () => {
    const db = world();
    let fired = false;
    // The archive lands INSIDE the batch and the restore lands before it
    // returns: a read after the write would find a LIVE bot and report `ok`
    // for an override that was never written.
    const racing = {
      ...db,
      prepare: (query: string) => db.prepare(query),
      batch: async (statements: Parameters<TestD1["batch"]>[0]) => {
        if (!fired) {
          fired = true;
          db.raw.prepare("UPDATE review_bots SET archived_at = ? WHERE id = 'bot-shared'").run(TS);
        }
        const results = await db.batch(statements);
        db.raw.prepare("UPDATE review_bots SET archived_at = NULL WHERE id = 'bot-shared'").run();
        return results;
      },
    } as TestD1;

    expect(
      await createReviewBotsStore(racing).setBotQuotaOverride({
        botId: "bot-shared",
        workspaceId: "tenant",
        ownerWorkspaceId: "provider",
        monthlyRp: 500,
        now: TS,
      }),
    ).toBe("archived");
    expect(fired).toBe(true);
    expect(overrides(db, "bot-shared")).toEqual([]);
    db.raw.close();
  });

  test("a clear between the read and an archive writes nothing and reports archived", async () => {
    const db = world();
    const store = createReviewBotsStore(db);
    await store.setBotQuotaOverride({
      botId: "bot-shared",
      workspaceId: "tenant",
      ownerWorkspaceId: "provider",
      monthlyRp: 500,
      now: TS,
    });
    let fired = false;
    const racing = {
      ...db,
      prepare(query: string) {
        if (!fired && /DELETE FROM bot_quota_overrides/.test(query)) {
          fired = true;
          db.raw.prepare("UPDATE review_bots SET archived_at = ? WHERE id = 'bot-shared'").run(TS);
        }
        return db.prepare(query);
      },
    } as TestD1;

    expect(
      await createReviewBotsStore(racing).setBotQuotaOverride({
        botId: "bot-shared",
        workspaceId: "tenant",
        ownerWorkspaceId: "provider",
        monthlyRp: null,
        now: TS,
      }),
    ).toBe("archived");
    expect(overrides(db, "bot-shared")).toEqual([{ workspaceId: "tenant", monthlyRp: 500 }]);
    db.raw.close();
  });

  test("a bot deleted inside the batch reports not_owner, not archived", async () => {
    const db = world();
    let fired = false;
    const racing = {
      ...db,
      prepare: (query: string) => db.prepare(query),
      batch: async (statements: Parameters<TestD1["batch"]>[0]) => {
        if (!fired) {
          fired = true;
          // Deleted after the owner read: the probe's `present` column is the
          // only witness that this is an absent target, not a locked one.
          db.raw.prepare("UPDATE review_bots SET deleted_at = ? WHERE id = 'bot-shared'").run(TS);
        }
        return db.batch(statements);
      },
    } as TestD1;

    expect(
      await createReviewBotsStore(racing).setBotQuotaOverride({
        botId: "bot-shared",
        workspaceId: "tenant",
        ownerWorkspaceId: "provider",
        monthlyRp: 500,
        now: TS,
      }),
    ).toBe("not_owner");
    expect(fired).toBe(true);
    expect(overrides(db, "bot-shared")).toEqual([]);
    db.raw.close();
  });

  test("an archive restored before the batch runs lets the write succeed", async () => {
    const db = world();
    let fired = false;
    // Archive and restore both land before the statements run: the probe and
    // the write see one live target, so the override IS stored.
    const restoredFirst = {
      ...db,
      prepare: (query: string) => db.prepare(query),
      batch: async (statements: Parameters<TestD1["batch"]>[0]) => {
        if (!fired) {
          fired = true;
          db.raw.prepare("UPDATE review_bots SET archived_at = ? WHERE id = 'bot-shared'").run(TS);
          db.raw.prepare("UPDATE review_bots SET archived_at = NULL WHERE id = 'bot-shared'").run();
        }
        return db.batch(statements);
      },
    } as TestD1;

    expect(
      await createReviewBotsStore(restoredFirst).setBotQuotaOverride({
        botId: "bot-shared",
        workspaceId: "tenant",
        ownerWorkspaceId: "provider",
        monthlyRp: 500,
        now: TS,
      }),
    ).toBe("ok");
    expect(fired).toBe(true);
    expect(overrides(db, "bot-shared")).toEqual([{ workspaceId: "tenant", monthlyRp: 500 }]);
    db.raw.close();
  });
});

describe("replaceInstallChain — an archive between the request and the batch", () => {
  /**
   * The retained set is decided INSIDE the batch, so a bot another request
   * removed and archived in the same window is neither retained nor mountable:
   * it is a NEW id by then, the admission guard refuses it, and the whole batch
   * — including the DELETE — rolls back.
   */
  test("a bot removed and archived before the batch cannot be re-mounted from a stale payload", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, "bot-a", "provider", "shared");
    seedBot(db, "bot-kept", "provider", "shared");
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);
    await store.replaceInstallChain({
      appId: "app-1",
      workspaceId: "default",
      botIds: ["bot-a", "bot-kept"],
    });
    const before = chainOf(db, "app-1", "default");

    // The competing request: unmount bot-a and archive it, both landing after
    // this call read the chain and before its batch runs.
    const racing = {
      ...db,
      async batch(statements: Parameters<TestD1["batch"]>[0]) {
        db.raw.prepare("DELETE FROM app_install_bots WHERE bot_id = 'bot-a'").run();
        db.raw.prepare("UPDATE review_bots SET archived_at = ? WHERE id = 'bot-a'").run(TS);
        return db.batch(statements);
      },
    } as TestD1;

    // This request still names bot-a FIRST: its payload says it was retained.
    expect(
      await createReviewBotsStore(racing).replaceInstallChain({
        appId: "app-1",
        workspaceId: "default",
        botIds: ["bot-a", "bot-kept"],
      }),
    ).toBe("bot_unavailable");
    // The competitor's chain stands, exactly as it left it — no archived bot was
    // mounted back, and this refused batch restored nothing over it.
    expect(chainOf(db, "app-1", "default")).toEqual([{ position: 2, bot_id: "bot-kept" }]);
    expect(before).toEqual([
      { position: 1, bot_id: "bot-a" },
      { position: 2, bot_id: "bot-kept" },
    ]);
    db.raw.close();
  });

  test("a bot archived but STILL mounted stays retained through the same batch", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, "bot-a", "provider", "shared");
    seedInstall(db, "app-1", "default");
    const store = createReviewBotsStore(db);
    await store.replaceInstallChain({ appId: "app-1", workspaceId: "default", botIds: ["bot-a"] });

    const racing = {
      ...db,
      async batch(statements: Parameters<TestD1["batch"]>[0]) {
        db.raw.prepare("UPDATE review_bots SET archived_at = ? WHERE id = 'bot-a'").run(TS);
        return db.batch(statements);
      },
    } as TestD1;

    // Still in the OLD chain when the guard statement reads it: retained.
    expect(
      await createReviewBotsStore(racing).replaceInstallChain({
        appId: "app-1",
        workspaceId: "default",
        botIds: ["bot-a"],
      }),
    ).toBe("ok");
    expect(chainOf(db, "app-1", "default")).toEqual([{ position: 1, bot_id: "bot-a" }]);
    db.raw.close();
  });
});

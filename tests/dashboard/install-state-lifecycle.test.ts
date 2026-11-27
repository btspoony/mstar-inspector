import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";

// The install-state lifecycle: the two writers (`createApp`, `bindInstallation`)
// and the removal sweep. The App owner's chain on an App is what the App
// brings, so a first bind copies its usable rows; nothing rewrites a chain that
// already exists, and losing one of several installations retires nothing.

const OWNER = "default";
const CONSUMER = "ws-consumer";
const OTHER = "ws-other";
const TS = "2026-01-01T00:00:00.000Z";

function seedWorkspace(db: TestD1, id: string): void {
  db.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(id, id, id, TS);
}

let nextGithubAppId = 8100;

/** One App row plus its bot and ownership row — the split's pair, no install state. */
function seedApp(
  db: TestD1,
  id: string,
  opts: { workspaceId?: string; scope?: "owned" | "shared"; name?: string } = {},
): void {
  nextGithubAppId += 1;
  const workspaceId = opts.workspaceId ?? OWNER;
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
          status, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', 'enc', 'fixture', 'active', ?, ?)`,
    )
    .run(id, nextGithubAppId, opts.name ?? id, TS, TS);
  db.raw
    .prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)")
    .run(id, workspaceId);
  db.raw
    .prepare(
      `INSERT INTO review_bots (id, workspace_id, name, scope, multiplier, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(id, workspaceId, opts.name ?? id, opts.scope ?? "owned", TS, TS);
}

/** A physical installation of an App; `bound` is the workspace its bind proved. */
function seedInstallation(
  db: TestD1,
  row: { appId: string; installationId: number; bound: string | null; removed?: boolean },
): void {
  db.raw
    .prepare(
      `INSERT INTO github_app_installations
         (id, app_id, installation_id, account_login, seen_at, removed_at, bound_workspace_id)
       VALUES (?, ?, ?, 'acme', ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      row.appId,
      row.installationId,
      TS,
      row.removed ? "2026-02-01T00:00:00.000Z" : null,
      row.bound,
    );
}

function states(db: TestD1): Array<{ github_app_id: string; workspace_id: string }> {
  return db.raw
    .query("SELECT github_app_id, workspace_id FROM app_installations ORDER BY github_app_id, workspace_id")
    .all() as Array<{ github_app_id: string; workspace_id: string }>;
}

function chain(db: TestD1): Array<{ github_app_id: string; workspace_id: string; position: number; bot_id: string }> {
  return db.raw
    .query(
      `SELECT github_app_id, workspace_id, position, bot_id FROM app_install_bots
        ORDER BY github_app_id, workspace_id, position`,
    )
    .all() as Array<{ github_app_id: string; workspace_id: string; position: number; bot_id: string }>;
}

function count(db: TestD1, table: string, where = ""): number {
  return (db.raw.query(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n;
}

describe("createApp writes the owner's install state and its first chain row", () => {
  test("one state at zero installations and one chain row at position 1 naming the created bot", async () => {
    const db = createMigratedTestD1();
    const store = createReviewBotsStore(db);

    await store.createApp({
      id: "app-new",
      githubAppId: 9001,
      githubSlug: null,
      name: "app-new",
      privateKeyEnc: "enc",
      webhookSecretEnc: "enc",
      createdBy: "acme",
      workspaceId: OWNER,
      maxApps: null,
    });

    expect(states(db)).toEqual([{ github_app_id: "app-new", workspace_id: OWNER }]);
    expect(chain(db)).toEqual([
      { github_app_id: "app-new", workspace_id: OWNER, position: 1, bot_id: "app-new" },
    ]);
    // An install state is not a physical installation: the App has none yet.
    expect(count(db, "github_app_installations", "WHERE app_id = 'app-new'")).toBe(0);
    db.raw.close();
  });

  test("a refused creation (cap reached) writes no state and no chain row", async () => {
    const db = createMigratedTestD1();
    const store = createReviewBotsStore(db);
    await store.createApp({
      id: "app-first",
      githubAppId: 9002,
      githubSlug: null,
      name: "app-first",
      privateKeyEnc: "enc",
      webhookSecretEnc: "enc",
      createdBy: "acme",
      workspaceId: OWNER,
      maxApps: null,
    });

    await expect(
      store.createApp({
        id: "app-over-cap",
        githubAppId: 9003,
        githubSlug: null,
        name: "app-over-cap",
        privateKeyEnc: "enc",
        webhookSecretEnc: "enc",
        createdBy: "acme",
        workspaceId: OWNER,
        maxApps: 1,
      }),
    ).rejects.toThrow(/createApp refused/);

    expect(states(db)).toEqual([{ github_app_id: "app-first", workspace_id: OWNER }]);
    expect(chain(db).map((row) => row.github_app_id)).toEqual(["app-first"]);
    db.raw.close();
  });
});

describe("bindInstallation writes the install state and copies the owner's chain", () => {
  /**
   * An App owned by `owner`, shared, whose owner chain holds a shared bot and
   * an owned bot — the two rows a consumer may mount — plus a third row the
   * consumer may not (a bot owned by someone else and not shared).
   */
  function bindWorld(): TestD1 {
    const db = createMigratedTestD1();
    seedWorkspace(db, CONSUMER);
    seedWorkspace(db, OTHER);
    seedApp(db, "app-shared", { workspaceId: OWNER, scope: "shared" });
    seedApp(db, "bot-shared", { workspaceId: OTHER, scope: "shared" });
    seedApp(db, "bot-private", { workspaceId: OTHER, scope: "owned" });
    // The App owner's chain on its own App: positions 1..3.
    db.raw.run(
      `INSERT INTO app_installations (github_app_id, workspace_id, created_at)
         VALUES ('app-shared', '${OWNER}', '${TS}');
       INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
         VALUES ('app-shared', '${OWNER}', 1, 'app-shared'),
                ('app-shared', '${OWNER}', 2, 'bot-shared'),
                ('app-shared', '${OWNER}', 3, 'bot-private');`,
    );
    seedInstallation(db, { appId: "app-shared", installationId: 501, bound: null });
    return db;
  }

  test("a first bind creates exactly one state and copies the rows the consumer may mount", async () => {
    const db = bindWorld();

    expect(await createReviewBotsStore(db).bindInstallation("app-shared", 501, CONSUMER)).toBe("bound");

    expect(states(db)).toEqual([
      { github_app_id: "app-shared", workspace_id: OWNER },
      { github_app_id: "app-shared", workspace_id: CONSUMER },
    ]);
    // The owner's chain on this App holds a shared bot at 1 and 2 and a bot
    // owned by another workspace at 3; only the shared rows cross, and their
    // positions are the owner's own — never renumbered.
    expect(chain(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([
      { github_app_id: "app-shared", workspace_id: CONSUMER, position: 1, bot_id: "app-shared" },
      { github_app_id: "app-shared", workspace_id: CONSUMER, position: 2, bot_id: "bot-shared" },
    ]);
    db.raw.close();
  });

  test("a second bind of the same App neither rewrites the state nor appends a position-1 row", async () => {
    const db = bindWorld();
    const store = createReviewBotsStore(db);
    seedInstallation(db, { appId: "app-shared", installationId: 502, bound: null });

    await store.bindInstallation("app-shared", 501, CONSUMER);
    const afterFirst = { states: states(db), chain: chain(db) };
    expect(await store.bindInstallation("app-shared", 502, CONSUMER)).toBe("bound");

    // The fixed point: the state row is the same one, and the chain is
    // byte-identical — in particular no SECOND row at position 1.
    expect({ states: states(db), chain: chain(db) }).toEqual(afterFirst);
    expect(count(db, "app_install_bots", `WHERE workspace_id = '${CONSUMER}' AND position = 1`)).toBe(1);
    // The second installation did bind, though: only the aggregate was left alone.
    expect(
      db.raw
        .query(
          `SELECT installation_id FROM github_app_installations
            WHERE app_id = 'app-shared' AND bound_workspace_id = '${CONSUMER}'
            ORDER BY installation_id`,
        )
        .all(),
    ).toEqual([{ installation_id: 501 }, { installation_id: 502 }]);
    db.raw.close();
  });

  test("a chain with no usable owner row is created empty", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, CONSUMER);
    seedWorkspace(db, OTHER);
    seedApp(db, "app-bare", { workspaceId: OWNER, scope: "shared" });
    seedApp(db, "bot-private", { workspaceId: OTHER, scope: "owned" });
    db.raw.run(
      `INSERT INTO app_installations (github_app_id, workspace_id, created_at)
         VALUES ('app-bare', '${OWNER}', '${TS}');
       INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
         VALUES ('app-bare', '${OWNER}', 1, 'bot-private');`,
    );
    seedInstallation(db, { appId: "app-bare", installationId: 601, bound: null });

    await createReviewBotsStore(db).bindInstallation("app-bare", 601, CONSUMER);

    expect(states(db)).toContainEqual({ github_app_id: "app-bare", workspace_id: CONSUMER });
    expect(chain(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([]);
    // The empty chain is what the refusal (D41) reports, never a silent bot.
    db.raw.close();
  });

  test("a refused bind (already bound elsewhere) writes no state", async () => {
    const db = bindWorld();
    seedInstallation(db, { appId: "app-shared", installationId: 502, bound: OTHER });

    expect(await createReviewBotsStore(db).bindInstallation("app-shared", 502, CONSUMER)).toBe("bound_elsewhere");

    expect(states(db)).toEqual([{ github_app_id: "app-shared", workspace_id: OWNER }]);
    db.raw.close();
  });
});

describe("uninstall removes the aggregate only when the App is no longer installed", () => {
  /**
   * A consumer with two bound installations of a shared App it does not own,
   * plus that App owner's own chain — what a reinstall would copy.
   */
  function uninstallWorld(): TestD1 {
    const db = createMigratedTestD1();
    seedWorkspace(db, CONSUMER);
    seedWorkspace(db, OTHER);
    seedApp(db, "app-shared", { workspaceId: OTHER, scope: "shared" });
    db.raw.run(
      `INSERT INTO app_installations (github_app_id, workspace_id, created_at)
         VALUES ('app-shared', '${OTHER}', '${TS}'),
                ('app-shared', '${CONSUMER}', '${TS}');
       INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
         VALUES ('app-shared', '${OTHER}', 1, 'app-shared'),
                ('app-shared', '${CONSUMER}', 1, 'app-shared');`,
    );
    seedInstallation(db, { appId: "app-shared", installationId: 701, bound: CONSUMER });
    seedInstallation(db, { appId: "app-shared", installationId: 702, bound: CONSUMER });
    return db;
  }

  test("losing one of two installations keeps the state and its chain", async () => {
    const db = uninstallWorld();
    await createReviewBotsStore(db).markInstallationRemoved("app-shared", 701);

    expect(states(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([
      { github_app_id: "app-shared", workspace_id: CONSUMER },
    ]);
    expect(chain(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([
      { github_app_id: "app-shared", workspace_id: CONSUMER, position: 1, bot_id: "app-shared" },
    ]);
    // The installation row survives with its removal stamp; the bot never dies.
    expect(count(db, "github_app_installations", "WHERE app_id = 'app-shared'")).toBe(2);
    expect(count(db, "review_bots", "WHERE id = 'app-shared'")).toBe(1);
    db.raw.close();
  });

  test("losing the last installation removes the state and its chain, and touches nothing else", async () => {
    const db = uninstallWorld();
    const store = createReviewBotsStore(db);
    await store.markInstallationRemoved("app-shared", 701);
    await store.markInstallationRemoved("app-shared", 702);

    // The consumer's aggregate is gone; the OWNER's state and chain stand.
    expect(states(db)).toEqual([{ github_app_id: "app-shared", workspace_id: OTHER }]);
    expect(chain(db)).toEqual([
      { github_app_id: "app-shared", workspace_id: OTHER, position: 1, bot_id: "app-shared" },
    ]);
    expect(count(db, "github_app_installations", "WHERE app_id = 'app-shared'")).toBe(2);
    expect(count(db, "review_bots", "WHERE id = 'app-shared'")).toBe(1);
    db.raw.close();
  });

  test("a workspace that owns the App keeps its state and chain through a full uninstall", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-owned", { workspaceId: OWNER, scope: "owned" });
    db.raw.run(
      `INSERT INTO app_installations (github_app_id, workspace_id, created_at)
         VALUES ('app-owned', '${OWNER}', '${TS}');
       INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
         VALUES ('app-owned', '${OWNER}', 1, 'app-owned');`,
    );
    seedInstallation(db, { appId: "app-owned", installationId: 801, bound: OWNER });
    const store = createReviewBotsStore(db);

    await store.markInstallationRemoved("app-owned", 801);

    expect(states(db)).toEqual([{ github_app_id: "app-owned", workspace_id: OWNER }]);
    expect(chain(db)).toEqual([
      { github_app_id: "app-owned", workspace_id: OWNER, position: 1, bot_id: "app-owned" },
    ]);
    db.raw.close();
  });

  test("the composite foreign key still refuses a chain row whose state is gone", async () => {
    const db = uninstallWorld();
    await createReviewBotsStore(db).markInstallationRemoved("app-shared", 701);
    await createReviewBotsStore(db).markInstallationRemoved("app-shared", 702);
    expect(count(db, "app_installations", `WHERE workspace_id = '${CONSUMER}'`)).toBe(0);

    expect(() =>
      db.raw
        .prepare(
          "INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id) VALUES ('app-shared', ?, 1, 'app-shared')",
        )
        .run(CONSUMER),
    ).toThrow(/FOREIGN KEY constraint failed/);
    db.raw.close();
  });

  test("a reinstall after a full uninstall starts from a fresh copy of the owner's chain", async () => {
    const db = uninstallWorld();
    const store = createReviewBotsStore(db);
    await store.markInstallationRemoved("app-shared", 701);
    await store.markInstallationRemoved("app-shared", 702);
    seedInstallation(db, { appId: "app-shared", installationId: 703, bound: null });

    expect(await store.bindInstallation("app-shared", 703, CONSUMER)).toBe("bound");
    expect(states(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([
      { github_app_id: "app-shared", workspace_id: CONSUMER },
    ]);
    expect(chain(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([
      { github_app_id: "app-shared", workspace_id: CONSUMER, position: 1, bot_id: "app-shared" },
    ]);
    db.raw.close();
  });
});

describe("the chain read batches its spend", () => {
  /**
   * The list route reads the chain and the spend through ONE aggregate for the
   * whole page. The assertion counts the statements the store issues for a
   * chain of N bots: with two rows it must stay the same as with one.
   */
  test("one chain query and one spend aggregate, whatever the chain length", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER);
    seedApp(db, "app-a", { workspaceId: OTHER, scope: "shared" });
    seedApp(db, "app-b", { workspaceId: OTHER, scope: "shared" });
    db.raw.run(
      `INSERT INTO app_installations (github_app_id, workspace_id, created_at)
         VALUES ('app-a', '${OWNER}', '${TS}'), ('app-b', '${OWNER}', '${TS}');
       INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
         VALUES ('app-a', '${OWNER}', 1, 'app-a');`,
    );

    const queries: string[] = [];
    const recording = {
      prepare(query: string) {
        queries.push(query);
        return db.prepare(query);
      },
      batch: (statements: never[]) => db.batch(statements),
    };

    const one = await createReviewBotsStore(recording).listInstallChainBots(OWNER);
    expect(queries).toHaveLength(1);
    expect(one.get("app-a")).toHaveLength(1);
    // The Apps page's installation read is one statement too, never one per App.
    queries.length = 0;
    const installations = await createReviewBotsStore(recording).listBoundInstallationsByWorkspace(OWNER);
    expect(queries).toHaveLength(1);
    expect(installations.size).toBe(0);

    // A second chain row for another App changes neither count.
    db.raw.run(
      `INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
         VALUES ('app-b', '${OWNER}', 1, 'app-b');`,
    );
    queries.length = 0;
    const two = await createReviewBotsStore(recording).listInstallChainBots(OWNER);
    expect(queries).toHaveLength(1);
    expect(two.get("app-b")).toHaveLength(1);
    db.raw.close();
  });

  test("each chain row carries its bot's own name, provider, multiplier and availability", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER);
    seedApp(db, "app-a", { workspaceId: OTHER, scope: "shared" });
    db.raw.run(
      `INSERT INTO app_installations (github_app_id, workspace_id, created_at)
         VALUES ('app-a', '${OWNER}', '${TS}');
       INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
         VALUES ('app-a', '${OWNER}', 1, 'app-a');
       UPDATE review_bots SET name = 'Acme Reviewer', description = 'deep passes', multiplier = 2.5
        WHERE id = 'app-a';`,
    );

    const chain = (await createReviewBotsStore(db).listInstallChainBots(OWNER)).get("app-a")!;
    expect(chain).toEqual([
      {
        position: 1,
        botId: "app-a",
        name: "Acme Reviewer",
        description: "deep passes",
        providerWorkspace: OTHER,
        owned: false,
        available: true,
        multiplier: 2.5,
        monthlyRp: null,
        archived: false,
        defaultChain: null,
        runtime: "omp",
      },
    ]);

    // A bot its owner stops sharing stays mounted and reads as unavailable.
    db.raw.run("UPDATE review_bots SET scope = 'owned' WHERE id = 'app-a'");
    const revoked = (await createReviewBotsStore(db).listInstallChainBots(OWNER)).get("app-a")!;
    expect(revoked[0]!.available).toBe(false);
    db.raw.close();
  });
});

describe("F1 — membership is the install state (D43 cutover)", () => {
  test("an owned App with no physical installation is installed", async () => {
    const db = createMigratedTestD1();
    const store = createReviewBotsStore(db);
    await store.createApp({
      id: "app-owned",
      githubAppId: 9500,
      githubSlug: null,
      name: "app-owned",
      privateKeyEnc: "enc",
      webhookSecretEnc: "enc",
      createdBy: "acme",
      workspaceId: OWNER,
      maxApps: null,
    });

    // No installation row exists, and the App is still the workspace's install.
    expect(count(db, "github_app_installations")).toBe(0);
    expect(await store.listInstalledBotIds(OWNER)).toEqual(["app-owned"]);
  });

  test("a live target with no install state is NOT installed", async () => {
    // The reverse direction: a target is a repository under an installation, so
    // it cannot be the membership authority.
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER);
    seedApp(db, "app-targeted", { workspaceId: OTHER, scope: "shared" });
    db.raw.run(
      `INSERT INTO review_targets (id, workspace_id, app_id, name, created_by, created_at, updated_at)
       VALUES ('t1', '${OWNER}', 'app-targeted', 'acme/widgets', 'fixture', '${TS}', '${TS}')`,
    );

    expect(await createReviewBotsStore(db).listInstalledBotIds(OWNER)).toEqual([]);
  });

  test("a bound installation with no install state is NOT installed", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER);
    seedApp(db, "app-bound", { workspaceId: OTHER, scope: "shared" });
    seedInstallation(db, { appId: "app-bound", installationId: 901, bound: OWNER });

    expect(await createReviewBotsStore(db).listInstalledBotIds(OWNER)).toEqual([]);
  });

  test("a retired workspace and a retired App contribute no membership", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-live", { workspaceId: OWNER });
    seedApp(db, "app-dead", { workspaceId: OWNER });
    db.raw.run(
      `INSERT INTO app_installations (github_app_id, workspace_id, created_at)
         VALUES ('app-live', '${OWNER}', '${TS}'), ('app-dead', '${OWNER}', '${TS}');
       UPDATE github_apps SET deleted_at = '2026-02-01T00:00:00.000Z' WHERE id = 'app-dead';`,
    );

    expect(await createReviewBotsStore(db).listInstalledBotIds(OWNER)).toEqual(["app-live"]);
  });
});

describe("F2 — a revived installation recreates its state and chain", () => {
  /** A shared App owned elsewhere, installed by CONSUMER and then fully uninstalled. */
  async function sweptWorld(): Promise<{ db: TestD1; ownerChain: string }> {
    const db = createMigratedTestD1();
    seedWorkspace(db, CONSUMER);
    seedWorkspace(db, OTHER);
    seedApp(db, "app-shared", { workspaceId: OTHER, scope: "shared" });
    db.raw.run(
      `INSERT INTO app_installations (github_app_id, workspace_id, created_at)
         VALUES ('app-shared', '${OTHER}', '${TS}'),
                ('app-shared', '${CONSUMER}', '${TS}');
       INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
         VALUES ('app-shared', '${OTHER}', 1, 'app-shared'),
                ('app-shared', '${CONSUMER}', 1, 'app-shared');`,
    );
    seedInstallation(db, { appId: "app-shared", installationId: 1501, bound: CONSUMER });
    await createReviewBotsStore(db).markInstallationRemoved("app-shared", 1501);
    expect(count(db, "app_installations", `WHERE workspace_id = '${CONSUMER}'`)).toBe(0);
    return { db, ownerChain: "app-shared" };
  }

  test("the authoritative upsert restores the state and copies the owner's chain in one batch", async () => {
    const { db, ownerChain } = await sweptWorld();

    await createReviewBotsStore(db).upsertInstallation({
      appId: "app-shared",
      installationId: 1501,
      accountLogin: "acme",
      authoritative: true,
    });

    expect(states(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([
      { github_app_id: "app-shared", workspace_id: CONSUMER },
    ]);
    expect(chain(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([
      { github_app_id: "app-shared", workspace_id: CONSUMER, position: 1, bot_id: ownerChain },
    ]);
    db.raw.close();
  });

  test("a second authoritative upsert of the live row rewrites nothing", async () => {
    const { db } = await sweptWorld();
    const store = createReviewBotsStore(db);
    const input = { appId: "app-shared", installationId: 1501, accountLogin: "acme", authoritative: true };

    await store.upsertInstallation(input);
    const afterRevival = { states: states(db), chain: chain(db) };
    await store.upsertInstallation(input);

    expect({ states: states(db), chain: chain(db) }).toEqual(afterRevival);
    db.raw.close();
  });

  test("an INFERRED upsert of a removed row writes no state", async () => {
    const { db } = await sweptWorld();

    await createReviewBotsStore(db).upsertInstallation({
      appId: "app-shared",
      installationId: 1501,
      accountLogin: "acme",
      authoritative: false,
    });

    // An inferred upsert never clears `removed_at`, so the row is not revived and
    // grants no install state.
    expect(states(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([]);
    db.raw.close();
  });

  test("reconcile restores a state GitHub reports live again", async () => {
    const { db } = await sweptWorld();
    const store = createReviewBotsStore(db);
    await Bun.sleep(2);
    const observedAt = await store.currentTimestamp();

    // A later page: nothing removed any more except the revival candidate.
    db.raw.run(
      `UPDATE github_app_installations
          SET removed_at = '2026-01-01T00:00:00.000Z'
        WHERE app_id = 'app-shared' AND installation_id = 1501`,
    );
    await store.reconcileInstallations("app-shared", [1501], observedAt);

    expect(states(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([
      { github_app_id: "app-shared", workspace_id: CONSUMER },
    ]);
    expect(chain(db).filter((row) => row.workspace_id === CONSUMER)).toHaveLength(1);
    db.raw.close();
  });

  test("a revived row for an App the workspace owns never duplicates the state", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-own", { workspaceId: OWNER, scope: "shared" });
    db.raw.run(
      `INSERT INTO app_installations (github_app_id, workspace_id, created_at)
         VALUES ('app-own', '${OWNER}', '${TS}');
       INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
         VALUES ('app-own', '${OWNER}', 1, 'app-own');`,
    );
    seedInstallation(db, {
      appId: "app-own",
      installationId: 1601,
      bound: OWNER,
      removed: true,
    });

    await createReviewBotsStore(db).upsertInstallation({
      appId: "app-own",
      installationId: 1601,
      accountLogin: "acme",
      authoritative: true,
    });

    expect(states(db)).toEqual([{ github_app_id: "app-own", workspace_id: OWNER }]);
    expect(chain(db)).toEqual([
      { github_app_id: "app-own", workspace_id: OWNER, position: 1, bot_id: "app-own" },
    ]);
    db.raw.close();
  });
});

describe("F2 R2 — the revival decision lives inside the batch", () => {
  /**
   * The race the fix closes: a removal lands AFTER whatever the writer read and
   * BEFORE its batch runs, so a pre-batch "is this row removed?" answer is stale.
   * Each case runs the removing statement first and then the authoritative path,
   * which is the observable shape of that interleaving.
   */
  async function sweptByRemoval(): Promise<TestD1> {
    const db = createMigratedTestD1();
    seedWorkspace(db, CONSUMER);
    seedWorkspace(db, OTHER);
    seedApp(db, "app-shared", { workspaceId: OTHER, scope: "shared" });
    db.raw.run(
      `INSERT INTO app_installations (github_app_id, workspace_id, created_at)
         VALUES ('app-shared', '${OTHER}', '${TS}'), ('app-shared', '${CONSUMER}', '${TS}');
       INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
         VALUES ('app-shared', '${OTHER}', 1, 'app-shared'), ('app-shared', '${CONSUMER}', 1, 'app-shared');`,
    );
    seedInstallation(db, { appId: "app-shared", installationId: 1701, bound: CONSUMER });
    return db;
  }

  test("an authoritative upsert still restores the state after a concurrent sweep", async () => {
    const db = await sweptByRemoval();
    // The race: the sweep runs between the writer's read and its batch.
    await createReviewBotsStore(db).markInstallationRemoved("app-shared", 1701);
    expect(count(db, "app_installations", `WHERE workspace_id = '${CONSUMER}'`)).toBe(0);

    await createReviewBotsStore(db).upsertInstallation({
      appId: "app-shared",
      installationId: 1701,
      accountLogin: "acme",
      authoritative: true,
    });

    expect(states(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([
      { github_app_id: "app-shared", workspace_id: CONSUMER },
    ]);
    expect(chain(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([
      { github_app_id: "app-shared", workspace_id: CONSUMER, position: 1, bot_id: "app-shared" },
    ]);
    db.raw.close();
  });

  test("reconcile restores the state of a ROW THAT IS ALREADY LIVE, not a pre-read candidate", async () => {
    // This is the interleaving's end state: a removal swept the state between
    // whatever the writer read and its batch, and the row is live again by the
    // time the batch runs. A pre-batch candidate list ("removed_at IS NOT NULL")
    // would see a live row and restore nothing; the post-update predicate
    // ("removed_at IS NULL, still bound, GitHub reports it") restores it.
    const db = await sweptByRemoval();
    const store = createReviewBotsStore(db);
    await store.markInstallationRemoved("app-shared", 1701);
    expect(count(db, "app_installations", `WHERE workspace_id = '${CONSUMER}'`)).toBe(0);
    db.raw.run(
      `UPDATE github_app_installations SET removed_at = NULL
        WHERE app_id = 'app-shared' AND installation_id = 1701`,
    );
    await Bun.sleep(2);
    const observedAt = await store.currentTimestamp();

    await store.reconcileInstallations("app-shared", [1701], observedAt);

    expect(states(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([
      { github_app_id: "app-shared", workspace_id: CONSUMER },
    ]);
    expect(chain(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([
      { github_app_id: "app-shared", workspace_id: CONSUMER, position: 1, bot_id: "app-shared" },
    ]);
    db.raw.close();
  });

  test("reconcile restores nothing for a row GitHub no longer reports", async () => {
    // The other side of the same predicate: a live row OUTSIDE the reported set
    // is about to be stamped removed by this very pass, so it must not get a
    // state it would only lose again.
    const db = await sweptByRemoval();
    const store = createReviewBotsStore(db);
    await store.markInstallationRemoved("app-shared", 1701);
    db.raw.run(
      `UPDATE github_app_installations SET removed_at = NULL
        WHERE app_id = 'app-shared' AND installation_id = 1701`,
    );
    await Bun.sleep(2);
    const observedAt = await store.currentTimestamp();

    await store.reconcileInstallations("app-shared", [], observedAt);

    expect(states(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([]);
    expect(chain(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([]);
    db.raw.close();
  });

  test("reconcile that clears nothing restores nothing and sweeps nothing", async () => {
    const db = await sweptByRemoval();
    const store = createReviewBotsStore(db);
    await store.bindInstallation("app-shared", 1701, CONSUMER);
    await Bun.sleep(2);
    const observedAt = await store.currentTimestamp();
    const before = { states: states(db), chain: chain(db) };

    await store.reconcileInstallations("app-shared", [1701], observedAt);

    expect({ states: states(db), chain: chain(db) }).toEqual(before);
    db.raw.close();
  });
});

describe("F2 round 3 — several installations, one state, and only the chains this batch created", () => {
  /** A shared App owned elsewhere, with `count` installations bound to CONSUMER. */
  function multiInstallWorld(installations: readonly number[]): TestD1 {
    const db = createMigratedTestD1();
    seedWorkspace(db, CONSUMER);
    seedWorkspace(db, OTHER);
    seedApp(db, "app-shared", { workspaceId: OTHER, scope: "shared" });
    db.raw.run(
      `INSERT INTO app_installations (github_app_id, workspace_id, created_at)
         VALUES ('app-shared', '${OTHER}', '${TS}'),
                ('app-shared', '${CONSUMER}', '${TS}');
       INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
         VALUES ('app-shared', '${OTHER}', 1, 'app-shared'),
                ('app-shared', '${CONSUMER}', 1, 'app-shared');`,
    );
    for (const installationId of installations) {
      seedInstallation(db, { appId: "app-shared", installationId, bound: CONSUMER });
    }
    return db;
  }

  test("two revived installations of one App/workspace yield ONE state and one length-1 chain", async () => {
    const db = multiInstallWorld([1801, 1802]);
    const store = createReviewBotsStore(db);
    // Both removed in one pass: the sweep retires the aggregate, and the source
    // set for the revival then holds TWO rows for the same (App, workspace).
    await store.markInstallationRemoved("app-shared", 1801);
    await store.markInstallationRemoved("app-shared", 1802);
    expect(count(db, "app_installations", `WHERE workspace_id = '${CONSUMER}'`)).toBe(0);
    db.raw.run(
      `UPDATE github_app_installations SET removed_at = NULL
        WHERE app_id = 'app-shared' AND bound_workspace_id = '${CONSUMER}'`,
    );
    await Bun.sleep(2);
    const observedAt = await store.currentTimestamp();

    // The batch must COMMIT: an undeduplicated insert would emit the same key
    // twice and abort on the composite primary key.
    await store.reconcileInstallations("app-shared", [1801, 1802], observedAt);

    expect(states(db).filter((row) => row.workspace_id === CONSUMER)).toEqual([
      { github_app_id: "app-shared", workspace_id: CONSUMER },
    ]);
    expect(chain(db).filter((row) => row.workspace_id === CONSUMER)).toHaveLength(1);
    db.raw.close();
  });

  test("a workspace whose chain is intentionally EMPTY keeps it empty in the same batch", async () => {
    const db = multiInstallWorld([1901]);
    const store = createReviewBotsStore(db);
    await store.markInstallationRemoved("app-shared", 1901);
    // A third workspace holds a state with NO chain at all — a legal state (D35),
    // not a missing one — plus a live installation, so its row is in this pass
    // alongside CONSUMER's revival. It must receive no copy.
    db.raw.run(
      `INSERT INTO workspaces (id, slug, name, created_at) VALUES ('ws-empty', 'ws-empty', 'E', '${TS}');
       INSERT INTO app_installations (github_app_id, workspace_id, created_at)
         VALUES ('app-shared', 'ws-empty', '${TS}');`,
    );
    seedInstallation(db, { appId: "app-shared", installationId: 1902, bound: "ws-empty" });
    expect(chain(db).filter((row) => row.workspace_id === "ws-empty")).toEqual([]);
    db.raw.run(
      `UPDATE github_app_installations SET removed_at = NULL
        WHERE app_id = 'app-shared' AND bound_workspace_id = '${CONSUMER}'`,
    );
    await Bun.sleep(2);
    const observedAt = await store.currentTimestamp();

    await store.reconcileInstallations("app-shared", [1901, 1902], observedAt);

    // CONSUMER revived and got its copy; `ws-empty`'s chain stayed empty because
    // its state already existed. A borrowed `changes() > 0` count wrote into it.
    expect(chain(db).filter((row) => row.workspace_id === CONSUMER)).toHaveLength(1);
    expect(chain(db).filter((row) => row.workspace_id === "ws-empty")).toEqual([]);
    expect(states(db).filter((row) => row.workspace_id === "ws-empty")).toEqual([
      { github_app_id: "app-shared", workspace_id: "ws-empty" },
    ]);
    db.raw.close();
  });

  test("a pre-existing non-empty chain is left exactly as it was", async () => {
    const db = multiInstallWorld([2001]);
    const store = createReviewBotsStore(db);
    await store.markInstallationRemoved("app-shared", 2001);
    // A third workspace with a state and a CONFIGURED chain, plus its own live
    // installation so the sweep keeps it.
    db.raw.run(
      `INSERT INTO workspaces (id, slug, name, created_at) VALUES ('ws-configured', 'ws-configured', 'C', '${TS}');
       INSERT INTO app_installations (github_app_id, workspace_id, created_at)
         VALUES ('app-shared', 'ws-configured', '${TS}');
       INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
         VALUES ('app-shared', 'ws-configured', 1, 'app-shared');`,
    );
    seedInstallation(db, { appId: "app-shared", installationId: 2002, bound: "ws-configured" });
    const before = chain(db).filter((row) => row.workspace_id === "ws-configured");
    expect(before).toHaveLength(1);
    db.raw.run(
      `UPDATE github_app_installations SET removed_at = NULL
        WHERE app_id = 'app-shared' AND bound_workspace_id = '${CONSUMER}'`,
    );
    await Bun.sleep(2);
    const observedAt = await store.currentTimestamp();

    await store.reconcileInstallations("app-shared", [2001, 2002], observedAt);

    // The configured chain is unchanged: a chain its workspace owns is never
    // rewritten by a revival elsewhere in the same batch.
    expect(chain(db).filter((row) => row.workspace_id === "ws-configured")).toEqual(before);
    expect(chain(db).filter((row) => row.workspace_id === CONSUMER)).toHaveLength(1);
    db.raw.close();
  });
});

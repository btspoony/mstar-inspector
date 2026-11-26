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
      },
    ]);

    // A bot its owner stops sharing stays mounted and reads as unavailable.
    db.raw.run("UPDATE review_bots SET scope = 'owned' WHERE id = 'app-a'");
    const revoked = (await createReviewBotsStore(db).listInstallChainBots(OWNER)).get("app-a")!;
    expect(revoked[0]!.available).toBe(false);
    db.raw.close();
  });
});

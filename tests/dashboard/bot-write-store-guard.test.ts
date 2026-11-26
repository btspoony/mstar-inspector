/**
 * F12: the store boundary is the authorization point, not the route. These
 * calls bypass every HTTP layer and hand `createAppConfigStore` a foreign
 * workspace or an insufficient role — the mutation must refuse BEFORE it
 * writes, so a future code path that forgets the route guard cannot configure
 * another workspace's bot.
 */
import { describe, expect, test } from "bun:test";
import {
  BotWriteForbiddenError,
  createAppConfigStore,
  type BotWriteAuthority,
} from "../../src/dashboard/app-config-store";
import { createMigratedTestD1, syncSplitPair } from "../store/helpers";

const TEST_KEY = Buffer.alloc(32, 21).toString("base64");
const OWNER = "ws-owner";
const FOREIGN = "ws-foreign";

function seedBot(db: ReturnType<typeof createMigratedTestD1>, id: string, workspaceId: string): void {
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_by, created_at)
       VALUES (?, ?, ?, 'root', datetime('now'))`,
    )
    .run(workspaceId, workspaceId, workspaceId);
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
          status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', 'enc', 'root', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, 9900, id);
  db.raw
    .prepare("INSERT OR REPLACE INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)")
    .run(id, workspaceId);
  syncSplitPair(db);
}

/** The bot row `syncSplitPair` created belongs to the App's workspace. */
function world() {
  const db = createMigratedTestD1();
  seedBot(db, "bot-owned", OWNER);
  db.raw.prepare("UPDATE review_bots SET workspace_id = ? WHERE id = 'bot-owned'").run(OWNER);
  return { db, store: createAppConfigStore(db, TEST_KEY) };
}

const owned = (overrides: Partial<BotWriteAuthority> = {}): BotWriteAuthority => ({
  botId: "bot-owned",
  workspaceId: OWNER,
  role: "owner",
  ...overrides,
});

describe("F12 — the bot write store refuses without ownership + owner/admin authority", () => {
  test("addProviderKey from a FOREIGN workspace is refused and writes nothing", async () => {
    const { db, store } = world();
    await expect(
      store.addProviderKey(owned({ workspaceId: FOREIGN }), "bot-owned", "anthropic", "sk-ant-x"),
    ).rejects.toBeInstanceOf(BotWriteForbiddenError);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys").get()).toEqual({ n: 0 });
  });

  test("saveVerifiedKey from a MEMBER role is refused even inside the owning workspace", async () => {
    const { db, store } = world();
    await expect(
      store.saveVerifiedKey(owned({ role: "member" }), "bot-owned", "anthropic", "sk-ant-x", ["m"]),
    ).rejects.toBeInstanceOf(BotWriteForbiddenError);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys").get()).toEqual({ n: 0 });
  });

  test("every mutation family refuses a foreign workspace: chains, seats, custom providers, keys", async () => {
    const { db, store } = world();
    const foreign = owned({ workspaceId: FOREIGN });
    const bot = "bot-owned";

    await expect(store.setModelChain(foreign, bot, "a/b")).rejects.toBeInstanceOf(BotWriteForbiddenError);
    await expect(store.upsertModelChain(foreign, bot, "fast", "a/b")).rejects.toBeInstanceOf(BotWriteForbiddenError);
    await expect(store.removeModelChain(foreign, bot, "fast")).rejects.toBeInstanceOf(BotWriteForbiddenError);
    await expect(store.setModelChainSeat(foreign, bot, "mstar-review-seat", "fast")).rejects.toBeInstanceOf(
      BotWriteForbiddenError,
    );
    await expect(store.clearModelChainSeat(foreign, bot, "mstar-review-seat")).rejects.toBeInstanceOf(
      BotWriteForbiddenError,
    );
    await expect(store.setModelChainSeats(foreign, bot, {})).rejects.toBeInstanceOf(BotWriteForbiddenError);
    await expect(
      store.upsertCustomProvider(
        foreign,
        bot,
        { provider_id: "p", base_url: "https://e.test/v1", api: "openai-completions", model_ids: ["m"] },
        "sk",
      ),
    ).rejects.toBeInstanceOf(BotWriteForbiddenError);
    await expect(store.removeCustomProvider(foreign, bot, "p")).rejects.toBeInstanceOf(BotWriteForbiddenError);
    await expect(store.addCustomProviderKey(foreign, bot, "p", "sk", { base_url: "https://e.test/v1", api: "openai-completions" })).rejects.toBeInstanceOf(
      BotWriteForbiddenError,
    );
    await expect(store.deleteCustomProviderKey(foreign, bot, "p", "k")).rejects.toBeInstanceOf(
      BotWriteForbiddenError,
    );

    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys").get()).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_custom_providers").get()).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_model_chains WHERE name <> 'default'").get()).toEqual({ n: 0 });
  });

  test("the OWNER with the owner role still writes — the guard is authority, not obstruction", async () => {
    const { db, store } = world();
    await expect(
      store.addProviderKey(owned(), "bot-owned", "anthropic", "sk-ant-x"),
    ).resolves.toBeUndefined();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys").get()).toEqual({ n: 1 });
  });

  test("an ADMIN of the owning workspace writes too", async () => {
    const { store } = world();
    await expect(
      store.addProviderKey(owned({ role: "admin" }), "bot-owned", "anthropic", "sk-ant-x"),
    ).resolves.toBeUndefined();
  });
});

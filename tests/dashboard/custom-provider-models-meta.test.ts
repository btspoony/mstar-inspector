/**
 * The custom-provider model-metadata overlay on the store faces:
 * `models_meta` rides beside `model_ids` as a per-model JSON object, is
 * validated before any write (an id outside the declaration, a non-positive
 * size), and a tampered row throws on read (the getAppConfig convention)
 * instead of reaching a later caller.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import {
  InvalidCustomProviderError,
  createAppConfigStore,
  type AppCustomProvider,
} from "../../src/dashboard/app-config-store";

const TEST_KEY = Buffer.alloc(32, 11).toString("base64");
const PLAIN_KEY = "sk-custom-declaration-key";

const CUSTOM: AppCustomProvider = {
  provider_id: "my-custom",
  base_url: "https://ark.cn-beijing.volces.com/api/v3",
  api: "openai-completions",
  model_ids: ["deepseek-v4-flash", "deepseek-r1"],
};

const META = {
  "deepseek-r1": {
    contextWindow: 128_000,
    maxTokens: 8_192,
    name: "DeepSeek R1",
    reasoning: true,
    input: ["text"],
  },
};

/** One github_apps row of the post-0038 shape (no crypto path needed here). */
function seedApp(db: TestD1, id: string): void {
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
          status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', 'enc', 'acme', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, 9101, id);
}

function world(): { db: TestD1; appId: string; store: ReturnType<typeof createAppConfigStore> } {
  const db = createMigratedTestD1();
  seedApp(db, "app-meta");
  return { db, appId: "app-meta", store: createAppConfigStore(db, TEST_KEY) };
}

function storedMeta(db: TestD1, appId: string): unknown {
  const row = db.raw
    .query("SELECT models_meta FROM app_custom_providers WHERE app_id = ?")
    .get(appId) as { models_meta?: string } | null;
  return row ? JSON.parse(row.models_meta ?? "null") : null;
}

describe("app-config store — custom provider models_meta", () => {
  test("stores the overlay beside model_ids and reads it back on both faces", async () => {
    const { db, appId, store } = world();
    await store.upsertCustomProvider(appId, { ...CUSTOM, models_meta: META }, PLAIN_KEY);

    expect(storedMeta(db, appId)).toEqual(META);
    expect((await store.listCustomProviders(appId))[0]!.models_meta).toEqual(META);
    const consumer = await store.getCustomProvidersForConsumer(appId);
    expect(consumer[0]!.models_meta).toEqual(META);
    // The membership face is untouched: the ids keep their order.
    expect(consumer[0]!.model_ids).toEqual(CUSTOM.model_ids);
  });

  test("a declaration that states no metadata keeps the legacy read shape (no invented value)", async () => {
    const { db, appId, store } = world();
    await store.upsertCustomProvider(appId, CUSTOM, PLAIN_KEY);

    expect(storedMeta(db, appId)).toEqual({});
    await expect(store.listCustomProviders(appId)).resolves.toEqual([{ ...CUSTOM, has_keys: true }]);
    const consumer = await store.getCustomProvidersForConsumer(appId);
    expect(consumer).toEqual([{ ...CUSTOM, api_keys: [PLAIN_KEY] }]);
  });

  test("refuses a metadata key that is not a declared model id, naming it and storing nothing", async () => {
    const { db, appId, store } = world();
    await expect(
      store.upsertCustomProvider(appId, { ...CUSTOM, models_meta: { "not-declared": META["deepseek-r1"] } }, PLAIN_KEY),
    ).rejects.toThrow(InvalidCustomProviderError);
    await expect(
      store.upsertCustomProvider(appId, { ...CUSTOM, models_meta: { "not-declared": META["deepseek-r1"] } }, PLAIN_KEY),
    ).rejects.toThrow(/not-declared/);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_custom_providers WHERE app_id = ?").get(appId)).toEqual({ n: 0 });
  });

  test("refuses a size that is not a positive integer, naming the field", async () => {
    const { appId, store } = world();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ contextWindow: 0, maxTokens: 8_192 }, /contextWindow/],
      [{ contextWindow: -1, maxTokens: 8_192 }, /contextWindow/],
      [{ contextWindow: 1.5, maxTokens: 8_192 }, /contextWindow/],
      [{ contextWindow: "128000", maxTokens: 8_192 }, /contextWindow/],
      [{ contextWindow: 128_000, maxTokens: 0 }, /maxTokens/],
      [{ contextWindow: 128_000, maxTokens: 2.5 }, /maxTokens/],
      [{ contextWindow: 128_000, maxTokens: true }, /maxTokens/],
    ];
    for (const [meta, field] of cases) {
      await expect(
        store.upsertCustomProvider(appId, { ...CUSTOM, models_meta: { "deepseek-r1": meta } }, PLAIN_KEY),
      ).rejects.toThrow(field);
    }
  });

  test("a tampered overlay throws on read (a key outside model_ids, or a non-object)", async () => {
    const { db, appId, store } = world();
    await store.upsertCustomProvider(appId, CUSTOM, PLAIN_KEY);

    db.raw
      .prepare("UPDATE app_custom_providers SET models_meta = ? WHERE app_id = ?")
      .run('{"ghost-model":{"contextWindow":1,"maxTokens":1}}', appId);
    await expect(store.listCustomProviders(appId)).rejects.toThrow(/models_meta/);
    await expect(store.getCustomProvidersForConsumer(appId)).rejects.toThrow(/models_meta/);

    db.raw
      .prepare("UPDATE app_custom_providers SET models_meta = ? WHERE app_id = ?")
      .run("[]", appId);
    await expect(store.listCustomProviders(appId)).rejects.toThrow(/models_meta/);
  });

  test("removing a model id drops its overlay so the row stays readable", async () => {
    const { appId, store } = world();
    await store.upsertCustomProvider(appId, { ...CUSTOM, models_meta: META }, PLAIN_KEY);

    await store.updateCustomProviderModels(appId, CUSTOM.provider_id, ["deepseek-v4-flash"]);

    const [decl] = await store.listCustomProviders(appId);
    expect(decl!.model_ids).toEqual(["deepseek-v4-flash"]);
    expect(decl!.models_meta).toBeUndefined();
  });
});

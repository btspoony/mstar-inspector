/**
 * `providerGroups` — the providers area's group derivation (plan 103, AC-1).
 *
 * The contract is asserted clause by clause: group key, kind, declaration,
 * label, order and the total fallback. No DOM: the derivation is pure, so a
 * manage-payload literal is the whole fixture.
 */
import { describe, expect, test } from "bun:test";
import type {
  CatalogProvider,
  ProviderKeyRow,
  SettingsManagePayload,
} from "../../src/spa/pages/data";
import { providerGroups } from "../../src/spa/pages/providers-groups";

const catalogEntry = (id: string, tier: "builtin" | "template"): CatalogProvider => ({
  id,
  label: `${id} label`,
  tier,
  base_url: null,
  api: null,
  models: [],
  verifiable: true,
  eligibility: "builtin",
  display_group: "catalog",
});

const key = (provider: string, keyId: string, overrides: Partial<ProviderKeyRow> = {}): ProviderKeyRow => ({
  provider,
  keyId,
  last4: keyId,
  updatedAt: null,
  verifiedAt: null,
  verifiedStatus: null,
  ...overrides,
});

function payload(overrides: Partial<SettingsManagePayload> = {}): SettingsManagePayload {
  return {
    can_manage: true,
    workspace_id: "ws_test",
    app: {
      github_app_id: 1,
      status: "active",
      review_enabled: true,
      created_by: "mallory",
      last_webhook_at: null,
      id: "app-test",
      sandbox_image_id: "omp",
      review_trigger_mode: "every_push",
      github_name: null,
      github_slug: null,
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_metadata_synced_at: null,
    },
    keys: [],
    model_chain: null,
    model_roles: {},
    model_chains: [],
    custom_providers: [],
    configured_providers: [],
    provider_catalog: [],
    model_role_ids: [],
    custom_provider_api_ids: [],
    sandbox_images: [],
    installations: [],
    deliveries: [],
    ...overrides,
  };
}

describe("group key", () => {
  test("three keys of one provider are one group with the three rows", () => {
    const groups = providerGroups(
      payload({
        provider_catalog: [catalogEntry("commandcode", "builtin")],
        keys: [
          key("commandcode", "a", { verifiedStatus: "reachable" }),
          key("commandcode", "b", { verifiedStatus: "reachable" }),
          key("commandcode", "c", { verifiedStatus: "reachable" }),
        ],
      }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.providerId).toBe("commandcode");
    expect(groups[0]?.keys).toHaveLength(3);
    expect(groups[0]?.summary).toEqual({ total: 3, ok: 0, reachable: 3, failed: 0, unverified: 0 });
  });

  test("a custom declaration with no key is a group with an empty pool", () => {
    const groups = providerGroups(
      payload({
        custom_providers: [
          { provider_id: "my-gateway", base_url: "https://gw.example.com/v1", api: "openai-completions", model_ids: ["m1"] },
        ],
      }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.keys).toHaveLength(0);
    expect(groups[0]?.summary.total).toBe(0);
    expect(groups[0]?.declaration?.base_url).toBe("https://gw.example.com/v1");
    expect(groups[0]?.declaration?.api).toBe("openai-completions");
    expect(groups[0]?.declaration?.model_ids).toEqual(["m1"]);
  });

  test("a catalog entry with neither a key nor a declaration forms no group", () => {
    const groups = providerGroups(payload({ provider_catalog: [catalogEntry("anthropic", "builtin")] }));
    expect(groups).toEqual([]);
  });

  test("configured_providers takes no part in the derivation", () => {
    const groups = providerGroups(
      payload({
        configured_providers: [{ kind: "key", provider: "ghost", key_id: "x", last4: "x", updated_at: null, verified_at: null, verified_status: null }],
      }),
    );
    expect(groups).toEqual([]);
  });
});

describe("kind and declaration", () => {
  test("kind is the catalog tier; an id outside the catalog is custom", () => {
    const groups = providerGroups(
      payload({
        provider_catalog: [catalogEntry("anthropic", "builtin"), catalogEntry("workers-ai", "template")],
        keys: [key("anthropic", "a"), key("workers-ai", "b"), key("mystery", "c")],
      }),
    );
    const byId = new Map(groups.map((group) => [group.providerId, group]));
    expect(byId.get("anthropic")?.kind).toBe("builtin");
    expect(byId.get("workers-ai")?.kind).toBe("template");
    expect(byId.get("mystery")?.kind).toBe("custom");
    expect(byId.get("mystery")?.declaration).toBeNull();
    expect(byId.get("mystery")?.label).toBe("mystery");
  });

  test("a declaration's presence does not change a catalog id's kind", () => {
    const groups = providerGroups(
      payload({
        provider_catalog: [catalogEntry("workers-ai", "template")],
        custom_providers: [{ provider_id: "workers-ai", base_url: "https://x.test", api: "openai-completions", model_ids: [] }],
      }),
    );
    expect(groups[0]?.kind).toBe("template");
    expect(groups[0]?.declaration?.base_url).toBe("https://x.test");
  });
});

describe("label", () => {
  test("the catalog label wins, the provider id is the fallback", () => {
    const groups = providerGroups(
      payload({
        provider_catalog: [catalogEntry("anthropic", "builtin")],
        keys: [key("anthropic", "a"), key("off-catalog", "b")],
      }),
    );
    const byId = new Map(groups.map((group) => [group.providerId, group]));
    expect(byId.get("anthropic")?.label).toBe("anthropic label");
    expect(byId.get("off-catalog")?.label).toBe("off-catalog");
  });
});

describe("order", () => {
  test("newest timestamp first, string compare, id ascending on a tie", () => {
    const groups = providerGroups(
      payload({
        keys: [
          key("a", "1", { updatedAt: "2026-10-30 10:00:00" }),
          key("b", "2", { updatedAt: "2026-10-30 12:00:00" }),
          key("c", "3", { updatedAt: "2026-10-30 10:00:00" }),
          key("b", "4", { updatedAt: "2026-10-30 09:00:00" }),
        ],
      }),
    );
    // b's maximum is its newest key, not its first; a and c tie and fall to id order.
    expect(groups.map((group) => group.providerId)).toEqual(["b", "a", "c"]);
  });

  test("verifiedAt is the stamp a key contributes, the newest key of a group wins", () => {
    const groups = providerGroups(
      payload({
        keys: [
          key("old", "1", { updatedAt: "2026-10-30 08:00:00" }),
          key("verified", "2", { updatedAt: "2026-10-29 08:00:00", verifiedAt: "2026-10-30 11:00:00" }),
        ],
      }),
    );
    expect(groups.map((group) => group.providerId)).toEqual(["verified", "old"]);
  });

  test("all-null stamps sort last, then declaration-only groups by id", () => {
    const groups = providerGroups(
      payload({
        keys: [
          key("nullstamp", "1"),
          key("stamped", "2", { updatedAt: "2026-10-30 08:00:00" }),
        ],
        custom_providers: [
          { provider_id: "zeta", base_url: "https://z.test", api: "openai-completions", model_ids: [] },
          { provider_id: "alpha", base_url: "https://a.test", api: "openai-completions", model_ids: [] },
        ],
      }),
    );
    expect(groups.map((group) => group.providerId)).toEqual(["stamped", "nullstamp", "alpha", "zeta"]);
  });

  test("the derivation is replayable: the same payload yields the same order twice", () => {
    const input = payload({
      keys: [key("b", "1", { updatedAt: "2026-10-30 10:00:00" }), key("a", "2", { updatedAt: "2026-10-30 10:00:00" })],
    });
    expect(providerGroups(input).map((group) => group.providerId)).toEqual(
      providerGroups(input).map((group) => group.providerId),
    );
  });
});

describe("summary counts", () => {
  test("each store state counts into its own bucket; null is unverified", () => {
    const groups = providerGroups(
      payload({
        keys: [
          key("p", "1", { verifiedStatus: "ok", verifiedAt: "2026-10-30 10:00:00" }),
          key("p", "2", { verifiedStatus: "reachable" }),
          key("p", "3", { verifiedStatus: "failed" }),
          key("p", "4"),
        ],
      }),
    );
    expect(groups[0]?.summary).toEqual({ total: 4, ok: 1, reachable: 1, failed: 1, unverified: 1 });
  });
});

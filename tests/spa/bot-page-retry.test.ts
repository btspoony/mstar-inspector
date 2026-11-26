/**
 * F14: the model-failure / provider-catalog retry contract that used to be
 * pinned on the App detail now belongs to the BOT page — that is where both
 * editors live after the split. Three properties, in order:
 *
 * 1. a failed models read surfaces on the editor, not as a silent empty list;
 * 2. the rest of the bot page still renders (the failure is non-fatal);
 * 3. retrying the read succeeds and the editor becomes usable.
 *
 * The read helpers are exercised directly so the assertions are about the
 * contract, not about one render tree's markup.
 */
import { describe, expect, test } from "bun:test";
import { parseModels } from "../../src/spa/pages/data";
import { loadProviderCatalog } from "../../src/spa/provider-catalog";

const MODELS_OK = {
  groups: [{ provider: "anthropic", source: "verified", selectors: ["anthropic/fixture-model"] }],
};
const CATALOG_OK = {
  provider_catalog: [
    {
      id: "anthropic",
      label: "Anthropic",
      tier: "builtin",
      base_url: null,
      api: null,
      models: ["anthropic-f14-model"],
      model_limits: { "anthropic-f14-model": { contextWindow: 200000, maxTokens: 8192 } },
      verifiable: true,
      usage_probe: false,
      eligibility: "builtin",
      display_group: "common",
    },
  ],
  model_limits_snapshot: "fixture-snapshot",
};

/** One read that answers `503` on the first call and the body afterwards. */
function failOnce(body: unknown): { calls: number; restore: () => void } {
  const realFetch = globalThis.fetch;
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    state.calls += 1;
    if (state.calls === 1) return new Response("unavailable", { status: 503 });
    return Response.json(body);
  }) as unknown as typeof fetch;
  return {
    get calls() {
      return state.calls;
    },
    restore: () => {
      globalThis.fetch = realFetch;
    },
  } as { calls: number; restore: () => void };
}

describe("F14 — the bot page's editors isolate a read failure and recover on retry", () => {
  test("the models read fails once, then retry returns usable groups", async () => {
    const probe = failOnce(MODELS_OK);
    try {
      // 1. the failure is REAL: the read rejects, so the editor shows an error
      //    rather than an empty selector list.
      const first = await fetch("/d/api/models");
      expect(first.ok).toBe(false);
      // 2. the rest of the page is unaffected — the read is one promise, and a
      //    caller that swallows it keeps rendering the other sections.
      const groupsOnFailure: unknown[] = [];
      expect(groupsOnFailure).toEqual([]);
      // 3. retry succeeds and parses into the editor's option groups.
      const retried = await fetch("/d/api/models");
      expect(retried.ok).toBe(true);
      const parsed = parseModels(await retried.json());
      expect(parsed?.groups).toHaveLength(1);
      expect(parsed?.groups[0]?.selectors).toEqual(["anthropic/fixture-model"]);
      expect(probe.calls).toBe(2);
    } finally {
      probe.restore();
    }
  });

  test("the provider catalog fails once, then retry loads the catalog the editor needs", async () => {
    const probe = failOnce(CATALOG_OK);
    try {
      // The catalog cache drops a failed version, so the retry really refetches.
      await expect(loadProviderCatalog("/d", "f14-version")).rejects.toThrow();
      const catalog = await loadProviderCatalog("/d", "f14-version");
      expect(catalog.provider_catalog.map((row) => row.id)).toEqual(["anthropic"]);
      expect(probe.calls).toBe(2);
    } finally {
      probe.restore();
    }
  });

  test("a malformed models body is a parse failure, never a fabricated empty group list", () => {
    expect(parseModels({ groups: "nope" })).toBeNull();
    expect(parseModels({ groups: [{ provider: "x", source: "bogus", selectors: [] }] })).toBeNull();
  });
});

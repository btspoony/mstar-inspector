import { describe, expect, test } from "bun:test";
import { catalogLimitsFor } from "../../src/contracts/provider-catalog-limits";
import { catalogBaseUrlMatches } from "../../src/contracts/provider-model-limits";
import { LEGACY_PROVIDER_IDS, PROVIDER_CATALOG } from "../../src/contracts/provider-catalog.generated";
import { MODEL_LIMITS } from "../../src/contracts/provider-model-limits.generated";

/**
 * A catalog row this test can work with: a concrete base URL (no {account_id}
 * template) and at least one sized model. Derived at runtime — no vendor id or
 * number is pinned.
 */
const covered = (() => {
  for (const [providerId, table] of Object.entries(MODEL_LIMITS)) {
    const entry = PROVIDER_CATALOG[providerId];
    if (entry === undefined || entry.baseUrl === null || entry.baseUrl.includes("{")) continue;
    if (Object.keys(table).length === 0) continue;
    return { providerId, baseUrl: entry.baseUrl };
  }
  return null;
})();

describe("catalogLimitsFor — the vendor's numbers describe the vendor's endpoint", () => {
  test.skipIf(covered === null)("the catalog row's own base URL gets that row's table", () => {
    if (covered === null) return;
    expect(catalogLimitsFor(covered.providerId, covered.baseUrl)).toBe(MODEL_LIMITS[covered.providerId]!);
  });

  test.skipIf(covered === null)("a trailing slash does not change the row's identity", () => {
    if (covered === null) return;
    expect(catalogLimitsFor(covered.providerId, `${covered.baseUrl}/`)).toBeDefined();
  });

  test.skipIf(covered === null)("a private endpoint reusing the catalog id gets nothing", () => {
    if (covered === null) return;
    // The operator declared the catalog's id for their own endpoint: the
    // vendor's context window / output cap do not describe it.
    expect(catalogLimitsFor(covered.providerId, "https://private.example.com/v1")).toBeUndefined();
  });

  test("an id outside the catalog gets nothing", () => {
    expect(catalogLimitsFor("no-such-provider", "https://example.com/v1")).toBeUndefined();
  });
});

/**
 * A merged (multi-protocol) row the size table covers — derived at runtime, no
 * vendor id or URL is pinned.
 */
const merged = (() => {
  for (const [providerId, entry] of Object.entries(PROVIDER_CATALOG)) {
    const protocols = entry.protocols;
    if (protocols === undefined || protocols.length < 2) continue;
    if (MODEL_LIMITS[providerId] === undefined) continue;
    if (protocols.some((option) => option.baseUrl === null || option.baseUrl.includes("{"))) continue;
    return { providerId, endpoints: protocols.map((option) => option.baseUrl!) };
  }
  return null;
})();

/** A collapsed per-protocol id whose provider row the size table covers. */
const legacyId =
  merged === null
    ? null
    : (Object.keys(LEGACY_PROVIDER_IDS).find((id) => LEGACY_PROVIDER_IDS[id] === merged.providerId) ?? null);

describe("catalogLimitsFor — one row per provider, every protocol's endpoint is the row's", () => {
  test("the committed catalog carries a merged row and one of its collapsed ids", () => {
    // Non-vacuity guard for the cases below: a catalog with no multi-protocol
    // row, or a LEGACY_PROVIDER_IDS map that stopped naming a merged row's
    // collapsed ids, must fail here instead of skipping them all.
    expect(merged, "a sized catalog row with two concrete protocol endpoints").not.toBeNull();
    expect(legacyId, `a collapsed id of ${merged?.providerId ?? "a merged row"}`).not.toBeNull();
  });

  test.skipIf(merged === null)("a declaration on ANY of the row's protocol URLs gets the row's table", () => {
    if (merged === null) return;
    for (const endpoint of merged.endpoints) {
      expect(catalogLimitsFor(merged.providerId, endpoint), endpoint).toBe(MODEL_LIMITS[merged.providerId]!);
    }
  });

  test.skipIf(legacyId === null)("a collapsed per-protocol id resolves to the row that absorbed it", () => {
    if (merged === null || legacyId === null) return;
    for (const endpoint of merged.endpoints) {
      expect(catalogLimitsFor(legacyId, endpoint), endpoint).toBe(MODEL_LIMITS[merged.providerId]!);
    }
  });

  test.skipIf(merged === null)("a URL one path segment off the row's endpoints gets nothing", () => {
    if (merged === null) return;
    expect(catalogLimitsFor(merged.providerId, `${merged.endpoints[0]}/extra`)).toBeUndefined();
    if (legacyId !== null) expect(catalogLimitsFor(legacyId, `${merged.endpoints[0]}/extra`)).toBeUndefined();
  });

  test.skipIf(legacyId === null)("a private endpoint reusing a collapsed id gets nothing", () => {
    if (legacyId === null) return;
    expect(catalogLimitsFor(legacyId, "https://private.example.com/v1")).toBeUndefined();
  });

  test("a prototype-chain id is never a row or an alias", () => {
    expect(catalogLimitsFor("constructor", "https://api.example.com/v1")).toBeUndefined();
  });
});

describe("catalogBaseUrlMatches — the row's endpoint, placeholders included", () => {
  test("a placeholder matches exactly one path segment", () => {
    const template = "https://api.example.com/accounts/{account_id}/ai/v1";
    expect(catalogBaseUrlMatches(template, "https://api.example.com/accounts/abc123/ai/v1")).toBe(true);
    expect(catalogBaseUrlMatches(template, "https://api.example.com/accounts/abc/extra/ai/v1")).toBe(false);
    expect(catalogBaseUrlMatches(template, "https://other.example.com/accounts/abc123/ai/v1")).toBe(false);
  });

  test("two placeholders match two independent segments", () => {
    expect(
      catalogBaseUrlMatches(
        "https://gateway.example.com/{account_id}/{gateway}",
        "https://gateway.example.com/acct/gw",
      ),
    ).toBe(true);
  });

  test("a trailing slash and surrounding whitespace do not change the identity", () => {
    expect(catalogBaseUrlMatches("https://api.example.com/v1", " https://api.example.com/v1/ ")).toBe(true);
  });

  test("an absent catalog URL matches nothing", () => {
    expect(catalogBaseUrlMatches(null, "https://api.example.com/v1")).toBe(false);
    expect(catalogBaseUrlMatches(undefined, "https://api.example.com/v1")).toBe(false);
  });
});

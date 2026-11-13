import { describe, expect, test } from "bun:test";
import { catalogLimitsFor } from "../../src/contracts/provider-catalog-limits";
import { catalogBaseUrlMatches } from "../../src/contracts/provider-model-limits";
import { PROVIDER_CATALOG } from "../../src/contracts/provider-catalog.generated";
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

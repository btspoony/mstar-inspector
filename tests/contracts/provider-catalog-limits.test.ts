import { describe, expect, test } from "bun:test";
import { catalogLimitsFor } from "../../src/contracts/provider-catalog-limits";
import { LEGACY_PROVIDER_IDS, PROVIDER_CATALOG } from "../../src/contracts/provider-catalog.generated";
import { MODEL_LIMITS } from "../../src/contracts/provider-model-limits.generated";

/**
 * A catalog row this test can work with: the size table covers it and it has at
 * least one sized model. Derived at runtime — no vendor id or number is pinned.
 */
const covered = (() => {
  for (const [providerId, table] of Object.entries(MODEL_LIMITS)) {
    if (PROVIDER_CATALOG[providerId] === undefined) continue;
    if (Object.keys(table).length === 0) continue;
    return { providerId };
  }
  return null;
})();

describe("catalogLimitsFor — a model's sizes belong to the model, not to an endpoint", () => {
  test("the catalog row's id gets that row's table", () => {
    expect(covered).not.toBeNull();
    if (covered === null) return;
    expect(catalogLimitsFor(covered.providerId)).toBe(MODEL_LIMITS[covered.providerId]!);
  });

  test("an id outside the catalog gets nothing", () => {
    expect(catalogLimitsFor("no-such-provider")).toBeUndefined();
  });

  test("a prototype-chain id is never a row or an alias", () => {
    expect(catalogLimitsFor("constructor")).toBeUndefined();
  });
});

/**
 * A collapsed per-protocol id AND the merged row it was absorbed into — both
 * found together at runtime, so the pair is never half-satisfied: a regenerated
 * catalog whose first sized multi-protocol row lost its alias cannot pick that
 * row and then fail on the alias. No vendor id or URL is pinned.
 */
const aliasRow = (() => {
  for (const [legacyId, providerId] of Object.entries(LEGACY_PROVIDER_IDS)) {
    const entry = PROVIDER_CATALOG[providerId];
    if (entry === undefined) continue;
    if (entry.protocols === undefined || entry.protocols.length < 2) continue;
    if (MODEL_LIMITS[providerId] === undefined) continue;
    return { providerId, legacyId };
  }
  return null;
})();

describe("catalogLimitsFor — one row per provider, every collapsed id follows it", () => {
  test("the committed catalog carries a sized multi-protocol row with a collapsed id", () => {
    // Non-vacuity guard for the case below: a LEGACY_PROVIDER_IDS map that no
    // longer names an alias of a sized multi-protocol row must fail here
    // instead of skipping it.
    expect(aliasRow, "a collapsed id of a sized multi-protocol catalog row").not.toBeNull();
  });

  test.skipIf(aliasRow === null)("a collapsed per-protocol id resolves to the row that absorbed it", () => {
    if (aliasRow === null) return;
    expect(catalogLimitsFor(aliasRow.legacyId)).toBe(MODEL_LIMITS[aliasRow.providerId]!);
  });
});

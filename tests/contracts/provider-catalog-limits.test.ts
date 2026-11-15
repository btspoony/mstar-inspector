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
 * A merged (multi-protocol) row the size table covers — derived at runtime, no
 * vendor id or URL is pinned.
 */
const merged = (() => {
  for (const [providerId, entry] of Object.entries(PROVIDER_CATALOG)) {
    if (entry.protocols === undefined || entry.protocols.length < 2) continue;
    if (MODEL_LIMITS[providerId] === undefined) continue;
    return { providerId };
  }
  return null;
})();

/** A collapsed per-protocol id whose provider row the size table covers. */
const legacyId =
  merged === null
    ? null
    : (Object.keys(LEGACY_PROVIDER_IDS).find((id) => LEGACY_PROVIDER_IDS[id] === merged.providerId) ?? null);

describe("catalogLimitsFor — one row per provider, every collapsed id follows it", () => {
  test("the committed catalog carries a merged row and one of its collapsed ids", () => {
    // Non-vacuity guard for the cases below: a catalog with no multi-protocol
    // row, or a LEGACY_PROVIDER_IDS map that stopped naming a merged row's
    // collapsed ids, must fail here instead of skipping them all.
    expect(merged, "a sized catalog row with two protocol endpoints").not.toBeNull();
    expect(legacyId, `a collapsed id of ${merged?.providerId ?? "a merged row"}`).not.toBeNull();
  });

  test.skipIf(legacyId === null)("a collapsed per-protocol id resolves to the row that absorbed it", () => {
    if (merged === null || legacyId === null) return;
    expect(catalogLimitsFor(legacyId)).toBe(MODEL_LIMITS[merged.providerId]!);
  });
});

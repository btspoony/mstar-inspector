import { expect, spyOn, test } from "bun:test";
import { providerCatalog } from "./provider-catalog";

test("a failed catalog build can retry and a successful build stays cached", async () => {
  const failure = new Error("digest temporarily unavailable");
  const digest = spyOn(crypto.subtle, "digest").mockRejectedValueOnce(failure);
  try {
    await expect(providerCatalog()).rejects.toBe(failure);
  } finally {
    digest.mockRestore();
  }
  const retry = providerCatalog();
  const catalog = await retry;
  expect(catalog.version).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.parse(catalog.json).provider_catalog.length).toBeGreaterThan(0);
  expect(providerCatalog()).toBe(retry);
  expect(await providerCatalog()).toBe(catalog);
});

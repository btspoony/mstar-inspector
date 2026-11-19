import { expect, test } from "bun:test";
import { loadProviderCatalog } from "../../src/spa/provider-catalog";

test("catalog loads are shared by version across mounts/workspaces and omit tenant eligibility", async () => {
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    return Response.json({ provider_catalog: [], model_limits_snapshot: "fixture-snapshot" });
  }) as unknown as typeof fetch;
  try {
    const first = loadProviderCatalog("/dashboard/acme", "fixture-cache");
    const concurrent = loadProviderCatalog("/dashboard/beta", "fixture-cache");
    expect(concurrent).toBe(first);
    const result = await first;
    expect(result.provider_catalog).toEqual([]);
    expect(await loadProviderCatalog("/dashboard/acme", "fixture-cache")).toBe(result);
    expect(urls).toEqual(["/dashboard/acme/api/provider-catalog?v=fixture-cache"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("failed or malformed catalogs reject and can be retried", async () => {
  const realFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    if (attempts === 1) return new Response("unavailable", { status: 503 });
    if (attempts === 2) return Response.json({ provider_catalog: "invalid" });
    return Response.json({ provider_catalog: [], model_limits_snapshot: "fixture-snapshot" });
  }) as unknown as typeof fetch;
  try {
    await expect(loadProviderCatalog("/dashboard/acme", "fixture-retry")).rejects.toThrow("HTTP 503");
    await expect(loadProviderCatalog("/dashboard/acme", "fixture-retry")).rejects.toThrow("Invalid provider catalog");
    expect((await loadProviderCatalog("/dashboard/acme", "fixture-retry")).provider_catalog).toEqual([]);
    expect(attempts).toBe(3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

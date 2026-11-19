import { fetchJson } from "./api";
import { parseProviderCatalog, type StaticProviderCatalog } from "./pages/data";

const catalogs = new Map<string, Promise<StaticProviderCatalog>>();

export function loadProviderCatalog(base: string, version: string): Promise<StaticProviderCatalog> {
  const cached = catalogs.get(version);
  if (cached) return cached;
  const pending = fetchJson(`${base}/api/provider-catalog?v=${encodeURIComponent(version)}`)
    .then((value) => {
      const catalog = parseProviderCatalog(value);
      if (!catalog) throw new Error("Invalid provider catalog");
      return catalog;
    }).catch((error: unknown) => {
      catalogs.delete(version);
      throw error;
    });
  catalogs.set(version, pending);
  return pending;
}

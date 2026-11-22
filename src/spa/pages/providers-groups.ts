/**
 * note: Group derivation for the providers settings area.
 *
 * Pure by contract: no `t()`, no relative time, no clock read. Counts and the
 * stored ISO stamps leave here untouched; formatting is the view layer's.
 * Total over any payload — every key provider and every declaration forms a
 * group, a catalog-only id forms none (the catalog is the discovery surface,
 * not configured state).
 */
import type { ProviderManagementPayload, CustomProviderModelsMeta, ProviderKeyRow } from "./data";

export type ProviderGroup = {
  providerId: string;
  /** note: The catalog row this group's label / vocabulary / sizes come from: the
   *  stored id itself, or the provider row a collapsed per-protocol id
   *  resolved to (payload `legacy_of`). */
  catalogId: string;
  label: string;
  kind: "builtin" | "template" | "custom";
  keys: ProviderKeyRow[];
  declaration: {
    base_url: string;
    api: string;
    model_ids: string[];
    models_meta?: CustomProviderModelsMeta;
    /** invariant: The provider row this stored id resolves to (read-only compatibility). */
    legacy_of?: string;
  } | null;
  summary: { total: number; ok: number; reachable: number; failed: number; unverified: number };
};

function summaryOf(keys: readonly ProviderKeyRow[]): ProviderGroup["summary"] {
  const summary = { total: keys.length, ok: 0, reachable: 0, failed: 0, unverified: 0 };
  for (const key of keys) {
    if (key.verifiedStatus === "ok") summary.ok += 1;
    else if (key.verifiedStatus === "reachable") summary.reachable += 1;
    else if (key.verifiedStatus === "failed") summary.failed += 1;
    else summary.unverified += 1;
  }
  return summary;
}

/** note: The stamp a key contributes to its group's order: the verify time wins. */
function newestStamp(group: ProviderGroup): string | null {
  return group.keys.reduce<string | null>((max, key) => {
    const stamp = key.verifiedAt ?? key.updatedAt;
    return stamp !== null && (max === null || stamp > max) ? stamp : max;
  }, null);
}

export function providerGroups(payload: ProviderManagementPayload): ProviderGroup[] {
  const catalog = new Map(payload.provider_catalog.map((entry) => [entry.id, entry]));
  const declarations = new Map(payload.custom_providers.map((row) => [row.provider_id, row]));
  const providerIds = new Set([
    ...payload.keys.map((key) => key.provider),
    ...payload.custom_providers.map((row) => row.provider_id),
  ]);

  const groups = [...providerIds].map((providerId): ProviderGroup => {
    const keys = payload.keys.filter((key) => key.provider === providerId);
    const declaration = declarations.get(providerId) ?? null;
    // note: A declaration stored under a per-protocol id the catalog no longer emits
    // reads through the row that absorbed it; the stored id stays the group key
    // every write and removal names.
    const catalogId = declaration?.legacy_of ?? providerId;
    const catalogEntry = catalog.get(catalogId);
    return {
      providerId,
      catalogId,
      label: catalogEntry?.label ?? providerId,
      kind: catalogEntry?.tier ?? "custom",
      keys,
      declaration,
      summary: summaryOf(keys),
    };
  });

  const withKeys = groups.filter((group) => group.keys.length > 0);
  const withoutKeys = groups.filter((group) => group.keys.length === 0);
  // note: Code-unit order — `localeCompare` would make the list order locale-dependent.
  const byId = (a: ProviderGroup, b: ProviderGroup) =>
    a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
  withKeys.sort((a, b) => {
    const aNewest = newestStamp(a);
    const bNewest = newestStamp(b);
    // note: Groups whose stamps are all null sort last; ties fall back to the id.
    if (aNewest !== bNewest) {
      if (aNewest === null) return 1;
      if (bNewest === null) return -1;
      return aNewest < bNewest ? 1 : -1;
    }
    return byId(a, b);
  });
  withoutKeys.sort(byId);

  return [...withKeys, ...withoutKeys];
}

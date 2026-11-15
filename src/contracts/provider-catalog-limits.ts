/**
 * Catalog sizes for a provider DECLARATION — the bridge between the generated
 * vendor table and a declaration an App saved.
 *
 * A declaration may carry any id matching the grammar, including one that
 * happens to be a catalog id. The vendor's numbers describe the vendor's
 * endpoints, so they are applied only when the declaration IS that catalog row
 * (one of its own base URLs); a private endpoint that reuses the id keeps the
 * operator's own numbers and nothing is filled in for it.
 *
 * A declaration stored under a per-protocol id the catalog no longer emits
 * (`LEGACY_PROVIDER_IDS`) resolves to the row that absorbed it — read-only, so
 * the live P0 (no sizes at all for those providers) is fixed for them too.
 *
 * Zero imports beyond the two generated data modules and the endpoint
 * predicate — the Worker side uses it; the SPA never does (it reads the table
 * through the settings payload).
 */
import { LEGACY_PROVIDER_IDS, PROVIDER_CATALOG } from "./provider-catalog.generated";
import { MODEL_LIMITS, type ModelLimit } from "./provider-model-limits.generated";
import { catalogEndpointsMatch } from "./provider-model-limits";

/**
 * The catalog's per-model sizes for one declaration, or undefined when the
 * declaration is not one of the catalog row's own endpoints (see
 * `catalogEndpointsMatch`: placeholders match one segment, trailing slashes are
 * insignificant).
 */
export function catalogLimitsFor(
  providerId: string,
  baseUrl: string,
): Readonly<Record<string, ModelLimit>> | undefined {
  // Own-property lookups on both tables: a prototype-chain name is never a row.
  const resolvedId = Object.hasOwn(PROVIDER_CATALOG, providerId)
    ? providerId
    : Object.hasOwn(LEGACY_PROVIDER_IDS, providerId)
      ? LEGACY_PROVIDER_IDS[providerId]
      : undefined;
  if (resolvedId === undefined) return undefined;
  const entry = PROVIDER_CATALOG[resolvedId];
  if (entry === undefined) return undefined;
  const endpoints = [entry.baseUrl, ...(entry.protocols ?? []).map((option) => option.baseUrl)];
  if (!catalogEndpointsMatch(endpoints, baseUrl)) return undefined;
  return MODEL_LIMITS[resolvedId];
}

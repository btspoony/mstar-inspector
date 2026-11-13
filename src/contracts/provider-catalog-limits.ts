/**
 * Catalog sizes for a provider DECLARATION — the bridge between the generated
 * vendor table and a declaration an App saved.
 *
 * A declaration may carry any id matching the grammar, including one that
 * happens to be a catalog id. The vendor's numbers describe the vendor's
 * endpoint, so they are applied only when the declaration IS that catalog row
 * (same base URL); a private endpoint that reuses the id keeps the operator's
 * own numbers and nothing is filled in for it.
 *
 * Zero imports beyond the two generated data modules — the Worker side uses it;
 * the SPA never does (it reads the table through the settings payload).
 */
import { PROVIDER_CATALOG } from "./provider-catalog.generated";
import { MODEL_LIMITS, type ModelLimit } from "./provider-model-limits.generated";

/** Trailing-slash-insensitive base-URL comparison. */
function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * The catalog's per-model sizes for one declaration, or undefined when the
 * declaration is not the catalog's own provider row.
 */
export function catalogLimitsFor(
  providerId: string,
  baseUrl: string,
): Readonly<Record<string, ModelLimit>> | undefined {
  const entry = PROVIDER_CATALOG[providerId];
  if (entry === undefined || entry.baseUrl === null) return undefined;
  if (normalizeBaseUrl(entry.baseUrl) !== normalizeBaseUrl(baseUrl)) return undefined;
  return MODEL_LIMITS[providerId];
}

/**
 * Catalog sizes for a provider DECLARATION — the bridge between the generated
 * vendor table and a declaration an App saved.
 *
 * A model's context window and output cap are properties of the MODEL, not of
 * the URL a proxy exposes it on. A declaration therefore resolves by provider
 * id alone (an own-property lookup in the catalog, then the collapsed ids), and
 * the row's numbers apply whatever base URL the declaration carries — the same
 * vendor models are served under several endpoints, and an operator's own
 * endpoint reuses the id. An id that is not a catalog row gets nothing.
 *
 * A declaration stored under a per-protocol id the catalog no longer emits
 * (`LEGACY_PROVIDER_IDS`) resolves to the row that absorbed it — read-only, so
 * the live P0 (no sizes at all for those providers) is fixed for them too.
 *
 * Zero imports beyond the two generated data modules — the Worker side uses it;
 * the SPA never does (it reads the table through the settings payload).
 */
import { LEGACY_PROVIDER_IDS, PROVIDER_CATALOG } from "./provider-catalog.generated";
import { MODEL_LIMITS, type ModelLimit } from "./provider-model-limits.generated";

/**
 * The catalog's per-model sizes for one declaration, or undefined when the id
 * names no catalog row (a private id, a prototype-chain name).
 */
export function catalogLimitsFor(
  providerId: string,
): Readonly<Record<string, ModelLimit>> | undefined {
  // Own-property lookups on both tables: a prototype-chain name is never a row.
  const resolvedId = Object.hasOwn(PROVIDER_CATALOG, providerId)
    ? providerId
    : Object.hasOwn(LEGACY_PROVIDER_IDS, providerId)
      ? LEGACY_PROVIDER_IDS[providerId]
      : undefined;
  return resolvedId === undefined ? undefined : MODEL_LIMITS[resolvedId];
}

import { LEGACY_PROVIDER_IDS, PROVIDER_CATALOG } from "./provider-catalog.generated";
import { MODEL_LIMITS, type ModelLimit } from "./provider-model-limits.generated";

/**
 * The catalog's per-model sizes for one declaration, or undefined when the id
 * names no catalog row (a private id, a prototype-chain name).
 */
export function catalogLimitsFor(
  providerId: string,
): Readonly<Record<string, ModelLimit>> | undefined {
  const resolvedId = Object.hasOwn(PROVIDER_CATALOG, providerId)
    ? providerId
    : Object.hasOwn(LEGACY_PROVIDER_IDS, providerId)
      ? LEGACY_PROVIDER_IDS[providerId]
      : undefined;
  return resolvedId === undefined ? undefined : MODEL_LIMITS[resolvedId];
}

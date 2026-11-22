import { PROVIDER_IDS, PROVIDER_META } from "./app-config-store";
import { PROVIDER_IDS_COMMON } from "../contracts/provider-catalog.generated";
import { MODEL_LIMITS, MODEL_LIMITS_SNAPSHOT } from "../contracts/provider-model-limits.generated";
import { PROVIDER_VERIFY_ENDPOINTS } from "./provider-verify";
import { hasUsageProbe } from "./provider-usage";

let catalog: Promise<{ json: string; version: string }> | undefined;

export function providerCatalog() {
  return catalog ??= (async () => {
    const provider_catalog = [
      ...PROVIDER_IDS.map((id) => {
        const meta = PROVIDER_META[id];
        if (!meta) throw new Error(`PROVIDER_META missing ${id}`);
        return {
          id,
          label: meta.label,
          tier: meta.tier,
          base_url: meta.baseUrl,
          api: meta.api,
          models: [...meta.models],
          model_limits: MODEL_LIMITS[id] ?? {},
          ...(meta.protocols === undefined
            ? {}
            : {
                protocols: meta.protocols.map((option) => ({
                  api: option.api,
                  base_url: option.baseUrl,
                  models: [...option.models],
                })),
              }),
          verifiable: PROVIDER_VERIFY_ENDPOINTS[id]?.kind !== "unsupported",
          usage_probe: hasUsageProbe(id),
          display_group: PROVIDER_IDS_COMMON.includes(id) ? ("common" as const) : ("catalog" as const),
        };
      }),
      ...Object.entries(PROVIDER_META)
        .filter(([id, meta]) => meta.tier === "template" && !PROVIDER_IDS.includes(id))
        .map(([id, meta]) => ({
          id,
          label: meta.label,
          tier: meta.tier,
          base_url: meta.baseUrl,
          api: meta.api,
          models: [...meta.models],
          model_limits: MODEL_LIMITS[id] ?? {},
          ...(meta.protocols === undefined
            ? {}
            : {
                protocols: meta.protocols.map((option) => ({
                  api: option.api,
                  base_url: option.baseUrl,
                  models: [...option.models],
                })),
              }),
          verifiable: true,
          usage_probe: hasUsageProbe(id),
          display_group: PROVIDER_IDS_COMMON.includes(id) ? ("common" as const) : ("catalog" as const),
        })),
    ];
    const json = JSON.stringify({ provider_catalog, model_limits_snapshot: MODEL_LIMITS_SNAPSHOT });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
    const version = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { json, version };
  })().catch((error: unknown) => {
    catalog = undefined;
    throw error;
  });
}

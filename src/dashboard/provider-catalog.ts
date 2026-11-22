import { PROVIDER_IDS, PROVIDER_META } from "./app-config-store";
// invariant: Display-only picker grouping (AD-547). Never a mechanics input —
// the runner BYOK allowlist stays PROVIDER_IDS_BUILTIN / PROVIDER_ENV_NAMES.
import { PROVIDER_IDS_COMMON } from "../contracts/provider-catalog.generated";
import { MODEL_LIMITS, MODEL_LIMITS_SNAPSHOT } from "../contracts/provider-model-limits.generated";
import { PROVIDER_VERIFY_ENDPOINTS } from "./provider-verify";
import { hasUsageProbe } from "./provider-usage";

let catalog: Promise<{ json: string; version: string }> | undefined;

export function providerCatalog() {
  return catalog ??= (async () => {
    // note: Builtin ids in PROVIDER_IDS order, then the template tier (the
    // hand-curated workers-ai entry followed by the snapshot's key order).
    // `verifiable: false` marks the console-only providers (no probeable
    // endpoint: azure-openai / ai-gateway); templates verify via the custom
    // probe, so always verifiable.
    // (AD-547): `display_group` is display-only picker grouping. Array order
    // is unchanged; add/verify/save mechanics branch on tier/eligibility.
    // `usage_probe` marks the providers whose own quota endpoint the per-key
    // usage action can ask, derived from the probe table, not a hand-kept list.
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
          // note: The row's own endpoint: the SPA applies the same base-URL
          // predicate the Worker does before it trusts `model_limits`.
          // The per-model sizes the vendor directory states, keyed by model
          // id. The model dialog pre-fills its blank fields from here and
          // posts no override for a value the operator leaves untouched.
          model_limits: MODEL_LIMITS[id] ?? {},
          // invariant: Mixed-protocol rows only: the protocol choice the add form
          // offers, default first. Absent = a single-protocol row.
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
    // note: The model dialog names this vendor snapshot beside a catalog-supplied
    // size so the operator can judge how fresh it is.
    const json = JSON.stringify({ provider_catalog, model_limits_snapshot: MODEL_LIMITS_SNAPSHOT });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
    const version = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { json, version };
  })().catch((error: unknown) => {
    catalog = undefined;
    throw error;
  });
}

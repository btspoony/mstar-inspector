/**
 * Pipeline face over the generated provider catalog (plan 42 T1 — the
 * catalog SSOT moved to src/contracts/provider-catalog.generated.ts, which
 * the dashboard imports directly; dashboard modules must not import pipeline
 * code, architect decision Q2, so the contract lives in src/contracts/).
 *
 * This file is HAND-WRITTEN, not generated: it re-exports the contract
 * verbatim (PROVIDER_CATALOG / PROVIDER_IDS_BUILTIN / PROVIDERS /
 * providerEnvName / PROVIDER_ENV_NAMES / TEMPLATE_PROVIDERS — export names
 * stable for consumer.ts) PLUS the ../review/runtime env-name helpers below.
 * The generated contract itself stays pure data and must NEVER absorb the
 * review/runtime re-export.
 */

export * from "../contracts/provider-catalog.generated";

/**
 * AL-23-1 custom-provider env-name contract — re-exported from
 * src/review/runtime.ts (the single source of truth): the sandbox image
 * COPYs only src/review (sandbox-image/omp/Dockerfile:96), so the helper must
 * live in-image next to CustomProviderDeclaration; the Worker-side SSOT
 * stays single-source through this re-export (zero duplicated literals).
 */
export {
  CUSTOM_PROVIDER_ENV_PREFIX,
  CUSTOM_PROVIDER_ENV_SUFFIX,
  customProviderEnvName,
} from "../review/runtime";

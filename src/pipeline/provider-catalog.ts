/**
 * Pipeline face over the generated provider catalog (the
 * catalog SSOT lives in src/contracts/provider-catalog.generated.ts, which
 * the dashboard imports directly; dashboard modules must not import pipeline
 * code, architect decision Q2, so the contract lives in src/contracts/).
 *
 * This file is HAND-WRITTEN, not generated: it re-exports the contract
 * verbatim (PROVIDER_CATALOG / PROVIDER_IDS_BUILTIN / PROVIDERS /
 * providerEnvName / PROVIDER_ENV_NAMES / TEMPLATE_PROVIDERS — export names
 * stable for consumer.ts). Provider keys ride the stdin credential payload
 * (`src/review/credential-payload.ts`), which the consumer builds and
 * the in-image runner consumes; there is no scalar env-name helper here.
 */

export * from "../contracts/provider-catalog.generated";

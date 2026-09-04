/**
 * GENERATED FILE — provider catalog (spec §5, plan 35 T3). DO NOT EDIT BY
 * HAND — regenerate with `bun run scripts/generate-provider-catalog.ts` and
 * commit the result as an explicit, reviewable regeneration commit.
 *
 * Source: pinned models.dev snapshot
 * `scripts/provider-catalog/models.dev-2026-09-04.json` (fetched 2026-09-04
 * from https://models.dev/api.json) + the omp-facing override table in the
 * generator (labels / env-name contract / workers-ai template). Runtime is
 * fully static: zero network, zero ai-sdk runtime dependencies — the Worker
 * and the sandbox image only import this module.
 *
 * Tiers: `builtin` = runner-consumable env-name entries (the per-App BYOK
 * allowlist, plan 24 / AL-24-5 — consumer.ts injects ONLY these env names
 * into the review container); `template` = metadata + prefill only,
 * materialized through the existing custom-provider machinery
 * (app_custom_providers) at save time (spec §5).
 */

export type ProviderTier = "builtin" | "template";

export type ProviderCatalogEntry = {
  /** Human-readable provider label (picker/table). */
  label: string;
  /** builtin = runner-consumable env-name entry; template = metadata + prefill only. */
  tier: ProviderTier;
  /** Env var name the key is injected under inside the review container
   *  (builtin tier only; null for template — materialized via
   *  customProviderEnvName). */
  envName: string | null;
  /** Default API base URL. Template entries carry a {account_id} placeholder
   *  the save flow substitutes. */
  baseUrl: string | null;
  /** Custom-provider API protocol to materialize a template with (template
   *  tier only; null for builtin). */
  api: string | null;
  /** Representative model ids (display/prefill metadata). */
  models: readonly string[];
  /** Provider docs URL. */
  doc: string | null;
};

export type ProviderInfo = {
  /** The env var name the key is injected under inside the review container. */
  envName: string;
  /** Human-readable provider label for the picker/table. */
  label: string;
};

export const PROVIDER_CATALOG: Record<string, ProviderCatalogEntry> = {
  "anthropic": {
    "label": "Anthropic",
    "tier": "builtin",
    "envName": "ANTHROPIC_API_KEY",
    "baseUrl": null,
    "api": null,
    "models": [
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-5"
    ],
    "doc": "https://docs.anthropic.com/en/docs/about-claude/models"
  },
  "openai": {
    "label": "OpenAI",
    "tier": "builtin",
    "envName": "OPENAI_API_KEY",
    "baseUrl": null,
    "api": null,
    "models": [
      "chatgpt-image-latest",
      "gpt-3.5-turbo",
      "gpt-4",
      "gpt-4-turbo",
      "gpt-4.1"
    ],
    "doc": "https://platform.openai.com/docs/models"
  },
  "gemini": {
    "label": "Google Gemini",
    "tier": "builtin",
    "envName": "GEMINI_API_KEY",
    "baseUrl": null,
    "api": null,
    "models": [
      "deep-research-max-preview-04-2026",
      "deep-research-preview-04-2026",
      "gemini-2.5-computer-use-preview-10-2025",
      "gemini-2.5-flash",
      "gemini-2.5-flash-image"
    ],
    "doc": "https://ai.google.dev/gemini-api/docs/models"
  },
  "copilot": {
    "label": "GitHub Copilot",
    "tier": "builtin",
    "envName": "COPILOT_GITHUB_TOKEN",
    "baseUrl": "https://api.githubcopilot.com",
    "api": null,
    "models": [
      "claude-fable-5",
      "claude-haiku-4.5",
      "claude-opus-4.5",
      "claude-opus-4.6",
      "claude-opus-4.7"
    ],
    "doc": "https://docs.github.com/en/copilot"
  },
  "azure-openai": {
    "label": "Azure OpenAI",
    "tier": "builtin",
    "envName": "AZURE_OPENAI_API_KEY",
    "baseUrl": null,
    "api": null,
    "models": [
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-haiku-4-5",
      "claude-mythos-5",
      "claude-opus-4-1"
    ],
    "doc": "https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models"
  },
  "groq": {
    "label": "Groq",
    "tier": "builtin",
    "envName": "GROQ_API_KEY",
    "baseUrl": null,
    "api": null,
    "models": [
      "allam-2-7b",
      "canopylabs/orpheus-arabic-saudi",
      "canopylabs/orpheus-v1-english",
      "groq/compound",
      "groq/compound-mini"
    ],
    "doc": "https://console.groq.com/docs/models"
  },
  "cerebras": {
    "label": "Cerebras",
    "tier": "builtin",
    "envName": "CEREBRAS_API_KEY",
    "baseUrl": null,
    "api": null,
    "models": [
      "gemma-4-31b",
      "gpt-oss-120b"
    ],
    "doc": "https://inference-docs.cerebras.ai/models/overview"
  },
  "xai": {
    "label": "xAI",
    "tier": "builtin",
    "envName": "XAI_API_KEY",
    "baseUrl": null,
    "api": null,
    "models": [
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-0309-reasoning",
      "grok-4.20-multi-agent-0309",
      "grok-4.3",
      "grok-4.5"
    ],
    "doc": "https://docs.x.ai/docs/models"
  },
  "openrouter": {
    "label": "OpenRouter",
    "tier": "builtin",
    "envName": "OPENROUTER_API_KEY",
    "baseUrl": "https://openrouter.ai/api/v1",
    "api": null,
    "models": [
      "aion-labs/aion-2.0",
      "aion-labs/aion-3.0",
      "aion-labs/aion-3.0-mini",
      "aion-labs/aion-rp-llama-3.1-8b",
      "amazon/nova-2-lite-v1"
    ],
    "doc": "https://openrouter.ai/models"
  },
  "kilo": {
    "label": "Kilo",
    "tier": "builtin",
    "envName": "KILO_API_KEY",
    "baseUrl": "https://api.kilo.ai/api/gateway",
    "api": null,
    "models": [
      "aion-labs/aion-2.0",
      "aion-labs/aion-3.0",
      "aion-labs/aion-3.0-mini",
      "aion-labs/aion-rp-llama-3.1-8b",
      "amazon/nova-2-lite-v1"
    ],
    "doc": "https://kilo.ai"
  },
  "mistral": {
    "label": "Mistral",
    "tier": "builtin",
    "envName": "MISTRAL_API_KEY",
    "baseUrl": null,
    "api": null,
    "models": [
      "codestral-latest",
      "devstral-2512",
      "devstral-latest",
      "devstral-medium-2507",
      "devstral-medium-latest"
    ],
    "doc": "https://docs.mistral.ai/getting-started/models/"
  },
  "zai": {
    "label": "Z.AI",
    "tier": "builtin",
    "envName": "ZAI_API_KEY",
    "baseUrl": "https://api.z.ai/api/paas/v4",
    "api": null,
    "models": [
      "glm-4.5",
      "glm-4.5-air",
      "glm-4.5-flash",
      "glm-4.5v",
      "glm-4.6"
    ],
    "doc": "https://docs.z.ai/guides/overview/pricing"
  },
  "umans": {
    "label": "Umans AI Coding Plan",
    "tier": "builtin",
    "envName": "UMANS_AI_CODING_PLAN_API_KEY",
    "baseUrl": "https://api.code.umans.ai/v1",
    "api": null,
    "models": [
      "umans-coder",
      "umans-deepseek-v4-flash-0731",
      "umans-deepseek-v4-pro-0813",
      "umans-flash",
      "umans-glm-5.2"
    ],
    "doc": "https://app.umans.ai/offers/code/docs"
  },
  "minimax": {
    "label": "MiniMax",
    "tier": "builtin",
    "envName": "MINIMAX_API_KEY",
    "baseUrl": "https://api.minimax.io/anthropic/v1",
    "api": null,
    "models": [
      "MiniMax-M2",
      "MiniMax-M2.1",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.7"
    ],
    "doc": "https://platform.minimax.io/docs/guides/quickstart"
  },
  "opencode": {
    "label": "OpenCode",
    "tier": "builtin",
    "envName": "OPENCODE_API_KEY",
    "baseUrl": "https://opencode.ai/zen/v1",
    "api": null,
    "models": [
      "big-pickle",
      "claude-3-5-haiku",
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-haiku-4-5"
    ],
    "doc": "https://opencode.ai/docs/zen"
  },
  "cursor": {
    "label": "Cursor",
    "tier": "builtin",
    "envName": "CURSOR_ACCESS_TOKEN",
    "baseUrl": null,
    "api": null,
    "models": [],
    "doc": "https://cursor.com/docs/api/overview"
  },
  "ai-gateway": {
    "label": "AI Gateway",
    "tier": "builtin",
    "envName": "AI_GATEWAY_API_KEY",
    "baseUrl": null,
    "api": null,
    "models": [
      "alibaba/qwen3-max",
      "alibaba/qwen3.5-397b-a17b",
      "alibaba/qwen3.7-max",
      "alibaba/qwen3.7-plus",
      "alibaba/qwen3.8-max"
    ],
    "doc": "https://developers.cloudflare.com/ai-gateway/"
  },
  "wafer-serverless": {
    "label": "Wafer Serverless",
    "tier": "builtin",
    "envName": "WAFER_SERVERLESS_API_KEY",
    "baseUrl": "https://pass.wafer.ai/v1",
    "api": null,
    "models": [
      "GLM-5.1",
      "GLM-5.2",
      "Kimi-K2.6",
      "MiniMax-M3",
      "glm5.2-fast"
    ],
    "doc": "https://docs.wafer.ai/wafer-pass"
  },
  "ark": {
    "label": "Ark",
    "tier": "builtin",
    "envName": "ARK_API_KEY",
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "api": null,
    "models": [
      "deepseek-v4-flash-ga-260731",
      "deepseek-v4-pro-ga-260813",
      "doubao-seed-1-6-251015",
      "doubao-seed-1-6-flash-250828",
      "doubao-seed-1-6-vision-250815"
    ],
    "doc": "https://www.volcengine.com/docs/82379/1330310"
  },
  "workers-ai": {
    "label": "Cloudflare Workers AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    "api": "openai-completions",
    "models": [
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      "@cf/qwen/qwen3-30b-a3b-fp8",
      "@cf/qwen/qwen2.5-coder-32b-instruct",
      "@cf/deepseek-ai/deepseek-v4-flash-0731",
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
      "@cf/google/gemma-4-26b-a4b-it",
      "@cf/mistralai/mistral-small-3.1-24b-instruct"
    ],
    "doc": "https://developers.cloudflare.com/workers-ai/models/"
  }
};

/** The builtin tier as the legacy env-name mapping (consumer.ts:64
 *  consumption surface — the per-App BYOK allowlist). */
export const PROVIDERS: Record<string, ProviderInfo> = Object.fromEntries(
  Object.entries(PROVIDER_CATALOG)
    .filter(([, entry]) => entry.tier === "builtin")
    .map(([id, entry]) => [id, { envName: entry.envName!, label: entry.label }]),
) as Record<string, ProviderInfo>;

/** Resolve the env var name a provider key is injected under, or undefined if unknown. */
export function providerEnvName(name: string): string | undefined {
  return PROVIDERS[name]?.envName;
}

/** Every provider key env name, in mapping order (frozen snapshot). */
export const PROVIDER_ENV_NAMES: readonly string[] = Object.freeze(
  Object.values(PROVIDERS).map((info) => info.envName),
);

/** The template tier (metadata + prefill only — not runner-consumable). */
export const TEMPLATE_PROVIDERS: Record<string, ProviderCatalogEntry> = Object.fromEntries(
  Object.entries(PROVIDER_CATALOG).filter(([, entry]) => entry.tier === "template"),
) as Record<string, ProviderCatalogEntry>;

/**
 * AL-23-1 custom-provider env-name contract — re-exported from
 * src/review/runtime.ts (the single source of truth): the sandbox image
 * COPYs only src/review (sandbox-image/Dockerfile:88), so the helper must
 * live in-image next to CustomProviderDeclaration; the Worker-side SSOT
 * stays single-source through this re-export (zero duplicated literals).
 */
export {
  CUSTOM_PROVIDER_ENV_PREFIX,
  CUSTOM_PROVIDER_ENV_SUFFIX,
  customProviderEnvName,
} from "../review/runtime";

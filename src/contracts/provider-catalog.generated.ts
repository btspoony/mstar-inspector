/**
 * GENERATED FILE — provider catalog (plan 42 T1; originally plan 35 T3,
 * spec §5). DO NOT EDIT BY HAND — regenerate with
 * `bun run scripts/generate-provider-catalog.ts` and commit the result as
 * an explicit, reviewable regeneration commit.
 *
 * Source: pinned models.dev snapshot
 * `scripts/provider-catalog/models.dev-2026-09-04.json` (fetched 2026-09-04
 * from https://models.dev/api.json; the `api` field carries the base URL)
 * + the omp-facing override table in the generator (labels / env-name
 * contract / workers-ai template). Runtime is fully static: zero network,
 * zero ai-sdk runtime dependencies — the Worker, the dashboard, and the
 * sandbox image only import this module. PURE DATA + pure derivations:
 * zero imports of any kind.
 *
 * Tiers: `builtin` = runner-consumable env-name entries (the per-App BYOK
 * allowlist, plan 24 / AL-24-5 — consumer.ts injects ONLY these env names
 * into the review container); `template` = metadata + prefill only,
 * materialized through the existing custom-provider machinery
 * (app_custom_providers) at save time (spec §5). The hand-curated
 * `workers-ai` template carries the {account_id} base-URL placeholder the
 * save flow substitutes.
 *
 * Breadth enumeration (deterministic, auditable — every excluded snapshot
 * key names its rule; 213 snapshot keys → 194 breadth template entries):
 *   - rule (a) excluded as a builtin sourceKey (18 — no duplicate
 *     vendor rows beside the builtin tier): groq, volcengine, minimax, anthropic, google, cloudflare-ai-gateway, github-copilot, umans-ai-coding-plan, wafer.ai, kilo, azure, opencode, openrouter, openai, xai, zai, mistral, cerebras
 *   - rule (b) deduped into a hand-curated template (1):
 *     cloudflare-workers-ai → workers-ai (the curated entry is preserved verbatim)
 *   - rule (c) skipped, failing CUSTOM_PROVIDER_ID_PATTERN (0 additional
 *     after rules a/b): (none)
 *   - models prefill cap: at most the first 20 model ids per provider
 *     (deterministic snapshot order — template prefill only)
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
  /** Default API base URL. Template entries may carry a {account_id}
   *  placeholder the save flow substitutes. */
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
  },
  "subconscious": {
    "label": "Subconscious",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.subconscious.dev/v1",
    "api": "openai-completions",
    "models": [
      "subconscious/glm-5.2",
      "subconscious/tim-qwen3.6-27b"
    ],
    "doc": "https://docs.subconscious.dev"
  },
  "tokengo": {
    "label": "TokenGo",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.tokengo.com/v1",
    "api": "openai-completions",
    "models": [
      "deepseek/deepseek-v3.1",
      "deepseek/deepseek-v3.2",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "minimax/minimax-m2.5",
      "moonshotai/kimi-k2.6",
      "moonshotai/kimi-k3",
      "qwen/qwen3.5-397b-a17b",
      "z-ai/glm-5",
      "z-ai/glm-5.1",
      "z-ai/glm-5.2",
      "z-ai/glm-5.3",
      "z-ai/glm-5.3-flash"
    ],
    "doc": "https://www.tokengo.com/docs"
  },
  "modelis": {
    "label": "Modelis",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://modelishub.com/v1",
    "api": "openai-completions",
    "models": [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "qwen/qwen3.7-max",
      "qwen/qwen3.7-plus"
    ],
    "doc": "https://modelishub.com/pricing"
  },
  "bothub": {
    "label": "Bothub",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://openai.bothub.ru/v1",
    "api": "openai-completions",
    "models": [
      "gemma-4-31b-it:free",
      "nemotron-3-ultra-550b-a55b:free"
    ],
    "doc": "https://bothub.ru/models"
  },
  "greenpt": {
    "label": "GreenPT",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.greenpt.ai/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-v4-flash-0731",
      "devstral-2-123b-instruct-2512",
      "gemma-3-27b-it",
      "gemma4",
      "glm-5.1",
      "glm-5.2",
      "glm-5.2-caveman",
      "glm-5.2-caveman-lite",
      "glm-5.2-caveman-ultra",
      "glm-5.2-honey",
      "glm-5.2-honey-lite",
      "glm-5.2-honey-ultra",
      "glm-5.2-ponytail",
      "glm-5.2-ponytail-lite",
      "glm-5.2-ponytail-ultra",
      "gpt-oss-120b",
      "green-l",
      "green-l-raw",
      "green-r",
      "green-r-raw"
    ],
    "doc": "https://docs.greenpt.ai"
  },
  "qiniu-ai": {
    "label": "Qiniu",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.qnaigc.com/v1",
    "api": "openai-completions",
    "models": [
      "MiniMax-M1",
      "claude-3.5-haiku",
      "claude-3.5-sonnet",
      "claude-3.7-sonnet",
      "claude-4.0-opus",
      "claude-4.0-sonnet",
      "claude-4.1-opus",
      "claude-4.5-haiku",
      "claude-4.5-opus",
      "claude-4.5-sonnet",
      "deepseek-r1",
      "deepseek-r1-0528",
      "deepseek-v3",
      "deepseek-v3-0324",
      "deepseek-v3.1",
      "deepseek/deepseek-math-v2",
      "deepseek/deepseek-v3.1-terminus",
      "deepseek/deepseek-v3.1-terminus-thinking",
      "deepseek/deepseek-v3.2-251201",
      "deepseek/deepseek-v3.2-exp"
    ],
    "doc": "https://developer.qiniu.com/aitokenapi"
  },
  "ambient": {
    "label": "Ambient",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.ambient.xyz/v1",
    "api": "openai-completions",
    "models": [
      "ambient/large",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-0731",
      "moonshotai/kimi-k2.6",
      "moonshotai/kimi-k2.7-code",
      "stepfun/step-3.7-flash",
      "xiaomi/mimo-v2.5",
      "z-ai/glm-5.2",
      "zai-org/GLM-5.1-FP8",
      "zai-org/GLM-5.2-FP8"
    ],
    "doc": "https://ambient.xyz"
  },
  "agentrouter": {
    "label": "AgentRouter",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://agentrouter.org/v1",
    "api": "openai-completions",
    "models": [
      "claude-opus-4-8",
      "claude-opus-5",
      "gpt-5.6-sol"
    ],
    "doc": "https://agentrouter.org/docs/opencode.html"
  },
  "xiaomi-token-plan-cn": {
    "label": "Xiaomi Token Plan (China)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://token-plan-cn.xiaomimimo.com/v1",
    "api": "openai-completions",
    "models": [
      "mimo-v2-pro",
      "mimo-v2-tts",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "mimo-v2.5-tts",
      "mimo-v2.5-tts-voiceclone",
      "mimo-v2.5-tts-voicedesign"
    ],
    "doc": "https://platform.xiaomimimo.com/#/docs"
  },
  "nano-gpt": {
    "label": "NanoGPT",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://nano-gpt.com/api/v1",
    "api": "openai-completions",
    "models": [
      "Doctor-Shotgun/MS3.2-24B-Magnum-Diamond",
      "EVA-UNIT-01/EVA-LLaMA-3.33-70B-v0.0",
      "EVA-UNIT-01/EVA-LLaMA-3.33-70B-v0.1",
      "EVA-UNIT-01/EVA-Qwen2.5-32B-v0.2",
      "EVA-UNIT-01/EVA-Qwen2.5-72B-v0.2",
      "Envoid/Llama-3.05-NT-Storybreaker-Ministral-70B",
      "Envoid/Llama-3.05-Nemotron-Tenyxchat-Storybreaker-70B",
      "GLM-4.6-Derestricted-v5",
      "GalrionSoftworks/MN-LooseCannon-12B-v1",
      "Gemma-4-26B-A4B-MeroMero",
      "Gemma-4-26B-A4B-MeroMero:thinking",
      "Gemma-4-31B-Claude-4.6-Opus-Reasoning-Distilled",
      "Gemma-4-31B-Cognitive-Unshackled",
      "Gemma-4-31B-DarkIdol",
      "Gemma-4-31B-GarnetV2",
      "Gemma-4-31B-MeroMero-v2",
      "Gemma-4-31B-MeroMero-v2:thinking",
      "Gemma-4-31B-Queen",
      "Gryphe/MythoMax-L2-13b",
      "LLM360/K2-Think"
    ],
    "doc": "https://docs.nano-gpt.com"
  },
  "watsonx": {
    "label": "watsonx.ai",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "ibm/granite-4-h-small",
      "meta-llama/llama-3-3-70b-instruct",
      "meta-llama/llama-4-maverick-17b-128e-instruct-fp8",
      "mistralai/mistral-small-3-1-24b-instruct-2503",
      "openai/gpt-oss-120b"
    ],
    "doc": "https://www.ibm.com/docs/en/watsonx/saas?topic=solutions-supported-foundation-models"
  },
  "digitalocean": {
    "label": "DigitalOcean",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://inference.do-ai.run/v1",
    "api": "openai-completions",
    "models": [
      "alibaba-qwen3-32b",
      "all-mini-lm-l6-v2",
      "anthropic-claude-3-opus",
      "anthropic-claude-3.5-haiku",
      "anthropic-claude-3.5-sonnet",
      "anthropic-claude-3.7-sonnet",
      "anthropic-claude-4.1-opus",
      "anthropic-claude-4.5-haiku",
      "anthropic-claude-4.5-sonnet",
      "anthropic-claude-4.6-sonnet",
      "anthropic-claude-5-sonnet",
      "anthropic-claude-fable-5",
      "anthropic-claude-fable-5.1",
      "anthropic-claude-haiku-4.5",
      "anthropic-claude-opus-4",
      "anthropic-claude-opus-4.5",
      "anthropic-claude-opus-4.6",
      "anthropic-claude-opus-4.7",
      "anthropic-claude-opus-4.8",
      "anthropic-claude-opus-5"
    ],
    "doc": "https://docs.digitalocean.com/products/gradient-ai-platform/details/models/"
  },
  "vivgrid": {
    "label": "Vivgrid",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.vivgrid.com/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-v3.2",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "gemini-3.1-flash-lite-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.7-flash",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "gpt-5-mini",
      "gpt-5.1-codex",
      "gpt-5.1-codex-max",
      "gpt-5.2-codex",
      "gpt-5.3-codex",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol"
    ],
    "doc": "https://docs.vivgrid.com/models"
  },
  "auriko": {
    "label": "Auriko",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.auriko.ai/v1",
    "api": "openai-completions",
    "models": [
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3.1-pro-preview",
      "glm-5.1",
      "grok-4.3",
      "kimi-k2.5",
      "kimi-k2.6",
      "minimax-m2-7",
      "minimax-m2-7-highspeed",
      "qwen-3.6-plus"
    ],
    "doc": "https://docs.auriko.ai"
  },
  "siliconflow-cn": {
    "label": "SiliconFlow (China)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.siliconflow.cn/v1",
    "api": "openai-completions",
    "models": [
      "ByteDance-Seed/Seed-OSS-36B-Instruct",
      "PaddlePaddle/PaddleOCR-VL-1.5",
      "Pro/MiniMaxAI/MiniMax-M2.5",
      "Pro/deepseek-ai/DeepSeek-R1",
      "Pro/deepseek-ai/DeepSeek-V3",
      "Pro/deepseek-ai/DeepSeek-V3.1-Terminus",
      "Pro/deepseek-ai/DeepSeek-V3.2",
      "Pro/moonshotai/Kimi-K2.5",
      "Pro/moonshotai/Kimi-K2.6",
      "Pro/zai-org/GLM-5",
      "Pro/zai-org/GLM-5.1",
      "Qwen/Qwen2.5-72B-Instruct",
      "Qwen/Qwen2.5-7B-Instruct",
      "Qwen/Qwen3-14B",
      "Qwen/Qwen3-235B-A22B-Thinking-2507",
      "Qwen/Qwen3-30B-A3B-Instruct-2507",
      "Qwen/Qwen3-32B",
      "Qwen/Qwen3-8B",
      "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      "Qwen/Qwen3-Coder-480B-A35B-Instruct"
    ],
    "doc": "https://cloud.siliconflow.com/models"
  },
  "nova": {
    "label": "Nova",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.nova.amazon.com/v1",
    "api": "openai-completions",
    "models": [
      "nova-2-lite-v1",
      "nova-2-pro-v1"
    ],
    "doc": "https://nova.amazon.com/dev/documentation"
  },
  "inceptron": {
    "label": "Inceptron",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.inceptron.io/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-ai/DeepSeek-V4-Flash-0731",
      "moonshotai/Kimi-K2.6",
      "moonshotai/Kimi-K2.7-Code",
      "zai-org/GLM-5.2"
    ],
    "doc": "https://docs.inceptron.io"
  },
  "vultr": {
    "label": "Vultr",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.vultrinference.com/v1",
    "api": "openai-completions",
    "models": [
      "MiniMaxAI/MiniMax-M2.7",
      "Qwen/Qwen3.5-397B-A17B",
      "Qwen/Qwen3.6-27B",
      "XiaomiMiMo/MiMo-V2.5-Pro",
      "deepseek-ai/DeepSeek-V4-Flash",
      "moonshotai/Kimi-K2.6",
      "nvidia/DeepSeek-V3.2-NVFP4",
      "nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16",
      "nvidia/Nemotron-Cascade-2-30B-A3B",
      "zai-org/GLM-5.2-FP8"
    ],
    "doc": "https://api.vultrinference.com/"
  },
  "ollama-cloud": {
    "label": "Ollama Cloud",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://ollama.com/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-v4-flash",
      "deepseek-v4-flash:0731",
      "deepseek-v4-pro",
      "gemma4:31b",
      "glm-5.1",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "gpt-oss:120b",
      "gpt-oss:20b",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k3",
      "minimax-m2.5",
      "minimax-m2.7",
      "minimax-m3",
      "mistral-large-3:675b",
      "nemotron-3-nano:30b",
      "nemotron-3-super"
    ],
    "doc": "https://docs.ollama.com/cloud"
  },
  "freemodel": {
    "label": "FreeModel",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://cc.freemodel.dev/v1",
    "api": "openai-completions",
    "models": [
      "claude-fable-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "gpt-5.3-codex",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5"
    ],
    "doc": "https://freemodel.dev"
  },
  "iflowcn": {
    "label": "iFlow",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://apis.iflow.cn/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-r1",
      "deepseek-v3",
      "deepseek-v3.2",
      "glm-4.6",
      "kimi-k2",
      "kimi-k2-0905",
      "qwen3-235b",
      "qwen3-235b-a22b-instruct",
      "qwen3-235b-a22b-thinking-2507",
      "qwen3-32b",
      "qwen3-coder-plus",
      "qwen3-max",
      "qwen3-max-preview",
      "qwen3-vl-plus"
    ],
    "doc": "https://platform.iflow.cn/en/docs"
  },
  "scx-ai": {
    "label": "SCX.ai",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.scx.ai/v1",
    "api": "openai-completions",
    "models": [
      "GLM-5.2",
      "MiniMax-M2.7",
      "Qwen3.8-Max",
      "gpt-oss-120b"
    ],
    "doc": "https://platform.scx.ai/docs"
  },
  "evroc": {
    "label": "evroc",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://models.think.evroc.com/v1",
    "api": "openai-completions",
    "models": [
      "KBLab/kb-whisper-large",
      "Qwen/Qwen3-Embedding-8B",
      "Qwen/Qwen3-Reranker-4B",
      "Qwen/Qwen3.6-35B-A3B",
      "Qwen/Qwen3.8-27B",
      "evroc/roc",
      "google/gemma-4-26B-A4B-it",
      "intfloat/multilingual-e5-large-instruct",
      "mistralai/Mistral-Medium-3.5-128B",
      "mistralai/Voxtral-Small-24B-2507",
      "moonshotai/Kimi-K2.6",
      "nvidia/Llama-3.3-70B-Instruct-FP8",
      "openai/gpt-oss-120b",
      "openai/whisper-large-v3",
      "openai/whisper-large-v3-turbo",
      "zai-org/GLM-5.2"
    ],
    "doc": "https://docs.evroc.com/products/think/overview.html"
  },
  "echo": {
    "label": "Echo",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://echo.tracerml.ai/v1",
    "api": "openai-completions",
    "models": [
      "echo"
    ],
    "doc": "https://echo.tracerml.ai/docs/api"
  },
  "aixy": {
    "label": "Aixy",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.aixy-gateway.com/v1",
    "api": "openai-completions",
    "models": [
      "openai/gpt-4.1-mini"
    ],
    "doc": "https://docs.aixy-gateway.com/integrations/overview"
  },
  "impossibl": {
    "label": "Impossibl",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.impossibl.com/v1",
    "api": "openai-completions",
    "models": [
      "anthropic/claude-fable-5",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-5",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-opus-4-7",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-sonnet-5",
      "cerebras/gpt-oss-120b",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "fireworks/glm-5.2",
      "fireworks/gpt-oss-120b",
      "fireworks/gpt-oss-20b",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-flash-lite",
      "google/gemini-2.5-pro",
      "google/gemini-3.1-flash-lite",
      "google/gemini-3.1-pro-preview"
    ],
    "doc": "https://impossibl.com/docs/models"
  },
  "llmgateway-providers": {
    "label": "LLM Gateway",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.llmgateway.io/v1",
    "api": "openai-completions",
    "models": [
      "alibaba/deepseek-v4-flash",
      "alibaba/deepseek-v4-pro",
      "alibaba/glm-5",
      "alibaba/glm-5.2",
      "alibaba/kimi-k2.5",
      "alibaba/qwen-coder-plus",
      "alibaba/qwen-flash",
      "alibaba/qwen-max",
      "alibaba/qwen-omni-turbo",
      "alibaba/qwen-plus",
      "alibaba/qwen-plus-latest",
      "alibaba/qwen3-coder-flash",
      "alibaba/qwen3-coder-plus",
      "alibaba/qwen3-max",
      "alibaba/qwen3-vl-flash",
      "alibaba/qwen3-vl-plus",
      "alibaba/qwen3.6-35b-a3b",
      "alibaba/qwen3.6-flash",
      "alibaba/qwen3.6-max-preview",
      "alibaba/qwen3.6-plus"
    ],
    "doc": "https://llmgateway.io/docs"
  },
  "llama": {
    "label": "Llama",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.llama.com/compat/v1/",
    "api": "openai-completions",
    "models": [
      "cerebras-llama-4-maverick-17b-128e-instruct",
      "cerebras-llama-4-scout-17b-16e-instruct",
      "groq-llama-4-maverick-17b-128e-instruct",
      "llama-3.3-70b-instruct",
      "llama-3.3-8b-instruct",
      "llama-4-maverick-17b-128e-instruct-fp8",
      "llama-4-scout-17b-16e-instruct-fp8"
    ],
    "doc": "https://llama.developer.meta.com/docs/models"
  },
  "alibaba-token-plan": {
    "label": "Alibaba Token Plan",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "api": "openai-completions",
    "models": [
      "MiniMax-M2.5",
      "deepseek-v3.2",
      "deepseek-v4-flash",
      "deepseek-v4-flash-0731",
      "deepseek-v4-pro",
      "deepseek-v4-pro-0813",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
      "happyhorse-1.1-i2v",
      "happyhorse-1.1-r2v",
      "happyhorse-1.1-t2v",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "qwen-image-2.0",
      "qwen-image-2.0-pro",
      "qwen3.6-flash",
      "qwen3.6-plus",
      "qwen3.7-max"
    ],
    "doc": "https://www.alibabacloud.com/help/en/model-studio/token-plan-overview"
  },
  "neuralwatt": {
    "label": "Neuralwatt",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.neuralwatt.com/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-v4-flash",
      "deepseek-v4-flash-flex",
      "deepseek-v4-pro",
      "gemma-4-31b",
      "glm-5.2",
      "glm-5.2-fast",
      "glm-5.2-flex",
      "glm-5.2-short",
      "glm-5.2-short-fast",
      "glm-5.2-short-fast-flex",
      "glm-5.2-short-flex",
      "glm-5.3",
      "kimi-k2.7-code",
      "kimi-k2.7-code-fast",
      "kimi-k2.7-code-flex",
      "kimi-k3",
      "kimi-k3-fast",
      "kimi-k3-flex",
      "qwen-3.8-27b",
      "qwen3.6-35b"
    ],
    "doc": "https://portal.neuralwatt.com/docs"
  },
  "abliteration-ai": {
    "label": "abliteration.ai",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.abliteration.ai/v1",
    "api": "openai-completions",
    "models": [
      "abliterated-model",
      "abliterated-model-large",
      "abliterated-model-large-v2"
    ],
    "doc": "https://docs.abliteration.ai/models"
  },
  "clarifai": {
    "label": "Clarifai",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.clarifai.com/v2/ext/openai/v1",
    "api": "openai-completions",
    "models": [
      "arcee_ai/AFM/models/trinity-mini",
      "clarifai/main/models/mm-poly-8b",
      "deepseek-ai/deepseek-ocr/models/DeepSeek-OCR",
      "minimaxai/chat-completion/models/MiniMax-M2_5-high-throughput",
      "mistralai/completion/models/Ministral-3-14B-Reasoning-2512",
      "mistralai/completion/models/Ministral-3-3B-Reasoning-2512",
      "moonshotai/chat-completion/models/Kimi-K2_6",
      "openai/chat-completion/models/gpt-oss-120b-high-throughput",
      "openai/chat-completion/models/gpt-oss-20b",
      "qwen/qwenCoder/models/Qwen3-Coder-30B-A3B-Instruct",
      "qwen/qwenLM/models/Qwen3-30B-A3B-Instruct-2507",
      "qwen/qwenLM/models/Qwen3-30B-A3B-Thinking-2507"
    ],
    "doc": "https://docs.clarifai.com/compute/inference/"
  },
  "morph": {
    "label": "Morph",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.morphllm.com/v1",
    "api": "openai-completions",
    "models": [
      "auto",
      "morph-v3-fast",
      "morph-v3-large"
    ],
    "doc": "https://docs.morphllm.com/api-reference/introduction"
  },
  "aihubmix": {
    "label": "AIHubMix",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "alicloud-deepseek-v4-flash",
      "alicloud-deepseek-v4-pro",
      "alicloud-glm-5.1",
      "claude-fable-5",
      "claude-opus-4-6",
      "claude-opus-4-6-think",
      "claude-opus-4-7",
      "claude-opus-4-7-think",
      "claude-opus-4-8",
      "claude-opus-4-8-think",
      "claude-opus-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-6-think",
      "claude-sonnet-5",
      "coding-glm-5.1",
      "coding-glm-5.1-free",
      "coding-minimax-m2.7",
      "coding-minimax-m2.7-free",
      "coding-minimax-m2.7-highspeed",
      "coding-xiaomi-mimo-v2.5"
    ],
    "doc": "https://docs.aihubmix.com"
  },
  "chutes": {
    "label": "Chutes",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://llm.chutes.ai/v1",
    "api": "openai-completions",
    "models": [
      "Nemotron-3-Nano-Omni-30B-TEE",
      "Qwen/Qwen3-235B-A22B-Thinking-2507-TEE",
      "Qwen/Qwen3-32B-TEE",
      "Qwen/Qwen3.5-397B-A17B-TEE",
      "Qwen/Qwen3.6-27B-TEE",
      "Qwen/Qwen3.8-27B-TEE",
      "deepseek-ai/DeepSeek-V3.2-TEE",
      "deepseek-ai/DeepSeek-V4-Flash-0731-TEE",
      "google/gemma-4-31B-turbo-TEE",
      "moonshotai/Kimi-K2.6-TEE",
      "moonshotai/Kimi-K3-TEE",
      "unsloth/Mistral-Nemo-Instruct-2407-TEE",
      "zai-org/GLM-5.1-TEE",
      "zai-org/GLM-5.2-TEE"
    ],
    "doc": "https://llm.chutes.ai/v1/models"
  },
  "zai-coding-plan": {
    "label": "Z.AI Coding Plan",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.z.ai/api/coding/paas/v4",
    "api": "openai-completions",
    "models": [
      "glm-4.7",
      "glm-5-turbo",
      "glm-5.2",
      "glm-5.2-highspeed",
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.3-highspeed"
    ],
    "doc": "https://docs.z.ai/devpack/overview"
  },
  "sensenova": {
    "label": "SenseNova (China)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://token.sensenova.cn/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-v4-flash",
      "glm-5.2",
      "sensenova-6.8-flash-lite"
    ],
    "doc": "https://platform.sensenova.cn/docs"
  },
  "orcarouter": {
    "label": "OrcaRouter",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.orcarouter.ai/v1",
    "api": "openai-completions",
    "models": [
      "anthropic/claude-fable-5",
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-opus-4.5",
      "anthropic/claude-opus-4.6",
      "anthropic/claude-opus-4.7",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-sonnet-5",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-0731",
      "deepseek/deepseek-v4-flash-free",
      "deepseek/deepseek-v4-flash-vision-exp",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-pro-0813",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-flash-lite"
    ],
    "doc": "https://docs.orcarouter.ai"
  },
  "routing-run": {
    "label": "routing.run",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.routing.run/v1",
    "api": "openai-completions",
    "models": [
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "glm-5.2",
      "glm-5.2-nitro",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "kimi-k2.6",
      "kimi-k2.6-nitro",
      "kimi-k2.7-code",
      "kimi-k2.7-code-nitro",
      "nemotron-3-ultra",
      "qwen3.5-9b"
    ],
    "doc": "https://docs.routing.run/api-reference/models"
  },
  "llmtech": {
    "label": "LLM Tech",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.llmtech.eu/v1",
    "api": "openai-completions",
    "models": [
      "unsloth/Qwen3.8-27B-NVFP4"
    ],
    "doc": "https://llmtech.eu/models/qwen3.8-27b"
  },
  "sap-ai-core": {
    "label": "SAP AI Core",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "amazon--nova-lite",
      "amazon--nova-micro",
      "amazon--nova-pro",
      "amazon--titan-embed-text",
      "anthropic--claude-3-haiku",
      "anthropic--claude-3-opus",
      "anthropic--claude-3-sonnet",
      "anthropic--claude-3.5-sonnet",
      "anthropic--claude-3.7-sonnet",
      "anthropic--claude-4-opus",
      "anthropic--claude-4-sonnet",
      "anthropic--claude-4.5-haiku",
      "anthropic--claude-4.5-opus",
      "anthropic--claude-4.5-sonnet",
      "anthropic--claude-4.6-opus",
      "anthropic--claude-4.6-sonnet",
      "anthropic--claude-4.7-opus",
      "anthropic--claude-4.8-opus",
      "cohere--command-a-reasoning",
      "gemini-2.5-flash"
    ],
    "doc": "https://help.sap.com/docs/sap-ai-core"
  },
  "alibaba-coding-plan-cn": {
    "label": "Alibaba Coding Plan (China)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://coding.dashscope.aliyuncs.com/v1",
    "api": "openai-completions",
    "models": [
      "MiniMax-M2.5",
      "glm-4.7",
      "glm-5",
      "kimi-k2.5",
      "qwen3-coder-next",
      "qwen3-coder-plus",
      "qwen3-max-2026-01-23",
      "qwen3.5-plus",
      "qwen3.6-flash",
      "qwen3.6-plus",
      "qwen3.7-max",
      "qwen3.7-plus"
    ],
    "doc": "https://help.aliyun.com/zh/model-studio/coding-plan"
  },
  "azure-cognitive-services": {
    "label": "Azure Cognitive Services",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-haiku-4-5",
      "claude-mythos-5",
      "claude-opus-4-1",
      "claude-opus-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "codestral-2501",
      "codex-mini",
      "cohere-command-a",
      "cohere-embed-v-4-0",
      "cohere-embed-v3-english",
      "cohere-embed-v3-multilingual",
      "deepseek-r1"
    ],
    "doc": "https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models"
  },
  "regolo-ai": {
    "label": "Regolo AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.regolo.ai/v1",
    "api": "openai-completions",
    "models": [
      "apertus-70b",
      "brick-complexity-pro",
      "brick-v1-beta",
      "deepseek-ocr-2",
      "faster-whisper-large-v3",
      "gemma4-31b",
      "glm5.2",
      "gpt-oss-120b",
      "gpt-oss-20b",
      "llama-3.3-70b-instruct",
      "mistral-small-4-119b",
      "qwen-image",
      "qwen3-coder-next",
      "qwen3-embedding-8b",
      "qwen3-reranker-4b",
      "qwen3.5-122b",
      "qwen3.5-9b",
      "qwen3.8-27b"
    ],
    "doc": "https://docs.regolo.ai/"
  },
  "kenari": {
    "label": "Kenari",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://kenari.id/v1",
    "api": "openai-completions",
    "models": [
      "claude-fable-5",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "deepseek-v4-flash",
      "deepseek-v4-flash:free",
      "deepseek-v4-pro",
      "gemini-2-5-flash",
      "gemini-2-5-flash-lite",
      "gemini-3-1-flash-lite",
      "gemini-3-1-flash-tts",
      "gemini-3-1-pro",
      "gemini-3-5-flash",
      "gemini-3-6-flash",
      "gemini-3-7-flash",
      "gemma-4-31b-it",
      "glm-4-7-flash:free",
      "glm-5-1"
    ],
    "doc": "https://kenari.id/docs"
  },
  "the-grid-ai": {
    "label": "The Grid AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.thegrid.ai/v1",
    "api": "openai-completions",
    "models": [
      "agent-max",
      "agent-prime",
      "agent-standard",
      "code-max",
      "code-prime",
      "code-standard",
      "text-max",
      "text-prime",
      "text-standard"
    ],
    "doc": "https://thegrid.ai/docs"
  },
  "google-vertex": {
    "label": "Vertex",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "claude-fable-5-1@default",
      "claude-fable-5@default",
      "claude-haiku-4-5@20251001",
      "claude-opus-4-1@20250805",
      "claude-opus-4-5@20251101",
      "claude-opus-4-6@default",
      "claude-opus-4-7@default",
      "claude-opus-4-8@default",
      "claude-opus-4@20250514",
      "claude-opus-5@default",
      "claude-sonnet-4-5@20250929",
      "claude-sonnet-4-6@default",
      "claude-sonnet-4@20250514",
      "claude-sonnet-5@default",
      "deepseek-ai/deepseek-v3.1-maas",
      "deepseek-ai/deepseek-v3.2-maas",
      "gemini-2.5-flash",
      "gemini-2.5-flash-image",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash-tts"
    ],
    "doc": "https://cloud.google.com/vertex-ai/generative-ai/docs/models"
  },
  "stepfun-ai": {
    "label": "StepFun (Global)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.stepfun.ai/v1",
    "api": "openai-completions",
    "models": [
      "step-1-32k",
      "step-2-16k",
      "step-3.5-flash",
      "step-3.5-flash-2603",
      "step-3.7-flash",
      "step-tts-2",
      "stepaudio-2.5-asr",
      "stepaudio-2.5-tts"
    ],
    "doc": "https://platform.stepfun.ai/docs/en/overview/concept"
  },
  "pendra": {
    "label": "Pendra",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.pendra.ai/api/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-v4-flash",
      "glm-4.7-flash",
      "gpt-oss:120b",
      "llama3.3:70b",
      "qwen3-coder:30b",
      "qwen3.6:27b"
    ],
    "doc": "https://pendra.ai/docs/integrations/opencode"
  },
  "above": {
    "label": "above.dev",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.above.dev/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
      "glm-5.2",
      "glm-5.2-fast",
      "glm-5.3-flash",
      "mimo-v2.5-pro",
      "mimo-v2.5-pro-ultraspeed",
      "qwen3.8-max"
    ],
    "doc": "https://above.dev/docs"
  },
  "scaleway": {
    "label": "Scaleway",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.scaleway.ai/v1",
    "api": "openai-completions",
    "models": [
      "bge-multilingual-gemma2",
      "deepseek-v4-flash-0731",
      "gemma-4-26b-a4b-it",
      "glm-5.2",
      "gpt-oss-120b",
      "llama-3.3-70b-instruct",
      "mistral-medium-3.5-128b",
      "mistral-small-3.2-24b-instruct-2506",
      "pixtral-12b-2409",
      "qwen3-235b-a22b-instruct-2507",
      "qwen3-coder-30b-a3b-instruct",
      "qwen3-embedding-8b",
      "qwen3.5-397b-a17b",
      "qwen3.6-35b-a3b",
      "whisper-large-v3"
    ],
    "doc": "https://www.scaleway.com/en/docs/generative-apis/"
  },
  "alibaba-cn": {
    "label": "Alibaba (China)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "api": "openai-completions",
    "models": [
      "MiniMax-M2.5",
      "MiniMax/MiniMax-M2.7",
      "deepseek-r1",
      "deepseek-r1-0528",
      "deepseek-r1-distill-llama-70b",
      "deepseek-r1-distill-llama-8b",
      "deepseek-r1-distill-qwen-1-5b",
      "deepseek-r1-distill-qwen-14b",
      "deepseek-r1-distill-qwen-32b",
      "deepseek-r1-distill-qwen-7b",
      "deepseek-v3",
      "deepseek-v3-1",
      "deepseek-v3-2-exp",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
      "kimi-k2-thinking",
      "kimi-k2.5"
    ],
    "doc": "https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "poe": {
    "label": "Poe",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.poe.com/v1",
    "api": "openai-completions",
    "models": [
      "anthropic/claude-haiku-3",
      "anthropic/claude-haiku-3.5",
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-opus-4",
      "anthropic/claude-opus-4.1",
      "anthropic/claude-opus-4.5",
      "anthropic/claude-opus-4.6",
      "anthropic/claude-opus-4.7",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-3.5",
      "anthropic/claude-sonnet-3.5-june",
      "anthropic/claude-sonnet-3.7",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-sonnet-4.6",
      "cerebras/gpt-oss-120b-cs",
      "cerebras/llama-3.1-8b-cs",
      "cerebras/llama-3.3-70b-cs",
      "cerebras/qwen3-235b-2507-cs",
      "cerebras/qwen3-32b-cs"
    ],
    "doc": "https://creator.poe.com/docs/external-applications/openai-compatible-api"
  },
  "modelscope": {
    "label": "ModelScope",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api-inference.modelscope.cn/v1",
    "api": "openai-completions",
    "models": [
      "Qwen/Qwen3-235B-A22B-Instruct-2507",
      "Qwen/Qwen3-235B-A22B-Thinking-2507",
      "Qwen/Qwen3-30B-A3B-Instruct-2507",
      "Qwen/Qwen3-30B-A3B-Thinking-2507",
      "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      "ZhipuAI/GLM-4.5",
      "ZhipuAI/GLM-4.6"
    ],
    "doc": "https://modelscope.cn/docs/model-service/API-Inference/intro"
  },
  "poolside": {
    "label": "Poolside",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://inference.poolside.ai/v1",
    "api": "openai-completions",
    "models": [
      "poolside/laguna-m.1",
      "poolside/laguna-s-2.1",
      "poolside/laguna-xs-2.1"
    ],
    "doc": "https://platform.poolside.ai"
  },
  "claudinio": {
    "label": "Claudinio",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.claudin.io/v1",
    "api": "openai-completions",
    "models": [
      "claudinio",
      "claudius"
    ],
    "doc": "https://claudin.io"
  },
  "novita-ai": {
    "label": "NovitaAI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.novita.ai/openai",
    "api": "openai-completions",
    "models": [
      "baichuan/baichuan-m2-32b",
      "baidu/ernie-4.5-21B-a3b",
      "baidu/ernie-4.5-21B-a3b-thinking",
      "baidu/ernie-4.5-300b-a47b-paddle",
      "baidu/ernie-4.5-vl-28b-a3b",
      "baidu/ernie-4.5-vl-28b-a3b-thinking",
      "baidu/ernie-4.5-vl-424b-a47b",
      "deepseek/deepseek-ocr",
      "deepseek/deepseek-ocr-2",
      "deepseek/deepseek-prover-v2-671b",
      "deepseek/deepseek-r1-0528",
      "deepseek/deepseek-r1-0528-qwen3-8b",
      "deepseek/deepseek-r1-distill-llama-70b",
      "deepseek/deepseek-r1-distill-qwen-14b",
      "deepseek/deepseek-r1-distill-qwen-32b",
      "deepseek/deepseek-r1-turbo",
      "deepseek/deepseek-v3-0324",
      "deepseek/deepseek-v3-turbo",
      "deepseek/deepseek-v3.1",
      "deepseek/deepseek-v3.1-terminus"
    ],
    "doc": "https://novita.ai/docs/guides/introduction"
  },
  "nebius": {
    "label": "Nebius Token Factory",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.tokenfactory.nebius.com/v1",
    "api": "openai-completions",
    "models": [
      "MiniMaxAI/MiniMax-M3",
      "NousResearch/Hermes-4-405B",
      "Qwen/Qwen3-235B-A22B-Instruct-2507",
      "Qwen/Qwen3-30B-A3B-Instruct-2507",
      "Qwen/Qwen3-Embedding-8B",
      "Qwen/Qwen3.5-397B-A17B",
      "deepseek-ai/DeepSeek-V4-Flash-0731",
      "deepseek-ai/DeepSeek-V4-Pro",
      "google/gemma-3-27b-it",
      "moonshotai/Kimi-K2.7-Code",
      "moonshotai/Kimi-K3",
      "nvidia/Nemotron-3-Ultra-550b-a55b",
      "nvidia/Nemotron-3_5-Lightning",
      "nvidia/nemotron-3-super-120b-a12b",
      "openai/gpt-oss-120b",
      "zai-org/GLM-5.2",
      "zai-org/GLM-5.3-Flash"
    ],
    "doc": "https://docs.tokenfactory.nebius.com/"
  },
  "minimax-cn-coding-plan": {
    "label": "MiniMax Token Plan (minimaxi.com)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.minimaxi.com/anthropic/v1",
    "api": "openai-completions",
    "models": [
      "MiniMax-M2",
      "MiniMax-M2.1",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M3"
    ],
    "doc": "https://platform.minimaxi.com/docs/token-plan/intro"
  },
  "xiaomi-token-plan-ams": {
    "label": "Xiaomi Token Plan (Europe)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://token-plan-ams.xiaomimimo.com/v1",
    "api": "openai-completions",
    "models": [
      "mimo-v2-pro",
      "mimo-v2-tts",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "mimo-v2.5-tts",
      "mimo-v2.5-tts-voiceclone",
      "mimo-v2.5-tts-voicedesign"
    ],
    "doc": "https://platform.xiaomimimo.com/#/docs"
  },
  "zeldoc": {
    "label": "Zeldoc",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.zeldoc.ai/v1",
    "api": "openai-completions",
    "models": [
      "zdev"
    ],
    "doc": "https://docs.zeldoc.ai"
  },
  "dinference": {
    "label": "DInference",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.dinference.com/v1",
    "api": "openai-completions",
    "models": [
      "glm-4.7",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
      "gpt-oss-120b",
      "minimax-m2.5"
    ],
    "doc": "https://dinference.com"
  },
  "pioneer": {
    "label": "Pioneer",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.pioneer.ai/v1",
    "api": "openai-completions",
    "models": [
      "HuggingFaceTB/SmolLM3-3B-Base",
      "LiquidAI/LFM2-24B-A2B",
      "MiniMaxAI/MiniMax-M2.7",
      "MiniMaxAI/MiniMax-M3",
      "Qwen/Qwen2.5-Coder-0.5B",
      "Qwen/Qwen3-1.7B-Base",
      "Qwen/Qwen3-235B-A22B-Instruct-2507",
      "Qwen/Qwen3-32B",
      "Qwen/Qwen3-4B-Base",
      "Qwen/Qwen3-4B-Instruct-2507",
      "Qwen/Qwen3-8B",
      "Qwen/Qwen3.5-9B",
      "Qwen/Qwen3.6-27B",
      "Qwen/Qwen3.6-35B-A3B",
      "XiaomiMiMo/MiMo-V2.5",
      "XiaomiMiMo/MiMo-V2.5-Pro",
      "claude-3-7-sonnet-latest",
      "claude-fable-5",
      "claude-haiku-4-5",
      "claude-opus-4-1"
    ],
    "doc": "https://agent.pioneer.ai/llms.txt"
  },
  "helicone": {
    "label": "Helicone",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://ai-gateway.helicone.ai/v1",
    "api": "openai-completions",
    "models": [
      "chatgpt-4o-latest",
      "claude-3-haiku-20240307",
      "claude-3.5-haiku",
      "claude-3.5-sonnet-v2",
      "claude-3.7-sonnet",
      "claude-4.5-haiku",
      "claude-4.5-opus",
      "claude-4.5-sonnet",
      "claude-haiku-4-5-20251001",
      "claude-opus-4",
      "claude-opus-4-1",
      "claude-opus-4-1-20250805",
      "claude-sonnet-4",
      "claude-sonnet-4-5-20250929",
      "deepseek-r1-distill-llama-70b",
      "deepseek-reasoner",
      "deepseek-tng-r1t2-chimera",
      "deepseek-v3",
      "deepseek-v3.1-terminus",
      "deepseek-v3.2"
    ],
    "doc": "https://helicone.ai/models"
  },
  "cloudferro-sherlock": {
    "label": "CloudFerro Sherlock",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api-sherlock.cloudferro.com/openai/v1/",
    "api": "openai-completions",
    "models": [
      "MiniMaxAI/MiniMax-M2.5",
      "meta-llama/Llama-3.3-70B-Instruct",
      "openai/gpt-oss-120b",
      "speakleash/Bielik-11B-v2.6-Instruct",
      "speakleash/Bielik-11B-v3.0-Instruct"
    ],
    "doc": "https://docs.sherlock.cloudferro.com/"
  },
  "stepfun": {
    "label": "StepFun (China)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.stepfun.com/v1",
    "api": "openai-completions",
    "models": [
      "step-1-32k",
      "step-2-16k",
      "step-3.5-flash",
      "step-3.5-flash-2603",
      "step-3.7-flash",
      "step-tts-2",
      "stepaudio-2.5-asr",
      "stepaudio-2.5-tts"
    ],
    "doc": "https://platform.stepfun.com/docs/zh/overview/concept"
  },
  "unorouter": {
    "label": "UnoRouter",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.unorouter.com/v1",
    "api": "openai-completions",
    "models": [
      "claude-haiku-4-5-20251001",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "deepseek-v4-flash",
      "deepseek-v4-flash:free",
      "deepseek-v4-pro",
      "deepseek-v4-pro:free",
      "gemini-3.5-flash",
      "gemma-4-31b-it:free",
      "glm-4.5-flash:free",
      "glm-5.2",
      "glm-5.2:free",
      "gpt-5.2",
      "gpt-5.4",
      "gpt-5.4:free",
      "gpt-5.5",
      "gpt-5.5:free",
      "kimi-k2.6",
      "minimax-m2.7",
      "minimax-m2.7:free"
    ],
    "doc": "https://unorouter.com/models"
  },
  "coralbricks": {
    "label": "CoralBricks",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://inference.coralbricks.ai/v1",
    "api": "openai-completions",
    "models": [
      "glm-5.3-fp4",
      "gpt-oss-120b",
      "kimi-k3"
    ],
    "doc": "https://www.coralbricks.ai/docs"
  },
  "hyper": {
    "label": "Charm Hyper",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://hyper.charm.land/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-v4-flash",
      "deepseek-v4-flash-0731",
      "deepseek-v4-pro",
      "deepseek-v4-pro-0813",
      "gemma-4-26b-a4b-it",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "gpt-oss-120b",
      "kimi-k2-thinking",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k3",
      "llama-3.3-70b-instruct",
      "llama-4-maverick-17b-128e-instruct-fp8",
      "minimax-m2.7",
      "minimax-m3"
    ],
    "doc": "https://hyper.charm.land"
  },
  "requesty": {
    "label": "Requesty",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://router.requesty.ai/v1",
    "api": "openai-completions",
    "models": [
      "claude-fable-5",
      "claude-fable-5.1",
      "claude-fable-5.1@eu",
      "claude-fable-5@eu",
      "claude-haiku-4-5",
      "claude-haiku-4-5@eu",
      "claude-opus-4-1",
      "claude-opus-4-5",
      "claude-opus-4-5@eu",
      "claude-opus-4-6",
      "claude-opus-4-6@eu",
      "claude-opus-4-7",
      "claude-opus-4-7@eu",
      "claude-opus-4-8",
      "claude-opus-4-8@eu",
      "claude-opus-5",
      "claude-opus-5@eu",
      "claude-sonnet-4-5",
      "claude-sonnet-4-5@eu",
      "claude-sonnet-4-6"
    ],
    "doc": "https://requesty.ai/solution/llm-routing/models"
  },
  "llmtr": {
    "label": "LLMTR",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://llmtr.com/v1",
    "api": "openai-completions",
    "models": [
      "gemma-4",
      "google/gemini-2.5-flash-lite",
      "magibu-11b-v8",
      "medgemma-4b",
      "meta/muse-spark-1.2-contributor",
      "mimo/mimo-v2.5",
      "mimo/mimo-v2.5-pro",
      "mistral/voxtral-small-latest",
      "muse-glimmer-30b-tr",
      "perplexity/sonar-deep-research",
      "poolside/laguna-xs-2.1",
      "publicai/apertus-70b-instruct",
      "publicai/apertus-8b-instruct",
      "qwen/qwen-flash",
      "qwen/qwen-plus",
      "qwen/qwen3-coder-flash",
      "qwen/qwen3-coder-plus",
      "qwen/qwen3-max",
      "qwen/qwen3-vl-plus",
      "qwen/qwen3.5-397b-a17b"
    ],
    "doc": "https://llmtr.com/docs"
  },
  "xiaomi": {
    "label": "Xiaomi",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.xiaomimimo.com/v1",
    "api": "openai-completions",
    "models": [
      "mimo-v2-flash",
      "mimo-v2-omni",
      "mimo-v2-pro",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "mimo-v2.5-pro-ultraspeed"
    ],
    "doc": "https://platform.xiaomimimo.com/#/docs"
  },
  "huggingface": {
    "label": "Hugging Face",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://router.huggingface.co/v1",
    "api": "openai-completions",
    "models": [
      "MiniMaxAI/MiniMax-M2",
      "MiniMaxAI/MiniMax-M2.1",
      "MiniMaxAI/MiniMax-M2.5",
      "MiniMaxAI/MiniMax-M2.7",
      "MiniMaxAI/MiniMax-M3",
      "Qwen/Qwen2.5-Coder-32B-Instruct",
      "Qwen/Qwen3-235B-A22B",
      "Qwen/Qwen3-235B-A22B-Instruct-2507",
      "Qwen/Qwen3-235B-A22B-Thinking-2507",
      "Qwen/Qwen3-30B-A3B",
      "Qwen/Qwen3-32B",
      "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "Qwen/Qwen3-Coder-Next",
      "Qwen/Qwen3-Embedding-4B",
      "Qwen/Qwen3-Embedding-8B",
      "Qwen/Qwen3-Next-80B-A3B-Instruct",
      "Qwen/Qwen3-Next-80B-A3B-Thinking",
      "Qwen/Qwen3-VL-235B-A22B-Instruct",
      "Qwen/Qwen3-VL-235B-A22B-Thinking"
    ],
    "doc": "https://huggingface.co/docs/inference-providers"
  },
  "zhipuai-coding-plan": {
    "label": "Zhipu AI Coding Plan",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
    "api": "openai-completions",
    "models": [
      "glm-4.6v",
      "glm-4.7",
      "glm-5-turbo",
      "glm-5.1",
      "glm-5.2",
      "glm-5.2-highspeed",
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.3-highspeed",
      "glm-5v-turbo"
    ],
    "doc": "https://docs.bigmodel.cn/cn/coding-plan/overview"
  },
  "daoxe": {
    "label": "DaoXE",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://daoxe.com/v1",
    "api": "openai-completions",
    "models": [
      "claude-haiku-4-5-20251001",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "gemini-3.1-pro-preview",
      "gpt-5.4",
      "gpt-5.5",
      "grok-4.3",
      "grok-4.5",
      "kimi-k2.5"
    ],
    "doc": "https://daoxe.com/pricing"
  },
  "crossmodel": {
    "label": "CrossModel",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.crossmodel.ai/v1",
    "api": "openai-completions",
    "models": [
      "anthropic/claude-fable-5",
      "anthropic/claude-fable-5-1",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-7",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-sonnet-5",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-vision-exp",
      "deepseek/deepseek-v4-pro",
      "gemini/gemini-2.5-flash",
      "gemini/gemini-2.5-flash-lite",
      "gemini/gemini-2.5-pro",
      "gemini/gemini-3-flash-preview",
      "gemini/gemini-3.1-pro-preview",
      "gemini/gemini-3.5-flash",
      "gemini/gemini-3.5-flash-lite",
      "gemini/gemini-3.6-flash",
      "gemini/gemini-3.7-flash"
    ],
    "doc": "https://www.crossmodel.ai/docs"
  },
  "salad-cloud": {
    "label": "SaladCloud AI Gateway",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "qwen3.6-35b-a3b"
    ],
    "doc": "https://docs.salad.com/ai-gateway/explanation/overview"
  },
  "aki-io": {
    "label": "AKI.IO",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://aki.io/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-v4-flash-0731-284b",
      "gemma4-26b",
      "gpt-oss-120b",
      "kimi-k2.7-code-1100b",
      "mistral4-119b",
      "qwen3.6-35b",
      "qwen3.8-27b"
    ],
    "doc": "https://aki.io/docs/"
  },
  "trustedrouter": {
    "label": "TrustedRouter",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.trustedrouter.com/v1",
    "api": "openai-completions",
    "models": [
      "trustedrouter/auto",
      "trustedrouter/cheap",
      "trustedrouter/e2e",
      "trustedrouter/fast",
      "trustedrouter/synth",
      "trustedrouter/synth-code",
      "trustedrouter/zdr"
    ],
    "doc": "https://trustedrouter.com/docs"
  },
  "alibaba": {
    "label": "Alibaba",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-v4-flash-0731",
      "glm-5.2",
      "qvq-max",
      "qwen-flash",
      "qwen-max",
      "qwen-mt-plus",
      "qwen-mt-turbo",
      "qwen-omni-turbo",
      "qwen-omni-turbo-realtime",
      "qwen-plus",
      "qwen-plus-character-ja",
      "qwen-turbo",
      "qwen-vl-max",
      "qwen-vl-ocr",
      "qwen-vl-plus",
      "qwen2-5-14b-instruct",
      "qwen2-5-32b-instruct",
      "qwen2-5-72b-instruct",
      "qwen2-5-7b-instruct",
      "qwen2-5-omni-7b"
    ],
    "doc": "https://www.alibabacloud.com/help/en/model-studio/models"
  },
  "nvidia": {
    "label": "Nvidia",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://integrate.api.nvidia.com/v1",
    "api": "openai-completions",
    "models": [
      "abacusai/dracarys-llama-3.1-70b-instruct",
      "baai/bge-m3",
      "black-forest-labs/flux.1-dev",
      "black-forest-labs/flux_1-kontext-dev",
      "black-forest-labs/flux_1-schnell",
      "black-forest-labs/flux_2-klein-4b",
      "bytedance/seed-oss-36b-instruct",
      "deepseek-ai/deepseek-v4-flash",
      "deepseek-ai/deepseek-v4-flash-0731",
      "deepseek-ai/deepseek-v4-pro",
      "deepseek-ai/deepseek-v4-pro-0813",
      "google/gemma-2-2b-it",
      "google/gemma-3-12b-it",
      "google/gemma-3-4b-it",
      "google/gemma-3n-e2b-it",
      "google/gemma-3n-e4b-it",
      "google/gemma-4-31b-it",
      "google/google-paligemma",
      "meta/esm2-650m",
      "meta/esmfold"
    ],
    "doc": "https://docs.api.nvidia.com/nim/"
  },
  "jiekou": {
    "label": "Jiekou.AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.jiekou.ai/openai",
    "api": "openai-completions",
    "models": [
      "baidu/ernie-4.5-300b-a47b-paddle",
      "baidu/ernie-4.5-vl-424b-a47b",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-1-20250805",
      "claude-opus-4-20250514",
      "claude-opus-4-5-20251101",
      "claude-opus-4-6",
      "claude-sonnet-4-20250514",
      "claude-sonnet-4-5-20250929",
      "deepseek/deepseek-r1-0528",
      "deepseek/deepseek-v3-0324",
      "deepseek/deepseek-v3.1",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash-lite-preview-06-17",
      "gemini-2.5-flash-lite-preview-09-2025",
      "gemini-2.5-flash-preview-05-20",
      "gemini-2.5-pro",
      "gemini-2.5-pro-preview-06-05",
      "gemini-3-flash-preview"
    ],
    "doc": "https://docs.jiekou.ai/docs/support/quickstart?utm_source=github_models.dev"
  },
  "frogbot": {
    "label": "FrogBot",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://app.frogbot.ai/api/v1",
    "api": "openai-completions",
    "models": [
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "deepseek-v4-pro",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3-1-pro-preview",
      "gemini-3-flash-preview",
      "gpt-4o",
      "gpt-5-3-codex",
      "gpt-5-4-mini",
      "gpt-5-4-nano",
      "gpt-5-5",
      "gpt-oss-120b",
      "gpt-oss-20b",
      "grok-4-1-fast-non-reasoning",
      "grok-4-1-fast-reasoning",
      "grok-4-3",
      "grok-code-fast-1"
    ],
    "doc": "https://docs.frogbot.ai"
  },
  "ovhcloud": {
    "label": "OVHcloud AI Endpoints",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    "api": "openai-completions",
    "models": [
      "gpt-oss-120b",
      "gpt-oss-20b",
      "meta-llama-3_3-70b-instruct",
      "mistral-7b-instruct-v0.3",
      "mistral-nemo-instruct-2407",
      "mistral-small-3.2-24b-instruct-2506",
      "qwen2.5-vl-72b-instruct",
      "qwen3-32b",
      "qwen3-coder-30b-a3b-instruct",
      "qwen3.5-397b-a17b",
      "qwen3.5-9b",
      "qwen3.6-27b",
      "qwen3.8-27b",
      "qwen3guard-gen-0.6b",
      "qwen3guard-gen-8b"
    ],
    "doc": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog//"
  },
  "xpersona": {
    "label": "Xpersona",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://www.xpersona.co/v1",
    "api": "openai-completions",
    "models": [
      "claude-fable-5",
      "claude-haiku-4-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "gemini-3.5-flash",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "xpersona-frieren-coder",
      "xpersona-gpt-5.5"
    ],
    "doc": "https://www.xpersona.co/docs"
  },
  "baseten": {
    "label": "Baseten",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://inference.baseten.co/v1",
    "api": "openai-completions",
    "models": [
      "MiniMaxAI/MiniMax-M2.5",
      "deepseek-ai/DeepSeek-V3.1",
      "deepseek-ai/DeepSeek-V4-Flash-0731",
      "deepseek-ai/DeepSeek-V4-Pro",
      "deepseek-ai/DeepSeek-V4-Pro-0813",
      "moonshotai/Kimi-K2.5",
      "moonshotai/Kimi-K2.6",
      "moonshotai/Kimi-K2.7-Code",
      "moonshotai/Kimi-K3",
      "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
      "nvidia/Nemotron-120B-A12B",
      "openai/gpt-oss-120b",
      "thinkingmachines/inkling",
      "thinkingmachines/inkling-small",
      "zai-org/GLM-4.7",
      "zai-org/GLM-5",
      "zai-org/GLM-5.1",
      "zai-org/GLM-5.2",
      "zai-org/GLM-5.2-Fast",
      "zai-org/GLM-5.3"
    ],
    "doc": "https://docs.baseten.co/inference/model-apis/overview"
  },
  "vercel": {
    "label": "Vercel AI Gateway",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "alibaba/qwen-3-14b",
      "alibaba/qwen-3-235b",
      "alibaba/qwen-3-30b",
      "alibaba/qwen-3-32b",
      "alibaba/qwen-3.6-max-preview",
      "alibaba/qwen3-235b-a22b-thinking",
      "alibaba/qwen3-coder",
      "alibaba/qwen3-coder-30b-a3b",
      "alibaba/qwen3-coder-next",
      "alibaba/qwen3-coder-plus",
      "alibaba/qwen3-embedding-0.6b",
      "alibaba/qwen3-embedding-4b",
      "alibaba/qwen3-embedding-8b",
      "alibaba/qwen3-max",
      "alibaba/qwen3-max-preview",
      "alibaba/qwen3-max-thinking",
      "alibaba/qwen3-next-80b-a3b-instruct",
      "alibaba/qwen3-next-80b-a3b-thinking",
      "alibaba/qwen3-vl-235b-a22b-instruct",
      "alibaba/qwen3-vl-instruct"
    ],
    "doc": "https://github.com/vercel/ai/tree/5eb85cc45a259553501f535b8ac79a77d0e79223/packages/gateway"
  },
  "qvac": {
    "label": "QVAC",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "gemma4-31b",
      "gpt-oss-120b",
      "gpt-oss-20b",
      "qwen3.5-0.8b",
      "qwen3.5-2b",
      "qwen3.5-4b",
      "qwen3.5-9b",
      "qwen3.6-27b",
      "qwen3.6-35b-a3b"
    ],
    "doc": "https://www.npmjs.com/package/@qvac/ai-sdk-provider"
  },
  "wandb": {
    "label": "Weights & Biases",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.inference.wandb.ai/v1",
    "api": "openai-completions",
    "models": [
      "JetBrains/Mellum2-12B-A2.5B-Instruct",
      "MiniMaxAI/MiniMax-M3",
      "OpenPipe/Qwen3-14B-Instruct",
      "Qwen/Qwen3-30B-A3B-Instruct-2507",
      "Qwen/Qwen3.5-35B-A3B",
      "Qwen/Qwen3.6-27B",
      "Qwen/Qwen3.6-35B-A3B",
      "Qwen/Qwen3.8-27B",
      "deepseek-ai/DeepSeek-V3.1",
      "deepseek-ai/DeepSeek-V4-Flash",
      "deepseek-ai/DeepSeek-V4-Flash-0731",
      "deepseek-ai/DeepSeek-V4-Pro",
      "deepseek-ai/DeepSeek-V4-Pro-0813",
      "google/gemma-4-31B-it",
      "ibm-granite/granite-4.1-8b",
      "ibm-granite/granite-4.2-8b",
      "meta-llama/Llama-3.1-70B-Instruct",
      "meta-llama/Llama-3.1-8B-Instruct",
      "meta-llama/Llama-3.3-70B-Instruct",
      "moonshotai/Kimi-K2.6"
    ],
    "doc": "https://docs.wandb.ai/guides/integrations/inference/"
  },
  "friendli": {
    "label": "Friendli",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.friendli.ai/serverless/v1",
    "api": "openai-completions",
    "models": [
      "MiniMaxAI/MiniMax-M2.5",
      "deepseek-ai/DeepSeek-V3.2",
      "google/gemma-4-31B-it",
      "zai-org/GLM-5.1",
      "zai-org/GLM-5.2",
      "zai-org/GLM-5.3"
    ],
    "doc": "https://friendli.ai/docs/guides/serverless_endpoints/introduction"
  },
  "tokenrouter": {
    "label": "TokenRouter",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.tokenrouter.com/v1",
    "api": "openai-completions",
    "models": [
      "z-ai/glm-5.3-free"
    ],
    "doc": "https://www.tokenrouter.com/docs/tokenrouter-feature-guide/"
  },
  "thinkingmachines": {
    "label": "Thinking Machines",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://tinker.thinkingmachines.dev/services/tinker-prod/anthropic/api/v1",
    "api": "openai-completions",
    "models": [
      "thinkingmachines/Inkling",
      "thinkingmachines/Inkling:peft:262144"
    ],
    "doc": "https://tinker-docs.thinkingmachines.ai/tinker/compatible-apis/anthropic/"
  },
  "standardcompute": {
    "label": "Standard Compute",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.stdcmpt.com/v1",
    "api": "openai-completions",
    "models": [
      "standardcompute"
    ],
    "doc": "https://standardcompute.com/models"
  },
  "tensorx": {
    "label": "TensorX",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.tensorx.ai/v1",
    "api": "openai-completions",
    "models": [
      "deepseek/deepseek-chat-v3.1",
      "deepseek/deepseek-r1-0528",
      "deepseek/deepseek-v3.2",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-0731",
      "deepseek/deepseek-v4-pro",
      "minimax/minimax-m2.5",
      "minimax/minimax-m3",
      "moonshotai/kimi-k2.5",
      "moonshotai/kimi-k2.6",
      "moonshotai/kimi-k2.7-code",
      "moonshotai/kimi-k3",
      "nvidia/nemotron-3-super-120b-a12b",
      "openai/gpt-oss-120b",
      "qwen/qwen3-235b-a22b-2507",
      "qwen/qwen3-coder-30b-a3b-instruct",
      "qwen/qwen3-vl-235b-a22b-instruct",
      "qwen/qwen3.5-122b-a10b",
      "qwen/qwen3.5-9b",
      "z-ai/glm-4.7"
    ],
    "doc": "https://docs.tensorx.ai/"
  },
  "meta": {
    "label": "Meta",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.meta.ai/v1",
    "api": "openai-completions",
    "models": [
      "muse-spark-1.1",
      "muse-spark-1.2",
      "muse-spark-1.2-contributor",
      "muse-spark-1.3",
      "muse-spark-1.3-contributor"
    ],
    "doc": "https://dev.meta.ai/docs"
  },
  "venice": {
    "label": "Venice AI",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "aion-labs-aion-3-0",
      "aion-labs-aion-3-0-mini",
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-opus-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-4-8-fast",
      "claude-opus-5",
      "claude-opus-5-fast",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "deepseek-v3.2",
      "deepseek-v4-flash",
      "deepseek-v4-flash-0731",
      "deepseek-v4-flash-0731-fast",
      "deepseek-v4-pro",
      "deepseek-v4-pro-0813"
    ],
    "doc": "https://docs.venice.ai"
  },
  "gmicloud": {
    "label": "GMI Cloud",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.gmi-serving.com/v1",
    "api": "openai-completions",
    "models": [
      "MiniMaxAI/MiniMax-M2.7",
      "MiniMaxAI/MiniMax-M3",
      "Qwen/Qwen3.7-Max",
      "anthropic/claude-opus-4.6",
      "anthropic/claude-opus-4.7",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-4.6",
      "deepseek-ai/DeepSeek-V4-Flash",
      "deepseek-ai/DeepSeek-V4-Pro",
      "moonshotai/Kimi-K2.6",
      "moonshotai/kimi-k2.7-code-highspeed",
      "openai/gpt-5.5",
      "zai-org/GLM-5-FP8",
      "zai-org/GLM-5.1-FP8",
      "zai-org/GLM-5.2-FP8"
    ],
    "doc": "https://docs.gmicloud.ai/inference-engine/api-reference/llm-api-reference"
  },
  "io-net": {
    "label": "IO.NET",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.intelligence.io.solutions/api/v1",
    "api": "openai-completions",
    "models": [
      "Intel/Qwen3-Coder-480B-A35B-Instruct-int4-mixed-ar",
      "Qwen/Qwen2.5-VL-32B-Instruct",
      "Qwen/Qwen3-235B-A22B-Thinking-2507",
      "Qwen/Qwen3-Next-80B-A3B-Instruct",
      "deepseek-ai/DeepSeek-R1-0528",
      "meta-llama/Llama-3.2-90B-Vision-Instruct",
      "meta-llama/Llama-3.3-70B-Instruct",
      "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
      "mistralai/Devstral-Small-2505",
      "mistralai/Magistral-Small-2506",
      "mistralai/Mistral-Large-Instruct-2411",
      "mistralai/Mistral-Nemo-Instruct-2407",
      "moonshotai/Kimi-K2-Instruct-0905",
      "moonshotai/Kimi-K2-Thinking",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "zai-org/GLM-4.6"
    ],
    "doc": "https://io.net/docs/guides/intelligence/io-intelligence"
  },
  "llmgateway": {
    "label": "DevPass (LLM Gateway)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.llmgateway.io/v1",
    "api": "openai-completions",
    "models": [
      "Qwen3.8-27B",
      "auto",
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-1-20250805",
      "claude-opus-4-5-20251101",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-4-5",
      "claude-sonnet-4-5-20250929",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "codestral-2508",
      "custom",
      "deepseek-v3.2",
      "deepseek-v4-flash"
    ],
    "doc": "https://llmgateway.io/docs"
  },
  "infomaniak": {
    "label": "Infomaniak",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.infomaniak.com/2/ai/${INFOMANIAK_PRODUCT_ID}/openai/v1",
    "api": "openai-completions",
    "models": [
      "Qwen/Qwen3.5-122B-A10B-FP8",
      "Qwen/Qwen3.5-397B-A17B-FP8",
      "bge_multilingual_gemma2",
      "google/gemma-4-31B-it",
      "mini_lm_l12_v2",
      "mistralai/Ministral-3-14B-Instruct-2512",
      "mistralai/Mistral-Small-4-119B-2603",
      "moonshotai/Kimi-K2.6",
      "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8",
      "swiss-ai/Apertus-v1.5-70B"
    ],
    "doc": "https://www.infomaniak.com/en/hosting/ai-services/open-source-models"
  },
  "inception": {
    "label": "Inception",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.inceptionlabs.ai/v1/",
    "api": "openai-completions",
    "models": [
      "mercury-2",
      "mercury-edit-2"
    ],
    "doc": "https://platform.inceptionlabs.ai/docs"
  },
  "lilac": {
    "label": "Lilac",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.getlilac.com/v1",
    "api": "openai-completions",
    "models": [
      "google/gemma-4-31b-it",
      "minimaxai/minimax-m3",
      "moonshotai/kimi-k2.6",
      "zai-org/glm-5.2"
    ],
    "doc": "https://docs.getlilac.com/inference/models"
  },
  "fastrouter": {
    "label": "FastRouter",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://go.fastrouter.ai/api/v1",
    "api": "openai-completions",
    "models": [
      "anthropic/claude-opus-4.1",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-sonnet-4.6",
      "bytedance/seedance-2",
      "deepseek-ai/deepseek-r1-distill-llama-70b",
      "deepseek/deepseek-v4-pro",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
      "google/gemini-3-pro-image-preview",
      "google/gemini-3.1-flash-image-preview",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.5-flash",
      "google/gemma-4-31b-it",
      "google/imagen-4.0-fast",
      "google/imagen-4.0-ultra",
      "google/veo3.1",
      "google/veo3.1-fast",
      "google/veo3.1-lite",
      "leonardo-ai/lucid-origin"
    ],
    "doc": "https://fastrouter.ai/models"
  },
  "zhipuai": {
    "label": "Zhipu AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "api": "openai-completions",
    "models": [
      "glm-4.5",
      "glm-4.5-air",
      "glm-4.5-flash",
      "glm-4.5v",
      "glm-4.6",
      "glm-4.6v",
      "glm-4.7",
      "glm-4.7-flash",
      "glm-4.7-flashx",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5v-turbo"
    ],
    "doc": "https://docs.z.ai/guides/overview/pricing"
  },
  "jalapeno": {
    "label": "Jalapeno Cloud",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.jalapeno-cloud.ai/v1",
    "api": "openai-completions",
    "models": [
      "DeepSeek-V4-Flash",
      "DeepSeek-V4-Pro",
      "GLM-5.1",
      "GLM-5.2",
      "Hy3",
      "Kimi-K2.5",
      "Kimi-K2.7-Code",
      "Kimi-K3",
      "MiniMax-M3",
      "Qwen3-Next-80B-A3B-Instruct",
      "Qwen3-Next-80B-A3B-Thinking",
      "Qwen3-VL-235B-A22B-Instruct",
      "Qwen3-VL-235B-A22B-Thinking",
      "Qwen3.5-122B-A10B",
      "Qwen3.5-27B",
      "Qwen3.5-35B-A3B",
      "Qwen3.5-397B-A17B"
    ],
    "doc": "https://www.jalapeno-cloud.ai/docs/"
  },
  "perplexity-agent": {
    "label": "Perplexity Agent",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.perplexity.ai/v1",
    "api": "openai-completions",
    "models": [
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-5",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-sonnet-4-6",
      "deepseek/deepseek-v4-flash-0731",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
      "google/gemini-3-flash-preview",
      "google/gemini-3.1-pro-preview",
      "moonshot-ai/kimi-k2.7-code",
      "moonshot-ai/kimi-k3",
      "nvidia/nemotron-3-super-120b-a12b",
      "openai/gpt-5-mini",
      "openai/gpt-5.1",
      "openai/gpt-5.2",
      "openai/gpt-5.4",
      "openai/gpt-5.5",
      "perplexity/sonar"
    ],
    "doc": "https://docs.perplexity.ai/docs/agent-api/models"
  },
  "fireworks-ai": {
    "label": "Fireworks AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.fireworks.ai/inference/v1/",
    "api": "openai-completions",
    "models": [
      "accounts/fireworks/models/deepseek-v4-flash-0731",
      "accounts/fireworks/models/deepseek-v4-flash-vision-exp",
      "accounts/fireworks/models/deepseek-v4-pro-0813",
      "accounts/fireworks/models/glm-5p2",
      "accounts/fireworks/models/glm-5p3",
      "accounts/fireworks/models/glm-5p3-flash",
      "accounts/fireworks/models/gpt-oss-120b",
      "accounts/fireworks/models/inkling",
      "accounts/fireworks/models/kimi-k2p6",
      "accounts/fireworks/models/kimi-k2p7-code",
      "accounts/fireworks/models/kimi-k3",
      "accounts/fireworks/models/minimax-m3",
      "accounts/fireworks/models/muse-glimmer-30b",
      "accounts/fireworks/models/nemotron-3-ultra-nvfp4",
      "accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b",
      "accounts/fireworks/models/qwen3p7-plus",
      "accounts/fireworks/models/qwen3p8-max",
      "accounts/fireworks/routers/glm-5p2-fast",
      "accounts/fireworks/routers/kimi-k3-fast"
    ],
    "doc": "https://fireworks.ai/docs/"
  },
  "opper": {
    "label": "Opper",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.opper.ai/v3/compat",
    "api": "openai-completions",
    "models": [
      "anthropic/claude-fable-5",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-5",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-opus-4-7",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-sonnet-5",
      "gemini/gemini-3-flash-preview",
      "gemini/gemini-3.1-pro-preview",
      "gemini/gemini-3.5-flash",
      "gemini/gemini-3.5-flash-lite",
      "meta/muse-spark-1.2",
      "minimax/m3",
      "mistral/devstral-2512",
      "mistral/mistral-large-2512",
      "mistral/mistral-small-2603",
      "moonshot/kimi-k3"
    ],
    "doc": "https://opper.ai/models"
  },
  "stackit": {
    "label": "STACKIT",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1",
    "api": "openai-completions",
    "models": [
      "Qwen/Qwen3-VL-235B-A22B-Instruct-FP8",
      "Qwen/Qwen3-VL-Embedding-8B",
      "Qwen/Qwen3.6-27B",
      "cortecs/Llama-3.3-70B-Instruct-FP8-Dynamic",
      "google/gemma-3-27b-it",
      "intfloat/e5-mistral-7b-instruct",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b"
    ],
    "doc": "https://docs.stackit.cloud/products/data-and-ai/ai-model-serving/basics/available-shared-models"
  },
  "crof": {
    "label": "CrofAI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://crof.ai/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-v3.2",
      "deepseek-v4-flash",
      "deepseek-v4-flash-0731",
      "deepseek-v4-pro",
      "deepseek-v4-pro-0813",
      "gemma-4-31b-it",
      "glm-5.1",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "greg-1-mini",
      "greg-2-super",
      "greg-2-ultra",
      "greg-rp",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k3",
      "kimi-k3-eco",
      "mimo-v2.5-pro",
      "qwen3.5-397b-a17b"
    ],
    "doc": "https://crof.ai/docs"
  },
  "crusoe": {
    "label": "Crusoe",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.inference.crusoecloud.com/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-ai/DeepSeek-V3-0324",
      "google/gemma-4-31b-it",
      "meta-llama/Llama-3.3-70B-Instruct",
      "moonshotai/Kimi-K2.6",
      "nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B",
      "openai/gpt-oss-120b",
      "zai/GLM-5.1",
      "zai/GLM-5.2"
    ],
    "doc": "https://docs.crusoecloud.com/managed-inference/overview"
  },
  "empiriolabs": {
    "label": "EmpirioLabs AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.empiriolabs.ai/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-v3-2",
      "deepseek-v4-flash",
      "deepseek-v4-flash-0731",
      "deepseek-v4-pro",
      "deepseek-v4-pro-0813",
      "fugu-ultra-v1-0",
      "fugu-ultra-v1-1",
      "gemma-4-26b-a4b",
      "glm-4-5-flash",
      "glm-4-6v-flash",
      "glm-4-7-flash",
      "glm-5-1",
      "glm-5-2",
      "glm-5-3",
      "glm-5-3-flash",
      "kimi-k2-6",
      "kimi-k2-7-code",
      "kimi-k2-7-code-highspeed",
      "kimi-k3",
      "mimo-v2-5"
    ],
    "doc": "https://docs.empiriolabs.ai"
  },
  "klokintegration": {
    "label": "klokintegration.se",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api-gw.klok.ipaas.se/proxy/kloker-key/v1",
    "api": "openai-completions",
    "models": [
      "Kloker",
      "Kloker-Integration-Architect",
      "Kloker-Integration-Developer"
    ],
    "doc": "https://klokintegration.se/docs/ai-api"
  },
  "privatemode-ai": {
    "label": "Privatemode AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "http://localhost:8080/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-ocr-2",
      "gpt-oss-120b",
      "kimi-k2.6",
      "kimi-latest",
      "qwen3-embedding-4b",
      "voxtral-mini-3b",
      "whisper-large-v3"
    ],
    "doc": "https://docs.privatemode.ai/api/overview"
  },
  "minimax-coding-plan": {
    "label": "MiniMax Token Plan (minimax.io)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.minimax.io/anthropic/v1",
    "api": "openai-completions",
    "models": [
      "MiniMax-M2",
      "MiniMax-M2.1",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M3"
    ],
    "doc": "https://platform.minimax.io/docs/token-plan/intro"
  },
  "inferx": {
    "label": "InferX",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://model.inferx.net/endpoints/v1",
    "api": "openai-completions",
    "models": [
      "Agents-A1",
      "Devstral-2-123B-Instruct-2512-int4-AutoRound",
      "Ornith-1.0-35B-FP8",
      "Qwen3-Coder-Next-FP8",
      "Qwen3-Coder-Next-FP8-no-thinking",
      "Qwen3-Embedding-8B",
      "Qwen3.6-27B-FP8",
      "Qwen3.6-35B-A3B-FP8",
      "Qwen3.6-35B-A3B-fp8-no-thinking",
      "deepseek-v4-flash",
      "gemma-4-31B-it-fp8",
      "mimo-v25"
    ],
    "doc": "https://model.inferx.net/endpoints"
  },
  "databricks": {
    "label": "Databricks",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://${DATABRICKS_HOST}/ai-gateway/mlflow/v1",
    "api": "openai-completions",
    "models": [
      "databricks-claude-haiku-4-5",
      "databricks-claude-opus-4-1",
      "databricks-claude-opus-4-5",
      "databricks-claude-opus-4-6",
      "databricks-claude-opus-4-7",
      "databricks-claude-sonnet-4",
      "databricks-claude-sonnet-4-5",
      "databricks-claude-sonnet-4-6",
      "databricks-gemini-2-5-flash",
      "databricks-gemini-2-5-pro",
      "databricks-gemini-3-1-flash-lite",
      "databricks-gemini-3-1-pro",
      "databricks-gemini-3-flash",
      "databricks-gemini-3-pro",
      "databricks-glm-5-2",
      "databricks-gpt-5",
      "databricks-gpt-5-1",
      "databricks-gpt-5-2",
      "databricks-gpt-5-4",
      "databricks-gpt-5-4-mini"
    ],
    "doc": "https://docs.databricks.com/aws/en/machine-learning/foundation-models/"
  },
  "modal": {
    "label": "Modal",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://inference.us-west.modal.direct/v1",
    "api": "openai-completions",
    "models": [
      "Qwen/Qwen3.8-2.4T-A95B",
      "moonshotai/Kimi-K3",
      "thinkingmachines/Inkling-NVFP4",
      "zai-org/GLM-5.3-Flash"
    ],
    "doc": "https://modal.com/docs/guide/endpoints"
  },
  "lucidquery": {
    "label": "LucidQuery",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.lucidquery.com/v1",
    "api": "openai-completions",
    "models": [
      "lucidnova-rf1-100b",
      "lucidquery-agi-01-frontier",
      "lucidquery-agi-01-swift",
      "lucidquery-nexus-coder"
    ],
    "doc": "https://lucidquery.com/docs"
  },
  "atomic-chat": {
    "label": "Atomic Chat",
    "tier": "template",
    "envName": null,
    "baseUrl": "http://127.0.0.1:1337/v1",
    "api": "openai-completions",
    "models": [
      "Meta-Llama-3_1-8B-Instruct-GGUF",
      "Qwen3_5-9B-MLX-4bit",
      "Qwen3_5-9B-Q4_K_M",
      "gemma-4-E4B-it-IQ4_XS",
      "gemma-4-E4B-it-MLX-4bit"
    ],
    "doc": "https://atomic.chat"
  },
  "umans-ai": {
    "label": "Umans AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.code.umans.ai/v1",
    "api": "openai-completions",
    "models": [
      "umans-coder",
      "umans-deepseek-v4-flash-0731",
      "umans-deepseek-v4-pro-0813",
      "umans-flash",
      "umans-glm-5.2",
      "umans-kimi-k2.7",
      "umans-kimi-k3"
    ],
    "doc": "https://app.umans.ai/offers/code/docs/orgs"
  },
  "sakana": {
    "label": "Sakana AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.sakana.ai/v1",
    "api": "openai-completions",
    "models": [
      "fugu",
      "fugu-ultra",
      "fugu-ultra-20260615",
      "sakana-namazu"
    ],
    "doc": "https://console.sakana.ai/models"
  },
  "deepinfra": {
    "label": "Deep Infra",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "ByteDance/Seed-2.0-code",
      "ByteDance/Seed-2.0-mini",
      "ByteDance/Seed-2.0-pro",
      "MiniMaxAI/MiniMax-M2.5",
      "MiniMaxAI/MiniMax-M2.7",
      "MiniMaxAI/MiniMax-M3",
      "Qwen/Qwen3-235B-A22B-Instruct-2507",
      "Qwen/Qwen3-30B-A3B",
      "Qwen/Qwen3-32B",
      "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo",
      "Qwen/Qwen3-Max",
      "Qwen/Qwen3-Next-80B-A3B-Instruct",
      "Qwen/Qwen3-VL-235B-A22B-Instruct",
      "Qwen/Qwen3.5-122B-A10B",
      "Qwen/Qwen3.5-27B",
      "Qwen/Qwen3.5-35B-A3B",
      "Qwen/Qwen3.5-397B-A17B",
      "Qwen/Qwen3.5-9B",
      "Qwen/Qwen3.6-27B",
      "Qwen/Qwen3.6-35B-A3B"
    ],
    "doc": "https://deepinfra.com/models"
  },
  "alibaba-coding-plan": {
    "label": "Alibaba Coding Plan",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://coding-intl.dashscope.aliyuncs.com/v1",
    "api": "openai-completions",
    "models": [
      "MiniMax-M2.5",
      "glm-4.7",
      "glm-5",
      "kimi-k2.5",
      "qwen3-coder-next",
      "qwen3-coder-plus",
      "qwen3-max-2026-01-23",
      "qwen3.5-plus",
      "qwen3.6-flash",
      "qwen3.6-plus",
      "qwen3.7-max",
      "qwen3.7-plus"
    ],
    "doc": "https://www.alibabacloud.com/help/en/model-studio/coding-plan"
  },
  "submodel": {
    "label": "submodel",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://llm.submodel.ai/v1",
    "api": "openai-completions",
    "models": [
      "Qwen/Qwen3-235B-A22B-Instruct-2507",
      "Qwen/Qwen3-235B-A22B-Thinking-2507",
      "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
      "deepseek-ai/DeepSeek-R1-0528",
      "deepseek-ai/DeepSeek-V3-0324",
      "deepseek-ai/DeepSeek-V3.1",
      "openai/gpt-oss-120b",
      "zai-org/GLM-4.5-Air",
      "zai-org/GLM-4.5-FP8"
    ],
    "doc": "https://submodel.gitbook.io"
  },
  "openreason": {
    "label": "OpenReason",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.openreason.app/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-ai/deepseek-v4-flash-0731",
      "moonshotai/kimi-k2.7-code",
      "openai/gpt-oss-120b"
    ],
    "doc": "https://openreason.app/docs"
  },
  "amazon-bedrock": {
    "label": "Amazon Bedrock",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "amazon.nova-2-lite-v1:0",
      "amazon.nova-lite-v1:0",
      "amazon.nova-micro-v1:0",
      "amazon.nova-pro-v1:0",
      "anthropic.claude-fable-5",
      "anthropic.claude-fable-5-1",
      "anthropic.claude-haiku-4-5-20251001-v1:0",
      "anthropic.claude-opus-4-1-20250805-v1:0",
      "anthropic.claude-opus-4-5-20251101-v1:0",
      "anthropic.claude-opus-4-6-v1",
      "anthropic.claude-opus-4-7",
      "anthropic.claude-opus-4-8",
      "anthropic.claude-opus-5",
      "anthropic.claude-sonnet-4-5-20250929-v1:0",
      "anthropic.claude-sonnet-4-6",
      "anthropic.claude-sonnet-5",
      "au.anthropic.claude-haiku-4-5-20251001-v1:0",
      "au.anthropic.claude-opus-4-6-v1",
      "au.anthropic.claude-opus-4-8",
      "au.anthropic.claude-opus-5"
    ],
    "doc": "https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html"
  },
  "merge-gateway": {
    "label": "Merge Gateway",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api-gateway.merge.dev/v1/ai-sdk",
    "api": "openai-completions",
    "models": [
      "anthropic/claude-3-7-sonnet-20250219",
      "anthropic/claude-fable-5",
      "anthropic/claude-fable-5-1",
      "anthropic/claude-haiku-4-5-20251001",
      "anthropic/claude-opus-4-1-20250805",
      "anthropic/claude-opus-4-20250514",
      "anthropic/claude-opus-4-5-20251101",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-opus-4-7",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-4-20250514",
      "anthropic/claude-sonnet-4-5-20250929",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-sonnet-5",
      "bytedance/dola-seed-2.0-code",
      "bytedance/dola-seed-2.0-code-preview",
      "bytedance/dola-seed-2.0-lite",
      "bytedance/dola-seed-2.0-mini",
      "bytedance/dola-seed-2.0-pro"
    ],
    "doc": "https://docs.merge.dev/merge-gateway"
  },
  "deepseek": {
    "label": "DeepSeek",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.deepseek.com",
    "api": "openai-completions",
    "models": [
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro"
    ],
    "doc": "https://api-docs.deepseek.com/quick_start/pricing"
  },
  "abacus": {
    "label": "Abacus",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://routellm.abacus.ai/v1",
    "api": "openai-completions",
    "models": [
      "MiniMaxAI/MiniMax-M2.7",
      "MiniMaxAI/MiniMax-M3",
      "Qwen/QwQ-32B",
      "Qwen/Qwen2.5-72B-Instruct",
      "Qwen/Qwen3-235B-A22B-Instruct-2507",
      "Qwen/Qwen3-32B",
      "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "Qwen/Qwen3.6-27B",
      "claude-3-7-sonnet-20250219",
      "claude-fable-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-1-20250805",
      "claude-opus-4-20250514",
      "claude-opus-4-5-20251101",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-4-20250514",
      "claude-sonnet-4-5-20250929"
    ],
    "doc": "https://abacus.ai/help/api"
  },
  "blueclaw": {
    "label": "Blue Claw",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://openai.blueclaw.network/v1",
    "api": "openai-completions",
    "models": [
      "Qwen/Qwen3.6-35B-A3B-FP8",
      "Qwen3.6-27B"
    ],
    "doc": "https://blueclaw.network"
  },
  "kosmik": {
    "label": "Kosmik Compute",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.koscompute.com/v1",
    "api": "openai-completions",
    "models": [
      "qwen/qwen3.8-27b"
    ],
    "doc": "https://api.koscompute.com/docs/"
  },
  "moonshotai-cn": {
    "label": "Moonshot AI (China)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.moonshot.cn/v1",
    "api": "openai-completions",
    "models": [
      "kimi-k2-0711-preview",
      "kimi-k2-0905-preview",
      "kimi-k2-thinking",
      "kimi-k2-thinking-turbo",
      "kimi-k2-turbo-preview",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
      "kimi-k3"
    ],
    "doc": "https://platform.moonshot.cn/docs/api/chat"
  },
  "stepfun-step-plan": {
    "label": "StepFun Step Plan (China)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.stepfun.com/step_plan/v1",
    "api": "openai-completions",
    "models": [
      "step-3.5-flash",
      "step-3.5-flash-2603",
      "step-3.7-flash",
      "step-router-v1"
    ],
    "doc": "https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api"
  },
  "nearai": {
    "label": "NEAR AI Cloud",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://cloud-api.near.ai/v1",
    "api": "openai-completions",
    "models": [
      "Qwen/Qwen3-30B-A3B-Instruct-2507",
      "Qwen/Qwen3-Embedding-0.6B",
      "Qwen/Qwen3-Reranker-0.6B",
      "Qwen/Qwen3-VL-30B-A3B-Instruct",
      "Qwen/Qwen3.5-122B-A10B",
      "Qwen/Qwen3.6-35B-A3B-FP8",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-sonnet-4-6",
      "black-forest-labs/FLUX.2-klein-4B",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-flash-lite",
      "google/gemini-2.5-pro",
      "google/gemini-3-pro",
      "google/gemini-3.1-flash-lite",
      "google/gemini-3.5-flash",
      "google/gemma-4-31B-it",
      "openai/gpt-4.1"
    ],
    "doc": "https://docs.near.ai/"
  },
  "cline-pass": {
    "label": "ClinePass",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.cline.bot/api/v1",
    "api": "openai-completions",
    "models": [
      "cline-pass/deepseek-v4-flash",
      "cline-pass/deepseek-v4-pro",
      "cline-pass/glm-5.2",
      "cline-pass/glm-5.3",
      "cline-pass/kimi-k2.6",
      "cline-pass/kimi-k2.7-code",
      "cline-pass/kimi-k3",
      "cline-pass/mimo-v2.5",
      "cline-pass/mimo-v2.5-pro",
      "cline-pass/minimax-m3",
      "cline-pass/qwen3.7-max",
      "cline-pass/qwen3.7-plus",
      "cline-pass/qwen3.8-max"
    ],
    "doc": "https://docs.cline.bot/getting-started/clinepass"
  },
  "iteracompute": {
    "label": "IteraCompute",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.iteracompute.com/v1",
    "api": "openai-completions",
    "models": [
      "iteracompute/ornith-1.5-35b-a3b",
      "iteracompute/qwen3.8-27b"
    ],
    "doc": "https://iteracompute.com/docs.html"
  },
  "model-oracle-ai": {
    "label": "Model Oracle AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.modeloracle.com/api/v1",
    "api": "openai-completions",
    "models": [
      "auto",
      "claude-fable-5",
      "claude-haiku-4.5",
      "claude-opus-4.8",
      "claude-sonnet-5",
      "deepseek-v4-pro",
      "glm-5.2",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.5",
      "o4-mini"
    ],
    "doc": "https://modeloracle.com/setup/"
  },
  "ofox": {
    "label": "Ofox",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.ofox.ai/v1",
    "api": "openai-completions",
    "models": [
      "anthropic/claude-fable-5",
      "anthropic/claude-fable-5.1",
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-opus-4.5",
      "anthropic/claude-opus-4.6",
      "anthropic/claude-opus-4.7",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-sonnet-5",
      "bailian/qwen-flash",
      "bailian/qwen-max",
      "bailian/qwen-plus",
      "bailian/qwen-turbo",
      "bailian/qwen-vl-max",
      "bailian/qwen3-coder-flash",
      "bailian/qwen3-coder-next",
      "bailian/qwen3-coder-plus",
      "bailian/qwen3-max"
    ],
    "doc": "https://ofox.ai/docs"
  },
  "arcee": {
    "label": "Arcee",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.arcee.ai/api/v1",
    "api": "openai-completions",
    "models": [
      "deepseek/deepseek-v4-flash-latest",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-pro-0813",
      "moonshotai/kimi-k3",
      "thinkingmachines/inkling-small",
      "trinity-large-thinking",
      "zai-org/glm-5.2"
    ],
    "doc": "https://docs.arcee.ai"
  },
  "kuae-cloud-coding-plan": {
    "label": "KUAE Cloud Coding Plan",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://coding-plan-endpoint.kuaecloud.net/v1",
    "api": "openai-completions",
    "models": [
      "GLM-4.7"
    ],
    "doc": "https://docs.mthreads.com/kuaecloud/kuaecloud-doc-online/coding_plan/"
  },
  "ebcloud": {
    "label": "EBCloud",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://maas-api.ebcloud.com/v1",
    "api": "openai-completions",
    "models": [
      "DeepSeek-V4-Flash",
      "DeepSeek-V4-Pro",
      "GLM-5.1",
      "Kimi-K2.6"
    ],
    "doc": "https://docs.ebtech.com/ai/model-api.html"
  },
  "agnes": {
    "label": "Agnes AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://apihub.agnes-ai.com/v1",
    "api": "openai-completions",
    "models": [
      "agnes-2.0-flash",
      "agnes-2.5-flash",
      "agnes-2.5-pro-alpha"
    ],
    "doc": "https://agnes-ai.com/doc"
  },
  "amd": {
    "label": "AMD",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://developer.amd.com.cn/radeon/api/v1",
    "api": "openai-completions",
    "models": [
      "DeepSeek-V4-Flash",
      "DeepSeek-V4-Flash-Vision-Exp",
      "MiniCPM5-1B",
      "Qwen3.8-Flash-Next"
    ],
    "doc": "https://developer.amd.com.cn/radeon/tokenfactory"
  },
  "xiaomi-token-plan-sgp": {
    "label": "Xiaomi Token Plan (Singapore)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://token-plan-sgp.xiaomimimo.com/v1",
    "api": "openai-completions",
    "models": [
      "mimo-v2-pro",
      "mimo-v2-tts",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "mimo-v2.5-tts",
      "mimo-v2.5-tts-voiceclone",
      "mimo-v2.5-tts-voicedesign"
    ],
    "doc": "https://platform.xiaomimimo.com/#/docs"
  },
  "neon": {
    "label": "Neon",
    "tier": "template",
    "envName": null,
    "baseUrl": "${NEON_AI_GATEWAY_BASE_URL}/v1",
    "api": "openai-completions",
    "models": [
      "claude-fable-5",
      "claude-haiku-4-5",
      "claude-opus-4-1",
      "claude-opus-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "gemini-3-1-flash-lite",
      "gemini-3-1-pro",
      "gemini-3-5-flash",
      "gemini-3-5-flash-lite",
      "gemini-3-6-flash",
      "gemini-3-flash",
      "gemma-3-12b",
      "glm-5-2",
      "gpt-5"
    ],
    "doc": "https://neon.com/docs"
  },
  "qihang-ai": {
    "label": "QiHang",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.qhaigc.net/v1",
    "api": "openai-completions",
    "models": [
      "claude-haiku-4-5-20251001",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-5-20250929",
      "gemini-2.5-flash",
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      "gpt-5-mini",
      "gpt-5.2",
      "gpt-5.2-codex"
    ],
    "doc": "https://www.qhaigc.net/docs"
  },
  "scnet-token-plan": {
    "label": "SCNet Token Plan",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.scnet.cn/api/llm/v1",
    "api": "openai-completions",
    "models": [
      "DeepSeek-V3.2",
      "DeepSeek-V4-Flash",
      "DeepSeek-V4-Flash-0731",
      "DeepSeek-V4-Pro",
      "DeepSeek-V4-Pro-0813",
      "GLM-5",
      "GLM-5.1",
      "GLM-5.2",
      "Kimi-K2.5",
      "Kimi-K2.6",
      "Kimi-K2.7-Code",
      "Kimi-K3",
      "MiMo-V2.5-Pro",
      "MiniMax-M2.5",
      "MiniMax-M2.7",
      "MiniMax-M3",
      "Qwen3.8-Max"
    ],
    "doc": "https://www.scnet.cn/ac/openapi/doc/2.0/moduleapi/plans/token-plan.html"
  },
  "inference": {
    "label": "Inference",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://inference.net/v1",
    "api": "openai-completions",
    "models": [
      "google/gemma-3",
      "meta/llama-3.1-8b-instruct",
      "meta/llama-3.2-11b-vision-instruct",
      "meta/llama-3.2-1b-instruct",
      "meta/llama-3.2-3b-instruct",
      "mistral/mistral-nemo-12b-instruct",
      "osmosis/osmosis-structure-0.6b",
      "qwen/qwen-2.5-7b-vision-instruct",
      "qwen/qwen3-embedding-4b"
    ],
    "doc": "https://inference.net/models"
  },
  "aiand": {
    "label": "ai&",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.aiand.com/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-ai/deepseek-v4-flash",
      "deepseek-ai/deepseek-v4-pro",
      "google/gemma-4-31b-it",
      "moonshotai/kimi-k2.7-code",
      "moonshotai/kimi-k3",
      "motif-technologies/motif-3",
      "openai/gpt-oss-120b",
      "qwen/qwen3.6-27b",
      "qwen/qwen3.8-27b",
      "zai-org/glm-5.2",
      "zai-org/glm-5.3"
    ],
    "doc": "https://docs.aiand.com/"
  },
  "siliconflow": {
    "label": "SiliconFlow",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.siliconflow.com/v1",
    "api": "openai-completions",
    "models": [
      "ByteDance-Seed/Seed-OSS-36B-Instruct",
      "MiniMaxAI/MiniMax-M2.5",
      "Qwen/Qwen2.5-72B-Instruct",
      "Qwen/Qwen2.5-7B-Instruct",
      "Qwen/Qwen3-14B",
      "Qwen/Qwen3-235B-A22B-Thinking-2507",
      "Qwen/Qwen3-30B-A3B-Instruct-2507",
      "Qwen/Qwen3-32B",
      "Qwen/Qwen3-8B",
      "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "Qwen/Qwen3-VL-235B-A22B-Instruct",
      "Qwen/Qwen3-VL-235B-A22B-Thinking",
      "Qwen/Qwen3-VL-30B-A3B-Instruct",
      "Qwen/Qwen3-VL-30B-A3B-Thinking",
      "Qwen/Qwen3-VL-32B-Instruct",
      "Qwen/Qwen3-VL-32B-Thinking",
      "Qwen/Qwen3-VL-8B-Instruct",
      "Qwen/Qwen3.5-122B-A10B",
      "Qwen/Qwen3.5-27B"
    ],
    "doc": "https://cloud.siliconflow.com/models"
  },
  "stepfun-ai-step-plan": {
    "label": "StepFun Step Plan (Global)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.stepfun.ai/step_plan/v1",
    "api": "openai-completions",
    "models": [
      "step-3.5-flash",
      "step-3.5-flash-2603",
      "step-3.7-flash"
    ],
    "doc": "https://platform.stepfun.ai/docs/en/step-plan/integrations/reasoning-api"
  },
  "hetzner": {
    "label": "Hetzner",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://inference.hetzner.com/api/v1",
    "api": "openai-completions",
    "models": [
      "Qwen/Qwen3.6-35B-A3B-FP8",
      "Qwen3.8-27B"
    ],
    "doc": "https://experiments.hetzner.com/docs/inference"
  },
  "snowflake-cortex": {
    "label": "Snowflake Cortex",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1",
    "api": "openai-completions",
    "models": [
      "claude-fable-5",
      "claude-haiku-4-5",
      "claude-opus-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "deepseek-r1",
      "gemini-3.1-pro",
      "mistral-large2",
      "openai-gpt-4.1",
      "openai-gpt-5",
      "openai-gpt-5-mini",
      "openai-gpt-5-nano",
      "openai-gpt-5.1",
      "openai-gpt-5.2",
      "openai-gpt-5.4"
    ],
    "doc": "https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api"
  },
  "meganova": {
    "label": "Meganova",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.meganova.ai/v1",
    "api": "openai-completions",
    "models": [
      "MiniMaxAI/MiniMax-M2.1",
      "MiniMaxAI/MiniMax-M2.5",
      "Qwen/Qwen2.5-VL-32B-Instruct",
      "Qwen/Qwen3-235B-A22B-Instruct-2507",
      "Qwen/Qwen3.5-Plus",
      "XiaomiMiMo/MiMo-V2-Flash",
      "deepseek-ai/DeepSeek-R1-0528",
      "deepseek-ai/DeepSeek-V3-0324",
      "deepseek-ai/DeepSeek-V3.1",
      "deepseek-ai/DeepSeek-V3.2",
      "deepseek-ai/DeepSeek-V3.2-Exp",
      "meta-llama/Llama-3.3-70B-Instruct",
      "mistralai/Mistral-Nemo-Instruct-2407",
      "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
      "moonshotai/Kimi-K2-Thinking",
      "moonshotai/Kimi-K2.5",
      "zai-org/GLM-4.6",
      "zai-org/GLM-4.7",
      "zai-org/GLM-5"
    ],
    "doc": "https://docs.meganova.ai"
  },
  "moonshotai": {
    "label": "Moonshot AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.moonshot.ai/v1",
    "api": "openai-completions",
    "models": [
      "kimi-k2-0711-preview",
      "kimi-k2-0905-preview",
      "kimi-k2-thinking",
      "kimi-k2-thinking-turbo",
      "kimi-k2-turbo-preview",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
      "kimi-k3"
    ],
    "doc": "https://platform.moonshot.ai/docs/api/chat"
  },
  "volcengine-coding-plan": {
    "label": "Volcengine Ark Coding Plan",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3",
    "api": "openai-completions",
    "models": [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "doubao-seed-2.0-lite",
      "doubao-seed-2.1-turbo",
      "doubao-seed-evolving",
      "glm-5.3",
      "kimi-k2.7-code",
      "minimax-m3"
    ],
    "doc": "https://www.volcengine.com/docs/82379/1928261"
  },
  "302ai": {
    "label": "302.AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.302.ai/v1",
    "api": "openai-completions",
    "models": [
      "MiniMax-M1",
      "MiniMax-M2",
      "MiniMax-M2.1",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "chatgpt-4o-latest",
      "claude-3-5-haiku-20241022",
      "claude-3-5-haiku-latest",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-1-20250805",
      "claude-opus-4-1-20250805-thinking",
      "claude-opus-4-20250514",
      "claude-opus-4-5",
      "claude-opus-4-5-20251101",
      "claude-opus-4-5-20251101-thinking",
      "claude-opus-4-6",
      "claude-opus-4-6-thinking",
      "claude-opus-4-7",
      "claude-sonnet-4-20250514"
    ],
    "doc": "https://doc.302.ai"
  },
  "cohere": {
    "label": "Cohere",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "c4ai-aya-expanse-32b",
      "c4ai-aya-expanse-8b",
      "c4ai-aya-vision-32b",
      "c4ai-aya-vision-8b",
      "command-a-03-2025",
      "command-a-plus-05-2026",
      "command-a-reasoning-08-2025",
      "command-a-translate-08-2025",
      "command-a-vision-07-2025",
      "command-r-08-2024",
      "command-r-plus-08-2024",
      "command-r7b-12-2024",
      "command-r7b-arabic-02-2025",
      "north-mini-code-1-0"
    ],
    "doc": "https://docs.cohere.com/docs/models"
  },
  "upstage": {
    "label": "Upstage",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.upstage.ai/v1/solar",
    "api": "openai-completions",
    "models": [
      "solar-mini",
      "solar-pro2",
      "solar-pro3",
      "solar-pro4"
    ],
    "doc": "https://developers.upstage.ai/docs/apis/chat"
  },
  "sarvam": {
    "label": "Sarvam AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.sarvam.ai/v1",
    "api": "openai-completions",
    "models": [
      "sarvam-105b",
      "sarvam-30b"
    ],
    "doc": "https://docs.sarvam.ai/api-reference-docs/getting-started/models"
  },
  "zenifra": {
    "label": "Zenifra",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://ai.zenifra.com/v1",
    "api": "openai-completions",
    "models": [
      "alibaba/qwen3.6-35b-a3b"
    ],
    "doc": "https://docs.zenifra.com"
  },
  "bailing": {
    "label": "Bailing",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.tbox.cn/api/llm/v1/chat/completions",
    "api": "openai-completions",
    "models": [
      "Ling-1T",
      "Ring-1T"
    ],
    "doc": "https://alipaytbox.yuque.com/sxs0ba/ling/intro"
  },
  "tencent-tokenhub": {
    "label": "Tencent TokenHub",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://tokenhub.tencentmaas.com/v1",
    "api": "openai-completions",
    "models": [
      "hy3",
      "hy3-preview",
      "hy4-preview"
    ],
    "doc": "https://cloud.tencent.com/document/product/1823/130050"
  },
  "runinfra": {
    "label": "RunInfra",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.runinfra.ai/v1",
    "api": "openai-completions",
    "models": [
      "Inferact/Qwen3.8-2.4T-A95B-NVFP4",
      "Qwen/Qwen3.8-27B",
      "deepseek-ai/DeepSeek-V4-Flash-0731",
      "deepseek-ai/DeepSeek-V4-Pro-0813",
      "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16",
      "ornith-ai/Ornith-1.5-35B-A3B",
      "zai-org/GLM-5.3-Flash"
    ],
    "doc": "https://runinfra.ai/docs"
  },
  "ai-router": {
    "label": "AI-ROUTER",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.ai-router.dev/v1",
    "api": "openai-completions",
    "models": [
      "gpt-5.4",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra"
    ],
    "doc": "https://ai-router.dev/openai-compatible-api-gateway/"
  },
  "berget": {
    "label": "Berget.AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.berget.ai/v1",
    "api": "openai-completions",
    "models": [
      "Qwen/Qwen3.8-27B-FP8",
      "google/gemma-4-31B-it",
      "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
      "moonshotai/Kimi-K3",
      "zai-org/GLM-5.2",
      "zai-org/GLM-5.3-Flash"
    ],
    "doc": "https://api.berget.ai"
  },
  "synthetic": {
    "label": "Synthetic",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.synthetic.new/openai/v1",
    "api": "openai-completions",
    "models": [
      "hf:MiniMaxAI/MiniMax-M3",
      "hf:Qwen/Qwen3.6-27B",
      "hf:moonshotai/Kimi-K2.7-Code",
      "hf:moonshotai/Kimi-K3",
      "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
      "hf:openai/gpt-oss-120b",
      "hf:zai-org/GLM-4.7-Flash",
      "hf:zai-org/GLM-5.2",
      "hf:zai-org/GLM-5.3-Flash"
    ],
    "doc": "https://synthetic.new/pricing"
  },
  "mixlayer": {
    "label": "Mixlayer",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://models.mixlayer.ai/v1",
    "api": "openai-completions",
    "models": [
      "qwen/qwen3.5-122b-a10b",
      "qwen/qwen3.5-27b",
      "qwen/qwen3.5-35b-a3b",
      "qwen/qwen3.5-397b-a17b",
      "qwen/qwen3.5-9b"
    ],
    "doc": "https://docs.mixlayer.com"
  },
  "longcat": {
    "label": "LongCat",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.longcat.chat/openai",
    "api": "openai-completions",
    "models": [
      "LongCat-2.0"
    ],
    "doc": "https://longcat.chat/platform/docs/"
  },
  "togetherai": {
    "label": "Together AI",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "LiquidAI/LFM2-24B-A2B",
      "MiniMaxAI/MiniMax-M2.5",
      "MiniMaxAI/MiniMax-M2.7",
      "MiniMaxAI/MiniMax-M3",
      "Qwen/Qwen2.5-7B-Instruct-Turbo",
      "Qwen/Qwen3-235B-A22B-Instruct-2507-tput",
      "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
      "Qwen/Qwen3-Coder-Next-FP8",
      "Qwen/Qwen3.5-397B-A17B",
      "Qwen/Qwen3.5-9B",
      "Qwen/Qwen3.6-Plus",
      "Qwen/Qwen3.7-Max",
      "deepcogito/cogito-v2-1-671b",
      "deepseek-ai/DeepSeek-R1",
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-V3-1",
      "deepseek-ai/DeepSeek-V4-Flash-0731",
      "deepseek-ai/DeepSeek-V4-Pro",
      "deepseek-ai/DeepSeek-V4-Pro-0813",
      "essentialai/Rnj-1-Instruct"
    ],
    "doc": "https://docs.together.ai/docs/serverless-models"
  },
  "moark": {
    "label": "Moark",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://moark.com/v1",
    "api": "openai-completions",
    "models": [
      "GLM-4.7",
      "MiniMax-M2.1"
    ],
    "doc": "https://moark.com/docs/openapi/v1#tag/%E6%96%87%E6%9C%AC%E7%94%9F%E6%88%90"
  },
  "zenmux": {
    "label": "ZenMux",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://zenmux.ai/api/v1",
    "api": "openai-completions",
    "models": [
      "anthropic/claude-3.5-haiku",
      "anthropic/claude-3.7-sonnet",
      "anthropic/claude-fable-5",
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-opus-4",
      "anthropic/claude-opus-4.1",
      "anthropic/claude-opus-4.5",
      "anthropic/claude-opus-4.6",
      "anthropic/claude-opus-4.7",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-sonnet-5-free",
      "baidu/ernie-5.0-thinking-preview",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-v3.2",
      "deepseek/deepseek-v3.2-exp",
      "deepseek/deepseek-v4-flash"
    ],
    "doc": "https://docs.zenmux.ai"
  },
  "vancine": {
    "label": "Vancine",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://vancine.com/v1",
    "api": "openai-completions",
    "models": [
      "MiniMax-M3",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
      "glm-5.3",
      "glm-5.3-flash",
      "hy4-preview",
      "kimi-k3",
      "qwen3.8-flash",
      "qwen3.8-max"
    ],
    "doc": "https://vancine.com/docs"
  },
  "minimax-cn": {
    "label": "MiniMax (minimaxi.com)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.minimaxi.com/anthropic/v1",
    "api": "openai-completions",
    "models": [
      "MiniMax-M2",
      "MiniMax-M2.1",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M3"
    ],
    "doc": "https://platform.minimaxi.com/docs/guides/quickstart"
  },
  "cortecs": {
    "label": "Cortecs",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.cortecs.ai/v1",
    "api": "openai-completions",
    "models": [
      "apertus-70b",
      "claude-4-5-sonnet",
      "claude-4-6-sonnet",
      "claude-haiku-4-5",
      "claude-opus-5",
      "claude-opus4-5",
      "claude-opus4-6",
      "claude-opus4-7",
      "claude-opus4-8",
      "claude-sonnet-4",
      "claude-sonnet-5",
      "codestral-2508",
      "cosmos3-super-reasoner",
      "deepseek-r1-0528",
      "deepseek-v3.2",
      "deepseek-v4-flash-0731",
      "deepseek-v4-pro",
      "deepseek-v4-pro-0813",
      "devstral-2512",
      "gemini-2.5-flash"
    ],
    "doc": "https://api.cortecs.ai/v1/models"
  },
  "hpc-ai": {
    "label": "HPC-AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.hpc-ai.com/inference/v1",
    "api": "openai-completions",
    "models": [
      "anthropic/claude-opus-4.7",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "minimax/minimax-m2.5",
      "moonshotai/kimi-k2.5",
      "moonshotai/kimi-k2.7-code",
      "openai/gpt-5.5",
      "zai-org/glm-5.1",
      "zai-org/glm-5.2"
    ],
    "doc": "https://www.hpc-ai.com/doc/docs/quickstart/"
  },
  "tencent-coding-plan": {
    "label": "Tencent Coding Plan (China)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.lkeap.cloud.tencent.com/coding/v3",
    "api": "openai-completions",
    "models": [
      "glm-5",
      "hunyuan-2.0-instruct",
      "hunyuan-2.0-thinking",
      "hunyuan-t1",
      "hunyuan-turbos",
      "kimi-k2.5",
      "minimax-m2.5",
      "tc-code-latest"
    ],
    "doc": "https://cloud.tencent.com/document/product/1772/128947"
  },
  "v0": {
    "label": "v0",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "v0-1.0-md",
      "v0-1.5-lg",
      "v0-1.5-md"
    ],
    "doc": "https://sdk.vercel.ai/providers/ai-sdk-providers/vercel"
  },
  "nan": {
    "label": "NaN",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.nan.builders/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-v4-flash",
      "gemma4",
      "glm5.2",
      "glm5.3-flash",
      "mimo-v2.5",
      "qwen3.6",
      "qwen3.8-flash"
    ],
    "doc": "https://nan.builders/docs/models"
  },
  "perplexity": {
    "label": "Perplexity",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "sonar",
      "sonar-deep-research",
      "sonar-pro",
      "sonar-reasoning-pro"
    ],
    "doc": "https://docs.perplexity.ai"
  },
  "kimi-for-coding": {
    "label": "Kimi For Coding",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.kimi.com/coding/v1",
    "api": "openai-completions",
    "models": [
      "k3",
      "k3-256k",
      "kimi-for-coding",
      "kimi-for-coding-highspeed"
    ],
    "doc": "https://www.kimi.com/code/docs/en/kimi-code/models.html"
  },
  "alibaba-token-plan-cn": {
    "label": "Alibaba Token Plan (China)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "api": "openai-completions",
    "models": [
      "MiniMax-M2.5",
      "deepseek-v3.2",
      "deepseek-v4-flash",
      "deepseek-v4-flash-0731",
      "deepseek-v4-pro",
      "deepseek-v4-pro-0813",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
      "happyhorse-1.1-i2v",
      "happyhorse-1.1-r2v",
      "happyhorse-1.1-t2v",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "qwen-image-2.0",
      "qwen-image-2.0-pro",
      "qwen3.6-flash",
      "qwen3.6-plus",
      "qwen3.7-max"
    ],
    "doc": "https://www.alibabacloud.com/help/zh/model-studio/token-plan-overview"
  },
  "drun": {
    "label": "D.Run (China)",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://chat.d.run/v1",
    "api": "openai-completions",
    "models": [
      "public/deepseek-r1",
      "public/deepseek-v3",
      "public/minimax-m25"
    ],
    "doc": "https://www.d.run"
  },
  "google-vertex-anthropic": {
    "label": "Vertex (Anthropic)",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "claude-fable-5-1@default",
      "claude-fable-5@default",
      "claude-haiku-4-5@20251001",
      "claude-opus-4-1@20250805",
      "claude-opus-4-5@20251101",
      "claude-opus-4-6@default",
      "claude-opus-4-7@default",
      "claude-opus-4-8@default",
      "claude-opus-4@20250514",
      "claude-opus-5@default",
      "claude-sonnet-4-5@20250929",
      "claude-sonnet-4-6@default",
      "claude-sonnet-4@20250514",
      "claude-sonnet-5@default"
    ],
    "doc": "https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude"
  },
  "anyapi": {
    "label": "AnyAPI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.anyapi.ai/v1",
    "api": "openai-completions",
    "models": [
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-sonnet-4-6",
      "cohere/command-r-plus-08-2024",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-r1",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-flash-lite",
      "google/gemini-2.5-pro",
      "google/gemini-3-flash-preview",
      "google/gemini-3-pro-preview",
      "mistralai/devstral-2512",
      "mistralai/mistral-large-2512",
      "openai/gpt-4.1",
      "openai/gpt-4.1-mini",
      "openai/gpt-5"
    ],
    "doc": "https://docs.anyapi.ai"
  },
  "opencode-go": {
    "label": "OpenCode Go",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://opencode.ai/zen/go/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "gpt-5.6-luna",
      "grok-4.5",
      "grok-4.6",
      "hy3",
      "hy4-preview",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k3",
      "longcat-2.0",
      "mimo-v2-omni",
      "mimo-v2-pro"
    ],
    "doc": "https://opencode.ai/docs/zen"
  },
  "tencent-token-plan": {
    "label": "Tencent Token Plan",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.lkeap.cloud.tencent.com/plan/v3",
    "api": "openai-completions",
    "models": [
      "hy3",
      "hy4-preview"
    ],
    "doc": "https://cloud.tencent.com/document/product/1823/130060"
  },
  "gitlab": {
    "label": "GitLab Duo",
    "tier": "template",
    "envName": null,
    "baseUrl": null,
    "api": "openai-completions",
    "models": [
      "duo-chat-fable-5",
      "duo-chat-fable-5-1",
      "duo-chat-gpt-5-1",
      "duo-chat-gpt-5-2",
      "duo-chat-gpt-5-2-codex",
      "duo-chat-gpt-5-3-codex",
      "duo-chat-gpt-5-4",
      "duo-chat-gpt-5-4-mini",
      "duo-chat-gpt-5-4-nano",
      "duo-chat-gpt-5-5",
      "duo-chat-gpt-5-6-luna",
      "duo-chat-gpt-5-6-sol",
      "duo-chat-gpt-5-6-terra",
      "duo-chat-gpt-5-codex",
      "duo-chat-gpt-5-mini",
      "duo-chat-haiku-4-5",
      "duo-chat-opus-4-5",
      "duo-chat-opus-4-6",
      "duo-chat-opus-4-7",
      "duo-chat-opus-4-8"
    ],
    "doc": "https://docs.gitlab.com/user/duo_agent_platform/"
  },
  "neosmith": {
    "label": "NeoSmith",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://router.neosmith.ai/v1",
    "api": "openai-completions",
    "models": [
      "neosmith.intelligent-basic",
      "neosmith.intelligent-maestro",
      "neosmith.intelligent-pro",
      "neosmith.neolite"
    ],
    "doc": "https://neosmith.ai/docs"
  },
  "tinfoil": {
    "label": "Tinfoil",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://inference.tinfoil.sh/v1",
    "api": "openai-completions",
    "models": [
      "deepseek-v4-flash",
      "gemma4-31b",
      "glm-5-3-flash",
      "gpt-oss-120b",
      "gpt-oss-safeguard-120b",
      "kimi-k3",
      "llama3-3-70b",
      "nomic-embed-text"
    ],
    "doc": "https://docs.tinfoil.sh"
  },
  "edenai": {
    "label": "Eden AI",
    "tier": "template",
    "envName": null,
    "baseUrl": "https://api.edenai.run/v3",
    "api": "openai-completions",
    "models": [
      "amazon/moonshot.kimi-k2-thinking",
      "amazon/moonshotai.kimi-k2.5",
      "amazon/zai.glm-4.7-flash",
      "amazon/zai.glm-4.7-flash@us",
      "anthropic/claude-fable-5",
      "anthropic/claude-fable-5-1",
      "anthropic/claude-fable-latest",
      "anthropic/claude-opus-4-5",
      "anthropic/claude-opus-4-5-20251101",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-opus-4-7",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-latest",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-sonnet-latest",
      "azure/gpt-5.1-codex",
      "azure/gpt-5.1-codex-max",
      "azure/gpt-5.1-codex-mini"
    ],
    "doc": "https://docs.edenai.co"
  },
  "lmstudio": {
    "label": "LMStudio",
    "tier": "template",
    "envName": null,
    "baseUrl": "http://127.0.0.1:1234/v1",
    "api": "openai-completions",
    "models": [
      "openai/gpt-oss-20b",
      "qwen/qwen3-30b-a3b-2507",
      "qwen/qwen3-coder-30b"
    ],
    "doc": "https://lmstudio.ai/models"
  },
  "lynkr": {
    "label": "Lynkr",
    "tier": "template",
    "envName": null,
    "baseUrl": "http://127.0.0.1:8081/v1",
    "api": "openai-completions",
    "models": [
      "lynkr-auto"
    ],
    "doc": "https://github.com/Fast-Editor/Lynkr"
  }
};

/** The builtin tier ids in exact mapping order (the dashboard's PROVIDER_IDS
 *  allowlist sequence — plan 24 / AL-24-5, `ark` last). */
export const PROVIDER_IDS_BUILTIN: readonly string[] = Object.freeze([
  "anthropic",
  "openai",
  "gemini",
  "copilot",
  "azure-openai",
  "groq",
  "cerebras",
  "xai",
  "openrouter",
  "kilo",
  "mistral",
  "zai",
  "umans",
  "minimax",
  "opencode",
  "cursor",
  "ai-gateway",
  "wafer-serverless",
  "ark"
]);

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

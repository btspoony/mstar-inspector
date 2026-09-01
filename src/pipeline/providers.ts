/**
 * omp provider ids → review-container env var names (the per-App BYOK
 * allowlist, plan 24 / AL-24-5).
 *
 * Single source of truth for the provider key allowlist: the queue consumer
 * (src/pipeline/consumer.ts) injects ONLY keys stored on the App's own
 * per-App config (app_provider_keys, via `resolveAppConfig`) into the review
 * container's exec env — there is NO Worker-env provider-key surface (the
 * `bun run keys` face was retired with the global fallback, AL-24-5 verdict
 * 1). The mapping lives HERE; the dashboard's PROVIDER_IDS mirror
 * (src/dashboard/app-config-store.ts) is parity-locked against this
 * mapping's key sequence by tests/worker/app-config.test.ts (dashboard
 * modules never import pipeline code — architect decision Q2; the copy is
 * the SSOT there).
 *
 * The env names match omp's built-in provider discovery (help-extra "Core
 * Providers" + "Additional LLM Providers" API-key envs: ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GEMINI_API_KEY, COPILOT_GITHUB_TOKEN, AZURE_OPENAI_API_KEY,
 * GROQ_API_KEY, CEREBRAS_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY,
 * KILO_API_KEY, MISTRAL_API_KEY, ZAI_API_KEY, UMANS_AI_CODING_PLAN_API_KEY,
 * MINIMAX_API_KEY, OPENCODE_API_KEY, CURSOR_ACCESS_TOKEN, AI_GATEWAY_API_KEY,
 * WAFER_SERVERLESS_API_KEY — WF-004). `ark` → ARK_API_KEY lets the in-image
 * ark-plan base provider (sandbox-image/omp-models.yml) authenticate from
 * the SAME per-App keys map as every other provider (AL-24-5 mechanism — the
 * ark key rides per-App BYOK, no OMP_MODEL_KEY). OAuth
 * (ANTHROPIC_OAUTH_TOKEN), AWS/Vertex and search keys are deliberately
 * absent (different auth mechanisms).
 */

export type ProviderInfo = {
  /** The env var name the key is injected under inside the review container. */
  envName: string;
  /** Human-readable provider label for the picker/table. */
  label: string;
};

export const PROVIDERS: Record<string, ProviderInfo> = {
  anthropic: { envName: "ANTHROPIC_API_KEY", label: "Anthropic" },
  openai: { envName: "OPENAI_API_KEY", label: "OpenAI" },
  gemini: { envName: "GEMINI_API_KEY", label: "Google Gemini" },
  copilot: { envName: "COPILOT_GITHUB_TOKEN", label: "GitHub Copilot" },
  "azure-openai": { envName: "AZURE_OPENAI_API_KEY", label: "Azure OpenAI" },
  groq: { envName: "GROQ_API_KEY", label: "Groq" },
  cerebras: { envName: "CEREBRAS_API_KEY", label: "Cerebras" },
  xai: { envName: "XAI_API_KEY", label: "xAI" },
  openrouter: { envName: "OPENROUTER_API_KEY", label: "OpenRouter" },
  kilo: { envName: "KILO_API_KEY", label: "Kilo" },
  mistral: { envName: "MISTRAL_API_KEY", label: "Mistral" },
  zai: { envName: "ZAI_API_KEY", label: "Z.AI" },
  umans: { envName: "UMANS_AI_CODING_PLAN_API_KEY", label: "Umans AI Coding Plan" },
  minimax: { envName: "MINIMAX_API_KEY", label: "MiniMax" },
  opencode: { envName: "OPENCODE_API_KEY", label: "OpenCode" },
  cursor: { envName: "CURSOR_ACCESS_TOKEN", label: "Cursor" },
  "ai-gateway": { envName: "AI_GATEWAY_API_KEY", label: "AI Gateway" },
  "wafer-serverless": { envName: "WAFER_SERVERLESS_API_KEY", label: "Wafer Serverless" },
  ark: { envName: "ARK_API_KEY", label: "Ark" },
};

/** Resolve the env var name a provider key is injected under, or undefined if unknown. */
export function providerEnvName(name: string): string | undefined {
  return PROVIDERS[name]?.envName;
}

/** Every provider key env name, in mapping order (frozen snapshot). */
export const PROVIDER_ENV_NAMES: readonly string[] = Object.freeze(
  Object.values(PROVIDERS).map((info) => info.envName),
);

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

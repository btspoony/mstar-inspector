/**
 * omp built-in providers → Worker env var names (shared mapping, bugbot BB-2).
 *
 * Single source of truth for the provider key allowlist: the queue consumer
 * (src/pipeline/consumer.ts) forwards EVERY known provider key that is
 * present-and-non-empty on the Worker env into the review container's exec
 * env, and scripts/provider-keys.ts (`bun run keys`) sets these same names on
 * the deployed Worker via `wrangler secret put`. The mapping lives HERE — the
 * script imports it (zero duplicated literals; tests/scripts/provider-keys
 * coverage test locks it).
 *
 * The env names match omp's built-in provider discovery (help-extra "Core
 * Providers" + "Additional LLM Providers" API-key envs: ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GEMINI_API_KEY, COPILOT_GITHUB_TOKEN, AZURE_OPENAI_API_KEY,
 * GROQ_API_KEY, CEREBRAS_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY,
 * KILO_API_KEY, MISTRAL_API_KEY, ZAI_API_KEY, UMANS_AI_CODING_PLAN_API_KEY,
 * MINIMAX_API_KEY, OPENCODE_API_KEY, CURSOR_ACCESS_TOKEN, AI_GATEWAY_API_KEY,
 * WAFER_SERVERLESS_API_KEY — WF-004). ARK_* is NOT built-in — the ark-plan
 * provider stays configured via sandbox-image/omp-models.yml (custom baseUrl
 * provider, key = OMP_MODEL_KEY); OAuth (ANTHROPIC_OAUTH_TOKEN), AWS/Vertex
 * and search keys are deliberately absent (different auth mechanisms).
 */

export type ProviderInfo = {
  /** Worker env var name the key is stored under (wrangler secret put target). */
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
};

/** Resolve the Worker env var name for a provider, or undefined if unknown. */
export function providerEnvName(name: string): string | undefined {
  return PROVIDERS[name]?.envName;
}

/** Every provider key env name, in mapping order (frozen snapshot). */
export const PROVIDER_ENV_NAMES: readonly string[] = Object.freeze(
  Object.values(PROVIDERS).map((info) => info.envName),
);

/**
 * Read the present-and-non-empty provider keys from a worker-env-shaped
 * record (bugbot PR-3 BB-2). Allowlist = PROVIDERS only — arbitrary env keys
 * are NEVER picked up; a non-string value (e.g. a non-string binding
 * shadowing the name) or a whitespace-only value is treated as absent.
 */
export function pickProviderKeys(env: Record<string, unknown>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const info of Object.values(PROVIDERS)) {
    const value = env[info.envName];
    if (typeof value === "string" && value.trim() !== "") {
      picked[info.envName] = value;
    }
  }
  return picked;
}
/**
 * AL-23-1 env-name contract fragments for custom-provider API keys. The full
 * mapping is CUSTOM_<UPPER_SNAKE(provider_id)>_API_KEY — provider ids are
 * store-enforced `[a-z0-9][a-z0-9-]{0,63}` (hyphen → underscore, uppercased).
 */
export const CUSTOM_PROVIDER_ENV_PREFIX = "CUSTOM_";
export const CUSTOM_PROVIDER_ENV_SUFFIX = "_API_KEY";

/**
 * Env var name for a custom-provider API key (plan 23 Task 3, AL-23-1): a
 * total function — any id maps to a syntactically valid env var name. The
 * queue consumer injects the decrypted key under this name and the runner's
 * synthesized per-review models.yml references the SAME name (`apiKey:
 * CUSTOM_<ID>_API_KEY` — omp resolves env first, literal fallback, so the
 * consumer-side injection closes the "declaration ⇒ key ⇒ env" loop).
 */
export function customProviderEnvName(providerId: string): string {
  return `${CUSTOM_PROVIDER_ENV_PREFIX}${providerId.toUpperCase().replace(/-/g, "_")}${CUSTOM_PROVIDER_ENV_SUFFIX}`;
}

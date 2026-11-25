/**
 * GENERATED FILE — per-model size table (context window / max output) for the
 * provider catalog. DO NOT EDIT BY HAND — regenerate with
 * `bun run scripts/generate-provider-catalog.ts`.
 *
 * Source: `scripts/provider-catalog/inputs/models.dev-2026-11-25.json` (fetched
 * 2026-11-25 from https://models.dev/api.json; each model carries
 * `limit: { context, output }`). Only providers and model ids that the
 * generated provider catalog lists are carried here — the table exists to fill
 * an operator's blank size fields, not to mirror the whole directory.
 *
 * Coverage: 326 of 334 catalog providers, 9893 model entries. The omitted
 * 8 providers carry no models.dev model row at all (their
 * vocabulary comes from the vendored omp provider snapshot, or the row is
 * local-only metadata), so the table states no number for them instead of
 * inventing one:
 *   cursor, qwen-portal, firepass, helmcode, qianfan, coreweave, yolo-auto, typesafe
 *
 * Static data, zero imports, zero network: the Worker, the dashboard and the
 * sandbox image only ever import this module.
 */

/** One model's sizes, in tokens. */
export type ModelLimit = { contextWindow: number; maxTokens: number };

/** The snapshot date the table was generated from (shown as the value's source). */
export const MODEL_LIMITS_SNAPSHOT = "2026-11-25";

/** provider id → model id → sizes. */
export const MODEL_LIMITS: Readonly<Record<string, Readonly<Record<string, ModelLimit>>>> = Object.freeze({
  "anthropic": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-5-20251101": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-5-20250929": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    }
  },
  "openai": {
    "gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-4o-2024-08-06": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-4o-2024-11-20": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 272000
    },
    "gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra-healthcare": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol-healthcare": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-astra-healthcare": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-sol-healthcare": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-daybreak-blue-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-daybreak-red-latest": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o3-pro": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "text-embedding-3-large": {
      "contextWindow": 8191,
      "maxTokens": 3072
    },
    "text-embedding-3-small": {
      "contextWindow": 8191,
      "maxTokens": 1536
    },
    "text-embedding-ada-002": {
      "contextWindow": 8192,
      "maxTokens": 1536
    }
  },
  "gemini": {
    "deep-research-max-preview-04-2026": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deep-research-preview-04-2026": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-flash-image": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-flash-preview-tts": {
      "contextWindow": 8192,
      "maxTokens": 16384
    },
    "gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-pro-preview-tts": {
      "contextWindow": 8192,
      "maxTokens": 16384
    },
    "gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-pro-image": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "gemini-3.1-flash-image": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-flash-lite-image": {
      "contextWindow": 65536,
      "maxTokens": 4096
    },
    "gemini-3.1-flash-live-preview": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "gemini-3.1-flash-tts-preview": {
      "contextWindow": 8192,
      "maxTokens": 16384
    },
    "gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-pro-preview-customtools": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-live-translate-preview": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-embedding-001": {
      "contextWindow": 2048,
      "maxTokens": 1
    },
    "gemini-embedding-2": {
      "contextWindow": 8192,
      "maxTokens": 1
    },
    "gemini-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-flash-lite-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-pro-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemma-4-26b-a4b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "lyria-3-clip-preview": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "lyria-3-pro-preview": {
      "contextWindow": 131072,
      "maxTokens": 65536
    }
  },
  "copilot": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4.8": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4.6": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gemini-3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 128000
    },
    "grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 128000
    },
    "grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 128000
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "mai-code-1.1-flash": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "mai-code-2": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "mai-code-2-flash": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  },
  "azure-openai": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-mythos-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "codestral-2501": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "codex-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "cohere-command-a": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "cohere-embed-v-4-0": {
      "contextWindow": 128000,
      "maxTokens": 1536
    },
    "cohere-embed-v3-english": {
      "contextWindow": 512,
      "maxTokens": 1024
    },
    "cohere-embed-v3-multilingual": {
      "contextWindow": 512,
      "maxTokens": 1024
    },
    "deepseek-v3.2": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "deepseek-v3.2-speciale": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-3.5-turbo-0125": {
      "contextWindow": 16384,
      "maxTokens": 4096
    },
    "gpt-3.5-turbo-1106": {
      "contextWindow": 16384,
      "maxTokens": 4096
    },
    "gpt-3.5-turbo-instruct": {
      "contextWindow": 4096,
      "maxTokens": 4096
    },
    "gpt-4-turbo": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "gpt-4-turbo-vision": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex-max": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-chat-latest": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "grok-4-1-fast-non-reasoning": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "grok-4-1-fast-reasoning": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "grok-4-20-non-reasoning": {
      "contextWindow": 262000,
      "maxTokens": 8192
    },
    "grok-4-20-reasoning": {
      "contextWindow": 262000,
      "maxTokens": 8192
    },
    "grok-4.6": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "llama-3.3-70b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "llama-4-maverick-17b-128e-instruct-fp8": {
      "contextWindow": 1000000,
      "maxTokens": 16384
    },
    "llama-4-scout-17b-16e-instruct": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "ministral-3b": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "mistral-medium-2505": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "mistral-small-2503": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "model-router": {
      "contextWindow": 200000,
      "maxTokens": 16384
    },
    "o1": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o3-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o4-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "phi-4": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "phi-4-mini": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "phi-4-mini-reasoning": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "phi-4-multimodal": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "phi-4-reasoning": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "phi-4-reasoning-plus": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "text-embedding-3-large": {
      "contextWindow": 8192,
      "maxTokens": 3072
    },
    "text-embedding-3-small": {
      "contextWindow": 8192,
      "maxTokens": 1536
    },
    "text-embedding-ada-002": {
      "contextWindow": 8192,
      "maxTokens": 1536
    }
  },
  "groq": {
    "allam-2-7b": {
      "contextWindow": 4096,
      "maxTokens": 4096
    },
    "canopylabs/orpheus-arabic-saudi": {
      "contextWindow": 4000,
      "maxTokens": 50000
    },
    "canopylabs/orpheus-v1-english": {
      "contextWindow": 4000,
      "maxTokens": 50000
    },
    "llama-3.1-8b-instant": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "llama-3.3-70b-versatile": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "meta-llama/llama-prompt-guard-2-22m": {
      "contextWindow": 512,
      "maxTokens": 512
    },
    "meta-llama/llama-prompt-guard-2-86m": {
      "contextWindow": 512,
      "maxTokens": 512
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "openai/gpt-oss-safeguard-20b": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-27b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "whisper-large-v3": {
      "contextWindow": 448,
      "maxTokens": 448
    },
    "whisper-large-v3-turbo": {
      "contextWindow": 448,
      "maxTokens": 448
    }
  },
  "cerebras": {
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 40960
    },
    "qwen-3.8-27b": {
      "contextWindow": 131072,
      "maxTokens": 40960
    }
  },
  "xai": {
    "grok-4.20-0309-non-reasoning": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "grok-4.20-0309-reasoning": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "grok-4.20-multi-agent-0309": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    }
  },
  "openrouter": {
    "aion-labs/aion-2.0": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "aion-labs/aion-3.0": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "aion-labs/aion-3.0-mini": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "aion-labs/aion-3.5": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "aion-labs/aion-3.5-mini": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "aion-labs/aion-rp-llama-3.1-8b": {
      "contextWindow": 32768,
      "maxTokens": 29491
    },
    "amazon/nova-2-lite-v1": {
      "contextWindow": 1000000,
      "maxTokens": 65535
    },
    "amazon/nova-lite-v1": {
      "contextWindow": 300000,
      "maxTokens": 5120
    },
    "amazon/nova-micro-v1": {
      "contextWindow": 128000,
      "maxTokens": 5120
    },
    "amazon/nova-premier-v1": {
      "contextWindow": 1000000,
      "maxTokens": 32000
    },
    "amazon/nova-pro-v1": {
      "contextWindow": 300000,
      "maxTokens": 5120
    },
    "anthracite-org/magnum-v4-72b": {
      "contextWindow": 32768,
      "maxTokens": 4096
    },
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-haiku-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.1": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "anthropic/claude-opus-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4.5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "baidu/ernie-5.5-flash-preview:free": {
      "contextWindow": 1024000,
      "maxTokens": 921600
    },
    "baidu/ernie-light-dt-1.0-intl": {
      "contextWindow": 1024000,
      "maxTokens": 131072
    },
    "bytedance-seed/seed-2-1-turbo": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "bytedance-seed/seed-2.0-lite": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "bytedance-seed/seed-2.0-mini": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "bytedance/ui-tars-1.5-7b": {
      "contextWindow": 128000,
      "maxTokens": 2048
    },
    "cognitivecomputations/dolphin-mistral-24b-venice-edition": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "cohere/command-a": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "cohere/command-a-plus": {
      "contextWindow": 192000,
      "maxTokens": 64000
    },
    "cohere/command-r-08-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "cohere/command-r-plus-08-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "cohere/command-r7b-12-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "deepseek/deepseek-chat": {
      "contextWindow": 163840,
      "maxTokens": 16000
    },
    "deepseek/deepseek-chat-v3-0324": {
      "contextWindow": 163840,
      "maxTokens": 147456
    },
    "deepseek/deepseek-chat-v3.1": {
      "contextWindow": 163840,
      "maxTokens": 32768
    },
    "deepseek/deepseek-r1-0528": {
      "contextWindow": 163840,
      "maxTokens": 32000
    },
    "deepseek/deepseek-v3.1-terminus": {
      "contextWindow": 163840,
      "maxTokens": 147456
    },
    "deepseek/deepseek-v3.2": {
      "contextWindow": 163840,
      "maxTokens": 64000
    },
    "deepseek/deepseek-v3.2-exp": {
      "contextWindow": 163840,
      "maxTokens": 147456
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "elorian/glimpse": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "fireworks/ember-1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "google/gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "google/gemini-2.5-flash-image": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "google/gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "google/gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-2.5-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3-pro-image": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "google/gemini-3-pro-image-preview": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "google/gemini-3.1-flash-image": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "google/gemini-3.1-flash-image-preview": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "google/gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-flash-lite-image": {
      "contextWindow": 65536,
      "maxTokens": 4096
    },
    "google/gemini-3.1-flash-lite-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview-customtools": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-nano-banana-2.1": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "google/gemini-omni-1.1-flash": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "google/gemini-omni-1.2-flash": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "google/gemma-2-27b-it": {
      "contextWindow": 8192,
      "maxTokens": 2048
    },
    "google/gemma-3-12b-it": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "google/gemma-3-27b-it": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "google/gemma-3-4b-it": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "google/gemma-4-26b-a4b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "google/gemma-4-26b-a4b-it:free": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "google/gemma-4-31b-it:free": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "google/lyria-3-clip-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/lyria-3-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gryphe/mythomax-l2-13b": {
      "contextWindow": 8192,
      "maxTokens": 3200
    },
    "ibm-granite/granite-4.2-8b": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "inclusionai/ling-3.0-flash": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "inclusionai/ling-3.0-flash-vl": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "inclusionai/ling-3.0-tiny": {
      "contextWindow": 262144,
      "maxTokens": 250000
    },
    "inclusionai/ling-3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "inclusionai/ling-3.2-flash:free": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "inference-net/schematron-v2-small": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "inference-net/schematron-v2-turbo": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "kt/midm-k-3.0-pro": {
      "contextWindow": 261795,
      "maxTokens": 235615
    },
    "liquid/lfm-2.5-24b-a2b": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "liquid/lfm-3-1.7b": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "liquid/lfm-3-1.7b:free": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "mancer/weaver": {
      "contextWindow": 8000,
      "maxTokens": 6000
    },
    "meta-llama/llama-3.1-70b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "meta-llama/llama-3.1-8b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "meta-llama/llama-3.2-3b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "meta-llama/llama-3.3-70b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "meta-llama/llama-4-maverick": {
      "contextWindow": 524288,
      "maxTokens": 32768
    },
    "meta-llama/llama-4-scout": {
      "contextWindow": 327680,
      "maxTokens": 16384
    },
    "meta-llama/llama-guard-4-12b": {
      "contextWindow": 163840,
      "maxTokens": 16384
    },
    "meta/muse-ember": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "meta/muse-glimmer-30b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.2-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "meta/muse-spark-1.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.3-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "meta/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-wonder": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "microsoft/phi-4": {
      "contextWindow": 16384,
      "maxTokens": 14745
    },
    "minimax/minimax-m2.5": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "minimax/minimax-m2.7": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "minimax/minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "minimax/minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mistralai/codestral-2508": {
      "contextWindow": 256000,
      "maxTokens": 204800
    },
    "mistralai/devstral-2512": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/ministral-14b-2512": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/ministral-3b-2512": {
      "contextWindow": 131072,
      "maxTokens": 104857
    },
    "mistralai/ministral-8b-2512": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/mistral-large": {
      "contextWindow": 128000,
      "maxTokens": 102400
    },
    "mistralai/mistral-large-2407": {
      "contextWindow": 131072,
      "maxTokens": 104857
    },
    "mistralai/mistral-large-2512": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/mistral-large-4-0": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "mistralai/mistral-medium-3-5": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/mistral-nemo": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "mistralai/mistral-saba": {
      "contextWindow": 32768,
      "maxTokens": 26214
    },
    "mistralai/mistral-small-24b-instruct-2501": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "mistralai/mistral-small-2603": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/mistral-small-3.1-24b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 102400
    },
    "mistralai/mistral-small-3.2-24b-instruct": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "mistralai/mixtral-8x22b-instruct": {
      "contextWindow": 65536,
      "maxTokens": 52428
    },
    "mistralai/pixtral-large-2502": {
      "contextWindow": 128000,
      "maxTokens": 102400
    },
    "mistralai/voxtral-small-24b-2507": {
      "contextWindow": 32768,
      "maxTokens": 26214
    },
    "moondream/moondream3-preview": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "moondream/moondream3.1-9b-a2b": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "moonshotai/kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "morph/morph-v3-fast": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "morph/morph-v3-large": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "motif-technologies/motif-3": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "nex-agi/nex-n2.5-mini": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "nex-agi/nex-n2.5-pro": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "nex-agi/nex-n2.6": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "nousresearch/hermes-4-405b": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "nvidia/nemotron-3-nano-30b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "nvidia/nemotron-3-super-120b-a12b": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "nvidia/nemotron-3-ultra-550b-a55b:free": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "nvidia/nemotron-3.5-content-safety": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "nvidia/nemotron-3.5-lightning": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "nvidia/nemotron-3.5-lightning:free": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "nvidia/nemotron-3.5-super-vl": {
      "contextWindow": 1048576,
      "maxTokens": 8192
    },
    "nvidia/nemotron-3.5-super-vl:free": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "openai/gpt-3.5-turbo-0613": {
      "contextWindow": 4095,
      "maxTokens": 3685
    },
    "openai/gpt-3.5-turbo-16k": {
      "contextWindow": 16385,
      "maxTokens": 4096
    },
    "openai/gpt-4": {
      "contextWindow": 8191,
      "maxTokens": 4096
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-2024-05-13": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "openai/gpt-4o-2024-08-06": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-2024-11-20": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini-2024-07-18": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-image": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-image-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex-max": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-image-2": {
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-audio": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-audio-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-chat-latest": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/gpt-oss-safeguard-20b": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "openai/o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-pro": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openrouter/auto": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "openrouter/bodybuilder": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "openrouter/free": {
      "contextWindow": 200000,
      "maxTokens": 8000
    },
    "openrouter/fusion": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openrouter/pareto-code": {
      "contextWindow": 2000000,
      "maxTokens": 200000
    },
    "particle-ai/particle-1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "particle-ai/particle-1:free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "perceptron/perceptron-mk1": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "perceptron/perceptron-mk1.5": {
      "contextWindow": 36864,
      "maxTokens": 8192
    },
    "perplexity/sonar": {
      "contextWindow": 127072,
      "maxTokens": 114364
    },
    "perplexity/sonar-deep-research": {
      "contextWindow": 128000,
      "maxTokens": 115200
    },
    "perplexity/sonar-pro": {
      "contextWindow": 200000,
      "maxTokens": 8000
    },
    "perplexity/sonar-pro-search": {
      "contextWindow": 200000,
      "maxTokens": 8000
    },
    "perplexity/sonar-reasoning-pro": {
      "contextWindow": 128000,
      "maxTokens": 115200
    },
    "prism-ml/ternary-bonsai-2-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "prism-ml/ternary-bonsai-2-9b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen-2.5-72b-instruct": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "qwen/qwen-2.5-coder-32b-instruct": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "qwen/qwen-plus": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "qwen/qwen2.5-vl-72b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "qwen/qwen3-14b": {
      "contextWindow": 40960,
      "maxTokens": 16384
    },
    "qwen/qwen3-235b-a22b-2507": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "qwen/qwen3-235b-a22b-thinking-2507": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "qwen/qwen3-30b-a3b": {
      "contextWindow": 40960,
      "maxTokens": 16384
    },
    "qwen/qwen3-30b-a3b-instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "qwen/qwen3-32b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "qwen/qwen3-coder": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3-coder-30b-a3b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3-coder-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3-coder-next": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3-next-80b-a3b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3-vl-235b-a22b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3-vl-30b-a3b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "qwen/qwen3-vl-8b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "qwen/qwen3.5-122b-a10b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-27b": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "qwen/qwen3.5-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "qwen/qwen3.5-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "qwen/qwen3.5-9b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-flash-02-23": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-plus-02-15": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-plus-20260420": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-27b": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "qwen/qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-2.4t-a95b": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 1024000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-max-0902": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-max-prime": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-omni-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "radixark/daisyrose-27b": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "recursive/flint-v1.0:free": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "reflection/beam-1.0-501b-a23b": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "rekaai/reka-edge": {
      "contextWindow": 16384,
      "maxTokens": 14745
    },
    "rekaai/reka-flash-3": {
      "contextWindow": 65536,
      "maxTokens": 58982
    },
    "relace/relace-apply-3": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "relace/relace-search": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "ricursiveai/ripple-65b-preview": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "sakana/fugu-max": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "sakana/fugu-ultra": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "sakana/fugu-ultra-v2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "sakana/sakana-namazu": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "sao10k/l3-lunaris-8b": {
      "contextWindow": 8192,
      "maxTokens": 7372
    },
    "sao10k/l3.1-euryale-70b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "scaledown/extract": {
      "contextWindow": 1000000,
      "maxTokens": 900000
    },
    "scaledown/summarize": {
      "contextWindow": 1000000,
      "maxTokens": 4000
    },
    "stepfun/step-3.7-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "stepfun/step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "tencent/hy-mt2-1.8b": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "tencent/hy-mt2-30b-a3b": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "tencent/hy-mt2-7b": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "tencent/hy3": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "tencent/hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "tencent/hy4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "tencent/hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    },
    "thedrummer/cydonia-24b-v4.1": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "thedrummer/skyfall-36b-v2": {
      "contextWindow": 32768,
      "maxTokens": 29491
    },
    "thedrummer/unslopnemo-12b": {
      "contextWindow": 1024000,
      "maxTokens": 819200
    },
    "thinkingmachines/inkling": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "thinkingmachines/inkling-2-mini": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "thinkingmachines/inkling-2-small": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "thinkingmachines/inkling-small": {
      "contextWindow": 524288,
      "maxTokens": 262144
    },
    "unbiased/pareto-26.10": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "unbiased/pareto-26.10-preview": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "unbiased/pareto-26.9": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "undi95/remm-slerp-l2-13b": {
      "contextWindow": 6144,
      "maxTokens": 5529
    },
    "upstage/solar-mini-4-5": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "upstage/solar-mini4": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "upstage/solar-pro-4-contributor": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "upstage/solar-pro4": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "writer/palmyra-x5": {
      "contextWindow": 1040000,
      "maxTokens": 8192
    },
    "x-ai/grok-4.20": {
      "contextWindow": 2000000,
      "maxTokens": 1800000
    },
    "x-ai/grok-4.20-multi-agent": {
      "contextWindow": 2000000,
      "maxTokens": 1800000
    },
    "x-ai/grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "x-ai/grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "x-ai/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "x-ai/grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xiaomi/mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-flash-mopd": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "xiaomi/mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-pro-ultraspeed": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-4.5": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "z-ai/glm-4.5-air": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "z-ai/glm-4.5v": {
      "contextWindow": 65536,
      "maxTokens": 16384
    },
    "z-ai/glm-4.6": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-4.6v": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "z-ai/glm-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-4.7-flash": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "z-ai/glm-5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-5-turbo": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "z-ai/glm-5.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flashx": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flashx-legal": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-prime": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5v-turbo": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "~anthropic/claude-fable-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "~anthropic/claude-haiku-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "~anthropic/claude-opus-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "~anthropic/claude-sonnet-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "~deepseek/deepseek-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "~deepseek/deepseek-pro-latest": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "~deepseek/deepseek-v4-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "~google/gemini-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "~google/gemini-pro-latest": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "~moonshotai/kimi-latest": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "~openai/gpt-astra-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "~openai/gpt-luna-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "~openai/gpt-mini-latest": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "~openai/gpt-sol-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "~openai/gpt-terra-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "~unbiased/pareto-latest": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "~x-ai/grok-latest": {
      "contextWindow": 500000,
      "maxTokens": 450000
    },
    "~z-ai/glm-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "~z-ai/glm-latest": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    }
  },
  "kilo": {
    "aion-labs/aion-2.0": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "aion-labs/aion-3.0": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "aion-labs/aion-3.0-mini": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "aion-labs/aion-3.5": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "aion-labs/aion-3.5-mini": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "aion-labs/aion-rp-llama-3.1-8b": {
      "contextWindow": 32768,
      "maxTokens": 29491
    },
    "amazon/nova-2-lite-v1": {
      "contextWindow": 1000000,
      "maxTokens": 65535
    },
    "amazon/nova-lite": {
      "contextWindow": 300000,
      "maxTokens": 8192
    },
    "amazon/nova-lite-v1": {
      "contextWindow": 300000,
      "maxTokens": 5120
    },
    "amazon/nova-micro": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "amazon/nova-micro-v1": {
      "contextWindow": 128000,
      "maxTokens": 5120
    },
    "amazon/nova-premier-v1": {
      "contextWindow": 1000000,
      "maxTokens": 32000
    },
    "amazon/nova-pro": {
      "contextWindow": 300000,
      "maxTokens": 8192
    },
    "amazon/nova-pro-v1": {
      "contextWindow": 300000,
      "maxTokens": 5120
    },
    "anthracite-org/magnum-v4-72b": {
      "contextWindow": 32768,
      "maxTokens": 4096
    },
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-haiku-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.1": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "anthropic/claude-opus-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4.5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "baidu/ernie-5.5-flash-preview:free": {
      "contextWindow": 1024000,
      "maxTokens": 921600
    },
    "baidu/ernie-light-dt-1.0-intl": {
      "contextWindow": 1024000,
      "maxTokens": 131072
    },
    "bytedance-seed/seed-2-1-turbo": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "bytedance-seed/seed-2.0-lite": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "bytedance-seed/seed-2.0-mini": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "bytedance/ui-tars-1.5-7b": {
      "contextWindow": 128000,
      "maxTokens": 2048
    },
    "callstack/apex": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "cognitivecomputations/dolphin-mistral-24b-venice-edition": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "cohere/command-a": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "cohere/command-a-plus": {
      "contextWindow": 192000,
      "maxTokens": 64000
    },
    "cohere/command-r-08-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "cohere/command-r-plus-08-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "cohere/command-r7b-12-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "deepseek/deepseek-chat": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "deepseek/deepseek-chat-v3-0324": {
      "contextWindow": 163840,
      "maxTokens": 147456
    },
    "deepseek/deepseek-chat-v3.1": {
      "contextWindow": 163840,
      "maxTokens": 147456
    },
    "deepseek/deepseek-r1": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "deepseek/deepseek-r1-0528": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "deepseek/deepseek-v3.1-terminus": {
      "contextWindow": 163840,
      "maxTokens": 147456
    },
    "deepseek/deepseek-v3.2": {
      "contextWindow": 163840,
      "maxTokens": 147456
    },
    "deepseek/deepseek-v3.2-exp": {
      "contextWindow": 163840,
      "maxTokens": 147456
    },
    "deepseek/deepseek-v3.2-thinking": {
      "contextWindow": 128000,
      "maxTokens": 8000
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4.1-flash-1017-fast": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "deepseek/deepseek-v4.1-flash-1017-ultrafast": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepseek/deepseek-v4.1-flash-fast": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "elorian/glimpse": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "fireworks/ember-1": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "google/gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "google/gemini-2.5-flash-image": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "google/gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "google/gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-2.5-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65000
    },
    "google/gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3-pro-image": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "google/gemini-3-pro-image-preview": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "google/gemini-3.1-flash-image": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "google/gemini-3.1-flash-image-preview": {
      "contextWindow": 65536,
      "maxTokens": 58982
    },
    "google/gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-flash-lite-image": {
      "contextWindow": 65536,
      "maxTokens": 58982
    },
    "google/gemini-3.1-flash-lite-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview-customtools": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "google/gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "google/gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "google/gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "google/gemini-4-neon-fast": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "google/gemini-nano-banana-2.1": {
      "contextWindow": 65536,
      "maxTokens": 58982
    },
    "google/gemini-omni-1.1-flash": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "google/gemini-omni-1.2-flash": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "google/gemini-omni-flash-preview": {
      "contextWindow": 1000000,
      "maxTokens": 57920
    },
    "google/gemma-2-27b-it": {
      "contextWindow": 8192,
      "maxTokens": 2048
    },
    "google/gemma-3-12b-it": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "google/gemma-3-27b-it": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "google/gemma-3-4b-it": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "google/gemma-4-26b-a4b-it": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "google/lyria-3-clip-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/lyria-3-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gryphe/mythomax-l2-13b": {
      "contextWindow": 8192,
      "maxTokens": 7372
    },
    "humansand/ampersand-v0.1": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "ibm-granite/granite-4.2-8b": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "inception/mercury-3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "inclusionai/ling-3.0-flash": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "inclusionai/ling-3.0-flash-fin": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "inclusionai/ling-3.0-flash-sante": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "inclusionai/ling-3.0-flash-vl": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "inclusionai/ling-3.0-tiny": {
      "contextWindow": 262144,
      "maxTokens": 250000
    },
    "inclusionai/ling-3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "inclusionai/ling-3.1-flash-1019": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "inclusionai/ling-3.2-flash:free": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "inference-net/schematron-v2-small": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "inference-net/schematron-v2-turbo": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "interfaze/interfaze-beta": {
      "contextWindow": 1000000,
      "maxTokens": 32000
    },
    "kilo-auto/balanced": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "kilo-auto/efficient": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "kilo-auto/free": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "kilo-auto/frontier": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "kilo-auto/small": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "kt/midm-k-3.0-pro": {
      "contextWindow": 261795,
      "maxTokens": 235615
    },
    "liquid/lfm-2.5-24b-a2b": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "liquid/lfm-3-1.7b": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "liquid/lfm-3-1.7b:free": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "mancer/weaver": {
      "contextWindow": 8000,
      "maxTokens": 6000
    },
    "meituan/longcat-2.5": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta-llama/llama-3.1-70b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "meta-llama/llama-3.1-8b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "meta-llama/llama-3.2-3b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "meta-llama/llama-3.3-70b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 115200
    },
    "meta-llama/llama-4-maverick": {
      "contextWindow": 524288,
      "maxTokens": 32768
    },
    "meta-llama/llama-4-scout": {
      "contextWindow": 327680,
      "maxTokens": 16384
    },
    "meta-llama/llama-guard-4-12b": {
      "contextWindow": 163840,
      "maxTokens": 16384
    },
    "meta/muse-ember": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "meta/muse-glimmer-30b": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "meta/muse-spark-1.1": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "meta/muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "meta/muse-spark-1.2-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "meta/muse-spark-1.3": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "meta/muse-spark-1.3-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "meta/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "meta/muse-wonder": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "microsoft/phi-4": {
      "contextWindow": 16384,
      "maxTokens": 14745
    },
    "minimax/minimax-m2.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.5": {
      "contextWindow": 65536,
      "maxTokens": 58982
    },
    "minimax/minimax-m2.7": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "minimax/minimax-m3": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "minimax/minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mistralai/codestral": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "mistralai/codestral-2508": {
      "contextWindow": 256000,
      "maxTokens": 204800
    },
    "mistralai/devstral-2512": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/ministral-14b": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "mistralai/ministral-14b-2512": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/ministral-3b": {
      "contextWindow": 131072,
      "maxTokens": 4000
    },
    "mistralai/ministral-3b-2512": {
      "contextWindow": 131072,
      "maxTokens": 104857
    },
    "mistralai/ministral-8b": {
      "contextWindow": 262144,
      "maxTokens": 4000
    },
    "mistralai/ministral-8b-2512": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/mistral-large": {
      "contextWindow": 128000,
      "maxTokens": 102400
    },
    "mistralai/mistral-large-2407": {
      "contextWindow": 131072,
      "maxTokens": 104857
    },
    "mistralai/mistral-large-2512": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/mistral-large-4-0": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "mistralai/mistral-medium-3-5": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/mistral-nemo": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "mistralai/mistral-saba": {
      "contextWindow": 32768,
      "maxTokens": 26214
    },
    "mistralai/mistral-small": {
      "contextWindow": 262144,
      "maxTokens": 4000
    },
    "mistralai/mistral-small-24b-instruct-2501": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "mistralai/mistral-small-2603": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/mistral-small-3.1-24b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 102400
    },
    "mistralai/mistral-small-3.2-24b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "mistralai/mixtral-8x22b-instruct": {
      "contextWindow": 65536,
      "maxTokens": 52428
    },
    "mistralai/pixtral-large-2502": {
      "contextWindow": 128000,
      "maxTokens": 102400
    },
    "mistralai/voxtral-small-24b-2507": {
      "contextWindow": 32768,
      "maxTokens": 26214
    },
    "mixedbread/toast-1": {
      "contextWindow": 131000,
      "maxTokens": 4000
    },
    "moondream/moondream3-preview": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "moondream/moondream3.1-9b-a2b": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "moonshotai/kimi-k2": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "moonshotai/kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "moonshotai/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "moonshotai/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "moonshotai/kimi-k2.7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "moonshotai/kimi-k3-fast": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "moonshotai/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "moonshotai/kimi-k3.1-pro-highspeed": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "morph/morph-v3-fast": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "morph/morph-v3-large": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "motif-technologies/motif-3": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "nex-agi/nex-n2.5-mini": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "nex-agi/nex-n2.5-pro": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "nex-agi/nex-n2.6": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "nousresearch/hermes-4-405b": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "nvidia/nemotron-3-nano-30b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "nvidia/nemotron-3-super-120b-a12b": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "nvidia/nemotron-3-ultra-550b-a55b:free": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "nvidia/nemotron-3.5-content-safety": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "nvidia/nemotron-3.5-lightning": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "nvidia/nemotron-3.5-lightning:free": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "nvidia/nemotron-3.5-super-vl": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "nvidia/nemotron-3.5-super-vl:free": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "nvidia/nemotron-nano-12b-v2-vl": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "nvidia/nemotron-nano-9b-v2": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/gpt-3.5-turbo-0613": {
      "contextWindow": 4095,
      "maxTokens": 3685
    },
    "openai/gpt-3.5-turbo-16k": {
      "contextWindow": 16385,
      "maxTokens": 4096
    },
    "openai/gpt-4": {
      "contextWindow": 8191,
      "maxTokens": 4096
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-fast": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini-fast": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 942818
    },
    "openai/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-2024-05-13": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "openai/gpt-4o-2024-08-06": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-2024-11-20": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-fast": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini-2024-07-18": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini-fast": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-fast": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-image": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-image-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini-fast": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex-max": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-thinking": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-thinking-fast": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-fast": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex-fast": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-image-2": {
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini-fast": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5-fast": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-audio": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-audio-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-chat-latest": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "openai/gpt-oss-safeguard-120b": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "openai/gpt-oss-safeguard-20b": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "openai/o1": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-fast": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-pro": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o4-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openrouter/auto": {
      "contextWindow": 2000000,
      "maxTokens": 32768
    },
    "openrouter/bodybuilder": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "openrouter/free": {
      "contextWindow": 200000,
      "maxTokens": 32768
    },
    "openrouter/pareto-code": {
      "contextWindow": 200000,
      "maxTokens": 65536
    },
    "paperinstruments/ultramarine-1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131000
    },
    "particle-ai/particle-1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "particle-ai/particle-1:free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "particle/particle-1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "perceptron/perceptron-mk1": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "perceptron/perceptron-mk1.5": {
      "contextWindow": 36864,
      "maxTokens": 8192
    },
    "perplexity/sonar": {
      "contextWindow": 127072,
      "maxTokens": 114364
    },
    "perplexity/sonar-deep-research": {
      "contextWindow": 128000,
      "maxTokens": 115200
    },
    "perplexity/sonar-pro": {
      "contextWindow": 200000,
      "maxTokens": 8000
    },
    "perplexity/sonar-pro-search": {
      "contextWindow": 200000,
      "maxTokens": 8000
    },
    "perplexity/sonar-reasoning-pro": {
      "contextWindow": 128000,
      "maxTokens": 115200
    },
    "prism-ml/ternary-bonsai-2-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "prism-ml/ternary-bonsai-2-9b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "quiverai/arrow-2": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "quiverai/arrow-2-telos": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "qwen/qwen-2.5-72b-instruct": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "qwen/qwen-2.5-coder-32b-instruct": {
      "contextWindow": 32768,
      "maxTokens": 29491
    },
    "qwen/qwen-3-14b": {
      "contextWindow": 40960,
      "maxTokens": 16384
    },
    "qwen/qwen-plus": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "qwen/qwen2.5-vl-72b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 115200
    },
    "qwen/qwen3-14b": {
      "contextWindow": 40960,
      "maxTokens": 16384
    },
    "qwen/qwen3-235b-a22b-2507": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "qwen/qwen3-235b-a22b-thinking-2507": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "qwen/qwen3-30b-a3b": {
      "contextWindow": 40960,
      "maxTokens": 16384
    },
    "qwen/qwen3-30b-a3b-instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "qwen/qwen3-32b": {
      "contextWindow": 40960,
      "maxTokens": 16384
    },
    "qwen/qwen3-coder": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3-coder-30b-a3b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "qwen/qwen3-coder-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3-coder-next": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "qwen/qwen3-next-80b-a3b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "qwen/qwen3-vl-235b-a22b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3-vl-30b-a3b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "qwen/qwen3-vl-8b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "qwen/qwen3.5-122b-a10b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-27b": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "qwen/qwen3.5-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "qwen/qwen3.5-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "qwen/qwen3.5-9b": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "qwen/qwen3.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen/qwen3.5-flash-02-23": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen/qwen3.5-plus-02-15": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-plus-20260420": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-27b": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "qwen/qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "qwen/qwen3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-2.4t-a95b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "qwen/qwen3.8-max-0902": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-max-prime": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-omni-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "radixark/daisyrose-27b": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "recursive/flint-v1.0": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "recursive/flint-v1.0:free": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "reflection/beam-1.0-501b-a23b": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "reflection/beam-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "rekaai/reka-edge": {
      "contextWindow": 16384,
      "maxTokens": 14745
    },
    "rekaai/reka-flash-3": {
      "contextWindow": 65536,
      "maxTokens": 58982
    },
    "relace/relace-apply-3": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "relace/relace-search": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "ricursiveai/ripple-65b-preview": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "sakana/fugu-max": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "sakana/fugu-ultra": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "sakana/fugu-ultra-v2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "sakana/sakana-namazu": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "sao10k/l3-lunaris-8b": {
      "contextWindow": 8192,
      "maxTokens": 7372
    },
    "sao10k/l3.1-euryale-70b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "scaledown/extract": {
      "contextWindow": 1000000,
      "maxTokens": 900000
    },
    "scaledown/scaledown-extract-1": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "scaledown/scaledown-summarize-1": {
      "contextWindow": 1000000,
      "maxTokens": 1000
    },
    "scaledown/summarize": {
      "contextWindow": 1000000,
      "maxTokens": 4000
    },
    "stealth/glyph-cluster": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "stepfun/step-3.7-flash": {
      "contextWindow": 256000,
      "maxTokens": 230400
    },
    "stepfun/step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "tencent/hy-mt2-1.8b": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "tencent/hy-mt2-30b-a3b": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "tencent/hy-mt2-7b": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "tencent/hy-mt2-lite": {
      "contextWindow": 8000,
      "maxTokens": 4000
    },
    "tencent/hy-mt2-plus": {
      "contextWindow": 8000,
      "maxTokens": 4000
    },
    "tencent/hy-mt2-pro": {
      "contextWindow": 8000,
      "maxTokens": 4000
    },
    "tencent/hy3": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "tencent/hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "tencent/hy4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "tencent/hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    },
    "thedrummer/cydonia-24b-v4.1": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "thedrummer/skyfall-36b-v2": {
      "contextWindow": 32768,
      "maxTokens": 29491
    },
    "thedrummer/unslopnemo-12b": {
      "contextWindow": 1024000,
      "maxTokens": 819200
    },
    "thinkingmachines/inkling": {
      "contextWindow": 524288,
      "maxTokens": 471859
    },
    "thinkingmachines/inkling-2-mini": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "thinkingmachines/inkling-2-small": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "thinkingmachines/inkling-small": {
      "contextWindow": 524288,
      "maxTokens": 262144
    },
    "unbiased/pareto-26.10": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "unbiased/pareto-26.10-preview": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "unbiased/pareto-26.9": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "undi95/remm-slerp-l2-13b": {
      "contextWindow": 6144,
      "maxTokens": 5529
    },
    "upstage/solar-mini-4-5": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "upstage/solar-mini4": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "upstage/solar-pro-4-contributor": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "upstage/solar-pro4": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "writer/palmyra-x5": {
      "contextWindow": 1040000,
      "maxTokens": 8192
    },
    "x-ai/grok-4.20": {
      "contextWindow": 2000000,
      "maxTokens": 1800000
    },
    "x-ai/grok-4.20-multi-agent": {
      "contextWindow": 2000000,
      "maxTokens": 1800000
    },
    "x-ai/grok-4.20-multi-agent-beta": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "x-ai/grok-4.20-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "x-ai/grok-4.20-non-reasoning-beta": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "x-ai/grok-4.20-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "x-ai/grok-4.20-reasoning-beta": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "x-ai/grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 900000
    },
    "x-ai/grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 450000
    },
    "x-ai/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 450000
    },
    "x-ai/grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 450000
    },
    "xiaomi/mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-flash-mopd": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "xiaomi/mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-pro-ultraspeed": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-4.5": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "z-ai/glm-4.5-air": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "z-ai/glm-4.5v": {
      "contextWindow": 65536,
      "maxTokens": 16384
    },
    "z-ai/glm-4.6": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "z-ai/glm-4.6v": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "z-ai/glm-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-4.7-flash": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "z-ai/glm-4.7-flashx": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-5": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "z-ai/glm-5-turbo": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "z-ai/glm-5.1": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "z-ai/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "z-ai/glm-5.2-fast": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "z-ai/glm-5.3-fast": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "z-ai/glm-5.3-flashx": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flashx-legal": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-prime": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5v-turbo": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "~anthropic/claude-fable-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "~anthropic/claude-haiku-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "~anthropic/claude-opus-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "~anthropic/claude-sonnet-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "~deepseek/deepseek-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "~deepseek/deepseek-pro-latest": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "~deepseek/deepseek-v4-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "~google/gemini-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "~google/gemini-pro-latest": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "~moonshotai/kimi-latest": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "~openai/gpt-astra-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "~openai/gpt-luna-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "~openai/gpt-mini-latest": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "~openai/gpt-sol-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "~openai/gpt-terra-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "~unbiased/pareto-latest": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "~x-ai/grok-latest": {
      "contextWindow": 500000,
      "maxTokens": 450000
    },
    "~z-ai/glm-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "~z-ai/glm-latest": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    }
  },
  "mistral": {
    "codestral-2508": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "codestral-latest": {
      "contextWindow": 256000,
      "maxTokens": 4096
    },
    "deepseek-v4-1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 128000
    },
    "glm-5-2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "magistral-medium-latest": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "ministral-14b-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "ministral-14b-latest": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "ministral-3b-2512": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "ministral-3b-latest": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "ministral-8b-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "ministral-8b-latest": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral-embed": {
      "contextWindow": 8000,
      "maxTokens": 3072
    },
    "mistral-large-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral-large-4": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "mistral-large-latest": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "mistral-medium-2604": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral-medium-latest": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral-small-2603": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "mistral-small-latest": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "voxtral-small-2507": {
      "contextWindow": 32768,
      "maxTokens": 32000
    },
    "voxtral-small-latest": {
      "contextWindow": 32768,
      "maxTokens": 32000
    },
    "zai-glm-5-2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-glm-5-3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-glm-5-3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "zai": {
    "glm-4.5": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "glm-4.5-air": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "glm-4.5-flash": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "glm-4.5v": {
      "contextWindow": 64000,
      "maxTokens": 16384
    },
    "glm-4.6": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-4.6v": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "glm-4.6v-flash": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "glm-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-4.7-flash": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-4.7-flashx": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-5-turbo": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flashx": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flashx-legal": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5v-turbo": {
      "contextWindow": 200000,
      "maxTokens": 131072
    }
  },
  "umans": {
    "umans-coder": {
      "contextWindow": 1048576,
      "maxTokens": 393215
    },
    "umans-deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 393215
    },
    "umans-deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393215
    },
    "umans-deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393215
    },
    "umans-flash": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "umans-glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131071
    },
    "umans-glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131071
    },
    "umans-kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 131071
    },
    "umans-kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131071
    },
    "umans-qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    }
  },
  "minimax": {
    "MiniMax-M2": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.5-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M3": {
      "contextWindow": 1000000,
      "maxTokens": 524288
    },
    "MiniMax-M3.1-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 524288
    }
  },
  "opencode": {
    "beam-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "big-pickle": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "cat-jam-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "claude-3-5-haiku": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-1": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-opus-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "crouton-alpha-free": {
      "contextWindow": 1048576,
      "maxTokens": 270000
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash-free": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "deepseek-v4-flash-vision-exp": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash-free": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "exo-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "fledge-alpha-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "flint-40b-free": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "gemini-3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "glm-4.6": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-4.7-free": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-5-free": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-5.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash-free": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex-max": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.3-codex-spark": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-build-0.1": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "grok-code": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "hy3-free": {
      "contextWindow": 190000,
      "maxTokens": 64000
    },
    "hy3-preview-free": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "hy4-flash-free": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "iceman-free": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "inkling-2-small-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "kimi-k2": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2-thinking": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "kimi-k2.5-free": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "laguna-s-2.1-free": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "ling-2.6-flash-free": {
      "contextWindow": 262100,
      "maxTokens": 32800
    },
    "ling-3.0-flash-fin-free": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "ling-3.0-flash-free": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "ling-3.0-tiny-free": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "ling-3.1-flash-free": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "ll-alpha-free": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "longcat-2.0-free": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "longcat-2.5-free": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "longcat-2.5-preview-free": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "mimo-v2-flash-free": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "mimo-v2-omni-free": {
      "contextWindow": 262144,
      "maxTokens": 64000
    },
    "mimo-v2-pro-free": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    },
    "mimo-v2.5-free": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "mimo-v2.6-flash-free": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "minimax-m2.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m2.1-free": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m2.5-free": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m3": {
      "contextWindow": 512000,
      "maxTokens": 128000
    },
    "minimax-m3-free": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "minimax-m3.1-flash-free": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "mistral-large-4": {
      "contextWindow": 524288,
      "maxTokens": 262144
    },
    "muse-ember-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 270000
    },
    "muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.2-contributor-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.3-contributor-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-wonder-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "nemotron-3-super-free": {
      "contextWindow": 204800,
      "maxTokens": 128000
    },
    "nemotron-3-ultra-free": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "nemotron-3.5-lightning-free": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nemotron-3.5-super-vl-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "north-mini-code-free": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "pulse-alpha-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "qwen3-coder": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-plus": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6-plus": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6-plus-free": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-max": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "qwen4-max-free": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "ring-2.6-1t-free": {
      "contextWindow": 262000,
      "maxTokens": 66000
    },
    "space-bunny-free": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "step-5-preview-free": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "tidepool-alpha-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "trinity-large-preview-free": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "x-preview-f-free": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "ai-gateway": {
    "alibaba/qwen3-max": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "alibaba/qwen3.5-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "alibaba/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "alibaba/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "alibaba/qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-haiku-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "fireworks/ember-1": {
      "contextWindow": 1040000,
      "maxTokens": 131072
    },
    "google/gemini-2.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-2.5-flash-lite": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-2.5-pro": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-3.1-flash-lite": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "meta/muse-ember-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "meta/muse-spark-1.1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-open": {
      "contextWindow": 1040000,
      "maxTokens": 131072
    },
    "meta/muse-wonder-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax/m3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-nano": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "openai/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "openai/gpt-5-nano": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5-pro": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o4-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "reflection-ai/beam-1.0-501b-a23b": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "unbiased/pareto": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "xai/grok-4.20-0309-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "xai/grok-4.20-0309-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "xai/grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "xai/grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xiaomi/mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "wafer-serverless": {
    "DeepSeek-V4-Flash-0423": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "DeepSeek-V4-Flash-0731-Fast": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "DeepSeek-V4-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "DeepSeek-V4.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "GLM-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "GLM-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "GLM-5.3-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 196608
    },
    "Kimi-K3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "Kimi-K3.1-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 32768
    }
  },
  "ark": {
    "deepseek-v4-1-flash-260910": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-1-flash-261017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-1-flash-economy-261017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash-ga-260731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro-ga-260813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "doubao-seed-2-0-lite-260428": {
      "contextWindow": 256000,
      "maxTokens": 131072
    },
    "doubao-seed-2-0-mini-260428": {
      "contextWindow": 256000,
      "maxTokens": 131072
    },
    "doubao-seed-2-0-pro-260215": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "doubao-seed-2-1-lite-260915": {
      "contextWindow": 1024000,
      "maxTokens": 256000
    },
    "doubao-seed-2-1-pro-260628": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "doubao-seed-2-1-pro-260915": {
      "contextWindow": 1024000,
      "maxTokens": 256000
    },
    "doubao-seed-2-1-turbo-260628": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "doubao-seed-character-260628": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "doubao-seed-evolving": {
      "contextWindow": 1024000,
      "maxTokens": 256000
    },
    "glm-5-2-260617": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5-3-flash-260828": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k3-1-pro-261024": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "workers-ai": {
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
      "contextWindow": 24000,
      "maxTokens": 24000
    },
    "@cf/meta/llama-4-scout-17b-16e-instruct": {
      "contextWindow": 131000,
      "maxTokens": 16384
    },
    "@cf/qwen/qwen3-30b-a3b-fp8": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "@cf/qwen/qwen2.5-coder-32b-instruct": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "@cf/deepseek-ai/deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": {
      "contextWindow": 80000,
      "maxTokens": 80000
    },
    "@cf/google/gemma-4-26b-a4b-it": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "@cf/mistralai/mistral-small-3.1-24b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 128000
    }
  },
  "302ai": {
    "MiniMax-M1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "MiniMax-M2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "MiniMax-M2.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "MiniMax-M3.1-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-1-20250805": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-opus-4-1-20250805-thinking": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-opus-4-5-20251101": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7-thinking": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-thinking": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-5-20250929": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-5-20250929-thinking": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-6-thinking": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v3.2": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "deepseek-v3.2-thinking": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "doubao-seed-1-6-thinking-250715": {
      "contextWindow": 256000,
      "maxTokens": 16000
    },
    "doubao-seed-1-6-vision-250815": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "doubao-seed-1-8-251215": {
      "contextWindow": 224000,
      "maxTokens": 64000
    },
    "gemini-2.0-flash-lite": {
      "contextWindow": 2000000,
      "maxTokens": 8192
    },
    "gemini-2.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemini-2.5-flash-image": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "gemini-2.5-flash-lite-preview-09-2025": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemini-2.5-flash-nothink": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemini-2.5-flash-preview-09-2025": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemini-2.5-pro": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemini-3-flash-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemini-3-pro-image-preview": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "gemini-3-pro-preview": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "gemini-3.1-flash-image-preview": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-flash-lite-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash-thinking": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "glm-4.5": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "glm-4.5v": {
      "contextWindow": 64000,
      "maxTokens": 16384
    },
    "glm-4.6": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-4.6v": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "glm-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-5-turbo": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5v-turbo": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 272000
    },
    "gpt-5-thinking": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-chat-latest": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2-chat-latest": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-5.3-chat-latest": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "grok-4-1-fast-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "grok-4-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "grok-4-fast-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "grok-4.1": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "grok-4.20-beta-0309-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "kimi-k2-0905-preview": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2-thinking": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "ministral-14b-2512": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "mistral-large-2512": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "qwen3-235b-a22b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "qwen3-235b-a22b-instruct-2507": {
      "contextWindow": 128000,
      "maxTokens": 65536
    },
    "qwen3-30b-a3b": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "qwen3-coder-480b-a35b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3-max-2025-09-23": {
      "contextWindow": 258048,
      "maxTokens": 65536
    },
    "qwen3.5-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.7-max-2026-06-08": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "abacus": {
    "MiniMaxAI/MiniMax-M2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMaxAI/MiniMax-M3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Qwen/QwQ-32B": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "Qwen/Qwen2.5-72B-Instruct": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "Qwen/Qwen3-32B": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "Qwen/Qwen3.6-27B": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "claude-3-7-sonnet-20250219": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-1-20250805": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-opus-4-20250514": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-opus-4-5-20251101": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-20250514": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-5-20250929": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "deepseek-ai/DeepSeek-R1": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "deepseek-ai/DeepSeek-V3.1-Terminus": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "deepseek-ai/DeepSeek-V3.2": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "deepseek/deepseek-v3.1": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-flash-image": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-pro-image": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "gemini-3-pro-image-preview": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "gemini-3.1-flash-image": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "gemini-3.1-flash-image-preview": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-flash-lite-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-4o-2024-11-20": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-chat-latest": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex-max": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2-chat-latest": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.3-chat-latest": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.3-codex-xhigh": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "grok-4-0709": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "grok-4-1-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 16384
    },
    "grok-4-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 16384
    },
    "grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 32768
    },
    "grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 32768
    },
    "grok-code-fast-1": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "kimi-k2-turbo-preview": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "llama-3.3-70b-versatile": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": {
      "contextWindow": 1048576,
      "maxTokens": 8192
    },
    "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "meta-llama/Meta-Llama-3.1-8B-Instruct": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "meta-llama/Meta-Llama-3.3-70B-Instruct": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "mimo-v2-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "moonshotai/Kimi-K2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/Kimi-K2.7-Code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/Kimi-K3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "muse-spark-1.1": {
      "contextWindow": 1000000,
      "maxTokens": 32000
    },
    "muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o3-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o3-pro": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o4-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "qwen-2.5-coder-32b": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "qwen3-max": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "route-llm": {
      "contextWindow": 128000,
      "maxTokens": 64000
    },
    "thinkingmachines/Inkling": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "zai-org/GLM-4.5": {
      "contextWindow": 131072,
      "maxTokens": 96000
    },
    "zai-org/GLM-4.6": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai-org/GLM-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "zai-org/GLM-5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "abliteratedllm": {
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepseek-v4.1-flash-1017-ultrafast": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepseek-v4.1-flash-original": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "ember-1": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "glm-5.3-fast": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "glm-5.3-flash-abliterated": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3-fast": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "minimax-m3": {
      "contextWindow": 512000,
      "maxTokens": 512000
    },
    "muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "qwen3.8-2.4t-a95b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen3.8-max": {
      "contextWindow": 262144,
      "maxTokens": 262144
    }
  },
  "abliteration-ai": {
    "abliterated-model": {
      "contextWindow": 150000,
      "maxTokens": 8192
    },
    "abliterated-model-large": {
      "contextWindow": 1000000,
      "maxTokens": 999990
    },
    "abliterated-model-large-flash": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "abliterated-model-large-v2": {
      "contextWindow": 1000000,
      "maxTokens": 999990
    }
  },
  "above": {
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.2-fast": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro-ultraspeed": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    }
  },
  "adaption": {
    "deepseek-v4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "gemma-4-26b-a4b-it": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "gemma-4-31b-it": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "glm-5.2": {
      "contextWindow": 1048575,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "qwen3.5-397b": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    }
  },
  "adzuki": {
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "doubao-seed-2.0-lite": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "doubao-seed-2.1-pro": {
      "contextWindow": 1024000,
      "maxTokens": 256000
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "mimo-v2.5": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "agentrouter": {
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  },
  "agnes": {
    "agnes-2.0-flash": {
      "contextWindow": 512000,
      "maxTokens": 65536
    },
    "agnes-2.5-flash": {
      "contextWindow": 512000,
      "maxTokens": 65536
    },
    "agnes-2.5-pro-alpha": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "agnes-3.0-flash": {
      "contextWindow": 512000,
      "maxTokens": 65536
    }
  },
  "ai-router": {
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  },
  "ai21": {
    "jamba-large": {
      "contextWindow": 256000,
      "maxTokens": 4096
    },
    "jamba-mini": {
      "contextWindow": 256000,
      "maxTokens": 4096
    }
  },
  "aiand": {
    "deepseek-ai/deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/deepseek-v4-pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "meta/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "moonshotai/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "motif-technologies/motif-3": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3.6-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "zai-org/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/glm-5.3-flash": {
      "contextWindow": 1048550,
      "maxTokens": 131072
    }
  },
  "aigrow": {
    "claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    }
  },
  "aihubmix": {
    "alicloud-deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "alicloud-deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "alicloud-glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-5-think": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-6-think": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7-think": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8-think": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-5-think": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-6-think": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "coding-glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "coding-glm-5.1-free": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "coding-glm-5.2-free": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "coding-glm-5.3-flash-free": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "coding-glm-5.3-free": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "coding-minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 128100
    },
    "coding-minimax-m2.7-free": {
      "contextWindow": 204800,
      "maxTokens": 128100
    },
    "coding-minimax-m2.7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 128100
    },
    "coding-xiaomi-mimo-v2.5": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "coding-xiaomi-mimo-v2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "deep-deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deep-deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash-0731-fast": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash-vision-exp": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "doubao-seed-2-0-code-preview": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "doubao-seed-2-0-lite-260428": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "doubao-seed-2-0-mini-260428": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "doubao-seed-2-0-pro": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-flash-image": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-pro-image": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "gemini-3.1-flash-image": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-flash-lite-image": {
      "contextWindow": 65536,
      "maxTokens": 4096
    },
    "gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-pro-preview-customtools": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemma-4-26b-a4b-it-free": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-31b-it-free": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "glm-4.5v": {
      "contextWindow": 64000,
      "maxTokens": 16384
    },
    "glm-4.6": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-4.6v": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "glm-4.7": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-4.7-flash-free": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5v-turbo": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "grok-4-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-build-0.1": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "hy3": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "hy3-preview": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "kimi-k2.7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "ling-3.0-flash-free": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "longcat-2.0": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "mimo-v2.5": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro-ultraspeed": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 128000
    },
    "minimax-m3": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "muse-spark-1.1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "nemotron-3-nano-omni-30b-a3b-reasoning-free": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "nemotron-3-super-120b-a12b-free": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nemotron-3-ultra-550b-a55b-free": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "nemotron-3.5-content-safety-free": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "nemotron-3.5-lightning-free": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o4-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "qwen3-coder-next": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3-max": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3-vl-plus": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3.5-122b-a10b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.5-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6-flash": {
      "contextWindow": 991000,
      "maxTokens": 65536
    },
    "qwen3.6-max-preview": {
      "contextWindow": 240000,
      "maxTokens": 64000
    },
    "qwen3.6-plus": {
      "contextWindow": 991000,
      "maxTokens": 65536
    },
    "qwen3.7-flash": {
      "contextWindow": 991000,
      "maxTokens": 131072
    },
    "qwen3.7-max": {
      "contextWindow": 991000,
      "maxTokens": 131072
    },
    "qwen3.7-plus": {
      "contextWindow": 991000,
      "maxTokens": 64000
    },
    "qwen3.8-2.4t-a95b": {
      "contextWindow": 262000,
      "maxTokens": 131072
    },
    "qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-flash-free": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-max": {
      "contextWindow": 991000,
      "maxTokens": 131072
    },
    "qwen3.8-max-free": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-max-preview": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-omni-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "step-3.7-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "xiaomi-mimo-v2.5": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi-mimo-v2.5-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi-mimo-v2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi-mimo-v2.5-pro-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 128000
    }
  },
  "aimlapi": {
    "aion-labs/aion-rp-llama-3.1-8b": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "alibaba/qwen-max": {
      "contextWindow": 32000,
      "maxTokens": 8192
    },
    "alibaba/qwen-plus": {
      "contextWindow": 131000,
      "maxTokens": 16384
    },
    "alibaba/qwen3-coder-480b-a35b-instruct": {
      "contextWindow": 262000,
      "maxTokens": 65536
    },
    "alibaba/qwen3-next-80b-a3b-instruct": {
      "contextWindow": 129024,
      "maxTokens": 16384
    },
    "alibaba/qwen3.8-2.4t-a95b": {
      "contextWindow": 262144,
      "maxTokens": 52429
    },
    "alibaba/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "alibaba/qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "alibaba/qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "alibaba/qwen3.8-max-prime": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "amazon/nova-lite-v1": {
      "contextWindow": 300000,
      "maxTokens": 5120
    },
    "amazon/nova-micro-v1": {
      "contextWindow": 128000,
      "maxTokens": 5120
    },
    "amazon/nova-pro-v1": {
      "contextWindow": 300000,
      "maxTokens": 5120
    },
    "anthracite-org/magnum-v4-72b": {
      "contextWindow": 32000,
      "maxTokens": 16384
    },
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-haiku-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4.7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4.6": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "bytedance-seed/seed-2.0-lite": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "bytedance-seed/seed-2.0-mini": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "cognitivecomputations/dolphin-mistral-24b-venice-edition": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "cohere/command-a": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "cohere/command-r-08-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "cohere/command-r-plus-08-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "cohere/command-r7b-12-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "deepseek/deepseek-chat": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-chat-v3-0324": {
      "contextWindow": 128000,
      "maxTokens": 124000
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "google/gemini-3-8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-flash-lite-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview-customtools": {
      "contextWindow": 1048756,
      "maxTokens": 65536
    },
    "google/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemma-2-27b-it": {
      "contextWindow": 8192,
      "maxTokens": 2048
    },
    "google/gemma-3-12b-it": {
      "contextWindow": 131000,
      "maxTokens": 96000
    },
    "google/gemma-3-27b-it": {
      "contextWindow": 128000,
      "maxTokens": 117964
    },
    "google/gemma-3-4b-it": {
      "contextWindow": 131000,
      "maxTokens": 32768
    },
    "google/gemma-4-26b-a4b-it": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "gryphe/mythomax-l2-13b": {
      "contextWindow": 4096,
      "maxTokens": 4096
    },
    "inference-net/schematron-v2-small": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "inference-net/schematron-v2-turbo": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "mancer/weaver": {
      "contextWindow": 8000,
      "maxTokens": 2000
    },
    "meta-llama/Llama-3.3-70B-Instruct-Turbo": {
      "contextWindow": 128000,
      "maxTokens": 127000
    },
    "meta/muse-glimmer-30b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mistralai/codestral-2508": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "mistralai/devstral-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistralai/ministral-14b-2512": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/ministral-3b-2512": {
      "contextWindow": 131072,
      "maxTokens": 104857
    },
    "mistralai/ministral-8b-2512": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/mistral-large": {
      "contextWindow": 128000,
      "maxTokens": 102400
    },
    "mistralai/mistral-large-2407": {
      "contextWindow": 131072,
      "maxTokens": 104857
    },
    "mistralai/mistral-medium-3": {
      "contextWindow": 131072,
      "maxTokens": 104857
    },
    "mistralai/mistral-medium-3-5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistralai/mistral-nemo": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "mistralai/mistral-saba": {
      "contextWindow": 32768,
      "maxTokens": 26214
    },
    "mistralai/mistral-small-24b-instruct-2501": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "mistralai/mistral-small-2603": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "mistralai/mistral-small-3.1-24b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "mistralai/mistral-small-3.2-24b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "mistralai/mixtral-8x22b-instruct": {
      "contextWindow": 65536,
      "maxTokens": 52428
    },
    "mistralai/voxtral-small-24b-2507": {
      "contextWindow": 32000,
      "maxTokens": 32000
    },
    "moonshot/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "morph/morph-v3-fast": {
      "contextWindow": 81920,
      "maxTokens": 38000
    },
    "morph/morph-v3-large": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "openai/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-2024-05-13": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-2024-08-06": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-2024-11-20": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5-5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 272000
    },
    "openai/gpt-5.1-codex-max": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-image-2": {
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131000,
      "maxTokens": 117964
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131000,
      "maxTokens": 117964
    },
    "openai/gpt-oss-safeguard-20b": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "openai/o3-pro": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "perceptron/perceptron-mk1.5": {
      "contextWindow": 36864,
      "maxTokens": 8192
    },
    "perplexity/sonar": {
      "contextWindow": 128000,
      "maxTokens": 100000
    },
    "perplexity/sonar-pro": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "rekaai/reka-edge": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "relace/relace-apply-3": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "relace/relace-search": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "sakana/fugu-max": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "sakana/fugu-ultra": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "sakana/fugu-ultra-v2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "sao10k/l3-lunaris-8b": {
      "contextWindow": 8192,
      "maxTokens": 7372
    },
    "sao10k/l3.1-euryale-70b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "stepfun/step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "tencent/hy-mt2-1.8b": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "tencent/hy-mt2-30b-a3b": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "tencent/hy-mt2-7b": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "tencent/hy3": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "tencent/hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    },
    "thedrummer/cydonia-24b-v4.1": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "thedrummer/skyfall-36b-v2": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "thedrummer/unslopnemo-12b": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "thinkingmachines/inkling": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "thinkingmachines/inkling-small": {
      "contextWindow": 524288,
      "maxTokens": 262144
    },
    "unbiased/pareto": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "undi95/remm-slerp-l2-13b": {
      "contextWindow": 6144,
      "maxTokens": 4096
    },
    "upstage/solar-pro4": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "x-ai/grok-4-20-0309-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 1999000
    },
    "x-ai/grok-4-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 1999000
    },
    "xiaomi/mimo-v2.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "z-ai/glm-4.5v": {
      "contextWindow": 65536,
      "maxTokens": 16384
    },
    "z-ai/glm-4.6v": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "z-ai/glm-4.7-flash": {
      "contextWindow": 202752,
      "maxTokens": 16384
    },
    "z-ai/glm-5-turbo": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5v-turbo": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zhipu/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zhipu/glm-5.3": {
      "contextWindow": 1024000,
      "maxTokens": 131072
    }
  },
  "ainetcafe": {
    "Kimi-K3": {
      "contextWindow": 262144,
      "maxTokens": 32768
    }
  },
  "aipg": {
    "gpt-oss-120b": {
      "contextWindow": 40000,
      "maxTokens": 32768
    },
    "qwen38-flash-next-nvfp4": {
      "contextWindow": 40000,
      "maxTokens": 32768
    }
  },
  "aistupidlevel": {
    "auto": {
      "contextWindow": 262144,
      "maxTokens": 64000
    },
    "auto-best": {
      "contextWindow": 262144,
      "maxTokens": 64000
    },
    "auto-coding": {
      "contextWindow": 262144,
      "maxTokens": 64000
    },
    "auto-fastest-quality": {
      "contextWindow": 262144,
      "maxTokens": 64000
    },
    "auto-reasoning": {
      "contextWindow": 262144,
      "maxTokens": 64000
    },
    "auto-tooling": {
      "contextWindow": 262144,
      "maxTokens": 64000
    },
    "auto-value": {
      "contextWindow": 262144,
      "maxTokens": 64000
    },
    "auto-value-coding": {
      "contextWindow": 262144,
      "maxTokens": 64000
    },
    "auto-value-reasoning": {
      "contextWindow": 262144,
      "maxTokens": 64000
    },
    "auto-value-tooling": {
      "contextWindow": 262144,
      "maxTokens": 64000
    }
  },
  "aixy": {
    "anthropic/claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gemini/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini/gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  },
  "aki-io": {
    "deepseek-v4.1-flash-1017-tl5": {
      "contextWindow": 1048576,
      "maxTokens": 81920
    },
    "deepseek-v4.1-flash-552b": {
      "contextWindow": 1048576,
      "maxTokens": 81920
    },
    "gemma4-26b": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "glm5.3-754b": {
      "contextWindow": 524288,
      "maxTokens": 81920
    },
    "gpt-oss-120b": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "kolibri-1-tl5": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "mistral4-119b": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    }
  },
  "alibaba": {
    "deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-prime": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro-prime": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "qwen-flash": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "qwen-max": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "qwen-mt-plus": {
      "contextWindow": 16384,
      "maxTokens": 8192
    },
    "qwen-plus": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "qwen-plus-character-ja": {
      "contextWindow": 8192,
      "maxTokens": 512
    },
    "qwen-vl-ocr": {
      "contextWindow": 34096,
      "maxTokens": 4096
    },
    "qwen3-asr-flash": {
      "contextWindow": 53248,
      "maxTokens": 4096
    },
    "qwen3-coder-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3-omni-flash": {
      "contextWindow": 65536,
      "maxTokens": 16384
    },
    "qwen3-vl-30b-a3b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen3-vl-plus": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3.5-122b-a10b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.5-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.6-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.7-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-omni-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    }
  },
  "alibaba-cn": {
    "MiniMax-M2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax/MiniMax-M2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "deepseek-r1": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "deepseek-r1-0528": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "deepseek-r1-distill-llama-70b": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "deepseek-r1-distill-llama-8b": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "deepseek-r1-distill-qwen-1-5b": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "deepseek-r1-distill-qwen-14b": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "deepseek-r1-distill-qwen-32b": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "deepseek-r1-distill-qwen-7b": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "deepseek-v3": {
      "contextWindow": 65536,
      "maxTokens": 8192
    },
    "deepseek-v3-1": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "deepseek-v3-2-exp": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "deepseek-v3.2": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5": {
      "contextWindow": 202752,
      "maxTokens": 16384
    },
    "glm-5.1": {
      "contextWindow": 202752,
      "maxTokens": 128000
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-prime": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k2-thinking": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro-prime": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi/kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshot-kimi-k2-instruct": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "qwen-deep-research": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "qwen-doc-turbo": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "qwen-flash": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "qwen-long": {
      "contextWindow": 10000000,
      "maxTokens": 8192
    },
    "qwen-math-turbo": {
      "contextWindow": 4096,
      "maxTokens": 3072
    },
    "qwen-max": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "qwen-mt-plus": {
      "contextWindow": 16384,
      "maxTokens": 8192
    },
    "qwen-plus": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "qwen-plus-character": {
      "contextWindow": 32768,
      "maxTokens": 4096
    },
    "qwen-vl-ocr": {
      "contextWindow": 34096,
      "maxTokens": 4096
    },
    "qwen3-asr-flash": {
      "contextWindow": 53248,
      "maxTokens": 4096
    },
    "qwen3-coder-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3-omni-flash": {
      "contextWindow": 65536,
      "maxTokens": 16384
    },
    "qwen3-vl-30b-a3b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen3-vl-plus": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3.5-122b-a10b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.5-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.6-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.7-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-omni-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "siliconflow/deepseek-r1-0528": {
      "contextWindow": 163840,
      "maxTokens": 32768
    },
    "siliconflow/deepseek-v3-0324": {
      "contextWindow": 163840,
      "maxTokens": 163840
    },
    "siliconflow/deepseek-v3.1-terminus": {
      "contextWindow": 163840,
      "maxTokens": 65536
    },
    "siliconflow/deepseek-v3.2": {
      "contextWindow": 163840,
      "maxTokens": 65536
    },
    "tongyi-intent-detect-v3": {
      "contextWindow": 8192,
      "maxTokens": 1024
    }
  },
  "alibaba-coding-plan": {
    "MiniMax-M2.5": {
      "contextWindow": 196608,
      "maxTokens": 24576
    },
    "glm-4.7": {
      "contextWindow": 202752,
      "maxTokens": 16384
    },
    "glm-5": {
      "contextWindow": 202752,
      "maxTokens": 16384
    },
    "kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3.5-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    }
  },
  "alibaba-coding-plan-cn": {
    "MiniMax-M2.5": {
      "contextWindow": 196608,
      "maxTokens": 24576
    },
    "glm-4.7": {
      "contextWindow": 202752,
      "maxTokens": 16384
    },
    "glm-5": {
      "contextWindow": 202752,
      "maxTokens": 16384
    },
    "kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3.5-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    }
  },
  "alibaba-token-plan": {
    "MiniMax-M2.5": {
      "contextWindow": 196608,
      "maxTokens": 32768
    },
    "deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5": {
      "contextWindow": 202752,
      "maxTokens": 16384
    },
    "glm-5.1": {
      "contextWindow": 202752,
      "maxTokens": 128000
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 98304
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "qwen3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    }
  },
  "alibaba-token-plan-cn": {
    "MiniMax-M2.5": {
      "contextWindow": 196608,
      "maxTokens": 32768
    },
    "deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5": {
      "contextWindow": 202752,
      "maxTokens": 16384
    },
    "glm-5.1": {
      "contextWindow": 202752,
      "maxTokens": 128000
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 98304
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "qwen3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    }
  },
  "amazon-bedrock": {
    "amazon.nova-2-lite-v1:0": {
      "contextWindow": 1000000,
      "maxTokens": 65535
    },
    "amazon.nova-lite-v1:0": {
      "contextWindow": 300000,
      "maxTokens": 10000
    },
    "amazon.nova-micro-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 10000
    },
    "amazon.nova-pro-v1:0": {
      "contextWindow": 300000,
      "maxTokens": 10000
    },
    "anthropic.claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic.claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic.claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic.claude-haiku-4-5-20251001-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic.claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic.claude-opus-4-1-20250805-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "anthropic.claude-opus-4-5-20251101-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic.claude-opus-4-6-v1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic.claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic.claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic.claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic.claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic.claude-sonnet-4-5-20250929-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic.claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic.claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic.claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "apac.amazon.nova-lite-v1:0": {
      "contextWindow": 300000,
      "maxTokens": 10000
    },
    "apac.amazon.nova-micro-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 10000
    },
    "apac.amazon.nova-pro-v1:0": {
      "contextWindow": 300000,
      "maxTokens": 10000
    },
    "apac.anthropic.claude-sonnet-4-20250514-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "au.anthropic.claude-haiku-4-5-20251001-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "au.anthropic.claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "au.anthropic.claude-opus-4-6-v1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "au.anthropic.claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "au.anthropic.claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "au.anthropic.claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "au.anthropic.claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "au.anthropic.claude-sonnet-4-5-20250929-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "au.anthropic.claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "au.anthropic.claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "au.anthropic.claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "ca.amazon.nova-lite-v1:0": {
      "contextWindow": 300000,
      "maxTokens": 10000
    },
    "deepseek.r1-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "deepseek.v3-v1:0": {
      "contextWindow": 163840,
      "maxTokens": 81920
    },
    "deepseek.v3.2": {
      "contextWindow": 163840,
      "maxTokens": 81920
    },
    "eu.amazon.nova-2-lite-v1:0": {
      "contextWindow": 1000000,
      "maxTokens": 65535
    },
    "eu.amazon.nova-lite-v1:0": {
      "contextWindow": 300000,
      "maxTokens": 10000
    },
    "eu.amazon.nova-micro-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 10000
    },
    "eu.amazon.nova-pro-v1:0": {
      "contextWindow": 300000,
      "maxTokens": 10000
    },
    "eu.anthropic.claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "eu.anthropic.claude-haiku-4-5-20251001-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "eu.anthropic.claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "eu.anthropic.claude-opus-4-5-20251101-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "eu.anthropic.claude-opus-4-6-v1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "eu.anthropic.claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "eu.anthropic.claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "eu.anthropic.claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "eu.anthropic.claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "eu.anthropic.claude-sonnet-4-20250514-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "eu.anthropic.claude-sonnet-4-5-20250929-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "eu.anthropic.claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "eu.anthropic.claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "eu.anthropic.claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "eu.mistral.pixtral-large-2502-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "global.amazon.nova-2-lite-v1:0": {
      "contextWindow": 1000000,
      "maxTokens": 65535
    },
    "global.anthropic.claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "global.anthropic.claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "global.anthropic.claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "global.anthropic.claude-haiku-4-5-20251001-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "global.anthropic.claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "global.anthropic.claude-opus-4-5-20251101-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "global.anthropic.claude-opus-4-6-v1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "global.anthropic.claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "global.anthropic.claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "global.anthropic.claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "global.anthropic.claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "global.anthropic.claude-sonnet-4-20250514-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "global.anthropic.claude-sonnet-4-5-20250929-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "global.anthropic.claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "global.anthropic.claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "global.anthropic.claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "global.moonshotai.kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 128000
    },
    "global.moonshotai.kimi-k3.1": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "global.openai.gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "global.openai.gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "global.openai.gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "global.openai.gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "global.openai.gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "global.openai.gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "global.openai.gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "global.openai.gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "global.openai.gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "global.openai.gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "global.xai.grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "global.xai.grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "global.zai.glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "google.gemma-3-12b-it": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "google.gemma-3-27b-it": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "google.gemma-3-4b-it": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "google.gemma-4-26b-a4b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "google.gemma-4-31b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "google.gemma-4-e2b": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "in.anthropic.claude-haiku-4-5-20251001-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "in.anthropic.claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "in.anthropic.claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "in.openai.gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "in.openai.gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "jp.amazon.nova-2-lite-v1:0": {
      "contextWindow": 1000000,
      "maxTokens": 65535
    },
    "jp.anthropic.claude-haiku-4-5-20251001-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "jp.anthropic.claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "jp.anthropic.claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "jp.anthropic.claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "jp.anthropic.claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "jp.anthropic.claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "jp.anthropic.claude-sonnet-4-5-20250929-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "jp.anthropic.claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "jp.anthropic.claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "meta.llama3-1-70b-instruct-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "meta.llama3-1-8b-instruct-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "meta.llama3-3-70b-instruct-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "meta.llama4-maverick-17b-instruct-v1:0": {
      "contextWindow": 1000000,
      "maxTokens": 8192
    },
    "meta.llama4-scout-17b-instruct-v1:0": {
      "contextWindow": 10000000,
      "maxTokens": 8192
    },
    "minimax.minimax-m2": {
      "contextWindow": 204608,
      "maxTokens": 128000
    },
    "minimax.minimax-m2.1": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "minimax.minimax-m2.5": {
      "contextWindow": 196608,
      "maxTokens": 98304
    },
    "mistral.devstral-2-123b": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "mistral.magistral-small-2509": {
      "contextWindow": 128000,
      "maxTokens": 40000
    },
    "mistral.ministral-3-14b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "mistral.ministral-3-3b-instruct": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "mistral.ministral-3-8b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "mistral.mistral-large-3-675b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "mistral.pixtral-large-2502-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "mistral.voxtral-mini-3b-2507": {
      "contextWindow": 32768,
      "maxTokens": 4096
    },
    "mistral.voxtral-small-24b-2507": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "moonshot.kimi-k2-thinking": {
      "contextWindow": 262144,
      "maxTokens": 16000
    },
    "moonshotai.kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "nvidia.nemotron-nano-12b-v2": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "nvidia.nemotron-nano-3-30b": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "nvidia.nemotron-nano-9b-v2": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "nvidia.nemotron-super-3-120b": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "openai.gpt-5.4": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai.gpt-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai.gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai.gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai.gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai.gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai.gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai.gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai.gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai.gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai.gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai.gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai.gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai.gpt-oss-120b-1:0": {
      "contextWindow": 131072,
      "maxTokens": 128000
    },
    "openai.gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai.gpt-oss-20b-1:0": {
      "contextWindow": 131072,
      "maxTokens": 128000
    },
    "openai.gpt-oss-safeguard-120b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai.gpt-oss-safeguard-20b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "qwen.qwen3-235b-a22b-2507-v1:0": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "qwen.qwen3-32b-v1:0": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "qwen.qwen3-coder-30b-a3b-v1:0": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "qwen.qwen3-coder-480b-a35b-v1:0": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "qwen.qwen3-coder-next": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen.qwen3-next-80b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 262000
    },
    "qwen.qwen3-vl-235b-a22b": {
      "contextWindow": 262144,
      "maxTokens": 262000
    },
    "us-gov.openai.gpt-oss-120b-1:0": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "us-gov.openai.gpt-oss-20b-1:0": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "us.amazon.nova-2-lite-v1:0": {
      "contextWindow": 1000000,
      "maxTokens": 65535
    },
    "us.amazon.nova-lite-v1:0": {
      "contextWindow": 300000,
      "maxTokens": 10000
    },
    "us.amazon.nova-micro-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 10000
    },
    "us.amazon.nova-premier-v1:0": {
      "contextWindow": 1000000,
      "maxTokens": 10000
    },
    "us.amazon.nova-pro-v1:0": {
      "contextWindow": 300000,
      "maxTokens": 10000
    },
    "us.anthropic.claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "us.anthropic.claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "us.anthropic.claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "us.anthropic.claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "us.anthropic.claude-opus-4-1-20250805-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "us.anthropic.claude-opus-4-5-20251101-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "us.anthropic.claude-opus-4-6-v1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "us.anthropic.claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "us.anthropic.claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "us.anthropic.claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "us.anthropic.claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "us.anthropic.claude-sonnet-4-20250514-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "us.anthropic.claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "us.anthropic.claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "us.anthropic.claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "us.deepseek.r1-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "us.meta.llama3-1-70b-instruct-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "us.meta.llama3-1-8b-instruct-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "us.meta.llama3-3-70b-instruct-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "us.meta.llama4-maverick-17b-instruct-v1:0": {
      "contextWindow": 1000000,
      "maxTokens": 8192
    },
    "us.meta.llama4-scout-17b-instruct-v1:0": {
      "contextWindow": 10000000,
      "maxTokens": 8192
    },
    "us.mistral.pixtral-large-2502-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "us.moonshotai.kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 128000
    },
    "us.moonshotai.kimi-k3.1": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "us.openai.gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "us.openai.gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "us.openai.gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "us.openai.gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "us.openai.gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "us.openai.gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "us.openai.gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "us.openai.gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "us.openai.gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "us.openai.gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "us.writer.palmyra-x4-v1:0": {
      "contextWindow": 122880,
      "maxTokens": 8192
    },
    "us.writer.palmyra-x5-v1:0": {
      "contextWindow": 1040000,
      "maxTokens": 8192
    },
    "us.xai.grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "us.xai.grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "us.zai.glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "writer.palmyra-vision-7b": {
      "contextWindow": 4096,
      "maxTokens": 4096
    },
    "writer.palmyra-x4-v1:0": {
      "contextWindow": 122880,
      "maxTokens": 8192
    },
    "writer.palmyra-x5-v1:0": {
      "contextWindow": 1040000,
      "maxTokens": 8192
    },
    "xai.grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "xai.grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "zai.glm-4.7": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai.glm-4.7-flash": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai.glm-5": {
      "contextWindow": 202752,
      "maxTokens": 131072
    }
  },
  "ambient": {
    "ambient/large": {
      "contextWindow": 202752,
      "maxTokens": 202752
    },
    "ambient/small": {
      "contextWindow": 101072,
      "maxTokens": 101072
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "minimax/minimax-m3": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "qwen/qwen3-30b-a3b-instruct-2507": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3.6-27b": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "qwen/qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "unsloth/qwen3.8-27b-gguf": {
      "contextWindow": 101072,
      "maxTokens": 101072
    },
    "z-ai/glm-5.2": {
      "contextWindow": 202752,
      "maxTokens": 202752
    },
    "zai-org/GLM-5.2-FP8": {
      "contextWindow": 202752,
      "maxTokens": 202752
    }
  },
  "amd": {
    "DeepSeek-V4-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "DeepSeek-V4-Flash-Vision-Exp": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "DeepSeek-V4.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "GLM-5.3-Flash": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "Gemma-4-31B-IT": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "MiMo-V2.6-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "MiniCPM-V-4.7-1B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "MiniCPM-V-4.7-35B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "MiniCPM5-2B": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Qwen3.8-Flash-Next": {
      "contextWindow": 262144,
      "maxTokens": 131072
    }
  },
  "anonrouter": {
    "deepseek/deepseek-v3": {
      "contextWindow": 163840,
      "maxTokens": 16384
    },
    "google/gemma-3-12b-it": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "google/gemma-3-27b-it": {
      "contextWindow": 131072,
      "maxTokens": 16384
    }
  },
  "anyapi": {
    "anthropic/claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "cohere/command-r-plus-08-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "deepseek/deepseek-chat": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-r1": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "mistralai/devstral-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistralai/mistral-large-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o4-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "perplexity/sonar-pro": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "perplexity/sonar-reasoning-pro": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "xai/grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    }
  },
  "apiko": {
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 32000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 32000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 32000
    }
  },
  "arcee": {
    "deepseek/deepseek-v4-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 512000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "thinkingmachines/inkling-small": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "trinity-large-thinking": {
      "contextWindow": 262144,
      "maxTokens": 80000
    },
    "zai-org/glm-5.2": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "zai-org/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai-org/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "atomic-chat": {
    "Meta-Llama-3_1-8B-Instruct-GGUF": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "Qwen3_5-9B-MLX-4bit": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "Qwen3_5-9B-Q4_K_M": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "gemma-4-E4B-it-IQ4_XS": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "gemma-4-E4B-it-MLX-4bit": {
      "contextWindow": 32768,
      "maxTokens": 8192
    }
  },
  "augure": {
    "open-glm-5-3": {
      "contextWindow": 262144,
      "maxTokens": 49152
    },
    "open-qwen-3.8-flash-next": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "ossington-4-1": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "ossington-5": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "rosedale-1": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "tofino-3": {
      "contextWindow": 262144,
      "maxTokens": 16384
    }
  },
  "auriko": {
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "minimax-m2-7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m2-7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "qwen-3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    }
  },
  "autarcho": {
    "llama-32-3b-uncensored": {
      "contextWindow": 131072,
      "maxTokens": 131072
    }
  },
  "azure-cognitive-services": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-mythos-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "codestral-2501": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "codex-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "cohere-command-a": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "cohere-embed-v-4-0": {
      "contextWindow": 128000,
      "maxTokens": 1536
    },
    "cohere-embed-v3-english": {
      "contextWindow": 512,
      "maxTokens": 1024
    },
    "cohere-embed-v3-multilingual": {
      "contextWindow": 512,
      "maxTokens": 1024
    },
    "deepseek-v3.2": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "deepseek-v3.2-speciale": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-3.5-turbo-0125": {
      "contextWindow": 16384,
      "maxTokens": 4096
    },
    "gpt-3.5-turbo-1106": {
      "contextWindow": 16384,
      "maxTokens": 4096
    },
    "gpt-3.5-turbo-instruct": {
      "contextWindow": 4096,
      "maxTokens": 4096
    },
    "gpt-4-turbo": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "gpt-4-turbo-vision": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex-max": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-chat-latest": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "grok-4-1-fast-non-reasoning": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "grok-4-1-fast-reasoning": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "grok-4-20-non-reasoning": {
      "contextWindow": 262000,
      "maxTokens": 8192
    },
    "grok-4-20-reasoning": {
      "contextWindow": 262000,
      "maxTokens": 8192
    },
    "grok-4.6": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "llama-3.3-70b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "llama-4-maverick-17b-128e-instruct-fp8": {
      "contextWindow": 1000000,
      "maxTokens": 16384
    },
    "llama-4-scout-17b-16e-instruct": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "ministral-3b": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "mistral-medium-2505": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "mistral-small-2503": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "model-router": {
      "contextWindow": 200000,
      "maxTokens": 16384
    },
    "o1": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o3-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o4-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "phi-4": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "phi-4-mini": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "phi-4-mini-reasoning": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "phi-4-multimodal": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "phi-4-reasoning": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "phi-4-reasoning-plus": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "text-embedding-3-large": {
      "contextWindow": 8192,
      "maxTokens": 3072
    },
    "text-embedding-3-small": {
      "contextWindow": 8192,
      "maxTokens": 1536
    },
    "text-embedding-ada-002": {
      "contextWindow": 8192,
      "maxTokens": 1536
    }
  },
  "bailing": {
    "Ling-3.0-flash": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Ling-3.0-flash-VL": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Ling-3.0-tiny": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "Ling-3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "Ling-3.2-flash": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    }
  },
  "baseten": {
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-Fast": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta-models/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/Kimi-K3": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "moonshotai/Kimi-K3.1-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B": {
      "contextWindow": 202800,
      "maxTokens": 202800
    },
    "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 128072,
      "maxTokens": 128072
    },
    "reflection/Beam-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "zai-org/GLM-5.2-Fast": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "zai-org/GLM-5.3-Fast": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "bee": {
    "bee-brood": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "bee-buzz": {
      "contextWindow": 262144,
      "maxTokens": 24576
    },
    "bee-cell": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "bee-comb": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "bee-hive": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "bee-swarm": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    }
  },
  "berget": {
    "Qwen/Qwen3.8-27B-FP8": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "google/gemma-4-31B-it": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "mistralai/Mistral-Small-3.2-24B-Instruct-2506": {
      "contextWindow": 32000,
      "maxTokens": 8192
    },
    "moonshotai/Kimi-K3": {
      "contextWindow": 327680,
      "maxTokens": 32768
    },
    "zai-org/GLM-5.2": {
      "contextWindow": 524288,
      "maxTokens": 32768
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 16384
    }
  },
  "blueclaw": {
    "Qwen3.8-27B": {
      "contextWindow": 131072,
      "maxTokens": 32768
    }
  },
  "bothub": {
    "deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gemma-4-31b-it:free": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "muse-spark-1.3-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "nemotron-3-ultra-550b-a55b:free": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    }
  },
  "boundless": {
    "claude-fable-5.1": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4-pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "dsv4": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "gpt-5.6-luna": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "nemotron3-super": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen3.6": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "bumo": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  },
  "byteplus": {
    "deepseek-v4-1-flash-260910": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-1-flash-261017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-1-flash-economy-261017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash-260425": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash-ga-260731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro-260425": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro-ga-260813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "dola-seed-2-1-turbo-260628": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "glm-5-2-260617": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5-3-flash-260828": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "seed-2-0-code-preview-260328": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "seed-2-0-lite-260428": {
      "contextWindow": 256000,
      "maxTokens": 131072
    },
    "seed-2-0-mini-260428": {
      "contextWindow": 256000,
      "maxTokens": 131072
    },
    "seed-2-0-pro-260328": {
      "contextWindow": 256000,
      "maxTokens": 128000
    }
  },
  "cedarllm": {
    "qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    }
  },
  "cheapaimodel": {
    "deepseek-v4-1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "cheapest-token": {
    "deepseek-v4-pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 128000
    },
    "glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "grok-4.6": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nemotron-3.5-super-vl": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    }
  },
  "cheapllm": {
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    }
  },
  "chutes": {
    "Qwen/Qwen3.5-27B-TEE": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen/Qwen3.5-397B-A17B-TEE": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.6-27B-TEE": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.8-2.4T-A95B": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Qwen/Qwen3.8-27B-TEE": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.8-Max-0902": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Qwen/Qwen4-Max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "deepseek-ai/DeepSeek-V3.2-TEE": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731-TEE": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "google/gemma-4-31B-turbo-TEE": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "moonshotai/Kimi-K2.6-TEE": {
      "contextWindow": 262144,
      "maxTokens": 65535
    },
    "moonshotai/Kimi-K2.7-Code": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "moonshotai/Kimi-K3-TEE": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "zai-org/GLM-5.1-TEE": {
      "contextWindow": 202752,
      "maxTokens": 65535
    },
    "zai-org/GLM-5.2-Fast": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.2-TEE": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "clarifai": {
    "arcee_ai/AFM/models/trinity-mini": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "clarifai/main/models/mm-poly-8b": {
      "contextWindow": 32768,
      "maxTokens": 4096
    },
    "deepseek-ai/deepseek-ocr/models/DeepSeek-OCR": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "minimaxai/chat-completion/models/MiniMax-M2_5-high-throughput": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "mistralai/completion/models/Ministral-3-14B-Reasoning-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistralai/completion/models/Ministral-3-3B-Reasoning-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/chat-completion/models/Kimi-K2_6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "openai/chat-completion/models/gpt-oss-120b-high-throughput": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "openai/chat-completion/models/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "qwen/qwenCoder/models/Qwen3-Coder-30B-A3B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwenLM/models/Qwen3-30B-A3B-Instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen/qwenLM/models/Qwen3-30B-A3B-Thinking-2507": {
      "contextWindow": 262144,
      "maxTokens": 131072
    }
  },
  "claudinio": {
    "claudinio": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "claudius": {
      "contextWindow": 256000,
      "maxTokens": 64000
    }
  },
  "cline-pass": {
    "cline-pass/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "cline-pass/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "cline-pass/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "cline-pass/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "cline-pass/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "cline-pass/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "cline-pass/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "cline-pass/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "cline-pass/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "cline-pass/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "cline-pass/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "cline-pass/mimo-v2.5": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "cline-pass/mimo-v2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "cline-pass/mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "cline-pass/mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "cline-pass/minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "cline-pass/minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "cline-pass/muse-spark-1.3-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "cline-pass/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "cline-pass/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "cline-pass/qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "cloudcode": {
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5v-turbo": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "mistral-large-4": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    }
  },
  "cloudferro-sherlock": {
    "MiniMaxAI/MiniMax-M2.5": {
      "contextWindow": 196000,
      "maxTokens": 16000
    },
    "meta-llama/Llama-3.3-70B-Instruct": {
      "contextWindow": 70000,
      "maxTokens": 70000
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "speakleash/Bielik-11B-v3.0-Instruct": {
      "contextWindow": 32000,
      "maxTokens": 32000
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 262144,
      "maxTokens": 131072
    }
  },
  "cohere": {
    "c4ai-aya-expanse-32b": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "c4ai-aya-vision-32b": {
      "contextWindow": 16000,
      "maxTokens": 4000
    },
    "command-a-03-2025": {
      "contextWindow": 256000,
      "maxTokens": 8000
    },
    "command-a-plus-05-2026": {
      "contextWindow": 128000,
      "maxTokens": 64000
    },
    "command-a-reasoning-08-2025": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "command-a-translate-08-2025": {
      "contextWindow": 8000,
      "maxTokens": 8000
    },
    "command-a-vision-07-2025": {
      "contextWindow": 128000,
      "maxTokens": 8000
    },
    "command-r-08-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "command-r-plus-08-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "command-r7b-12-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "command-r7b-arabic-02-2025": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "north-mini-code-1-0": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "north-mini-code-1.0": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "north-small-translate-09-2026": {
      "contextWindow": 32768,
      "maxTokens": 16000
    },
    "north-small-translate-1.0": {
      "contextWindow": 32768,
      "maxTokens": 16000
    },
    "tiny-aya-earth": {
      "contextWindow": 8000,
      "maxTokens": 8000
    },
    "tiny-aya-fire": {
      "contextWindow": 8000,
      "maxTokens": 8000
    },
    "tiny-aya-global": {
      "contextWindow": 8000,
      "maxTokens": 8000
    },
    "tiny-aya-water": {
      "contextWindow": 8000,
      "maxTokens": 8000
    }
  },
  "concentrate": {
    "apodex-1.1-mini": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "beam-1.0-501b-a23b": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "codestral": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "deepseek-r1": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "deepseek-r1-0528": {
      "contextWindow": 163840,
      "maxTokens": 32768
    },
    "deepseek-v3-1": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "deepseek-v4-1-fast": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "deepseek-v4-1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-1-flash-fast": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "deepseek-v4-flash-0423": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash-vision-exp": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-flash-lite-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemma-3-12b": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "gemma-4-26b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-31b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "glm-4.5": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "glm-4.5v": {
      "contextWindow": 64000,
      "maxTokens": 16384
    },
    "glm-4.6": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "glm-4.6v": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "glm-4.7": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "glm-5": {
      "contextWindow": 202800,
      "maxTokens": 131072
    },
    "glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-oss-safeguard-20b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "grok-4.20-0309-reasoning": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "grok-4.20-multi-agent-0309": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "grok-4.20-non-reasoning": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 125000
    },
    "grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 128000
    },
    "grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 125000
    },
    "grok-build-0.1": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "hy3": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "hy4": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "ibm-granite-micro": {
      "contextWindow": 131000,
      "maxTokens": 32750
    },
    "inkling": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "kimi-k2-5": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "kimi-k2-6": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "kimi-k2-7-code": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "kimi-k3-1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3-1-pro-highspeed": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "ling-3.1-flash": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "mercury-3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax-m2": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m2-1": {
      "contextWindow": 204800,
      "maxTokens": 51200
    },
    "minimax-m2-1-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 51200
    },
    "minimax-m2-5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m2-5-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 51200
    },
    "minimax-m2-7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m2-7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "minimax-m3-1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "ministral-3-3b": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "ministral-3-8b": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "mistral-large-4": {
      "contextWindow": 470000,
      "maxTokens": 262144
    },
    "mistral-medium-3": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "mistral-medium-3.1": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "mistral-small-3.1": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "mistral-small-3.2": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "muse-ember": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "muse-spark-1.1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.2-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-wonder": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "nemotron-3-120b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "nemotron-3-nano-30b": {
      "contextWindow": 262144,
      "maxTokens": 228000
    },
    "nemotron-3-ultra-nvfp4": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "nemotron-3.5-super-vl": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "nemotron-lightning-3.5-30b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "nova-2-lite": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "nova-lite": {
      "contextWindow": 300000,
      "maxTokens": 5000
    },
    "nova-micro": {
      "contextWindow": 128000,
      "maxTokens": 5000
    },
    "nova-pro": {
      "contextWindow": 300000,
      "maxTokens": 5000
    },
    "o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "qwen-flash": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "qwen-plus": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "qwen3-235b-a22b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "qwen3-30b": {
      "contextWindow": 40960,
      "maxTokens": 16384
    },
    "qwen3-30b-a3b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "qwen3-coder-480b-a35b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3-coder-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3-coder-next": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "qwen3-max": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "qwen3-next-80b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3-vl-235b-a22b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen3-vl-30b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3-vl-plus": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3.5-122b-a10b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3.5-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-9b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.5-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.6-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3.6-35b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.7-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen3.8-2.4t-a95b": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-omni-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "step-3-7-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "ultramarine-1-flash": {
      "contextWindow": 1048573,
      "maxTokens": 131072
    }
  },
  "confidential-ai": {
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    }
  },
  "coralbricks": {
    "deepseek-v4.1-flash-fast": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    }
  },
  "cortecs": {
    "claude-4-5-sonnet": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-4-6-sonnet": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "codestral-2508": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "deepseek-v3.2": {
      "contextWindow": 163840,
      "maxTokens": 65536
    },
    "deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "devstral-2512": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemma-3-27b-it": {
      "contextWindow": 131000,
      "maxTokens": 110000
    },
    "gemma-4-26b-a4b-it": {
      "contextWindow": 262000,
      "maxTokens": 81920
    },
    "gemma-4-31b-it": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "glm-4.7-flash": {
      "contextWindow": 203000,
      "maxTokens": 203000
    },
    "glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-oss-120b": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "gpt-oss-20b": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "gpt-oss-safeguard-120b": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "hermes-4-405b": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "inkling-2-small": {
      "contextWindow": 1048000,
      "maxTokens": 131072
    },
    "kimi-k2.6": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "kimi-k2.7-code": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "kimi-k3": {
      "contextWindow": 1024000,
      "maxTokens": 1024000
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 500000
    },
    "kolibri-1": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "llama-3.3-70b-instruct": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "minimax-m2": {
      "contextWindow": 400000,
      "maxTokens": 196000
    },
    "minimax-m2.1": {
      "contextWindow": 196000,
      "maxTokens": 196000
    },
    "minimax-m2.5": {
      "contextWindow": 196000,
      "maxTokens": 196000
    },
    "minimax-m3": {
      "contextWindow": 1000000,
      "maxTokens": 500000
    },
    "minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 500000
    },
    "ministral-14b-2512": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "ministral-3b-2512": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "ministral-8b-2512": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "mistral-7b-instruct-v0.2": {
      "contextWindow": 32000,
      "maxTokens": 8192
    },
    "mistral-large-2402": {
      "contextWindow": 32000,
      "maxTokens": 8192
    },
    "mistral-large-4-0": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "mistral-medium-3.5": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "mistral-small-2503": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "mistral-small-2603": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "mistral-small-3.2-24b-instruct-2506": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "mixtral-8x7B-instruct-v0.1": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "nemotron-3.5-super-vl": {
      "contextWindow": 1000000,
      "maxTokens": 500000
    },
    "nemotron-nano-v2-12b": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "nova-2-lite": {
      "contextWindow": 1000000,
      "maxTokens": 65535
    },
    "nova-lite-v1": {
      "contextWindow": 300000,
      "maxTokens": 10000
    },
    "nova-micro-v1": {
      "contextWindow": 128000,
      "maxTokens": 10000
    },
    "nova-pro-v1": {
      "contextWindow": 300000,
      "maxTokens": 10000
    },
    "nvidia-nemotron-3-nano-30b-a3b": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "pixtral-large-2502": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "qwen2.5-vl-72b-instruct": {
      "contextWindow": 32000,
      "maxTokens": 32000
    },
    "qwen3-235b-a22b-instruct-2507": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "qwen3-30b-a3b-instruct-2507": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "qwen3-32b": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "qwen3-coder-30b-a3b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen3-coder-next": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "qwen3-vl-235b-a22b": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "qwen3.5-397b-a17b": {
      "contextWindow": 262000,
      "maxTokens": 65536
    },
    "qwen3.5-9b": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "qwen3.6-27b": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "qwen3.6-35b-a3b": {
      "contextWindow": 262000,
      "maxTokens": 64000
    },
    "qwen3.8-2.4t-a95b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen3.8-27b": {
      "contextWindow": 1000000,
      "maxTokens": 500000
    },
    "qwen3guard-gen-0.6b": {
      "contextWindow": 32000,
      "maxTokens": 32000
    },
    "qwen3guard-gen-8b": {
      "contextWindow": 32000,
      "maxTokens": 32000
    },
    "voxtral-small-2507": {
      "contextWindow": 32000,
      "maxTokens": 32000
    }
  },
  "crossmodel": {
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gemini/gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini/gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini/gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini/gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini/gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini/gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini/gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini/gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini/gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "minimax/minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m3": {
      "contextWindow": 1024000,
      "maxTokens": 512000
    },
    "moonshot/kimi-k2.6": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "moonshot/kimi-k2.7-code": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "moonshot/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshot/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "qwen/qwen3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen/qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-omni-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "tencent/hy3": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "tencent/hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "tencent/hy4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "x-ai/grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "x-ai/grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "x-ai/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "x-ai/grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "x-ai/grok-build-0.1": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "xiaomi/mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-4.7": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-5": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-5-turbo": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    }
  },
  "crusoe": {
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "deepseek-ai/DeepSeek-V3-0324": {
      "contextWindow": 163840,
      "maxTokens": 163840
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "meta-llama/Llama-3.3-70B-Instruct": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "moonshotai/Kimi-K2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "zai/GLM-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "zai/GLM-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "daoxe": {
    "claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    }
  },
  "databricks": {
    "databricks-claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "databricks-claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "databricks-claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "databricks-claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "databricks-claude-opus-4-1": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "databricks-claude-opus-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "databricks-claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "databricks-claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "databricks-claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "databricks-claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "databricks-claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "databricks-claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "databricks-claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "databricks-claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "databricks-claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "databricks-deepseek-v4-1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "databricks-gemini-3-1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "databricks-gemini-3-1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "databricks-gemini-3-5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "databricks-gemini-3-5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "databricks-gemini-3-7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "databricks-gemini-3-8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "databricks-gemini-3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "databricks-gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "databricks-gemma-3-12b": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "databricks-glm-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "databricks-glm-5-3": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "databricks-glm-5-3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "databricks-gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "databricks-gpt-5-1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "databricks-gpt-5-2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "databricks-gpt-5-3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "databricks-gpt-5-4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "databricks-gpt-5-4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "databricks-gpt-5-4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "databricks-gpt-5-5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "databricks-gpt-5-5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "databricks-gpt-5-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "databricks-gpt-5-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "databricks-gpt-5-6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "databricks-gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "databricks-gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "databricks-gpt-6-1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "databricks-gpt-6-1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "databricks-gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "databricks-gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "databricks-gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "databricks-gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 25000
    },
    "databricks-gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 25000
    },
    "databricks-grok-4-6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "databricks-grok-4-7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "databricks-kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "databricks-kimi-k3-1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "databricks-llama-4-maverick": {
      "contextWindow": 1000000,
      "maxTokens": 8192
    },
    "databricks-meta-llama-3-1-8b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "databricks-meta-llama-3-3-70b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "system.ai.claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "system.ai.gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "system.ai.gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "system.ai.gpt-6-2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "system.ai.gpt-6-2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  },
  "deepseek": {
    "deepseek-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek-v4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek-v4-flash-vision-exp": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    }
  },
  "digitalocean": {
    "all-mini-lm-l6-v2": {
      "contextWindow": 256,
      "maxTokens": 384
    },
    "anthropic-claude-4.5-sonnet": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic-claude-4.6-sonnet": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "anthropic-claude-5-sonnet": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic-claude-5.5-haiku": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic-claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic-claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic-claude-fable-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic-claude-haiku-4.5": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "anthropic-claude-opus-4.5": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "anthropic-claude-opus-4.6": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "anthropic-claude-opus-4.7": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "anthropic-claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic-claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic-claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic-claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "arcee-trinity-large-thinking": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "bge-m3": {
      "contextWindow": 8192,
      "maxTokens": 1024
    },
    "bge-reranker-v2-m3": {
      "contextWindow": 8192,
      "maxTokens": 1
    },
    "deepseek-3.2": {
      "contextWindow": 163840,
      "maxTokens": 163840
    },
    "deepseek-4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-v4-pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "e5-large-v2": {
      "contextWindow": 512,
      "maxTokens": 1024
    },
    "gemma-4-31B-it": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "glm-5.2": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "gte-large-en-v1.5": {
      "contextWindow": 8192,
      "maxTokens": 1024
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "llama-4-maverick": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "mimo-v2.5-pro": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "minimax-m2.5": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "mistral-3-14B": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "multi-qa-mpnet-base-dot-v1": {
      "contextWindow": 512,
      "maxTokens": 768
    },
    "nemotron-3-nano-omni": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "nemotron-3-ultra-550b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "nemotron-3.5-super-vl": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nemotron-nano-12b-v2-vl": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai-gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai-gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai-gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai-gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai-gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai-gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai-gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai-gpt-5.2-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai-gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai-gpt-5.4": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai-gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai-gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai-gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai-gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-6-1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-oss-120b": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "openai-gpt-oss-20b": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "openai-o1": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai-o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai-o3-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "qwen3-embedding-0.6b": {
      "contextWindow": 8000,
      "maxTokens": 1024
    },
    "qwen3-tts-voicedesign": {
      "contextWindow": 32768,
      "maxTokens": 1
    },
    "qwen3.5-397b-a17b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "reflection-beam": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "stable-diffusion-3.5-large": {
      "contextWindow": 256,
      "maxTokens": 1
    },
    "wan2-2-t2v-a14b": {
      "contextWindow": 100,
      "maxTokens": 1
    }
  },
  "dinference": {
    "glm-4.7": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "glm-5": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "minimax-m2.5": {
      "contextWindow": 200000,
      "maxTokens": 32000
    }
  },
  "dothoosh": {
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "doubleword": {
    "Qwen/Qwen3-VL-235B-A22B-Instruct-FP8": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "Qwen/Qwen3.5-35B-A3B-FP8-dottxt": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.6-35B-A3B-FP8": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.8-27B-FP8": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/gemma-4-31B-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "meta-models/Muse-Glimmer-30B": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "meta/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "moonshotai/Kimi-K3.1-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "zai-org/GLM-5.2-FP8": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "drun": {
    "public/deepseek-r1": {
      "contextWindow": 131072,
      "maxTokens": 32000
    },
    "public/deepseek-v3": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "public/minimax-m25": {
      "contextWindow": 204800,
      "maxTokens": 131072
    }
  },
  "ebcloud": {
    "DeepSeek-V4-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "DeepSeek-V4-Pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "GLM-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "Kimi-K2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    }
  },
  "echo": {
    "echo": {
      "contextWindow": 262144,
      "maxTokens": 65536
    }
  },
  "edenai": {
    "amazon/amazon.nova-lite-v1:0": {
      "contextWindow": 300000,
      "maxTokens": 10000
    },
    "amazon/amazon.nova-lite-v1:0@us": {
      "contextWindow": 300000,
      "maxTokens": 10000
    },
    "amazon/amazon.nova-micro-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 10000
    },
    "amazon/amazon.nova-micro-v1:0@us": {
      "contextWindow": 128000,
      "maxTokens": 10000
    },
    "amazon/amazon.nova-pro-v1:0": {
      "contextWindow": 300000,
      "maxTokens": 10000
    },
    "amazon/amazon.nova-pro-v1:0@us": {
      "contextWindow": 300000,
      "maxTokens": 10000
    },
    "amazon/google.gemma-3-12b-it": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "amazon/google.gemma-3-12b-it@us": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "amazon/google.gemma-3-27b-it": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "amazon/google.gemma-3-27b-it@us": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "amazon/google.gemma-3-4b-it": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "amazon/google.gemma-3-4b-it@us": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "amazon/mistral.pixtral-large-2502-v1:0": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "amazon/mistral.pixtral-large-2502-v1:0@us": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "amazon/mistral.voxtral-mini-3b-2507": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "amazon/mistral.voxtral-mini-3b-2507@us": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "amazon/mistral.voxtral-small-24b-2507": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "amazon/mistral.voxtral-small-24b-2507@us": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "amazon/moonshot.kimi-k2-thinking": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "amazon/moonshotai.kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "amazon/openai.gpt-oss-safeguard-20b": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "amazon/openai.gpt-oss-safeguard-20b@us": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "amazon/qwen.qwen3-coder-next": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "amazon/writer.palmyra-vision-7b": {
      "contextWindow": 4096,
      "maxTokens": 4096
    },
    "amazon/zai.glm-4.7-flash": {
      "contextWindow": 203000,
      "maxTokens": 131072
    },
    "amazon/zai.glm-4.7-flash@us": {
      "contextWindow": 203000,
      "maxTokens": 131072
    },
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4-5-20251101": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "arkanecloud/Qwen/Qwen3-235B-A22B-Instruct-2507": {
      "contextWindow": 262000,
      "maxTokens": 16384
    },
    "arkanecloud/deepseek-ai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "arkanecloud/deepseek-ai/DeepSeek-V4.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "arkanecloud/deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "arkanecloud/ministral-14b": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "arkanecloud/nvidia/nemotron-3-ultra-550b-a55b": {
      "contextWindow": 512288,
      "maxTokens": 128000
    },
    "arkanecloud/openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "azure/gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "azure/gpt-4.1-nano@eu": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "azure/gpt-4.1-nano@us": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "azure/gpt-5.1-codex": {
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "azure/gpt-5.1-codex-max": {
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "azure/gpt-5.1-codex-mini": {
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "azure/gpt-5.2-codex": {
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "cerebras/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 40960
    },
    "cloudflare/@cf/aisingapore/gemma-sea-lion-v4-27b-it": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "cloudflare/@cf/deepseek-ai/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "cloudflare/@cf/meta/llama-3.2-3b-instruct": {
      "contextWindow": 80000,
      "maxTokens": 80000
    },
    "cloudflare/@cf/meta/llama-guard-3-8b": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "cloudflare/@cf/mistralai/mistral-small-3.1-24b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 102400
    },
    "cloudflare/@cf/openai/gpt-oss-120b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "cloudflare/@cf/openai/gpt-oss-20b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "cloudflare/@cf/qwen/qwen2.5-coder-32b-instruct": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "cloudflare/@cf/thinkingmachines/inkling-2-small": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "cloudflare/@cf/zai-org/glm-4.7-flash": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "cohere/c4ai-aya-expanse-32b": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "cohere/command-a-03-2025": {
      "contextWindow": 288000,
      "maxTokens": 8000
    },
    "cohere/command-a-translate-08-2025": {
      "contextWindow": 8992,
      "maxTokens": 8000
    },
    "cohere/command-a-vision-07-2025": {
      "contextWindow": 128000,
      "maxTokens": 8000
    },
    "cohere/command-r-08-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "cohere/command-r-plus-08-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "cohere/command-r7b-12-2024": {
      "contextWindow": 132000,
      "maxTokens": 4000
    },
    "databricks/databricks-gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 25000
    },
    "databricks/databricks-gpt-oss-120b@eu": {
      "contextWindow": 131072,
      "maxTokens": 25000
    },
    "databricks/databricks-gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 25000
    },
    "databricks/databricks-gpt-oss-20b@eu": {
      "contextWindow": 131072,
      "maxTokens": 25000
    },
    "databricks/databricks-qwen3-next-80b-a3b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "databricks/databricks-qwen3-next-80b-a3b-instruct@eu": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "deepinfra/ByteDance/Seed-2.0-code": {
      "contextWindow": 256000,
      "maxTokens": 131072
    },
    "deepinfra/Gryphe/MythoMax-L2-13b": {
      "contextWindow": 4096,
      "maxTokens": 3200
    },
    "deepinfra/NousResearch/Hermes-3-Llama-3.1-405B": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "deepinfra/NousResearch/Hermes-3-Llama-3.1-70B": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "deepinfra/Qwen/Qwen2.5-7B-Instruct": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "deepinfra/Qwen/Qwen3-235B-A22B-Instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "deepinfra/Qwen/Qwen3-235B-A22B-Thinking-2507": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "deepinfra/Qwen/Qwen3-Coder-480B-A35B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "deepinfra/Qwen/Qwen3-Max": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "deepinfra/Qwen/Qwen3-Next-80B-A3B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "deepinfra/Qwen/Qwen3-VL-235B-A22B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "deepinfra/deepseek-ai/DeepSeek-R1": {
      "contextWindow": 163840,
      "maxTokens": 32768
    },
    "deepinfra/deepseek-ai/DeepSeek-R1-0528": {
      "contextWindow": 163840,
      "maxTokens": 32768
    },
    "deepinfra/deepseek-ai/DeepSeek-V3": {
      "contextWindow": 163840,
      "maxTokens": 8192
    },
    "deepinfra/deepseek-ai/DeepSeek-V3-0324": {
      "contextWindow": 163840,
      "maxTokens": 163840
    },
    "deepinfra/deepseek-ai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepinfra/deepseek-ai/DeepSeek-V4-Pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepinfra/google/gemma-3-12b-it": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "deepinfra/google/gemma-3-27b-it": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "deepinfra/google/gemma-3-4b-it": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "deepinfra/ibm-granite/granite-4.2-8b": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "deepinfra/meta-llama/Llama-3.2-11B-Vision-Instruct": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "deepinfra/meta-llama/Llama-3.2-3B-Instruct": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "deepinfra/meta-llama/Llama-3.3-70B-Instruct": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "deepinfra/meta-llama/Llama-Guard-3-8B": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "deepinfra/meta-llama/Llama-Guard-4-12B": {
      "contextWindow": 163840,
      "maxTokens": 163840
    },
    "deepinfra/meta-models/Muse-Glimmer-30B": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "deepinfra/microsoft/WizardLM-2-8x22B": {
      "contextWindow": 65536,
      "maxTokens": 8000
    },
    "deepinfra/mistralai/Mistral-Small-24B-Instruct-2501": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "deepinfra/mistralai/Mixtral-8x7B-Instruct-v0.1": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "deepinfra/moonshotai/Kimi-K2-Instruct": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "deepinfra/moonshotai/Kimi-K2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "deepinfra/nemotron-3-super-120b-a12b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "deepinfra/nemotron-3-ultra-550b-a55b": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "deepinfra/nvidia/Llama-3.1-Nemotron-70B-Instruct": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "deepinfra/nvidia/Nemotron-3-Nano-30B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "deepinfra/openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "deepinfra/openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "deepinfra/stepfun-ai/Step-3.5-Flash": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "deepinfra/stepfun-ai/Step-3.7-Flash": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "deepinfra/stepfun-ai/Step-5-Preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepinfra/tencent/Hy3": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "deepinfra/tencent/Hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepinfra/tencent/Hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepinfra/thinkingmachines/Inkling": {
      "contextWindow": 524288,
      "maxTokens": 524288
    },
    "deepinfra/thinkingmachines/Inkling-2-Mini": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepinfra/thinkingmachines/Inkling-2-Small": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "deepinfra/thinkingmachines/Inkling-Small": {
      "contextWindow": 524288,
      "maxTokens": 524288
    },
    "deepinfra/zai-org/GLM-4.7-Flash": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "deepseek/deepseek-chat": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "fireworks_ai/accounts/fireworks/models/ember-1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "fireworks_ai/accounts/fireworks/models/inkling": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "fireworks_ai/accounts/fireworks/models/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "flexai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "flexai/DeepSeek-V4-Flash-0731@eu": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "flexai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "flexai/Muse-Glimmer-30B": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "flexai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "flexai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "flexai/gpt-oss-20b@eu": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "google/deep-research-max-preview-04-2026": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/deep-research-preview-04-2026": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-2.5-flash-image": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "google/gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3-pro-image": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "google/gemini-3-pro-image-preview": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "google/gemini-3.1-flash-image": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "google/gemini-3.1-flash-image-preview": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "google/gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-flash-lite-image": {
      "contextWindow": 65536,
      "maxTokens": 4096
    },
    "google/gemini-3.1-flash-lite-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview-customtools": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-nano-banana-2.1": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "google/gemini-pro-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-robotics-er-2-preview": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "greenference/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "greenpt/deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "greenpt/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "greenpt/gpt-oss-120b": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "greenpt/llama-3.3-70b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "greenpt/qwen3-235b-a22b-instruct-2507": {
      "contextWindow": 250000,
      "maxTokens": 16384
    },
    "groq/meta-llama/llama-prompt-guard-2-22m": {
      "contextWindow": 512,
      "maxTokens": 512
    },
    "groq/meta-llama/llama-prompt-guard-2-86m": {
      "contextWindow": 512,
      "maxTokens": 512
    },
    "groq/openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "groq/openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "groq/openai/gpt-oss-safeguard-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "infomaniak/mistralai/Ministral-3-14B-Instruct-2512": {
      "contextWindow": 100000,
      "maxTokens": 100000
    },
    "ionos/Qwen/Qwen3-Coder-Next": {
      "contextWindow": 128000,
      "maxTokens": 65536
    },
    "ionos/meta-llama/Llama-3.3-70B-Instruct": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "ionos/openai/gpt-oss-120b": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "meta/muse-spark-1.1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-wonder-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "microsoft/gpt-4": {
      "contextWindow": 8191,
      "maxTokens": 8191
    },
    "microsoft/o3-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "minimax/MiniMax-M2": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/MiniMax-M2.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/MiniMax-M2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/MiniMax-M2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/MiniMax-M3": {
      "contextWindow": 524288,
      "maxTokens": 512000
    },
    "minimax/MiniMax-M3.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "mistral/codestral-2508": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "mistral/codestral-2508@eu": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "mistral/codestral-latest": {
      "contextWindow": 256000,
      "maxTokens": 4096
    },
    "mistral/codestral-latest@eu": {
      "contextWindow": 256000,
      "maxTokens": 4096
    },
    "mistral/devstral-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/devstral-2512@eu": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/devstral-medium-latest": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/devstral-medium-latest@eu": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/magistral-medium-latest": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "mistral/magistral-medium-latest@eu": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "mistral/ministral-14b-2512": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistral/ministral-14b-2512@eu": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistral/ministral-3b-2512": {
      "contextWindow": 131072,
      "maxTokens": 104857
    },
    "mistral/ministral-3b-2512@eu": {
      "contextWindow": 131072,
      "maxTokens": 104857
    },
    "mistral/ministral-8b-2512": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistral/ministral-8b-2512@eu": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistral/mistral-large-2407": {
      "contextWindow": 131072,
      "maxTokens": 104857
    },
    "mistral/mistral-large-2407@eu": {
      "contextWindow": 131072,
      "maxTokens": 104857
    },
    "mistral/mistral-large-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/mistral-large-2512@eu": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/mistral-large-4@eu": {
      "contextWindow": 524288,
      "maxTokens": 262144
    },
    "mistral/mistral-large-latest": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "mistral/mistral-large-latest@eu": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "mistral/mistral-medium-2604": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/mistral-medium-2604@eu": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/mistral-medium-3": {
      "contextWindow": 262144,
      "maxTokens": 104857
    },
    "mistral/mistral-medium-3-5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/mistral-medium-3-5@eu": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/mistral-medium-3@eu": {
      "contextWindow": 262144,
      "maxTokens": 104857
    },
    "mistral/mistral-medium-latest": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/mistral-medium-latest@eu": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/mistral-small-2603": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "mistral/mistral-small-2603@eu": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "mistral/mistral-small-latest": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "mistral/mistral-small-latest@eu": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "mistral/voxtral-small-latest": {
      "contextWindow": 32768,
      "maxTokens": 32000
    },
    "mistral/voxtral-small-latest@eu": {
      "contextWindow": 32768,
      "maxTokens": 32000
    },
    "moonshot/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshot/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshot/kimi-k2.7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshot/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshot/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nebius/Qwen/Qwen3-235B-A22B-Instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "nebius/Qwen/Qwen3-30B-A3B-Instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "nebius/deepseek-ai/DeepSeek-V4-Pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "nebius/deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "nebius/google/gemma-3-27b-it": {
      "contextWindow": 110000,
      "maxTokens": 110000
    },
    "nebius/meta-models/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "nebius/nvidia/Nemotron-3-Ultra-550b-a55b": {
      "contextWindow": 1048576,
      "maxTokens": 128000
    },
    "nebius/nvidia/nemotron-3-super-120b-a12b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nebius/openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "nebius/thinkingmachines/Inkling-2-Small": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-2024-08-06": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-2024-11-20": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 272000
    },
    "openai/gpt-5-search-api": {
      "contextWindow": 272000,
      "maxTokens": 100000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-mini-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-pro-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-pro": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "ovhcloud/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "ovhcloud/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "ovhcloud/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "perplexityai/sonar": {
      "contextWindow": 127072,
      "maxTokens": 4096
    },
    "perplexityai/sonar-deep-research": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "perplexityai/sonar-pro": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "perplexityai/sonar-reasoning-pro": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "qwen/deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "qwen/deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "qwen/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "qwen/deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "qwen/qwen-max": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "qwen/qwen-mt-plus": {
      "contextWindow": 4096,
      "maxTokens": 4096
    },
    "qwen/qwen3-coder-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-2.4t-a95b": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-max-0902": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-omni-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "scaleway/deepseek-v4-flash-0731": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "scaleway/deepseek-v4.1-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "scaleway/deepseek-v4.1-flash-1017": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "scaleway/gemma-3-27b-it": {
      "contextWindow": 40000,
      "maxTokens": 40000
    },
    "scaleway/gpt-oss-120b": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "scaleway/llama-3.3-70b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "scaleway/qwen3-235b-a22b-instruct-2507": {
      "contextWindow": 250000,
      "maxTokens": 16384
    },
    "scaleway/qwen3-coder-30b-a3b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 65536
    },
    "sference/deepseek-ai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "sference/deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "tencent/deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "tencent/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "tencent/deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "tencent/hy3": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "tencent/hy4": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "tencent/hy4-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "tencent/step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "tensorx/deepseek/deepseek-r1-0528": {
      "contextWindow": 164000,
      "maxTokens": 32768
    },
    "tensorx/deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "tensorx/deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "tensorx/deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "tensorx/deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "tensorx/moonshotai/kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "together_ai/deepseek-ai/DeepSeek-V4-Pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "together_ai/deepseek-ai/DeepSeek-V4.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "together_ai/deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "together_ai/meta-models/Muse-Glimmer-30B": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "together_ai/openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "together_ai/reflection/Beam-1.0-501B-A23B": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "together_ai/tencent/Hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "together_ai/thinkingmachines/Inkling": {
      "contextWindow": 524288,
      "maxTokens": 524288
    },
    "together_ai/thinkingmachines/Inkling-2-Small": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "tsystems/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "vertex/gemini-2.5-flash-image": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "vertex/gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3-pro-image": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "vertex/gemini-3.1-flash-image": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "vertex/gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.1-flash-lite-image": {
      "contextWindow": 65536,
      "maxTokens": 4096
    },
    "vertex/gemini-3.1-flash-lite@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.1-flash-lite@us": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.5-flash-lite@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.5-flash-lite@us": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.5-flash@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.5-flash@us": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.6-flash@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.6-flash@us": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.7-flash@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.7-flash@us": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.8-flash@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-3.8-flash@us": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "vertex/gemini-nano-banana-2.1": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "xai/grok-4-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "xai/grok-4.20-0309-non-reasoning": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "xai/grok-4.20-0309-reasoning": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "xai/grok-4.20-multi-agent-0309": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "xai/grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "xai/grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-latest": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "zai/glm-4.6": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai/glm-4.6v": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "zai/glm-4.7": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai/glm-5": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai/glm-5-turbo": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai/glm-5.1": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai/glm-5.3-flashx-legal": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai/glm-5v-turbo": {
      "contextWindow": 202752,
      "maxTokens": 131072
    }
  },
  "empiriolabs": {
    "deepseek-v4-1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "fugu-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "fugu-ultra-v1-0": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "fugu-ultra-v1-1": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "fugu-ultra-v2-0": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gemma-4-26b-a4b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "glm-4-5-flash": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "glm-4-6v-flash": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "glm-4-7-flash": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "glm-4-7-flashx": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "glm-5-1": {
      "contextWindow": 202745,
      "maxTokens": 128000
    },
    "glm-5-2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5-3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5-3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "kimi-k2-6": {
      "contextWindow": 262144,
      "maxTokens": 16000
    },
    "kimi-k2-7-code": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "kimi-k2-7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "kimi-k3-1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2-6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2-6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2-6-pro-ultraspeed": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "minimax-m3-1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "mistral-small-4": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "muse-glimmer-30b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "muse-spark-1-1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1-2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1-3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "qwen3-5-122b-a10b": {
      "contextWindow": 258048,
      "maxTokens": 64000
    },
    "qwen3-5-27b": {
      "contextWindow": 258048,
      "maxTokens": 64000
    },
    "qwen3-5-35b-a3b": {
      "contextWindow": 258048,
      "maxTokens": 64000
    },
    "qwen3-5-397b-a17b": {
      "contextWindow": 258048,
      "maxTokens": 64000
    },
    "qwen3-5-4b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3-5-9b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3-5-flash": {
      "contextWindow": 995904,
      "maxTokens": 32768
    },
    "qwen3-5-plus": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "qwen3-6-27b": {
      "contextWindow": 229376,
      "maxTokens": 64000
    },
    "qwen3-6-35b-a3b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "qwen3-6-flash": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "qwen3-6-plus": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "qwen3-7-flash": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "qwen3-7-max": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "qwen3-7-plus": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "qwen3-8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3-8-flash": {
      "contextWindow": 983616,
      "maxTokens": 131072
    },
    "qwen3-8-max": {
      "contextWindow": 983616,
      "maxTokens": 131072
    },
    "qwen3-8-max-0902": {
      "contextWindow": 983616,
      "maxTokens": 131072
    },
    "qwen3-8-omni-flash": {
      "contextWindow": 1006592,
      "maxTokens": 131072
    },
    "qwen4-max": {
      "contextWindow": 983616,
      "maxTokens": 262144
    },
    "seed-2-0-code": {
      "contextWindow": 229096,
      "maxTokens": 128000
    },
    "seed-2-0-lite": {
      "contextWindow": 229096,
      "maxTokens": 128000
    },
    "seed-2-0-mini": {
      "contextWindow": 229156,
      "maxTokens": 128000
    },
    "seed-2-0-pro": {
      "contextWindow": 229096,
      "maxTokens": 128000
    },
    "seed-2-1-turbo": {
      "contextWindow": 229093,
      "maxTokens": 65536
    },
    "step-3-5-flash": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "step-3-5-flash-2603": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "step-3-7-flash": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "step-5-preview": {
      "contextWindow": 1024000,
      "maxTokens": 131072
    }
  },
  "engy": {
    "deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 128000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "glm-5.2": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "glm-5.3": {
      "contextWindow": 327680,
      "maxTokens": 32768
    },
    "glm-5.3-flash": {
      "contextWindow": 327680,
      "maxTokens": 32768
    },
    "kimi-k3": {
      "contextWindow": 1113088,
      "maxTokens": 65536
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1113088,
      "maxTokens": 65536
    },
    "qwen3.6-35b-a3b": {
      "contextWindow": 208192,
      "maxTokens": 8192
    },
    "qwen3.8-27b": {
      "contextWindow": 1001536,
      "maxTokens": 65536
    }
  },
  "entrim": {
    "Qwen/Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "evroc": {
    "KBLab/kb-whisper-large": {
      "contextWindow": 448,
      "maxTokens": 448
    },
    "Qwen/Qwen3-Embedding-8B": {
      "contextWindow": 40960,
      "maxTokens": 4096
    },
    "Qwen/Qwen3-Reranker-4B": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "Qwen/Qwen3.6-35B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "evroc/roc": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "google/gemma-4-26B-A4B-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "intfloat/multilingual-e5-large-instruct": {
      "contextWindow": 512,
      "maxTokens": 512
    },
    "mistralai/Mistral-Medium-3.5-128B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistralai/Voxtral-Small-24B-2507": {
      "contextWindow": 32000,
      "maxTokens": 32000
    },
    "moonshotai/Kimi-K2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/Llama-3.3-70B-Instruct-FP8": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "openai/whisper-large-v3": {
      "contextWindow": 448,
      "maxTokens": 448
    },
    "openai/whisper-large-v3-turbo": {
      "contextWindow": 448,
      "maxTokens": 448
    },
    "zai-org/GLM-5.2": {
      "contextWindow": 524288,
      "maxTokens": 131072
    }
  },
  "ezkielyna": {
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    }
  },
  "fastrouter": {
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.1": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "anthropic/claude-opus-4.7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3-pro-image-preview": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "google/gemini-3.1-flash-image-preview": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "minimax/minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "moonshotai/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "sarvam/sarvam-105b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "x-ai/grok-4": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "x-ai/grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "x-ai/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "x-ai/grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "x-ai/grok-build-0.1": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "z-ai/glm-5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "fiftyx": {
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "fireworks-ai": {
    "accounts/fireworks/models/deepseek-v4p1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "accounts/fireworks/models/deepseek-v4p1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "accounts/fireworks/models/ember-1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "accounts/fireworks/models/glm-5p3": {
      "contextWindow": 1048573,
      "maxTokens": 262144
    },
    "accounts/fireworks/models/glm-5p3-flash": {
      "contextWindow": 1048573,
      "maxTokens": 131072
    },
    "accounts/fireworks/models/hy4-flash": {
      "contextWindow": 524288,
      "maxTokens": 65536
    },
    "accounts/fireworks/models/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "accounts/fireworks/models/kimi-k3p1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "accounts/fireworks/models/minimax-m3": {
      "contextWindow": 512000,
      "maxTokens": 512000
    },
    "accounts/fireworks/models/minimax-m3p1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "accounts/fireworks/models/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "accounts/fireworks/models/qwen3p8-2p4t-a95b": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "accounts/fireworks/models/qwen3p8-max": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "accounts/fireworks/models/qwen4-max": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "accounts/fireworks/models/ultramarine-1-flash-us": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "accounts/fireworks/routers/deepseek-flash-latest": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "accounts/fireworks/routers/deepseek-v4p1-flash-1017-flex": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "accounts/fireworks/routers/deepseek-v4p1-flash-1017-spot": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "accounts/fireworks/routers/deepseek-v4p1-flash-1017-ultrafast": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "accounts/fireworks/routers/deepseek-v4p1-flash-1017-us": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "accounts/fireworks/routers/deepseek-v4p1-flash-spot": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "accounts/fireworks/routers/deepseek-v4p1-flash-us": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "accounts/fireworks/routers/glm-5p3-fast": {
      "contextWindow": 1048572,
      "maxTokens": 262144
    },
    "accounts/fireworks/routers/glm-5p3-spot": {
      "contextWindow": 1048573,
      "maxTokens": 262144
    },
    "accounts/fireworks/routers/glm-5p3-us": {
      "contextWindow": 1048573,
      "maxTokens": 262144
    },
    "accounts/fireworks/routers/glm-fast-latest": {
      "contextWindow": 1048572,
      "maxTokens": 262144
    },
    "accounts/fireworks/routers/glm-flash-latest": {
      "contextWindow": 1048573,
      "maxTokens": 131072
    },
    "accounts/fireworks/routers/glm-latest": {
      "contextWindow": 1048573,
      "maxTokens": 262144
    },
    "accounts/fireworks/routers/kimi-fast-latest": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "accounts/fireworks/routers/kimi-k3-fast": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "accounts/fireworks/routers/kimi-k3-us": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "accounts/fireworks/routers/kimi-k3p1-pro-us": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "accounts/fireworks/routers/kimi-latest": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "accounts/fireworks/routers/minimax-latest": {
      "contextWindow": 512000,
      "maxTokens": 512000
    },
    "accounts/fireworks/routers/qwen-max-latest": {
      "contextWindow": 262144,
      "maxTokens": 131072
    }
  },
  "fortytwo": {
    "qwen/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 235929
    }
  },
  "freemodel": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  },
  "frequency": {
    "google/gemma-4-26b-a4b-it": {
      "contextWindow": 32768,
      "maxTokens": 8192
    }
  },
  "friendli": {
    "google/gemma-4-31B-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "zai-org/GLM-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "frogbot": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-6": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4-1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-1-pro-preview": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "gemini-3-5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-5-3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-5": {
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "gpt-5-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5-6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "grok-4-1-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 128000
    },
    "grok-4-1-fast-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 128000
    },
    "grok-4-3": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "grok-4-5": {
      "contextWindow": 500000,
      "maxTokens": 128000
    },
    "grok-code-fast-1": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "kimi-k2-6": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "kimi-k2.5": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "kimi-k3": {
      "contextWindow": 1040000,
      "maxTokens": 1040000
    },
    "minimax-m2-5": {
      "contextWindow": 192000,
      "maxTokens": 8192
    },
    "minimax-m2-7": {
      "contextWindow": 192000,
      "maxTokens": 8192
    },
    "minimax-m3": {
      "contextWindow": 512000,
      "maxTokens": 131072
    },
    "qwen-3-6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "zai-glm-5-1": {
      "contextWindow": 198000,
      "maxTokens": 8192
    },
    "zai-glm-5-3": {
      "contextWindow": 1040000,
      "maxTokens": 131072
    },
    "zai-glm-5-3-flash": {
      "contextWindow": 1040000,
      "maxTokens": 131072
    }
  },
  "gisoo": {
    "alibaba/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  },
  "gitlab": {
    "duo-chat-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "duo-chat-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-5-1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-5-2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-5-2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-5-3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-5-4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-5-4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-5-4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-5-5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-5-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-5-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-5-6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-5-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-6-1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "duo-chat-gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "duo-chat-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "duo-chat-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "duo-chat-opus-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "duo-chat-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "duo-chat-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "duo-chat-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "duo-chat-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "duo-chat-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "duo-chat-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "duo-chat-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "duo-chat-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "duo-chat-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    }
  },
  "gmicloud": {
    "MiniMaxAI/MiniMax-M2.7": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "MiniMaxAI/MiniMax-M3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "Qwen/Qwen3.7-Max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Qwen/Qwen3.8-Flash": {
      "contextWindow": 1048575,
      "maxTokens": 131072
    },
    "Qwen/Qwen3.8-Max": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "anthropic/claude-opus-4.6": {
      "contextWindow": 409600,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.7": {
      "contextWindow": 409600,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4.6": {
      "contextWindow": 409600,
      "maxTokens": 128000
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
      "contextWindow": 1048575,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "moonshotai/Kimi-K2.6": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "moonshotai/kimi-k2.7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "zai-org/GLM-5-FP8": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.1-FP8": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.2-FP8": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "google-vertex": {
    "claude-fable-5-1@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-2@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5@20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-1@20250805": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-opus-4-5@20251101": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4@20250514": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-opus-5-5@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-5@20250929": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4@20250514": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-5-5@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "codestral-2": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "deepseek-ai/deepseek-v3.1-maas": {
      "contextWindow": 163840,
      "maxTokens": 32768
    },
    "deepseek-ai/deepseek-v3.2-maas": {
      "contextWindow": 163840,
      "maxTokens": 65536
    },
    "gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-flash-image": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-flash-tts": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-pro-tts": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-pro-image": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "gemini-3.1-flash-image": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-flash-lite-image": {
      "contextWindow": 65536,
      "maxTokens": 4096
    },
    "gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-pro-preview-customtools": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-embedding-001": {
      "contextWindow": 2048,
      "maxTokens": 1
    },
    "gemini-nano-banana-2.1": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "google/gemma-4-26b-a4b-it-maas": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "meta/llama-3.3-70b-instruct-maas": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "meta/llama-4-maverick-17b-128e-instruct-maas": {
      "contextWindow": 524288,
      "maxTokens": 8192
    },
    "meta/llama-4-scout-17b-16e-instruct-maas": {
      "contextWindow": 1310720,
      "maxTokens": 8192
    },
    "mistral-medium-3": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "mistral-small-2503": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "moonshotai/kimi-k2-thinking-maas": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "openai/gpt-oss-120b-maas": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/gpt-oss-20b-maas": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3-235b-a22b-instruct-2507-maas": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "xai/grok-4.1-fast-non-reasoning": {
      "contextWindow": 128000,
      "maxTokens": 30000
    },
    "xai/grok-4.1-fast-reasoning": {
      "contextWindow": 128000,
      "maxTokens": 30000
    },
    "xai/grok-4.20-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "xai/grok-4.20-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "xai/grok-4.3": {
      "contextWindow": 200000,
      "maxTokens": 30000
    },
    "xai/grok-4.6": {
      "contextWindow": 524288,
      "maxTokens": 500000
    },
    "xai/grok-4.7": {
      "contextWindow": 524288,
      "maxTokens": 500000
    },
    "zai-org/glm-4.7-maas": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "zai-org/glm-5-maas": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "zai-org/glm-5.2-maas": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    }
  },
  "google-vertex-anthropic": {
    "claude-fable-5-1@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-2@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5@20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-1@20250805": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-opus-4-5@20251101": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4@20250514": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-opus-5-5@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-5@20250929": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4@20250514": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-5-5@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5@default": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    }
  },
  "graphn": {
    "deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "gemma-4-e4b": {
      "contextWindow": 65536,
      "maxTokens": 8192
    },
    "glm-5.3": {
      "contextWindow": 250000,
      "maxTokens": 131072
    },
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "qwen3-80b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen3-vl": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    }
  },
  "greenpt": {
    "deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "devstral-2-123b-instruct-2512": {
      "contextWindow": 200000,
      "maxTokens": 16384
    },
    "gemma-3-27b-it": {
      "contextWindow": 40000,
      "maxTokens": 8192
    },
    "gemma4": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.2-caveman": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.2-caveman-lite": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.2-caveman-ultra": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.2-honey": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.2-honey-lite": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.2-honey-ultra": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.2-ponytail": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.2-ponytail-lite": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.2-ponytail-ultra": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "green-l": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "green-l-raw": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "green-r": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "green-r-raw": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "holo2-30b-a3b": {
      "contextWindow": 22016,
      "maxTokens": 16384
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.6-fast": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "llama-3.3-70b-instruct": {
      "contextWindow": 100000,
      "maxTokens": 16384
    },
    "minimax-m2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "mistral-medium-3.5-128b": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "mistral-small-3.2-24b-instruct-2506": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "pixtral-12b-2409": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "qwen3-235b-a22b-instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "qwen3-coder-30b-a3b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "qwen3.5-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "voxtral-small-24b-2507": {
      "contextWindow": 32768,
      "maxTokens": 16384
    }
  },
  "helicone": {
    "chatgpt-4o-latest": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "claude-3-haiku-20240307": {
      "contextWindow": 200000,
      "maxTokens": 4096
    },
    "claude-3.5-haiku": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "claude-3.5-sonnet-v2": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "claude-3.7-sonnet": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-4.5-haiku": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "claude-4.5-opus": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-4.5-sonnet": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "claude-opus-4": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-opus-4-1": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-opus-4-1-20250805": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-sonnet-4": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-5-20250929": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "deepseek-r1-distill-llama-70b": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "deepseek-reasoner": {
      "contextWindow": 128000,
      "maxTokens": 64000
    },
    "deepseek-tng-r1t2-chimera": {
      "contextWindow": 130000,
      "maxTokens": 130000
    },
    "deepseek-v3": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "deepseek-v3.1-terminus": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "deepseek-v3.2": {
      "contextWindow": 163840,
      "maxTokens": 65536
    },
    "ernie-4.5-21b-a3b-thinking": {
      "contextWindow": 128000,
      "maxTokens": 8000
    },
    "gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemma-3-12b-it": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "gemma2-9b-it": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "glm-4.6": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-mini-2025-04-14": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-chat-latest": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-5-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-pro": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-chat-latest": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "grok-3": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "grok-3-mini": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "grok-4": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "grok-4-1-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "grok-4-1-fast-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "grok-4-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "grok-4-fast-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "grok-code-fast-1": {
      "contextWindow": 256000,
      "maxTokens": 10000
    },
    "hermes-2-pro-llama-3-8b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "kimi-k2-0711": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "kimi-k2-0905": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "kimi-k2-thinking": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "llama-3.1-8b-instant": {
      "contextWindow": 131072,
      "maxTokens": 32678
    },
    "llama-3.1-8b-instruct": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "llama-3.1-8b-instruct-turbo": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "llama-3.3-70b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 16400
    },
    "llama-3.3-70b-versatile": {
      "contextWindow": 131072,
      "maxTokens": 32678
    },
    "llama-4-maverick": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "llama-4-scout": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "llama-guard-4": {
      "contextWindow": 131072,
      "maxTokens": 1024
    },
    "llama-prompt-guard-2-22m": {
      "contextWindow": 512,
      "maxTokens": 2
    },
    "llama-prompt-guard-2-86m": {
      "contextWindow": 512,
      "maxTokens": 2
    },
    "mistral-large-2411": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "mistral-nemo": {
      "contextWindow": 128000,
      "maxTokens": 16400
    },
    "mistral-small": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "o1": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o1-mini": {
      "contextWindow": 128000,
      "maxTokens": 65536
    },
    "o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o3-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o3-pro": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o4-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "qwen2.5-coder-7b-fast": {
      "contextWindow": 32000,
      "maxTokens": 8192
    },
    "qwen3-235b-a22b-thinking": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "qwen3-30b-a3b": {
      "contextWindow": 41000,
      "maxTokens": 41000
    },
    "qwen3-32b": {
      "contextWindow": 131072,
      "maxTokens": 40960
    },
    "qwen3-coder": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "qwen3-coder-30b-a3b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen3-next-80b-a3b-instruct": {
      "contextWindow": 262000,
      "maxTokens": 16384
    },
    "qwen3-vl-235b-a22b-instruct": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "sonar": {
      "contextWindow": 127000,
      "maxTokens": 4096
    },
    "sonar-deep-research": {
      "contextWindow": 127000,
      "maxTokens": 4096
    },
    "sonar-pro": {
      "contextWindow": 200000,
      "maxTokens": 4096
    },
    "sonar-reasoning": {
      "contextWindow": 127000,
      "maxTokens": 4096
    },
    "sonar-reasoning-pro": {
      "contextWindow": 127000,
      "maxTokens": 4096
    }
  },
  "hetzner": {
    "Qwen/Qwen3.6-35B-A3B-FP8": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    }
  },
  "hopper": {
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepseek-v4.1-flash-1017-abliterated": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "hostinger-router": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4.5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "claude-sonnet-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "hpc-ai": {
    "anthropic/claude-opus-4.7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 128000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1002000,
      "maxTokens": 128000
    },
    "minimax/minimax-m2.5": {
      "contextWindow": 196000,
      "maxTokens": 195000
    },
    "moonshotai/kimi-k2.5": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "moonshotai/kimi-k2.7-code": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "zai-org/glm-5.1": {
      "contextWindow": 202000,
      "maxTokens": 202000
    },
    "zai-org/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "huawei-maas": {
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "openpangu-2.0-flash": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "openpangu-2.0-pro": {
      "contextWindow": 524288,
      "maxTokens": 131072
    }
  },
  "hubris": {
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-haiku-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.1": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "anthropic/claude-opus-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4.5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    }
  },
  "huggingface": {
    "CohereLabs/command-a-plus-05-2026-bf16": {
      "contextWindow": 192000,
      "maxTokens": 64000
    },
    "Gryphe/MythoMax-L2-13b": {
      "contextWindow": 8192,
      "maxTokens": 3200
    },
    "MiniMaxAI/MiniMax-M2": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMaxAI/MiniMax-M2.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMaxAI/MiniMax-M2.5": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "MiniMaxAI/MiniMax-M2.7": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "MiniMaxAI/MiniMax-M3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "MiniMaxAI/MiniMax-M3.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "NousResearch/Hermes-3-Llama-3.1-70B": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "NousResearch/Hermes-4-405B": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "Qwen/Qwen2.5-Coder-32B-Instruct": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "Qwen/Qwen3-235B-A22B-Thinking-2507": {
      "contextWindow": 128000,
      "maxTokens": 81920
    },
    "Qwen/Qwen3-30B-A3B": {
      "contextWindow": 40960,
      "maxTokens": 16384
    },
    "Qwen/Qwen3-30B-A3B-Instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "Qwen/Qwen3-32B": {
      "contextWindow": 40960,
      "maxTokens": 16384
    },
    "Qwen/Qwen3-8B": {
      "contextWindow": 40960,
      "maxTokens": 32768
    },
    "Qwen/Qwen3-Coder-30B-A3B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3-Coder-Next": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3-Next-80B-A3B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Qwen/Qwen3-VL-235B-A22B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Qwen/Qwen3-VL-30B-A3B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Qwen/Qwen3.5-122B-A10B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.5-27B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.5-35B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.5-397B-A17B": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Qwen/Qwen3.5-9B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.6-27B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.6-35B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.8-2.4T-A95B": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Qwen/Qwen3.8-27B": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "Qwen/Qwen3.8-Flash-Next": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "Qwen/Qwen3.8-Flash-Next-FP8": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "Undi95/ReMM-SLERP-L2-13B": {
      "contextWindow": 6144,
      "maxTokens": 5529
    },
    "XiaomiMiMo/MiMo-V2.5": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "XiaomiMiMo/MiMo-V2.5-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "aisingapore/Gemma-SEA-LION-v4-27B-IT": {
      "contextWindow": 131072,
      "maxTokens": 128000
    },
    "alpindale/WizardLM-2-8x22B": {
      "contextWindow": 65535,
      "maxTokens": 8000
    },
    "anthracite-org/magnum-v4-72b": {
      "contextWindow": 32768,
      "maxTokens": 4096
    },
    "deepseek-ai/DeepSeek-R1": {
      "contextWindow": 64000,
      "maxTokens": 32768
    },
    "deepseek-ai/DeepSeek-R1-0528": {
      "contextWindow": 163840,
      "maxTokens": 32768
    },
    "deepseek-ai/DeepSeek-V3": {
      "contextWindow": 163840,
      "maxTokens": 8192
    },
    "deepseek-ai/DeepSeek-V3-0324": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "deepseek-ai/DeepSeek-V3.1": {
      "contextWindow": 163840,
      "maxTokens": 8192
    },
    "deepseek-ai/DeepSeek-V3.2": {
      "contextWindow": 163840,
      "maxTokens": 65536
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "dphn/Dolphin-Mistral-24B-Venice-Edition": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "google/gemma-2-27b-it": {
      "contextWindow": 8192,
      "maxTokens": 2048
    },
    "google/gemma-3-12b-it": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "google/gemma-3-27b-it": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "google/gemma-3-4b-it": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "google/gemma-4-26B-A4B-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "google/gemma-4-31B-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "ibm-granite/granite-4.2-8b": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "inclusionAI/Ling-3.0-flash": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "inclusionAI/Ling-3.0-flash-Fin": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "inclusionAI/Ling-3.0-flash-VL": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "inclusionAI/Ling-3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "meta-llama/Llama-3.1-70B-Instruct": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "meta-llama/Llama-3.1-8B-Instruct": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "meta-llama/Llama-3.2-1B-Instruct": {
      "contextWindow": 60000,
      "maxTokens": 32000
    },
    "meta-llama/Llama-3.2-3B-Instruct": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "meta-llama/Llama-3.3-70B-Instruct": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "meta-llama/Llama-4-Maverick-17B-128E-Instruct": {
      "contextWindow": 524288,
      "maxTokens": 16384
    },
    "meta-llama/Llama-4-Scout-17B-16E-Instruct": {
      "contextWindow": 327680,
      "maxTokens": 16384
    },
    "meta-llama/Llama-Guard-4-12B": {
      "contextWindow": 163840,
      "maxTokens": 163840
    },
    "meta-models/Muse-Glimmer-30B": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "meta-models/Muse-Spark-Open-816B-A42B": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mistralai/Mistral-Large-4-1T-A52B": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "moonshotai/Kimi-K2-Instruct": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "moonshotai/Kimi-K2-Instruct-0905": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "moonshotai/Kimi-K2-Thinking": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/Kimi-K2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/Kimi-K2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/Kimi-K2.7-Code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/Kimi-K3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/Kimi-K3.1-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16": {
      "contextWindow": 1048576,
      "maxTokens": 8192
    },
    "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4": {
      "contextWindow": 1048576,
      "maxTokens": 8192
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/gpt-oss-safeguard-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "reflection/Beam-1.0-501B-A23B": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "stepfun-ai/Step-3.5-Flash": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "stepfun-ai/Step-3.7-Flash": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "tencent/Hy3": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "tencent/Hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "tencent/Hy4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "tencent/Hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "thinkingmachines/Inkling": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "thinkingmachines/Inkling-2-Mini": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "thinkingmachines/Inkling-2-Small": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "thinkingmachines/Inkling-Small": {
      "contextWindow": 524288,
      "maxTokens": 524288
    },
    "zai-org/AutoGLM-Phone-9B-Multilingual": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "zai-org/GLM-4.5": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "zai-org/GLM-4.5-Air": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "zai-org/GLM-4.5V": {
      "contextWindow": 65536,
      "maxTokens": 16384
    },
    "zai-org/GLM-4.6": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai-org/GLM-4.6V": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "zai-org/GLM-4.6V-Flash": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "zai-org/GLM-4.7": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai-org/GLM-4.7-Flash": {
      "contextWindow": 131072,
      "maxTokens": 128000
    },
    "zai-org/GLM-5": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.1": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "humain": {
    "humain-m3-preview": {
      "contextWindow": 204800,
      "maxTokens": 16384
    },
    "humain-m3-research-preview": {
      "contextWindow": 1048576,
      "maxTokens": 16384
    }
  },
  "hyper": {
    "deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "deepseek-v4.1-flash-1017-economy": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gemma-4-26b-a4b-it": {
      "contextWindow": 256000,
      "maxTokens": 25600
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 13107
    },
    "inkling": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 16000
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "minimax-m3": {
      "contextWindow": 512000,
      "maxTokens": 512000
    },
    "muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "prism": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "prism-core": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "prism-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-2.4t-a95b": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "qwen3.8-27b": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    }
  },
  "impossibl": {
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "cerebras/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "fireworks/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "fireworks/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "fireworks/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "google/gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "groq/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "groq/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "openai/gpt-3.5-turbo": {
      "contextWindow": 16385,
      "maxTokens": 4096
    },
    "openai/gpt-4-turbo": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 272000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/o1": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o4-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "qwen/qwen3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen/qwen3.8-max-preview": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "thinkingmachines/inkling": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "xai/grok-4.20-0309-non-reasoning": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "xai/grok-4.20-0309-reasoning": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "xai/grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "xai/grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-build-0.1": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "xiaomi/mimo-v2.5": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai/glm-4.5": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "zai/glm-4.5-air": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "zai/glm-4.6": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "zai/glm-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "zai/glm-5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "zai/glm-5-turbo": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "zai/glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "zai/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "inception": {
    "mercury-2": {
      "contextWindow": 128000,
      "maxTokens": 50000
    },
    "mercury-2.5": {
      "contextWindow": 260000,
      "maxTokens": 65536
    },
    "mercury-3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "mercury-edit-2": {
      "contextWindow": 32000,
      "maxTokens": 8192
    }
  },
  "inceptron": {
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/Kimi-K2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/Kimi-K2.7-Code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "inco": {
    "deepseek-v4.1-flash:fast": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash:fast": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3:fast": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k3:fast": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "minimax-m3:fast": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    }
  },
  "infer": {
    "infer/claude-fable-5-1:low-cost": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "infer/claude-opus-5-5:low-cost": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "infer/claude-sonnet-5-5:low-cost": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "infer/gemini-3.1-pro-preview:low-cost": {
      "contextWindow": 199999,
      "maxTokens": 65536
    },
    "infer/gemini-3.8-flash:low-cost": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "infer/gpt-5.6-sol:official": {
      "contextWindow": 271999,
      "maxTokens": 128000
    },
    "infer/gpt-6-astra:low-cost": {
      "contextWindow": 271999,
      "maxTokens": 128000
    },
    "infer/gpt-6-astra:official": {
      "contextWindow": 271999,
      "maxTokens": 128000
    },
    "infer/gpt-6.1-sol:low-cost": {
      "contextWindow": 271999,
      "maxTokens": 128000
    },
    "infer/grok-4.7:low-cost": {
      "contextWindow": 199999,
      "maxTokens": 199999
    }
  },
  "inferall": {
    "nvidia/nemotron-3-ultra-550b-a55b": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "nvidia/nemotron-3.5-lightning-30b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/nemotron-3.5-super-vl-120b-a12b": {
      "contextWindow": 1048576,
      "maxTokens": 8192
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "inference": {
    "google/gemma-3": {
      "contextWindow": 125000,
      "maxTokens": 4096
    },
    "meta/llama-3.1-8b-instruct": {
      "contextWindow": 16000,
      "maxTokens": 4096
    },
    "meta/llama-3.2-11b-vision-instruct": {
      "contextWindow": 16000,
      "maxTokens": 4096
    },
    "meta/llama-3.2-1b-instruct": {
      "contextWindow": 16000,
      "maxTokens": 4096
    },
    "meta/llama-3.2-3b-instruct": {
      "contextWindow": 16000,
      "maxTokens": 4096
    },
    "mistral/mistral-nemo-12b-instruct": {
      "contextWindow": 16000,
      "maxTokens": 4096
    },
    "osmosis/osmosis-structure-0.6b": {
      "contextWindow": 4000,
      "maxTokens": 2048
    },
    "qwen/qwen-2.5-7b-vision-instruct": {
      "contextWindow": 125000,
      "maxTokens": 4096
    },
    "qwen/qwen3-embedding-4b": {
      "contextWindow": 32000,
      "maxTokens": 2048
    }
  },
  "inference-coop": {
    "greenpt/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "greenpt/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "greenpt/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "regolo/apertus-70b": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "regolo/qwen3.5-122b": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "tinfoil/deepseek-v4-1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "tinfoil/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "tinfoil/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    }
  },
  "inferenceapis": {
    "MiniMaxAI/MiniMax-M3": {
      "contextWindow": 524288,
      "maxTokens": 512000
    },
    "Qwen/Qwen3.8-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "meta-llama/Llama-3.3-70B-Instruct-Turbo": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "moonshotai/Kimi-K2.7-Code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "inferris": {
    "glm-5.3": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k3": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "infersia": {
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "minimax/minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "reflection/beam-1.0-501b-a23b": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "tencent/hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-flash": {
      "contextWindow": 1048320,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "inferx": {
    "Agents-A1": {
      "contextWindow": 262000,
      "maxTokens": 100000
    },
    "Devstral-2-123B-Instruct-2512-int4-AutoRound": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "Ornith-1.0-35B-FP8": {
      "contextWindow": 262000,
      "maxTokens": 100000
    },
    "Qwen3-Coder-Next-FP8": {
      "contextWindow": 256144,
      "maxTokens": 65536
    },
    "Qwen3-Coder-Next-FP8-no-thinking": {
      "contextWindow": 260000,
      "maxTokens": 65536
    },
    "Qwen3.6-27B-FP8": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen3.6-35B-A3B-FP8": {
      "contextWindow": 262000,
      "maxTokens": 65536
    },
    "Qwen3.6-35B-A3B-fp8-no-thinking": {
      "contextWindow": 262000,
      "maxTokens": 65536
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 100000
    },
    "gemma-4-31B-it-fp8": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "mimo-v25": {
      "contextWindow": 1000000,
      "maxTokens": 100000
    }
  },
  "infomaniak": {
    "Qwen/Qwen3.5-122B-A10B-FP8": {
      "contextWindow": 200000,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.5-397B-A17B-FP8": {
      "contextWindow": 200000,
      "maxTokens": 65536
    },
    "bge_multilingual_gemma2": {
      "contextWindow": 8000,
      "maxTokens": 3584
    },
    "google/gemma-4-31B-it": {
      "contextWindow": 100000,
      "maxTokens": 32768
    },
    "mini_lm_l12_v2": {
      "contextWindow": 128,
      "maxTokens": 384
    },
    "mistralai/Ministral-3-14B-Instruct-2512": {
      "contextWindow": 100000,
      "maxTokens": 25600
    },
    "mistralai/Mistral-Small-4-119B-2603": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "moonshotai/Kimi-K2.6": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "swiss-ai/Apertus-v1.5-70B": {
      "contextWindow": 100000,
      "maxTokens": 8192
    }
  },
  "io-net": {
    "Intel/Qwen3-Coder-480B-A35B-Instruct-int4-mixed-ar": {
      "contextWindow": 106000,
      "maxTokens": 4096
    },
    "Qwen/Qwen2.5-VL-32B-Instruct": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "Qwen/Qwen3-235B-A22B-Thinking-2507": {
      "contextWindow": 262144,
      "maxTokens": 4096
    },
    "Qwen/Qwen3-Next-80B-A3B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 4096
    },
    "deepseek-ai/DeepSeek-R1-0528": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "meta-llama/Llama-3.2-90B-Vision-Instruct": {
      "contextWindow": 16000,
      "maxTokens": 4096
    },
    "meta-llama/Llama-3.3-70B-Instruct": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": {
      "contextWindow": 430000,
      "maxTokens": 4096
    },
    "mistralai/Devstral-Small-2505": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "mistralai/Magistral-Small-2506": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "mistralai/Mistral-Large-Instruct-2411": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "mistralai/Mistral-Nemo-Instruct-2407": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "moonshotai/Kimi-K2-Instruct-0905": {
      "contextWindow": 32768,
      "maxTokens": 4096
    },
    "moonshotai/Kimi-K2-Thinking": {
      "contextWindow": 32768,
      "maxTokens": 4096
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 64000,
      "maxTokens": 4096
    },
    "zai-org/GLM-4.6": {
      "contextWindow": 200000,
      "maxTokens": 4096
    }
  },
  "isoquant": {
    "deepseek-v4.1-flash-1017-fast": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "iteracompute": {
    "anthropic/claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "gemini/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini/gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "minimax/minimax-m2.5": {
      "contextWindow": 204800,
      "maxTokens": 16384
    },
    "minimax/minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 16384
    },
    "minimax/minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "moonshotai/kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "moonshotai/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "moonshotai/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "qwen/qwen3.8-2.4t-a95b": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "qwen/qwen3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-max": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "jad-ai": {
    "jad-ai": {
      "contextWindow": 65000,
      "maxTokens": 32000
    },
    "jad-code": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "jad-go": {
      "contextWindow": 256000,
      "maxTokens": 16384
    }
  },
  "jalapeno": {
    "DeepSeek-V4-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "DeepSeek-V4-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "GLM-5.1": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "GLM-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "Hy3": {
      "contextWindow": 202752,
      "maxTokens": 128000
    },
    "Kimi-K2.5": {
      "contextWindow": 262144,
      "maxTokens": 180224
    },
    "Kimi-K2.7-Code": {
      "contextWindow": 271360,
      "maxTokens": 262144
    },
    "Kimi-K3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "MiniMax-M3": {
      "contextWindow": 524288,
      "maxTokens": 512000
    },
    "Qwen3-Next-80B-A3B-Instruct": {
      "contextWindow": 129024,
      "maxTokens": 32768
    },
    "Qwen3-Next-80B-A3B-Thinking": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Qwen3-VL-235B-A22B-Instruct": {
      "contextWindow": 129024,
      "maxTokens": 32768
    },
    "Qwen3-VL-235B-A22B-Thinking": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "Qwen3.5-122B-A10B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen3.5-27B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen3.5-35B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen3.5-397B-A17B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    }
  },
  "jiekou": {
    "baidu/ernie-4.5-300b-a47b-paddle": {
      "contextWindow": 123000,
      "maxTokens": 12000
    },
    "baidu/ernie-4.5-vl-424b-a47b": {
      "contextWindow": 123000,
      "maxTokens": 16000
    },
    "claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-1-20250805": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-opus-4-20250514": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-opus-4-5-20251101": {
      "contextWindow": 200000,
      "maxTokens": 65536
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-20250514": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-5-20250929": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "deepseek/deepseek-r1-0528": {
      "contextWindow": 163840,
      "maxTokens": 32768
    },
    "deepseek/deepseek-v3-0324": {
      "contextWindow": 163840,
      "maxTokens": 163840
    },
    "deepseek/deepseek-v3.1": {
      "contextWindow": 163840,
      "maxTokens": 32768
    },
    "gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-2.5-flash-lite-preview-06-17": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-2.5-flash-lite-preview-09-2025": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-flash-preview-05-20": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-2.5-pro-preview-06-05": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gpt-5-chat-latest": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 272000
    },
    "gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex-max": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "grok-4-0709": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "grok-4-1-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "grok-4-1-fast-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "grok-4-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "grok-4-fast-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "grok-code-fast-1": {
      "contextWindow": 256000,
      "maxTokens": 10000
    },
    "minimax/minimax-m2.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimaxai/minimax-m1-80k": {
      "contextWindow": 1000000,
      "maxTokens": 40000
    },
    "moonshotai/kimi-k2-0905": {
      "contextWindow": 262144,
      "maxTokens": 100352
    },
    "moonshotai/kimi-k2-instruct": {
      "contextWindow": 131072,
      "maxTokens": 100352
    },
    "moonshotai/kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o3-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "o4-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "qwen/qwen3-235b-a22b-fp8": {
      "contextWindow": 40960,
      "maxTokens": 20000
    },
    "qwen/qwen3-235b-a22b-instruct-2507": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "qwen/qwen3-235b-a22b-thinking-2507": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "qwen/qwen3-30b-a3b-fp8": {
      "contextWindow": 40960,
      "maxTokens": 20000
    },
    "qwen/qwen3-32b-fp8": {
      "contextWindow": 40960,
      "maxTokens": 20000
    },
    "qwen/qwen3-coder-480b-a35b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3-coder-next": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3-next-80b-a3b-instruct": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "qwen/qwen3-next-80b-a3b-thinking": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "xiaomimimo/mimo-v2-flash": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "zai-org/glm-4.5": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "zai-org/glm-4.5v": {
      "contextWindow": 65536,
      "maxTokens": 16384
    },
    "zai-org/glm-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "zai-org/glm-4.7-flash": {
      "contextWindow": 200000,
      "maxTokens": 128000
    }
  },
  "joingonka": {
    "MiniMaxAI/MiniMax-M2.7": {
      "contextWindow": 180000,
      "maxTokens": 8192
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 380000,
      "maxTokens": 32768
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 390000,
      "maxTokens": 8192
    }
  },
  "jzstoken": {
    "claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "keln": {
    "deepseek-ai/deepseek-v4-pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "minimaxai/minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "moonshotai/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "zai-org/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "kenari": {
    "beam-1-0:free": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4-1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gemini-3-1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-8-flash-lite-tts": {
      "contextWindow": 8192,
      "maxTokens": 16384
    },
    "glm-4-6v-flash:free": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "glm-4-7-flash:free": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5-3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5-3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-5-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-2-sol": {
      "contextWindow": 920000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-image-2": {
      "contextWindow": 272000,
      "maxTokens": 16384
    },
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "grok-4-5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4-6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4-7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "hy3": {
      "contextWindow": 196608,
      "maxTokens": 128000
    },
    "hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "hy4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "hy4-flash:free": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "inkling-2-mini-uncensored": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "kimi-k2-6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2-7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3-1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "longcat-2-5:free": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "lyria-3-5": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "minimax-m2-7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m2-7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "minimax-m3-1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "muse-ember-1-0": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "muse-glimmer-30b:free": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "muse-spark-1-2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1-2-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1-3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1-3-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-wonder-1-0": {
      "contextWindow": 1007997,
      "maxTokens": 131072
    },
    "nano-banana-2": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "nano-banana-2-lite": {
      "contextWindow": 65536,
      "maxTokens": 4096
    },
    "nano-banana-pro": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "nemotron-3-super-120b-a12b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nemotron-3-ultra-550b-a55b": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "nemotron-3-ultra-550b-a55b:free": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "particle-1:free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "qwen3-7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen3-8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "solar-mini4:free": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "step-3-7-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "whisper-large-v3-turbo": {
      "contextWindow": 448,
      "maxTokens": 448
    }
  },
  "kimi-code-plan-cn": {
    "k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "k3-256k": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "k3.1-pro-highspeed": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-for-coding": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "kimi-for-coding-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 32768
    }
  },
  "kimi-code-plan-global": {
    "k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "k3-256k": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "k3.1-pro-highspeed": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-for-coding": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "kimi-for-coding-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 32768
    }
  },
  "kitani": {
    "deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash-1017-thinking": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/gemma-4-12b-it": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "meta-llama/llama-3.1-8b-instruct": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "mistralai/ministral-8b-2512": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "mistralai/mistral-nemo-instruct-2407": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "klavo": {
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 128000
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "minimax/minimax-m3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 524288
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "qwen/qwen3.6-35b-a3b": {
      "contextWindow": 208192,
      "maxTokens": 8192
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 1001536,
      "maxTokens": 65536
    },
    "xiaomi/mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "klokintegration": {
    "Kloker": {
      "contextWindow": 200000,
      "maxTokens": 50000
    },
    "Kloker-Integration-Architect": {
      "contextWindow": 200000,
      "maxTokens": 50000
    },
    "Kloker-Integration-Developer": {
      "contextWindow": 200000,
      "maxTokens": 50000
    }
  },
  "korouter": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "kosmik": {
    "qwen/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    }
  },
  "kuae-cloud-coding-plan": {
    "GLM-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    }
  },
  "kunavo": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-5-5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5-6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  },
  "liquid": {
    "deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "liquid.auto": {
      "contextWindow": 10000000,
      "maxTokens": 1048576
    },
    "qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    }
  },
  "lithosai": {
    "deepseek-ai/DeepSeek-V4.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-fast": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-ultra": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    }
  },
  "llmgateway": {
    "auto": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "beam-1.0-501b-a23b": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-5-20251101": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-5-20250929": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "codestral-2508": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "custom": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "deepseek-v3.2": {
      "contextWindow": 163840,
      "maxTokens": 16384
    },
    "deepseek-v4-flash": {
      "contextWindow": 1050000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash-0731": {
      "contextWindow": 1050000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash-vision-exp": {
      "contextWindow": 1050000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1050000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1050000,
      "maxTokens": 1050000
    },
    "deepseek-v4.1-flash-cyber": {
      "contextWindow": 1040000,
      "maxTokens": 1040000
    },
    "deepseek-v4.1-flash-latest": {
      "contextWindow": 1050000,
      "maxTokens": 1050000
    },
    "deepseek-v4.1-flash-uncensored": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "devstral-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "fugu-max": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "fugu-ultra": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "fugu-ultra-v2.0": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-pro-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemma-4-26b-a4b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "glm-4-32b-0414-128k": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "glm-4.5": {
      "contextWindow": 128000,
      "maxTokens": 98304
    },
    "glm-4.5-air": {
      "contextWindow": 128000,
      "maxTokens": 98304
    },
    "glm-4.5-airx": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "glm-4.5-x": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "glm-4.5v": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "glm-4.6": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-4.6v": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "glm-4.6v-flashx": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "glm-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-4.7-flashx": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-5": {
      "contextWindow": 202800,
      "maxTokens": 131072
    },
    "glm-5-turbo": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-5.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.2-fast": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.3-fast": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.3-flashx": {
      "contextWindow": 1048576,
      "maxTokens": 1000000
    },
    "glm-5.3-prime": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "glm-5v-turbo": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "gpt-4.1": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "gpt-4.1-mini": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "gpt-4.1-nano": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-4o-mini-transcribe": {
      "contextWindow": 16000,
      "maxTokens": 16000
    },
    "gpt-4o-transcribe": {
      "contextWindow": 16000,
      "maxTokens": 16000
    },
    "gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 272000
    },
    "gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 1050000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 32766
    },
    "gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 32766
    },
    "granite-4.2-8b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "grok-4": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "grok-4-1-fast-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "grok-4-20-beta-0309-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "grok-4-20-beta-0309-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "grok-4-20-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "grok-4-20-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "grok-4-3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "grok-4-5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4-6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4-7": {
      "contextWindow": 524288,
      "maxTokens": 500000
    },
    "grok-build-0-1": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "hy-mt2-plus": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "hy3": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "hy4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "inkling-2-mini": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "kimi-k2": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.8-preview": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3-fast": {
      "contextWindow": 1040384,
      "maxTokens": 1040384
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro-highspeed": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro-prime": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "ling-3.0-flash": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "ling-3.0-flash-vl": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "ling-3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "llama-3.1-70b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 2048
    },
    "llama-3.2-11b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "llama-3.3-70b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "llama-4-maverick-17b-instruct": {
      "contextWindow": 1048576,
      "maxTokens": 2048
    },
    "llama-4-scout-17b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 2048
    },
    "mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro-ultraspeed": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "minimax-m2": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "minimax-m2.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m2.1-lightning": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "minimax-m2.5": {
      "contextWindow": 228700,
      "maxTokens": 131072
    },
    "minimax-m2.5-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m2.7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "minimax-text-01": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "ministral-14b-2512": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "ministral-3b-2512": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "ministral-8b-2512": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "mistral-large-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral-large-4": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "mistral-large-latest": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "mistral-medium-3-5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral-small-2506": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "mistral-small-2603": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "muse-ember-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "muse-glimmer-30b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "muse-spark-1.1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.2-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "muse-spark-1.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.3-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-wonder-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "nemotron-3-ultra-550b": {
      "contextWindow": 1048576,
      "maxTokens": 128000
    },
    "o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "pixtral-large-2502": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "qwen-flash": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "qwen-max": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "qwen-plus": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen-plus-latest": {
      "contextWindow": 1000000,
      "maxTokens": 8192
    },
    "qwen3-14b": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "qwen3-30b-a3b": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "qwen3-32b": {
      "contextWindow": 40960,
      "maxTokens": 16384
    },
    "qwen3-coder-flash": {
      "contextWindow": 997952,
      "maxTokens": 65536
    },
    "qwen3-vl-235b-a22b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "qwen3-vl-30b-a3b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "qwen3-vl-plus": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3.5-122b-a10b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-9b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6-27b": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6-flash": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "qwen3.6-plus": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "qwen3.7-flash": {
      "contextWindow": 983616,
      "maxTokens": 983616
    },
    "qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.7-plus": {
      "contextWindow": 983616,
      "maxTokens": 64000
    },
    "qwen3.8-2.4t-a95b": {
      "contextWindow": 1010000,
      "maxTokens": 131072
    },
    "qwen3.8-27b": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "qwen3.8-omni-flash": {
      "contextWindow": 983616,
      "maxTokens": 131072
    },
    "qwen35-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "reka-edge-2603": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "sakana-namazu": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "seed-2-0-code-preview-260328": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "seed-2-0-lite-260428": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "seed-2-0-mini-260428": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "seed-2-0-pro-260328": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "sonar": {
      "contextWindow": 130000,
      "maxTokens": 4096
    },
    "step-3.7-flash": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    }
  },
  "llmgateway-providers": {
    "alibaba/deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "alibaba/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "alibaba/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "alibaba/deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "alibaba/deepseek-v4.1-flash-latest": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "alibaba/glm-5": {
      "contextWindow": 202752,
      "maxTokens": 16384
    },
    "alibaba/glm-5.1": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "alibaba/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "alibaba/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "alibaba/glm-5.3-prime": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "alibaba/kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 98304
    },
    "alibaba/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "alibaba/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "alibaba/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "alibaba/kimi-k3.1-pro-prime": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "alibaba/qwen-flash": {
      "contextWindow": 1000000,
      "maxTokens": 32000
    },
    "alibaba/qwen-max": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "alibaba/qwen-plus": {
      "contextWindow": 131072,
      "maxTokens": 32000
    },
    "alibaba/qwen-plus-latest": {
      "contextWindow": 1000000,
      "maxTokens": 32000
    },
    "alibaba/qwen3-coder-flash": {
      "contextWindow": 997952,
      "maxTokens": 65536
    },
    "alibaba/qwen3-vl-plus": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "alibaba/qwen3.5-122b-a10b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "alibaba/qwen3.5-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "alibaba/qwen3.5-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "alibaba/qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "alibaba/qwen3.6-flash": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "alibaba/qwen3.6-plus": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "alibaba/qwen3.7-flash": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "alibaba/qwen3.7-max": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "alibaba/qwen3.7-plus": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "alibaba/qwen3.8-2.4t-a95b": {
      "contextWindow": 983616,
      "maxTokens": 131072
    },
    "alibaba/qwen3.8-27b": {
      "contextWindow": 983616,
      "maxTokens": 131072
    },
    "alibaba/qwen3.8-flash": {
      "contextWindow": 983616,
      "maxTokens": 131072
    },
    "alibaba/qwen3.8-max": {
      "contextWindow": 983616,
      "maxTokens": 131072
    },
    "alibaba/qwen3.8-omni-flash": {
      "contextWindow": 983616,
      "maxTokens": 131072
    },
    "alibaba/qwen35-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "alibaba/qwen4-max": {
      "contextWindow": 983616,
      "maxTokens": 131072
    },
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-5-20251101": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "anthropic/claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4-5-20250929": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "aws-bedrock/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "aws-bedrock/claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "aws-bedrock/claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "aws-bedrock/claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "aws-bedrock/claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "aws-bedrock/claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "aws-bedrock/claude-opus-4-5-20251101": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "aws-bedrock/claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "aws-bedrock/claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "aws-bedrock/claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "aws-bedrock/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "aws-bedrock/claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "aws-bedrock/claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "aws-bedrock/claude-sonnet-4-5-20250929": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "aws-bedrock/claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "aws-bedrock/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "aws-bedrock/claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "aws-bedrock/grok-4-3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "aws-bedrock/grok-4-6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "aws-bedrock/grok-4-7": {
      "contextWindow": 524288,
      "maxTokens": 524288
    },
    "aws-bedrock/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "aws-bedrock/llama-3.1-70b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 2048
    },
    "aws-bedrock/llama-4-maverick-17b-instruct": {
      "contextWindow": 8192,
      "maxTokens": 2048
    },
    "aws-bedrock/llama-4-scout-17b-instruct": {
      "contextWindow": 8192,
      "maxTokens": 2048
    },
    "aws-bedrock/pixtral-large-2502": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "aws-mantle/gpt-5.6-luna": {
      "contextWindow": 921600,
      "maxTokens": 128000
    },
    "aws-mantle/gpt-5.6-sol": {
      "contextWindow": 921600,
      "maxTokens": 128000
    },
    "aws-mantle/gpt-5.6-terra": {
      "contextWindow": 921600,
      "maxTokens": 128000
    },
    "aws-mantle/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "aws-mantle/gpt-6-luna": {
      "contextWindow": 921600,
      "maxTokens": 128000
    },
    "aws-mantle/gpt-6-sol": {
      "contextWindow": 921600,
      "maxTokens": 128000
    },
    "aws-mantle/gpt-6.1-sol": {
      "contextWindow": 921600,
      "maxTokens": 128000
    },
    "aws-mantle/gpt-6.1-terra": {
      "contextWindow": 921600,
      "maxTokens": 128000
    },
    "azure-anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "azure-anthropic/claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "azure-anthropic/claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "azure-anthropic/claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "azure-anthropic/claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "azure-anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "azure-anthropic/claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "azure-anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "azure-anthropic/claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "azure/gpt-4.1": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "azure/gpt-4.1-mini": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "azure/gpt-4.1-nano": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "azure/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "azure/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "azure/gpt-4o-mini-transcribe": {
      "contextWindow": 16000,
      "maxTokens": 2000
    },
    "azure/gpt-4o-transcribe": {
      "contextWindow": 16000,
      "maxTokens": 2000
    },
    "azure/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "azure/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "azure/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "azure/gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "azure/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "azure/gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 272000
    },
    "azure/gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "azure/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "azure/gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "azure/gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "azure/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "azure/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "azure/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "azure/gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "azure/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "azure/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "azure/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "azure/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "azure/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "azure/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "azure/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "azure/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "azure/gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "azure/gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "azure/gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "azure/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "azure/grok-4-1-fast-reasoning": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "azure/grok-4-3": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "baidu/deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "baidu/deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "baidu/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "baidu/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "baidu/deepseek-v4.1-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "baidu/glm-5.1": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "baidu/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "baidu/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "baidu/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "baidu/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "bytedance/deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "bytedance/deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "bytedance/glm-5.2": {
      "contextWindow": 1024000,
      "maxTokens": 128000
    },
    "bytedance/seed-2-0-code-preview-260328": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "bytedance/seed-2-0-lite-260428": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "bytedance/seed-2-0-mini-260428": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "bytedance/seed-2-0-pro-260328": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "canopywave/deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "canopywave/deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "canopywave/deepseek-v4.1-flash-latest": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "canopywave/glm-5.2": {
      "contextWindow": 200000,
      "maxTokens": 32768
    },
    "canopywave/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "canopywave/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "canopywave/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "canopywave/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "canopywave/kimi-k3.1-pro": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "canopywave/minimax-m3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "canopywave/qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "cerebras/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "cloudflare/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "cloudflare/deepseek-v4.1-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "cloudflare/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "consensusprotocol/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "consensusprotocol/deepseek-v4.1-flash-uncensored": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "consensusprotocol/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "consensusprotocol/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "consensusprotocol/gpt-oss-20b": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "consensusprotocol/qwen3.8-27b": {
      "contextWindow": 262000,
      "maxTokens": 32768
    },
    "deepinfra/deepseek-v3.2": {
      "contextWindow": 160000,
      "maxTokens": 65536
    },
    "deepinfra/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "deepinfra/deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "deepinfra/deepseek-v4-flash-vision-exp": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "deepinfra/deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    },
    "deepinfra/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepinfra/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepinfra/deepseek-v4.1-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepinfra/gemma-4-26b-a4b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "deepinfra/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "deepinfra/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "deepinfra/granite-4.2-8b": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "deepinfra/hy4": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepinfra/hy4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "deepinfra/hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "deepinfra/inkling-2-mini": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepinfra/ling-3.0-flash": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "deepinfra/ling-3.0-flash-vl": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "deepinfra/mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepinfra/mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepinfra/minimax-m3": {
      "contextWindow": 524288,
      "maxTokens": 524288
    },
    "deepinfra/muse-glimmer-30b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "deepinfra/nemotron-3-ultra-550b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "deepinfra/qwen3-vl-235b-a22b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "deepinfra/qwen3-vl-30b-a3b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "deepinfra/qwen3.5-9b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1050000,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4.1-flash-latest": {
      "contextWindow": 1050000,
      "maxTokens": 393216
    },
    "entrim/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "entrim/deepseek-v4.1-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "entrim/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "entrim/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "fireworks/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "fireworks/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "fireworks/deepseek-v4.1-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "fireworks/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "fireworks/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "fireworks/kimi-k3": {
      "contextWindow": 1040384,
      "maxTokens": 1040384
    },
    "fireworks/kimi-k3-fast": {
      "contextWindow": 1040384,
      "maxTokens": 1040384
    },
    "fireworks/kimi-k3.1-pro": {
      "contextWindow": 1040384,
      "maxTokens": 1040384
    },
    "fireworks/minimax-m3.1-flash": {
      "contextWindow": 1040384,
      "maxTokens": 1040384
    },
    "fireworks/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "fireworks/qwen3.8-2.4t-a95b": {
      "contextWindow": 1009981,
      "maxTokens": 1009981
    },
    "flexai/deepseek-v4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "flexai/deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "flexai/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "flexai/deepseek-v4.1-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "flexai/gemma-4-26b-a4b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "flexai/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "flexai/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "flexai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "flexai/mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "flexai/minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "google-ai-studio/gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "google-ai-studio/gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-ai-studio/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-ai-studio/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-ai-studio/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-ai-studio/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-ai-studio/gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "google-ai-studio/gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "google-ai-studio/gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-ai-studio/gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-ai-studio/gemini-pro-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-vertex/gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "google-vertex/gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-vertex/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-vertex/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-vertex/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-vertex/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-vertex/gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-vertex/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-vertex/gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "google-vertex/gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "google-vertex/gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google-vertex/gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "greenference/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "greenference/qwen3-14b": {
      "contextWindow": 16384,
      "maxTokens": 8192
    },
    "greenference/qwen3-30b-a3b": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "greenference/qwen3.6-27b": {
      "contextWindow": 16384,
      "maxTokens": 8192
    },
    "groq/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 32766
    },
    "groq/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 32766
    },
    "inference.net/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "inference.net/deepseek-v4.1-flash": {
      "contextWindow": 1040000,
      "maxTokens": 393216
    },
    "inference.net/deepseek-v4.1-flash-1017": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "inference.net/deepseek-v4.1-flash-cyber": {
      "contextWindow": 1040000,
      "maxTokens": 393216
    },
    "inference.net/deepseek-v4.1-flash-latest": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "inference.net/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "inference.net/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 128000
    },
    "inference.net/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "inference.net/llama-3.2-11b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "inference.net/minimax-m3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 524288
    },
    "luminal/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "meta-contributor/muse-spark-1.2-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta-contributor/muse-spark-1.3-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "meta/muse-ember-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "meta/muse-spark-1.1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "meta/muse-wonder-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "minimax/minimax-m2": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.1": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.1-lightning": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.5": {
      "contextWindow": 204800,
      "maxTokens": 131100
    },
    "minimax/minimax-m2.5-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131100
    },
    "minimax/minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 131100
    },
    "minimax/minimax-m2.7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131100
    },
    "minimax/minimax-m3": {
      "contextWindow": 512000,
      "maxTokens": 131072
    },
    "minimax/minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "minimax/minimax-text-01": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "mistral/codestral-2508": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "mistral/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mistral/deepseek-v4.1-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mistral/devstral-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mistral/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mistral/ministral-14b-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/ministral-3b-2512": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "mistral/ministral-8b-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/mistral-large-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/mistral-large-4": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "mistral/mistral-large-latest": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "mistral/mistral-medium-3-5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/mistral-small-2506": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "mistral/mistral-small-2603": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "moonshot/kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "moonshot/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshot/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshot/kimi-k2.7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshot/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshot/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshot/kimi-k3.1-pro-highspeed": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nebius/minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "novita/deepseek-v4-flash-0731": {
      "contextWindow": 1050000,
      "maxTokens": 393216
    },
    "novita/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "novita/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "novita/deepseek-v4.1-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "novita/gemma-4-26b-a4b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "novita/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "novita/glm-4.5v": {
      "contextWindow": 65536,
      "maxTokens": 16000
    },
    "novita/glm-4.6": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "novita/glm-4.6v": {
      "contextWindow": 131072,
      "maxTokens": 16000
    },
    "novita/glm-4.7": {
      "contextWindow": 204800,
      "maxTokens": 128000
    },
    "novita/glm-5": {
      "contextWindow": 202800,
      "maxTokens": 131072
    },
    "novita/glm-5.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "novita/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "novita/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "novita/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "novita/hy3": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "novita/hy4-preview": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "novita/kimi-k2": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "novita/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "novita/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "novita/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "novita/ling-3.0-flash": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "novita/ling-3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "novita/llama-3.3-70b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 120000
    },
    "novita/llama-4-maverick-17b-instruct": {
      "contextWindow": 1048576,
      "maxTokens": 8192
    },
    "novita/llama-4-scout-17b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "novita/minimax-m2.5": {
      "contextWindow": 204800,
      "maxTokens": 131100
    },
    "novita/minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 131100
    },
    "novita/minimax-m3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "novita/minimax-m3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 524288
    },
    "novita/qwen3-vl-30b-a3b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "novita/qwen3.5-122b-a10b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "novita/qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 64000
    },
    "novita/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "novita/qwen3.8-2.4t-a95b": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "novita/qwen3.8-27b": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "novita/qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "novita/qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "novita/qwen35-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 64000
    },
    "novita/step-3.7-flash": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "openai/gpt-4.1": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "openai/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini-transcribe": {
      "contextWindow": 16000,
      "maxTokens": 2000
    },
    "openai/gpt-4o-transcribe": {
      "contextWindow": 16000,
      "maxTokens": 2000
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 272000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-pro": {
      "contextWindow": 400000,
      "maxTokens": 272000
    },
    "openai/gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "perplexity/sonar": {
      "contextWindow": 130000,
      "maxTokens": 4096
    },
    "quartz/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "reka-ai/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "reka-ai/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "reka-ai/deepseek-v4.1-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "reka-ai/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "reka-ai/reka-edge-2603": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "runpod/glm-5.3": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "runpod/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "runpod/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "runpod/kimi-k3.1-pro-highspeed": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "runware/deepseek-v4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "runware/deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "runware/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "runware/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "runware/deepseek-v4.1-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "runware/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "runware/glm-5.2": {
      "contextWindow": 1024000,
      "maxTokens": 128000
    },
    "runware/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "runware/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "runware/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "runware/kimi-k3.1-pro": {
      "contextWindow": 950000,
      "maxTokens": 950000
    },
    "sakana/fugu-max": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "sakana/fugu-ultra": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "sakana/fugu-ultra-v2.0": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "sakana/sakana-namazu": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "sciforium/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "sciforium/deepseek-v4.1-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "scx-ai-gp/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "scx-ai-gp/deepseek-v4.1-flash-1017": {
      "contextWindow": 1050000,
      "maxTokens": 384000
    },
    "scx-ai-gp/deepseek-v4.1-flash-latest": {
      "contextWindow": 1050000,
      "maxTokens": 1050000
    },
    "scx-ai-gp/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "scx-ai-gp/glm-5.2-fast": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "scx-ai-gp/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "scx-ai-gp/glm-5.3-fast": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "scx-ai-gp/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "scx-ai-gp/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "scx-ai-gp/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "scx-ai-gp/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "scx-ai-gp/kimi-k3.1-pro-highspeed": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "scx-ai-gp/qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "scx-ai-gp/qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "scx-ai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "scx-ai/minimax-m2.7": {
      "contextWindow": 196608,
      "maxTokens": 196608
    },
    "scx-ai/qwen3-32b": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "tencent/deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "tencent/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "tencent/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "tencent/deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "tencent/deepseek-v4.1-flash-latest": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "tencent/glm-5": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "tencent/glm-5-turbo": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "tencent/glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "tencent/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "tencent/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "tencent/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "tencent/glm-5.3-flashx": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "tencent/glm-5v-turbo": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "tencent/hy-mt2-plus": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "tencent/hy3": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "tencent/hy4": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "tencent/hy4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "tencent/hy4-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "tencent/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "tencent/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "tencent/kimi-k2.7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "tencent/kimi-k2.8-preview": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "tencent/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "tencent/mimo-v2.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "tencent/mimo-v2.6-pro": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "tencent/minimax-m2.7": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "tencent/minimax-m3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "tencent/step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "together-ai/beam-1.0-501b-a23b": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "together-ai/deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 163840
    },
    "together-ai/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "together-ai/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "together-ai/deepseek-v4.1-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "together-ai/glm-4.7": {
      "contextWindow": 202752,
      "maxTokens": 128000
    },
    "together-ai/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 943717
    },
    "together-ai/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 943717
    },
    "together-ai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "together-ai/hy4": {
      "contextWindow": 1048576,
      "maxTokens": 1000000
    },
    "together-ai/kimi-k3": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "together-ai/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "together-ai/minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "together-ai/muse-glimmer-30b": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "together-ai/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "vertex-anthropic/claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "vertex-anthropic/claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "vertex-anthropic/claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "vertex-anthropic/claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "vertex-anthropic/claude-opus-4-5-20251101": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "vertex-anthropic/claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "vertex-anthropic/claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "vertex-anthropic/claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "vertex-anthropic/claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "vertex-anthropic/claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "vertex-anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "vertex-anthropic/claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "vertex-openai/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "vertex-openai/deepseek-v4.1-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "vertex-openai/grok-4-20-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "vertex-openai/grok-4-20-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "vertex-openai/grok-4-6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "vertex-openai/grok-4-7": {
      "contextWindow": 524288,
      "maxTokens": 524288
    },
    "xai/grok-4": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "xai/grok-4-20-beta-0309-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "xai/grok-4-20-beta-0309-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "xai/grok-4-3": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "xai/grok-4-5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-4-6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-4-7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-build-0-1": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "xiaomi/mimo-v2.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-pro": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-pro-ultraspeed": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai/glm-4-32b-0414-128k": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "zai/glm-4.5": {
      "contextWindow": 128000,
      "maxTokens": 98304
    },
    "zai/glm-4.5-air": {
      "contextWindow": 128000,
      "maxTokens": 98304
    },
    "zai/glm-4.5-airx": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "zai/glm-4.5-x": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "zai/glm-4.5v": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "zai/glm-4.6": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "zai/glm-4.6v": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "zai/glm-4.6v-flashx": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "zai/glm-4.7": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "zai/glm-4.7-flashx": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "zai/glm-5": {
      "contextWindow": 202800,
      "maxTokens": 131100
    },
    "zai/glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "zai/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "zai/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "zai/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai/glm-5.3-flashx": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "llmtech": {
    "nvidia/Qwen3.8-27B-NVFP4": {
      "contextWindow": 262144,
      "maxTokens": 32768
    }
  },
  "llmtr": {
    "gemma-4": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "google/gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "magibu-11b-v8": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "medgemma-4b": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "meta/muse-spark-1.2-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo/mimo-v2.5": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "mimo/mimo-v2.5-pro": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "mistral/voxtral-small-latest": {
      "contextWindow": 32000,
      "maxTokens": 32000
    },
    "muse-glimmer-30b-tr": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "perplexity/sonar-deep-research": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "poolside/laguna-xs-2.1": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "publicai/apertus-70b-instruct": {
      "contextWindow": 65536,
      "maxTokens": 8192
    },
    "publicai/apertus-8b-instruct": {
      "contextWindow": 65536,
      "maxTokens": 8192
    },
    "qwen/qwen-flash": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "qwen/qwen-plus": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "qwen/qwen3-coder-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3-coder-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3-max": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "qwen/qwen3-vl-plus": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "qwen/qwen3.5-397b-a17b": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen3-6-35b": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "sakana/fugu-ultra": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "thinkingmachines/inkling": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "thinkingmachines/inkling-small": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "trendyol-asure-12b": {
      "contextWindow": 40960,
      "maxTokens": 40960
    },
    "upstage/solar-pro2": {
      "contextWindow": 65536,
      "maxTokens": 8192
    },
    "upstage/solar-pro3": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "upstage/solar-pro4": {
      "contextWindow": 524288,
      "maxTokens": 131072
    }
  },
  "lmstudio": {
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "qwen/qwen3-30b-a3b-2507": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "qwen/qwen3-coder-30b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    }
  },
  "logits": {
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "moonshotai/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "longcat": {
    "LongCat-2.0": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "LongCat-2.5": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    }
  },
  "lowrouter": {
    "auto/anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "auto/anthropic/claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "auto/anthropic/claude-haiku-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "auto/anthropic/claude-haiku-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "auto/anthropic/claude-opus-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "auto/anthropic/claude-opus-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "auto/anthropic/claude-opus-4.7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "auto/anthropic/claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "auto/anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "auto/anthropic/claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "auto/anthropic/claude-sonnet-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "auto/anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "auto/anthropic/claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "auto/mistralai/codestral-2508": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "auto/mistralai/ministral-14b-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "auto/mistralai/ministral-3b-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "auto/mistralai/ministral-8b-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "auto/mistralai/mistral-large-2512": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "auto/mistralai/mistral-large-4": {
      "contextWindow": 524288,
      "maxTokens": 262144
    },
    "auto/mistralai/mistral-medium-3.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "auto/mistralai/mistral-small-2603": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "auto/openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "auto/openai/gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "auto/openai/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "auto/openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "auto/openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "auto/openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "auto/openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "auto/openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "auto/openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "auto/openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "auto/openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "auto/openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "auto/openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "auto/openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "auto/openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "auto/openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "auto/openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "auto/openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "auto/openai/gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "auto/openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "auto/openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "auto/openai/gpt-oss-safeguard-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "auto/openai/gpt-oss-safeguard-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "auto/openai/o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    }
  },
  "lucidquery": {
    "lucidnova-rf1-100b": {
      "contextWindow": 120000,
      "maxTokens": 8000
    },
    "lucidquery-agi-01-frontier": {
      "contextWindow": 300000,
      "maxTokens": 120000
    },
    "lucidquery-agi-01-swift": {
      "contextWindow": 300000,
      "maxTokens": 120000
    },
    "lucidquery-nexus-coder": {
      "contextWindow": 250000,
      "maxTokens": 60000
    }
  },
  "lyceum": {
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "moonshotai/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "moonshotai/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-2.4t-a95b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    }
  },
  "lynkr": {
    "lynkr-auto": {
      "contextWindow": 128000,
      "maxTokens": 8192
    }
  },
  "mallard": {
    "qwen/qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 235929
    }
  },
  "meganova": {
    "MiniMaxAI/MiniMax-M2.1": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "MiniMaxAI/MiniMax-M2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "Qwen/Qwen2.5-VL-32B-Instruct": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3.5-Plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "XiaomiMiMo/MiMo-V2-Flash": {
      "contextWindow": 262144,
      "maxTokens": 32000
    },
    "deepseek-ai/DeepSeek-R1-0528": {
      "contextWindow": 163840,
      "maxTokens": 64000
    },
    "deepseek-ai/DeepSeek-V3-0324": {
      "contextWindow": 163840,
      "maxTokens": 163840
    },
    "deepseek-ai/DeepSeek-V3.1": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "deepseek-ai/DeepSeek-V3.2": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "deepseek-ai/DeepSeek-V3.2-Exp": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "meta-llama/Llama-3.3-70B-Instruct": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "mistralai/Mistral-Nemo-Instruct-2407": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "mistralai/Mistral-Small-3.2-24B-Instruct-2506": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "moonshotai/Kimi-K2-Thinking": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/Kimi-K2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "zai-org/GLM-4.6": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai-org/GLM-4.7": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai-org/GLM-5": {
      "contextWindow": 202752,
      "maxTokens": 131072
    }
  },
  "melious": {
    "deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k2.6": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    }
  },
  "meragpt": {
    "restyler-1": {
      "contextWindow": 4096,
      "maxTokens": 2048
    }
  },
  "merge-gateway": {
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-1-20250805": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "anthropic/claude-opus-4-5-20251101": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4-5-20250929": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "bytedance/dola-seed-2.0-code": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "bytedance/dola-seed-2.0-code-preview": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "bytedance/dola-seed-2.0-lite": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "bytedance/dola-seed-2.0-mini": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "bytedance/dola-seed-2.0-pro": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "cohere/command-a-03-2025": {
      "contextWindow": 256000,
      "maxTokens": 8000
    },
    "cohere/command-r-08-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "cohere/command-r-plus-08-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "cohere/command-r7b-12-2024": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "deepseek/deepseek-r1": {
      "contextWindow": 163840,
      "maxTokens": 40960
    },
    "deepseek/deepseek-r1-0528": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "deepseek/deepseek-v3": {
      "contextWindow": 163840,
      "maxTokens": 81920
    },
    "deepseek/deepseek-v3.1": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "deepseek/deepseek-v3.2": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-0423": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-0731-fast": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro-0423": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/gemini-2.5-computer-use-preview-10-2025": {
      "contextWindow": 128000,
      "maxTokens": 64000
    },
    "google/gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-2.5-flash-image": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "google/gemini-2.5-flash-lite": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3-pro-image": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "google/gemini-3.1-flash-image": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "google/gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview-customtools": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-embedding-001": {
      "contextWindow": 2048,
      "maxTokens": 4096
    },
    "google/gemini-embedding-2": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "google/gemini-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-flash-lite-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemma-3-12b-it": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "google/gemma-3-27b-it": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "google/gemma-3-4b-it": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "google/gemma-4-26b-a4b-it": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "meta/llama-3.1-70b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 2048
    },
    "meta/llama-3.1-8b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 2048
    },
    "meta/llama-3.3-70b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "meta/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax/minimax-m2": {
      "contextWindow": 204800,
      "maxTokens": 8192
    },
    "minimax/minimax-m2.1": {
      "contextWindow": 204800,
      "maxTokens": 8192
    },
    "minimax/minimax-m2.5": {
      "contextWindow": 204800,
      "maxTokens": 8192
    },
    "minimax/minimax-m2.5-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 8192
    },
    "minimax/minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 8192
    },
    "minimax/minimax-m2.7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 8192
    },
    "minimax/minimax-m3": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "minimax/minimax-m3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "mistral/codestral-latest": {
      "contextWindow": 256000,
      "maxTokens": 4096
    },
    "mistral/devstral-2512": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "mistral/devstral-medium-latest": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/magistral-medium-latest": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "mistral/mistral-large-2512": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "mistral/mistral-large-latest": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/mistral-medium-2505": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "mistral/mistral-medium-latest": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral/mistral-small-latest": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "mistral/pixtral-large-latest": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "moonshot/kimi-k2.5": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "moonshot/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshot/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "moonshot/kimi-k2.7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "moonshot/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshot/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nvidia/nemotron-3-nano-30b-a3b": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "nvidia/nemotron-3.5-lightning-30b-a3b": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "nvidia/nemotron-nano-9b-v2": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "openai/gpt-3.5-turbo": {
      "contextWindow": 16385,
      "maxTokens": 4096
    },
    "openai/gpt-4": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "openai/gpt-4-turbo": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-2024-05-13": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "openai/gpt-4o-2024-08-06": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-2024-11-20": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-chat-latest": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-search-api": {
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-chat-latest": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-chat-latest": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5.3-chat-latest": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-audio": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-audio-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "openai/gpt-oss-safeguard-120b": {
      "contextWindow": 4096,
      "maxTokens": 4096
    },
    "openai/gpt-oss-safeguard-20b": {
      "contextWindow": 4096,
      "maxTokens": 4096
    },
    "openai/o1": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o4-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/whisper-1": {
      "contextWindow": 448000,
      "maxTokens": 4096
    },
    "qwen/qwen-flash": {
      "contextWindow": 1000000,
      "maxTokens": 250000
    },
    "qwen/qwen-plus": {
      "contextWindow": 1000000,
      "maxTokens": 250000
    },
    "qwen/qwen3-235b-a22b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3-235b-a22b-instruct-2507": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3-30b-a3b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3-32b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3-coder-480b-a35b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3-coder-flash": {
      "contextWindow": 1000000,
      "maxTokens": 250000
    },
    "qwen/qwen3-coder-next": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3-coder-plus": {
      "contextWindow": 1000000,
      "maxTokens": 250000
    },
    "qwen/qwen3-max": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3-max-preview": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "qwen/qwen3-next-80b-a3b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3-next-80b-a3b-thinking": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3-vl-235b-a22b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3-vl-235b-a22b-thinking": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3-vl-30b-a3b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3-vl-flash": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3-vl-plus": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-122b-a10b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3.5-27b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3.5-35b-a3b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3.5-397b-a17b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3.5-4b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3.5-9b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 250000
    },
    "qwen/qwen3.5-plus": {
      "contextWindow": 1000000,
      "maxTokens": 250000
    },
    "qwen/qwen3.6-27b": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "qwen/qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 250000
    },
    "qwen/qwen3.6-max-preview": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 250000
    },
    "qwen/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 250000
    },
    "qwen/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-2.4t-a95b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-flash": {
      "contextWindow": 977000,
      "maxTokens": 128000
    },
    "qwen/qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "sakana/fugu-max": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "sakana/fugu-ultra": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "sakana/sakana-namazu": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "thinkingmachines/inkling": {
      "contextWindow": 1048000,
      "maxTokens": 32000
    },
    "writer/palmyra-x4": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "writer/palmyra-x5": {
      "contextWindow": 1000000,
      "maxTokens": 250000
    },
    "xai/grok-4.20-0309-non-reasoning": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "xai/grok-4.20-0309-reasoning": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "xai/grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "xai/grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-build-0.1": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "zai/glm-4.5": {
      "contextWindow": 128000,
      "maxTokens": 98304
    },
    "zai/glm-4.5-air": {
      "contextWindow": 128000,
      "maxTokens": 98304
    },
    "zai/glm-4.5v": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "zai/glm-4.6": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "zai/glm-4.7": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "zai/glm-4.7-flash": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "zai/glm-4.7-flashx": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "zai/glm-5": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "zai/glm-5-turbo": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "zai/glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "zai/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "meta": {
    "muse-ember-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "muse-spark-1.1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.2-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.3-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-wonder-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "minimax-cn": {
    "MiniMax-M2": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.5-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M3": {
      "contextWindow": 1000000,
      "maxTokens": 524288
    },
    "MiniMax-M3.1-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 524288
    }
  },
  "minimax-cn-coding-plan": {
    "MiniMax-M2": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.5-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M3": {
      "contextWindow": 1000000,
      "maxTokens": 524288
    },
    "MiniMax-M3.1-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 524288
    },
    "MiniMax-M3.1-Flash-Preview": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    }
  },
  "minimax-coding-plan": {
    "MiniMax-M2": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.5-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M3": {
      "contextWindow": 1000000,
      "maxTokens": 524288
    },
    "MiniMax-M3.1-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 524288
    },
    "MiniMax-M3.1-Flash-Preview": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    }
  },
  "mixlayer": {
    "qwen/qwen3.5-122b-a10b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen/qwen3.5-27b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen/qwen3.5-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen/qwen3.5-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen/qwen3.5-9b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    }
  },
  "moark": {
    "DeepSeek-V4-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "DeepSeek-V4-Pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "GLM-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "GLM-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Kimi-K2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "MiniMax-M2.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "Qwen3.6-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "modal": {
    "Qwen/Qwen3.8-2.4T-A95B": {
      "contextWindow": 1010000,
      "maxTokens": 131072
    },
    "Qwen/Qwen3.8-Max-VL-Thinking": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "meta-models/Muse-Spark-Open-816B-A42B": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "moonshotai/Kimi-K3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/Kimi-K3.1-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nvidia/GLM-5.3-Flash-NVFP4": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "thinkingmachines/Inkling-NVFP4": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "model-oracle-ai": {
    "auto": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "o4-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    }
  },
  "modelis": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    }
  },
  "modelscope": {
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "Qwen/Qwen3-235B-A22B-Thinking-2507": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "Qwen/Qwen3-30B-A3B-Instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "Qwen/Qwen3-30B-A3B-Thinking-2507": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Qwen/Qwen3-Coder-30B-A3B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "ZhipuAI/GLM-4.5": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "ZhipuAI/GLM-4.6": {
      "contextWindow": 202752,
      "maxTokens": 98304
    }
  },
  "modular": {
    "MiniMaxAI/MiniMax-M3.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "minimax/minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    }
  },
  "moneo": {
    "Claude Haiku 5.5": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "MiniMax-M2.7:web": {
      "contextWindow": 198000,
      "maxTokens": 131072
    },
    "deepseek-v4-1-flash-1017-uncensored": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash:web": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gemma-4-31b:web": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "gpt-5-6-luna": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "gpt-oss-120b": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "kimi-k2.7-code:web": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "nvidia-nemotron-3-5-super-vl-120b-a12b": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "qwen3-235b:web": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "qwen3-coder-480b-a35b-instruct": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "z-ai-glm-5-3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "moonshotai": {
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro-highspeed": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "moonshotai-cn": {
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro-highspeed": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "morph": {
    "auto": {
      "contextWindow": 32000,
      "maxTokens": 32000
    },
    "morph-dsv41flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "morph-dsv41flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "morph-dsv4flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "morph-glm52-744b": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "morph-glm53-744b": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "morph-glm53flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "morph-kimik3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "morph-kimik3-fast": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "morph-kimik31": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "morph-v3-fast": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "morph-v3-large": {
      "contextWindow": 262144,
      "maxTokens": 131072
    }
  },
  "munito": {
    "aleph-alpha/kolibri-1": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "deepseek-ai/deepseek-v4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "deepseek-ai/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "zai-org/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    }
  },
  "munito-eu": {
    "aleph-alpha/kolibri-1": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "deepseek-ai/deepseek-v4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "zai-org/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    }
  },
  "nan": {
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gemma4": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "glm5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "qwen3.6": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "nano-gpt": {
    "Doctor-Shotgun/MS3.2-24B-Magnum-Diamond": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "EVA-UNIT-01/EVA-LLaMA-3.33-70B-v0.0": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "EVA-UNIT-01/EVA-LLaMA-3.33-70B-v0.1": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "EVA-UNIT-01/EVA-Qwen2.5-32B-v0.2": {
      "contextWindow": 16384,
      "maxTokens": 8192
    },
    "EVA-UNIT-01/EVA-Qwen2.5-72B-v0.2": {
      "contextWindow": 16384,
      "maxTokens": 8192
    },
    "GLM-4.6-Derestricted-v5": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "Gemma-4-26B-A4B-MeroMero": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Gemma-4-26B-A4B-MeroMero:thinking": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Gemma-4-31B-Agares-v1": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Gemma-4-31B-Animus-V14.1": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Gemma-4-31B-AssGuard": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Gemma-4-31B-Claude-4.6-Opus-Reasoning-Distilled": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "Gemma-4-31B-Cognitive-Unshackled": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "Gemma-4-31B-Dark-Gemistry": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Gemma-4-31B-DarkIdol": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "Gemma-4-31B-Fabled": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Gemma-4-31B-GarnetV2": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "Gemma-4-31B-Gembrain-X-Core": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Gemma-4-31B-Gembrain-uncensored-heretic": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Gemma-4-31B-Isometry-RP": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Gemma-4-31B-K1-v5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Gemma-4-31B-MeroMero": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Gemma-4-31B-MeroMero-v2": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Gemma-4-31B-MeroMero-v2:thinking": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Gemma-4-31B-Novelist": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Gemma-4-31B-Queen": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "Gemma-4-31B-SDFT-Heretic-RP": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Gemma-4-31B-StyleTune": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Gryphe/MythoMax-L2-13b": {
      "contextWindow": 4096,
      "maxTokens": 3686
    },
    "LatitudeGames/Wayfarer-Large-70B-Llama-3.3": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "Meta-Llama-3-1-8B-Instruct-FP8": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "Qwen3.5-27B-Blossom-V6.4-Derestricted": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen3.5-27B-BlueStar-v3-Derestricted": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-Derestricted": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-Derestricted-Lite": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen3.5-27B-Queen-Derestricted": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "ReadyArt/MS3.2-The-Omega-Directive-24B-Unslop-v2.0": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "Sao10K/L3.3-70B-Euryale-v2.3": {
      "contextWindow": 20480,
      "maxTokens": 16384
    },
    "Steelskull/L3.3-Cu-Mai-R1-70b": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "Steelskull/L3.3-Electra-R1-70b": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "Steelskull/L3.3-MS-Nevoria-70b": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "Steelskull/L3.3-Nevoria-R1-70b": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "TEE/deepseek-v3.2": {
      "contextWindow": 164000,
      "maxTokens": 65536
    },
    "TEE/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "TEE/gemma-4-26b-a4b-uncensored": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "TEE/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "TEE/gemma4-31b": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "TEE/gemma4-31b:thinking": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "TEE/glm-5.1": {
      "contextWindow": 202752,
      "maxTokens": 65535
    },
    "TEE/glm-5.1-thinking": {
      "contextWindow": 202752,
      "maxTokens": 65535
    },
    "TEE/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "TEE/glm-5.2:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "TEE/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "TEE/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "TEE/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "TEE/inkling-2-small": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "TEE/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "TEE/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "TEE/kimi-k3.1-pro": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "TEE/llama3-3-70b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "TEE/qwen3.6-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "TEE/qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "TEE/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "TheDrummer/Artemis-v1.1": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "TheDrummer/artemis-31b-v1.2": {
      "contextWindow": 65536,
      "maxTokens": 8192
    },
    "abacusai/Dracarys-72B-Instruct": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "abliteration-ai/abliterated-model": {
      "contextWindow": 262144,
      "maxTokens": 262134
    },
    "abliteration-ai/abliterated-model-large": {
      "contextWindow": 1000000,
      "maxTokens": 999990
    },
    "abliteration-ai/abliterated-model-large-flash": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "abliteration-ai/abliterated-model-large-v2": {
      "contextWindow": 1000000,
      "maxTokens": 999990
    },
    "aion-labs/aion-2.0": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "aion-labs/aion-3.0": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "aion-labs/aion-3.0-mini": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "aion-labs/aion-3.5": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "aion-labs/aion-3.5-mini": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "aion-labs/aion-rp-llama-3.1-8b": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "aisingapore/gemma-sea-lion-v4-27b-it": {
      "contextWindow": 131072,
      "maxTokens": 128000
    },
    "aisingapore/qwen-sea-lion-v4-32b-it": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "aleph-alpha/kolibri-1": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "amazon/nova-2-lite-v1": {
      "contextWindow": 1000000,
      "maxTokens": 65535
    },
    "amazon/nova-lite-v1": {
      "contextWindow": 300000,
      "maxTokens": 5120
    },
    "amazon/nova-pro-v1": {
      "contextWindow": 300000,
      "maxTokens": 32000
    },
    "anthracite-org/magnum-v2-72b": {
      "contextWindow": 16384,
      "maxTokens": 8192
    },
    "anthracite-org/magnum-v4-72b": {
      "contextWindow": 16384,
      "maxTokens": 8192
    },
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-haiku-4.5:thinking": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-haiku-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4.5:thinking": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.6:thinking": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.6:thinking:low": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.6:thinking:max": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.6:thinking:medium": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.7:thinking": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8:thinking": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4.5:thinking": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4.6:thinking": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5.5:thinking": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5:thinking": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "auto-model": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "auto-model-basic": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "auto-model-premium": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "auto-model-standard": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "baidu/ernie-light-dt-1.0-intl": {
      "contextWindow": 1024000,
      "maxTokens": 131072
    },
    "bytedance-seed/seed-2-1-turbo": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "bytedance-seed/seed-2.0-code": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "bytedance-seed/seed-2.0-lite": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "bytedance/doubao-seed-character": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "celeris-1": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "claw-high": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "claw-low": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "claw-medium": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "cohere/command-r-plus-08-2024": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "command-a-reasoning-08-2025": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "deepcogito/cogito-v1-preview-qwen-32B": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "deepseek-ai/DeepSeek-R1-0528": {
      "contextWindow": 163840,
      "maxTokens": 32768
    },
    "deepseek-ai/DeepSeek-V3.1": {
      "contextWindow": 128000,
      "maxTokens": 65536
    },
    "deepseek-ai/DeepSeek-V3.1-Terminus": {
      "contextWindow": 128000,
      "maxTokens": 65536
    },
    "deepseek-ai/DeepSeek-V3.1-Terminus:thinking": {
      "contextWindow": 128000,
      "maxTokens": 65536
    },
    "deepseek-ai/DeepSeek-V3.1:thinking": {
      "contextWindow": 128000,
      "maxTokens": 65536
    },
    "deepseek-ai/deepseek-v3.2-exp": {
      "contextWindow": 163840,
      "maxTokens": 65536
    },
    "deepseek-ai/deepseek-v3.2-exp-thinking": {
      "contextWindow": 163840,
      "maxTokens": 65536
    },
    "deepseek-chat": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "deepseek-v3-0324": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "deepseek/deepseek-latest": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v3.2": {
      "contextWindow": 163000,
      "maxTokens": 65536
    },
    "deepseek/deepseek-v3.2:thinking": {
      "contextWindow": 163000,
      "maxTokens": 65536
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-0423": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-0423:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "deepseek/deepseek-v4-flash-0731:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "deepseek/deepseek-v4-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro-0813:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro-20260423": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro-20260423:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash-0910-uncensored": {
      "contextWindow": 524288,
      "maxTokens": 32768
    },
    "deepseek/deepseek-v4.1-flash-0910-uncensored:thinking": {
      "contextWindow": 524288,
      "maxTokens": 32768
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4.1-flash-1017-abliterated": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "deepseek/deepseek-v4.1-flash-1017-abliterated:thinking": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "deepseek/deepseek-v4.1-flash-1017-uncensored": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepseek/deepseek-v4.1-flash-1017-uncensored:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepseek/deepseek-v4.1-flash-1017:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4.1-flash-abliterated": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "deepseek/deepseek-v4.1-flash-uncensored": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepseek/deepseek-v4.1-flash-uncensored:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepseek/deepseek-v4.1-flash:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "doubao-seed-2-0-code-preview-260215": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "doubao-seed-2-0-lite-260215": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "doubao-seed-2-0-mini-260215": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "doubao-seed-2-0-pro-260215": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "elorian/glimpse": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "failspy/Meta-Llama-3-70B-Instruct-abliterated-v3.5": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "fastgpt": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "featherless-ai/Qwerky-72B": {
      "contextWindow": 32000,
      "maxTokens": 8192
    },
    "fireworks/ember-1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-flash-nothinking": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-pro-preview-06-05": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-pro-image-preview": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "gemma-4-12b-it": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "gemma-4-12b-it-semancer": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "gemma-4-12b-it-starry-ocean": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "gemma-4-12b-it-station-keeper": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "gemma-4-26b-a4b-it-chimerax": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-26b-a4b-it-chimeraxheretic": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-26b-a4b-it-darksoul": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-26b-a4b-it-luminous": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-26b-a4b-it-moonlight": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-26b-a4b-it-musica": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-26b-a4b-it-opusdistill": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-26b-a4b-it-shadowsiren": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-31b-it-darkidol": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-31b-it-fabled": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-31b-it-garnet": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-31b-it-gembrain": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-31b-it-gemsicle": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-31b-it-isometry": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-31b-it-novelist": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-31b-it-scarlet": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "google/diffusiongemma": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "google/gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3-flash-preview-thinking": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview-customtools": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview-high": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview-low": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash-thinking": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "google/gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-neon": {
      "contextWindow": 983040,
      "maxTokens": 65536
    },
    "google/gemini-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-flash-lite-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-pro-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemma-4-26b-a4b-it": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "google/gemma-4-26b-a4b-it-cybersecurity": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "google/gemma-4-26b-a4b-it:thinking": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "google/gemma-4-31b-it:thinking": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "google/gemma4-31b-splituntied": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "heabsy/cyberheabsy": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "heabsy/qwen3.8-27b-uncensored-fast": {
      "contextWindow": 1048576,
      "maxTokens": 235929
    },
    "hermes-high": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "hermes-low": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "hermes-medium": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "holo3-35b-a3b": {
      "contextWindow": 65536,
      "maxTokens": 8192
    },
    "holo3-35b-a3b:thinking": {
      "contextWindow": 65536,
      "maxTokens": 8192
    },
    "huihui-ai/DeepSeek-R1-Distill-Llama-70B-abliterated": {
      "contextWindow": 16384,
      "maxTokens": 8192
    },
    "huihui-ai/DeepSeek-R1-Distill-Qwen-32B-abliterated": {
      "contextWindow": 16384,
      "maxTokens": 8192
    },
    "huihui-ai/Llama-3.3-70B-Instruct-abliterated": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "huihui-ai/Qwen2.5-32B-Instruct-abliterated": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "hyperresearch/ousia-1": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "ibm-granite/granite-4.2-8b": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "inception/mercury-2.5-preview": {
      "contextWindow": 260000,
      "maxTokens": 65536
    },
    "inception/mercury-3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "inclusionai/ling-3.0-flash": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "inclusionai/ling-3.0-flash-vl": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "inclusionai/ling-3.0-flash:thinking": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "inclusionai/ling-3.0-tiny": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "inclusionai/ling-3.0-tiny:thinking": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "inclusionai/ling-3.1-flash": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "inference-net/schematron-v2-small": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "inference-net/schematron-v2-turbo": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "inflatebot/MN-12B-Mag-Mell-R1": {
      "contextWindow": 16384,
      "maxTokens": 8192
    },
    "jcartu/deepseek-v4.1-flash-1017-abliterated-lossless-csf": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "jiunsong/supergemma4-26b-uncensored": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "kitani/clover-2": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "kitani/clover-2:thinking": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "kitani/evolve-beta": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "lightonai/LightOnOCR-2-1B": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "liquid/lfm-2.5-2.6b": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "liquid/lfm-2.5-24b-a2b": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "longcat-2.0": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "longcat-2.0:thinking": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "lyber/deepseek-v4.1-flash-1017-abliterated": {
      "contextWindow": 1048576,
      "maxTokens": 126976
    },
    "lyber/kimi-k3.1-pro-abliterated": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "meganova-ai/manta-flash-1.0": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "meganova-ai/manta-mini-1.0": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "meganova-ai/manta-pro-1.0": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "meituan/longcat-2.5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "mercury-2": {
      "contextWindow": 128000,
      "maxTokens": 50000
    },
    "mercury-coder-small": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "meta-llama/llama-3.1-8b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "meta-llama/llama-3.2-3b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "meta-llama/llama-3.3-70b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "meta-llama/llama-4-maverick": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "meta-llama/llama-4-scout": {
      "contextWindow": 328000,
      "maxTokens": 65536
    },
    "meta/muse-ember": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "meta/muse-glimmer-30b": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "meta/muse-spark-1.1": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "meta/muse-spark-1.2": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "meta/muse-spark-1.2-contributor": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "meta/muse-spark-1.3": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "meta/muse-spark-1.3-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "meta/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-wonder": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "microsoft/wizardlm-2-8x22b": {
      "contextWindow": 65536,
      "maxTokens": 8192
    },
    "minimax/minimax-01": {
      "contextWindow": 1000192,
      "maxTokens": 16384
    },
    "minimax/minimax-latest": {
      "contextWindow": 512000,
      "maxTokens": 80000
    },
    "minimax/minimax-m2": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.7-turbo": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m3": {
      "contextWindow": 512000,
      "maxTokens": 80000
    },
    "minimax/minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "minimax/minimax-m3:thinking": {
      "contextWindow": 512000,
      "maxTokens": 80000
    },
    "mistral-code-agent-latest": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "mistral-code-latest": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "mistralai/codestral-2508": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "mistralai/devstral-2-123b-instruct-2512": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "mistralai/devstral-small-2505": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "mistralai/ministral-14b-2512": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "mistralai/ministral-14b-instruct-2512": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "mistralai/ministral-3b-2512": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "mistralai/ministral-8b-2512": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "mistralai/mistral-large": {
      "contextWindow": 128000,
      "maxTokens": 102400
    },
    "mistralai/mistral-large-4": {
      "contextWindow": 524288,
      "maxTokens": 262144
    },
    "mistralai/mistral-medium-3": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "mistralai/mistral-medium-3.5": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "mistralai/mistral-medium-3.5:thinking": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "mistralai/mistral-nemo-instruct-2407": {
      "contextWindow": 16384,
      "maxTokens": 8192
    },
    "mistralai/mistral-saba": {
      "contextWindow": 32768,
      "maxTokens": 26214
    },
    "mistralai/mistral-small-24b-instruct-2501": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "mistralai/mistral-small-3.1-24b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 102400
    },
    "mistralai/mistral-small-3.2-24b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "mistralai/mistral-small-4-119b-2603": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "mistralai/mistral-small-4-119b-2603:thinking": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "mistralai/mixtral-8x22b-instruct-v0.1": {
      "contextWindow": 65536,
      "maxTokens": 52428
    },
    "mlabonne/NeuralDaredevil-8B-abliterated": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "moondream/moondream3-preview": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "moondream/moondream3.1-9b-a2b": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "moonshotai/kimi-k2.5": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "moonshotai/kimi-k2.5:thinking": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "moonshotai/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "moonshotai/kimi-k2.6:thinking": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "moonshotai/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "moonshotai/kimi-k2.7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "moonshotai/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/kimi-k3.1-pro-highspeed": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/kimi-latest": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "nano-gpt-help": {
      "contextWindow": 6000,
      "maxTokens": 512
    },
    "nanogpt/coding-router": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "nanogpt/coding-router:high": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "nanogpt/coding-router:low": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "nanogpt/coding-router:max": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "nanogpt/coding-router:medium": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "nex-agi/nex-n2.5-mini": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nex-agi/nex-n2.5-pro": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nex-agi/nex-n2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nothingiisreal/L3.1-70B-Celeste-V0.1-BF16": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF": {
      "contextWindow": 16384,
      "maxTokens": 8192
    },
    "nvidia/nemotron-3-nano-30b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "nvidia/nemotron-3-super-120b-a12b": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "nvidia/nemotron-3-super-120b-a12b:thinking": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
      "contextWindow": 512288,
      "maxTokens": 65536
    },
    "nvidia/nemotron-3-ultra-550b-a55b:thinking": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "nvidia/nemotron-3.5-content-safety": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "nvidia/nemotron-3.5-lightning": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "nvidia/nemotron-3.5-lightning:thinking": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "nvidia/nemotron-3.5-super-vl": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-2024-08-06": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-2024-11-20": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-2025-11-13": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex-max": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra": {
      "contextWindow": 922000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra-pro": {
      "contextWindow": 922000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol": {
      "contextWindow": 922000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol-pro": {
      "contextWindow": 922000,
      "maxTokens": 128000
    },
    "openai/gpt-astra-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-chat-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-luna-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "openai/gpt-oss-safeguard-20b": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "openai/gpt-sol-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-terra-latest": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/o1": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-pro-2025-06-10": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "orca/orcacyber-flash-1.0": {
      "contextWindow": 1048064,
      "maxTokens": 393216
    },
    "orca/orcacyber-flash-1.0:thinking": {
      "contextWindow": 1048064,
      "maxTokens": 393216
    },
    "orca/orcacyber-glm-5.3": {
      "contextWindow": 999488,
      "maxTokens": 128000
    },
    "orca/orcacyber-glm-5.3-flash": {
      "contextWindow": 1048064,
      "maxTokens": 131072
    },
    "orca/orcacyber-hy4": {
      "contextWindow": 1048064,
      "maxTokens": 65536
    },
    "orca/orcacyber-hy4-flash": {
      "contextWindow": 1048064,
      "maxTokens": 65536
    },
    "orca/orcacyber-inkling-2-mini": {
      "contextWindow": 1048064,
      "maxTokens": 65536
    },
    "orca/orcacyber-k3.1-pro": {
      "contextWindow": 1048064,
      "maxTokens": 943718
    },
    "orca/orcacyber-ling-3.2-flash": {
      "contextWindow": 1048064,
      "maxTokens": 262144
    },
    "orca/orcacyber-mimo-flash": {
      "contextWindow": 1048064,
      "maxTokens": 131072
    },
    "orca/orcacyber-minimax-m3.1-flash": {
      "contextWindow": 261632,
      "maxTokens": 131072
    },
    "orca/orcacyber-qwen3.8-flash-next": {
      "contextWindow": 261632,
      "maxTokens": 131072
    },
    "orca/orcacyber-step-5-preview": {
      "contextWindow": 999488,
      "maxTokens": 64000
    },
    "orca/orcacyber-ultra-1.0": {
      "contextWindow": 1048064,
      "maxTokens": 131072
    },
    "orca/orcacyber-zero-1.0": {
      "contextWindow": 999488,
      "maxTokens": 128000
    },
    "orca/orcacyber-zero-1.5": {
      "contextWindow": 999488,
      "maxTokens": 128000
    },
    "ornith-ai/ornith-1.5-122b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "ornith-ai/ornith-1.5-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "ornith-ai/ornith-1.5-35b-a3b:thinking": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "paperinstruments/ultramarine-1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "particle-ai/particle-1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "perceptron/perceptron-mk1": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "perceptron/perceptron-mk1.5": {
      "contextWindow": 36864,
      "maxTokens": 8192
    },
    "phi-4-mini-instruct": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "phi-4-multimodal-instruct": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "pokee-isaac": {
      "contextWindow": 250000,
      "maxTokens": 60000
    },
    "pqhaz/DeepSeek-V4.1-Flash-1017-heretic": {
      "contextWindow": 512000,
      "maxTokens": 128000
    },
    "pqhaz/DeepSeek-V4.1-Flash-1017-heretic:thinking": {
      "contextWindow": 512000,
      "maxTokens": 128000
    },
    "prism-ml/ternary-bonsai-2-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "prism-ml/ternary-bonsai-2-9b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen-2.5-72b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "qwen/qwen-max": {
      "contextWindow": 32000,
      "maxTokens": 8192
    },
    "qwen/qwen-plus": {
      "contextWindow": 995904,
      "maxTokens": 32768
    },
    "qwen/qwen-turbo": {
      "contextWindow": 1000000,
      "maxTokens": 8192
    },
    "qwen/qwen2.5-coder-32b-instruct": {
      "contextWindow": 32000,
      "maxTokens": 8192
    },
    "qwen/qwen2.5-vl-72b-instruct": {
      "contextWindow": 32000,
      "maxTokens": 32000
    },
    "qwen/qwen3-14b": {
      "contextWindow": 41000,
      "maxTokens": 32768
    },
    "qwen/qwen3-235b-a22b-instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "qwen/qwen3-235b-a22b-thinking-2507": {
      "contextWindow": 131072,
      "maxTokens": 81920
    },
    "qwen/qwen3-30b-a3b": {
      "contextWindow": 41000,
      "maxTokens": 32768
    },
    "qwen/qwen3-30b-a3b-instruct-2507": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "qwen/qwen3-32b": {
      "contextWindow": 41000,
      "maxTokens": 32768
    },
    "qwen/qwen3-8b": {
      "contextWindow": 41000,
      "maxTokens": 32768
    },
    "qwen/qwen3-coder": {
      "contextWindow": 262000,
      "maxTokens": 65536
    },
    "qwen/qwen3-coder-30b-a3b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 65536
    },
    "qwen/qwen3-coder-flash": {
      "contextWindow": 128000,
      "maxTokens": 65536
    },
    "qwen/qwen3-coder-next": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3-next-80b-a3b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3-vl-235b-a22b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3.5-122b-a10b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3.5-122b-a10b:thinking": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3.5-27b": {
      "contextWindow": 260096,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-27b:thinking": {
      "contextWindow": 260096,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-35b-a3b": {
      "contextWindow": 260096,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-35b-a3b:thinking": {
      "contextWindow": 260096,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-397b-a17b": {
      "contextWindow": 258048,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-397b-a17b:thinking": {
      "contextWindow": 258048,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-9b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-flash": {
      "contextWindow": 991808,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-flash:thinking": {
      "contextWindow": 991808,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-omni-flash": {
      "contextWindow": 49152,
      "maxTokens": 16384
    },
    "qwen/qwen3.5-omni-plus": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-plus": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-plus:thinking": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-27b:thinking": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-35b-a3b": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-35b-a3b:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-flash": {
      "contextWindow": 991808,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-max-preview": {
      "contextWindow": 245760,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-plus": {
      "contextWindow": 991808,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-flash": {
      "contextWindow": 991808,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-flash:thinking": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-max:thinking": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-plus": {
      "contextWindow": 991808,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-plus:thinking": {
      "contextWindow": 983616,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-27b-antislop": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-27b-cybersecurity": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-27b-darkidol": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-27b-fable": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-27b-fimi": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-27b-kimiko": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-27b-kiwen": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-27b-novelist": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-27b-queen": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-27b-swift": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-27b-synthia": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-27b-uncensored": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-27b-uncensored:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-27b:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-max": {
      "contextWindow": 991000,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-max-0902": {
      "contextWindow": 991808,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-max-prime": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-max:thinking": {
      "contextWindow": 991000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-omni-flash": {
      "contextWindow": 991808,
      "maxTokens": 131072
    },
    "qwen/qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen4-max:thinking": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "qwen3-vl-235b-a22b-instruct-original": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "radixark/daisyrose-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "reflection/beam-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "reka/reka-edge-2603": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "reka/reka-flash-3": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "ricursiveai/ripple-65b-preview": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "sakana/fugu-max": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "sakana/fugu-ultra": {
      "contextWindow": 1000000,
      "maxTokens": 16384
    },
    "sakana/fugu-ultra-v1.1": {
      "contextWindow": 1000000,
      "maxTokens": 16384
    },
    "sarvam-105b": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "shisa-ai/shisa-v2-llama3.3-70b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "shisa-ai/shisa-v2.1-llama3.3-70b": {
      "contextWindow": 32768,
      "maxTokens": 4096
    },
    "sicariussicariistuff/assistant-pepe-32b": {
      "contextWindow": 40960,
      "maxTokens": 8192
    },
    "soob3123/GrayLine-Qwen3-8B": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "soob3123/Veiled-Calla-12B": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "speakleash/bielik-11b-v3.0-instruct": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "stepfun/step-3.7-flash:thinking": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "stepfun/step-5-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "synth-2.5-flash": {
      "contextWindow": 30000,
      "maxTokens": 30000
    },
    "synth-2.5-pro": {
      "contextWindow": 30000,
      "maxTokens": 30000
    },
    "tencent/hy3": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "tencent/hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "tencent/hy4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "tencent/hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    },
    "thinkingmachines/Inkling-Small": {
      "contextWindow": 524288,
      "maxTokens": 32768
    },
    "thinkingmachines/Inkling-Small:thinking": {
      "contextWindow": 524288,
      "maxTokens": 32768
    },
    "thinkingmachines/inkling": {
      "contextWindow": 1040000,
      "maxTokens": 32768
    },
    "thinkingmachines/inkling:thinking": {
      "contextWindow": 1040000,
      "maxTokens": 32768
    },
    "unbiased/pareto-26.10": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "unbiased/pareto-26.9": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "universal-summarizer": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "unsloth/gemma-3-12b-it": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "unsloth/gemma-3-27b-it": {
      "contextWindow": 128000,
      "maxTokens": 96000
    },
    "unsloth/gemma-3-4b-it": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "upstage/solar-mini-4-5": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "upstage/solar-mini-4-5:thinking": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "upstage/solar-mini4": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "upstage/solar-mini4:thinking": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "upstage/solar-pro-4-contributor": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "upstage/solar-pro-4-contributor:thinking": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "upstage/solar-pro4": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "upstage/solar-pro4:thinking": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "venice-uncensored": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "x-ai/grok-4.20": {
      "contextWindow": 2000000,
      "maxTokens": 131072
    },
    "x-ai/grok-4.20-multi-agent": {
      "contextWindow": 2000000,
      "maxTokens": 131072
    },
    "x-ai/grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 900000
    },
    "x-ai/grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 450000
    },
    "x-ai/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 450000
    },
    "x-ai/grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "x-ai/grok-latest": {
      "contextWindow": 500000,
      "maxTokens": 450000
    },
    "xiaomi/mimo-v2.5": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.5-pro": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.5-pro:thinking": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.5:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-flash-abliterated": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "xiaomi/mimo-v2.6-flash-mopd": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-flash-uncensored": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "xiaomi/mimo-v2.6-flash-uncensored:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "xiaomi/mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-pro-ultraspeed": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xtools-at/deepseek-v4-pro-qwen3.5-9b-uncensored-heretic": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "z-ai/GLM-4.5-Air": {
      "contextWindow": 128000,
      "maxTokens": 98304
    },
    "z-ai/GLM-4.5-Air:thinking": {
      "contextWindow": 128000,
      "maxTokens": 98304
    },
    "z-ai/GLM-4.5:thinking": {
      "contextWindow": 128000,
      "maxTokens": 65536
    },
    "z-ai/GLM-4.6-turbo": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/GLM-4.6-turbo:thinking": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-4.5": {
      "contextWindow": 128000,
      "maxTokens": 65536
    },
    "z-ai/glm-4.5v": {
      "contextWindow": 65536,
      "maxTokens": 16384
    },
    "z-ai/glm-4.5v:thinking": {
      "contextWindow": 65536,
      "maxTokens": 16384
    },
    "z-ai/glm-4.6": {
      "contextWindow": 200000,
      "maxTokens": 65535
    },
    "z-ai/glm-4.6-original": {
      "contextWindow": 256000,
      "maxTokens": 65535
    },
    "z-ai/glm-4.6:thinking": {
      "contextWindow": 200000,
      "maxTokens": 65535
    },
    "z-ai/glm-4.6v": {
      "contextWindow": 128000,
      "maxTokens": 24000
    },
    "z-ai/glm-4.6v-original": {
      "contextWindow": 128000,
      "maxTokens": 24000
    },
    "z-ai/glm-4.7": {
      "contextWindow": 200000,
      "maxTokens": 65535
    },
    "z-ai/glm-4.7-flash": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-4.7-flash:thinking": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-4.7-original": {
      "contextWindow": 200000,
      "maxTokens": 65535
    },
    "z-ai/glm-4.7-original:thinking": {
      "contextWindow": 200000,
      "maxTokens": 65535
    },
    "z-ai/glm-4.7:thinking": {
      "contextWindow": 200000,
      "maxTokens": 65535
    },
    "z-ai/glm-5": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-5-original": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-5-original:thinking": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-5-turbo": {
      "contextWindow": 202800,
      "maxTokens": 131072
    },
    "z-ai/glm-5.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-5.1:thinking": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.2:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-abliterated": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash-abliterated": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "z-ai/glm-5.3-flash-apex": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "z-ai/glm-5.3-flash-apex-abliterated": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "z-ai/glm-5.3-flash-cybersecurity": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "z-ai/glm-5.3-flash-uncensored": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "z-ai/glm-5.3-flashx-legal": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-uncensored": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3:thinking": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5:thinking": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-5v-turbo": {
      "contextWindow": 202800,
      "maxTokens": 131072
    },
    "z-ai/glm-5v-turbo:thinking": {
      "contextWindow": 202800,
      "maxTokens": 131072
    },
    "z-ai/glm-latest": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "nearai": {
    "Qwen/Qwen3-Embedding-0.6B": {
      "contextWindow": 32768,
      "maxTokens": 1024
    },
    "Qwen/Qwen3-Reranker-0.6B": {
      "contextWindow": 40960,
      "maxTokens": 1024
    },
    "Qwen/Qwen3-VL-30B-A3B-Instruct": {
      "contextWindow": 16384,
      "maxTokens": 8192
    },
    "Qwen/Qwen3.6-35B-A3B-FP8": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "Qwen/Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Qwen/Qwen3.8-27B-abliterated": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-6": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v3.2": {
      "contextWindow": 128000,
      "maxTokens": 64000
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "moonshotai/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o4-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/whisper-large-v3": {
      "contextWindow": 448,
      "maxTokens": 448
    },
    "x-ai/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "x-ai/grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "nebius": {
    "MiniMaxAI/MiniMax-M3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "MiniMaxAI/MiniMax-M3.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "NousResearch/Hermes-4-405B": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "Qwen/Qwen3-30B-A3B-Instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "Qwen/Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
      "contextWindow": 979000,
      "maxTokens": 979000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017-fast": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "google/gemma-3-27b-it": {
      "contextWindow": 110000,
      "maxTokens": 8192
    },
    "meta-models/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/Kimi-K3": {
      "contextWindow": 1024000,
      "maxTokens": 8000
    },
    "moonshotai/Kimi-K3.1-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/Nemotron-3-Ultra-550b-a55b": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nvidia/Nemotron-3.5-Super-VL": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nvidia/Nemotron-3_5-Lightning": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nvidia/nemotron-3-super-120b-a12b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "reflection/beam": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "thinkingmachines/Inkling-2-Small": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "zai-org/GLM-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1024000,
      "maxTokens": 1024000
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1024000,
      "maxTokens": 1024000
    }
  },
  "neon": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-1": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-opus-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4-1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gemini-3-1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemma-3-12b": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "glm-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "glm-5-3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5-3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5-4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5-5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5-6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-6-1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 25000
    },
    "gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 25000
    },
    "grok-4-6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4-7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "llama-4-maverick": {
      "contextWindow": 1000000,
      "maxTokens": 8192
    },
    "meta-llama-3-1-8b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "meta-llama-3-3-70b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "qwen3-next-80b-a3b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 10000
    },
    "qwen35-122b-a10b": {
      "contextWindow": 262144,
      "maxTokens": 25000
    }
  },
  "neosmith": {
    "neosmith.intelligent-basic": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "neosmith.intelligent-maestro": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "neosmith.intelligent-pro": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "neosmith.neolite": {
      "contextWindow": 512000,
      "maxTokens": 64000
    }
  },
  "neuralwatt": {
    "deepseek-v4.1-flash": {
      "contextWindow": 1048560,
      "maxTokens": 393216
    },
    "deepseek-v4.1-flash-flex": {
      "contextWindow": 1048560,
      "maxTokens": 393216
    },
    "deepseek-v4.1-flash-speed": {
      "contextWindow": 1048560,
      "maxTokens": 393216
    },
    "gemma-4-31b": {
      "contextWindow": 262128,
      "maxTokens": 16384
    },
    "glm-5.3": {
      "contextWindow": 1048560,
      "maxTokens": 1048560
    },
    "glm-5.3-flash": {
      "contextWindow": 1048560,
      "maxTokens": 1048560
    },
    "glm-5.3-flash-flex": {
      "contextWindow": 1048560,
      "maxTokens": 1048560
    },
    "glm-5.3-flex": {
      "contextWindow": 1048560,
      "maxTokens": 1048560
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048560,
      "maxTokens": 1048560
    },
    "kimi-k3.1-pro-flex": {
      "contextWindow": 1048560,
      "maxTokens": 1048560
    },
    "mimo-v2.6-pro": {
      "contextWindow": 1048560,
      "maxTokens": 393216
    },
    "mimo-v2.6-pro-flex": {
      "contextWindow": 1048560,
      "maxTokens": 393216
    },
    "nw-flash": {
      "contextWindow": 1048560,
      "maxTokens": 393216
    },
    "nw-flash-flex": {
      "contextWindow": 1048560,
      "maxTokens": 393216
    },
    "nw-large": {
      "contextWindow": 1048560,
      "maxTokens": 1048560
    },
    "nw-large-flex": {
      "contextWindow": 1048560,
      "maxTokens": 1048560
    },
    "nw-small": {
      "contextWindow": 262128,
      "maxTokens": 131072
    },
    "nw-small-flex": {
      "contextWindow": 262128,
      "maxTokens": 131072
    },
    "qwen-3.8-27b": {
      "contextWindow": 262128,
      "maxTokens": 131072
    },
    "qwen-3.8-27b-flex": {
      "contextWindow": 262128,
      "maxTokens": 131072
    },
    "qwen3.6-35b": {
      "contextWindow": 262128,
      "maxTokens": 131056
    },
    "qwen3.6-35b-fast": {
      "contextWindow": 262128,
      "maxTokens": 131056
    },
    "qwen3.6-35b-flex": {
      "contextWindow": 262128,
      "maxTokens": 131056
    }
  },
  "nodecode": {
    "nodecode-cyber-v1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "nokeep": {
    "deepseek-v4.1-flash-1017-uncensored": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "deepseek-v4.1-flash-uncensored": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash-uncensored": {
      "contextWindow": 128000,
      "maxTokens": 32768
    }
  },
  "nova": {
    "nova-2-lite-v1": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "nova-2-pro-v1": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    }
  },
  "novita-ai": {
    "apodex/apodex-1.1-mini": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "baichuan/baichuan-m2-32b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "baidu/cobuddy": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "baidu/ernie-4.5-21B-a3b": {
      "contextWindow": 120000,
      "maxTokens": 8000
    },
    "deepseek/deepseek-ocr-2": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "deepseek/deepseek-r1-0528": {
      "contextWindow": 163840,
      "maxTokens": 32768
    },
    "deepseek/deepseek-r1-0528-qwen3-8b": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "deepseek/deepseek-r1-turbo": {
      "contextWindow": 64000,
      "maxTokens": 16000
    },
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek_v3": {
      "contextWindow": 64000,
      "maxTokens": 16000
    },
    "google/gemma-3-12b-it": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "google/gemma-3-27b-it": {
      "contextWindow": 98304,
      "maxTokens": 16384
    },
    "google/gemma-4-26b-a4b-it": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "gryphe/mythomax-l2-13b": {
      "contextWindow": 4096,
      "maxTokens": 3200
    },
    "inclusionai/ling-3.0-flash": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "inclusionai/ling-3.0-flash-fin": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "inclusionai/ling-3.0-flash-sante": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "inclusionai/ling-3.0-flash-vl": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "inclusionai/ling-3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "meta-llama/llama-3.1-8b-instruct": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "meta-llama/llama-3.2-1b-instruct": {
      "contextWindow": 131000,
      "maxTokens": 32000
    },
    "meta-llama/llama-3.3-70b-instruct": {
      "contextWindow": 12288,
      "maxTokens": 12288
    },
    "meta-llama/llama-4-maverick-17b-128e-instruct-fp8": {
      "contextWindow": 1048576,
      "maxTokens": 8192
    },
    "meta-llama/llama-4-scout-17b-16e-instruct": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "microsoft/wizardlm-2-8x22b": {
      "contextWindow": 65535,
      "maxTokens": 8000
    },
    "mindai/macaron-v1-tall": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "mindai/macaron-v1-venti": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.5": {
      "contextWindow": 204800,
      "maxTokens": 131100
    },
    "minimax/minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "minimax/minimax-m3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 524288
    },
    "minimaxai/minimax-m1-80k": {
      "contextWindow": 1000000,
      "maxTokens": 40000
    },
    "moonshotai/kimi-k2-0905": {
      "contextWindow": 262144,
      "maxTokens": 98304
    },
    "moonshotai/kimi-k2-instruct": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "moonshotai/kimi-k2-thinking": {
      "contextWindow": 262144,
      "maxTokens": 98304
    },
    "moonshotai/kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/kimi-k3.1-pro-highspeed": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nousresearch/hermes-2-pro-llama-3-8b": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "nvidia/nemotron-3-nano-30b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "openai/gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "paddlepaddle/paddleocr-vl": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "qwen/qwen-mt-plus": {
      "contextWindow": 16384,
      "maxTokens": 8192
    },
    "qwen/qwen3-omni-30b-a3b-thinking": {
      "contextWindow": 65536,
      "maxTokens": 16384
    },
    "qwen/qwen3-vl-30b-a3b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3-vl-plus": {
      "contextWindow": 262000,
      "maxTokens": 32000
    },
    "qwen/qwen3.5-122b-a10b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-2.4t-a95b": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 262000
    },
    "stepfun/step-3.7-flash": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "stepfun/step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "tencent/hy3": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "tencent/hy4": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "tencent/hy4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "tencent/hy4-preview": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "xiaomimimo/mimo-v2.5": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomimimo/mimo-v2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomimimo/mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomimimo/mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/autoglm-phone-9b-multilingual": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "zai-org/glm-4.5-air": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "zai-org/glm-4.5v": {
      "contextWindow": 65536,
      "maxTokens": 16384
    },
    "zai-org/glm-4.6": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "zai-org/glm-4.6v": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "zai-org/glm-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "zai-org/glm-4.7-flash": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "zai-org/glm-5": {
      "contextWindow": 202800,
      "maxTokens": 131072
    },
    "zai-org/glm-5.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "zai-org/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/glm-5.3-flashX": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "nvidia": {
    "deepseek-ai/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/diffusiongemma-26b-a4b-it": {
      "contextWindow": 250000,
      "maxTokens": 32768
    },
    "google/gemma-3-12b-it": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "google/gemma-3-4b-it": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "google/google-paligemma": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "meta/llama-3.2-11b-vision-instruct": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "meta/llama-3.2-90b-vision-instruct": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "meta/llama-guard-4-12b": {
      "contextWindow": 163840,
      "maxTokens": 16384
    },
    "meta/muse-glimmer-30b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "minimaxai/minimax-m3.1-flash": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistralai/magistral-small-2506": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "mistralai/mistral-7b-instruct-v0.3": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "mistralai/mistral-medium-3-instruct": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "moonshotai/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nvidia/bevformer": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "nvidia/cosmos-reason2-8b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "nvidia/llama-3.1-nemotron-70b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "nvidia/llama-3.1-nemotron-safety-guard-8b-v3": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "nvidia/llama-3.1-nemotron-ultra-253b-v1": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "nvidia/llama-nemotron-embed-vl-1b-v2": {
      "contextWindow": 8192,
      "maxTokens": 2048
    },
    "nvidia/llama-nemotron-rerank-vl-1b-v2": {
      "contextWindow": 10240,
      "maxTokens": 4096
    },
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "nvidia/nemotron-3.5-content-safety": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "nvidia/nemotron-3.5-lightning-30b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/nemotron-3.5-super-vl-120b-a12b": {
      "contextWindow": 1048576,
      "maxTokens": 8192
    },
    "nvidia/nemotron-voicechat": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "nvidia/rerank-qa-mistral-4b": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "nvidia/riva-translate-4b-instruct-v1.1": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "nvidia/sparsedrive": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "nvidia/streampetr": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "nvidia/usdcode": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/whisper-large-v3": {
      "contextWindow": 448,
      "maxTokens": 448
    },
    "poolside/laguna-xs-2.1": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "stepfun-ai/step-5-preview": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "oathbreaker": {
    "oathbreaker-glm-5.3": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "oathbreaker-glm-5.3-flash": {
      "contextWindow": 131072,
      "maxTokens": 32768
    }
  },
  "obscurify": {
    "anthropic/claude-haiku-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "meta-llama/llama-3.3-70b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "minimax/minimax-m3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "moonshotai/kimi-k2-0905": {
      "contextWindow": 262144,
      "maxTokens": 98304
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "qwen/qwen3-coder": {
      "contextWindow": 262000,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "x-ai/grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "oci": {
    "meta.llama-3.3-70b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "meta.llama-4-maverick-17b-128e-instruct-fp8": {
      "contextWindow": 512000,
      "maxTokens": 16384
    },
    "meta.llama-4-scout-17b-16e-instruct": {
      "contextWindow": 192000,
      "maxTokens": 16384
    },
    "openai.gpt-oss-120b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai.gpt-oss-20b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "xai.grok-4.20-non-reasoning": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "xai.grok-4.20-reasoning": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "xai.grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "xai.grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    }
  },
  "ofox": {
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-haiku-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "bailian/qwen-flash": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "bailian/qwen-max": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "bailian/qwen-plus": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "bailian/qwen-turbo": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "bailian/qwen-vl-max": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "bailian/qwen3-coder-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "bailian/qwen3-coder-next": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "bailian/qwen3-coder-plus": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "bailian/qwen3-max": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "bailian/qwen3.5-122b-a10b": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "bailian/qwen3.5-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "bailian/qwen3.5-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "bailian/qwen3.5-397b-a17b": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "bailian/qwen3.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "bailian/qwen3.5-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "bailian/qwen3.6-27b": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "bailian/qwen3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "bailian/qwen3.6-max-preview": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "bailian/qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "bailian/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "bailian/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "bailian/qwen3.8-27b": {
      "contextWindow": 1131072,
      "maxTokens": 131072
    },
    "bailian/qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "bailian/qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "bailian/qwen3.8-max-0902": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "deepseek/deepseek-v3.2": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-0423": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro-0423": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "minimax/m2-her": {
      "contextWindow": 65536,
      "maxTokens": 2048
    },
    "minimax/minimax-m2": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.1-lightning": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.5-lightning": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "moonshotai/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k2.7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex-max": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex-mini": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "qwen/qwen-flash": {
      "contextWindow": 1000000,
      "maxTokens": 32000
    },
    "qwen/qwen-max": {
      "contextWindow": 32000,
      "maxTokens": 8000
    },
    "qwen/qwen-plus": {
      "contextWindow": 1000000,
      "maxTokens": 32000
    },
    "qwen/qwen-turbo": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "qwen/qwen-vl-max": {
      "contextWindow": 128000,
      "maxTokens": 8000
    },
    "qwen/qwen3-coder-flash": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen/qwen3-coder-next": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "qwen/qwen3-coder-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen/qwen3-max": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "qwen/qwen3.5-122b-a10b": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "qwen/qwen3.5-27b": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "qwen/qwen3.5-35b-a3b": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "qwen/qwen3.5-397b-a17b": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "qwen/qwen3.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen/qwen3.5-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen/qwen3.6-27b": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "qwen/qwen3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen/qwen3.6-max-preview": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "qwen/qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen/qwen3.7-max": {
      "contextWindow": 1064000,
      "maxTokens": 64000
    },
    "qwen/qwen3.7-plus": {
      "contextWindow": 1064000,
      "maxTokens": 64000
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 1131072,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.8-max-0902": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "volcengine/doubao-seed-2.0-code": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "volcengine/doubao-seed-2.0-lite": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "volcengine/doubao-seed-2.0-mini": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "volcengine/doubao-seed-2.0-pro": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "volcengine/doubao-seed-2.1-pro": {
      "contextWindow": 1024000,
      "maxTokens": 256000
    },
    "volcengine/doubao-seed-2.1-turbo": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "volcengine/doubao-seed-character": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "volcengine/doubao-seed-evolving": {
      "contextWindow": 1024000,
      "maxTokens": 256000
    },
    "x-ai/grok-4.1-fast": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "x-ai/grok-4.20": {
      "contextWindow": 2000000,
      "maxTokens": 128000
    },
    "x-ai/grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "x-ai/grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 65536
    },
    "x-ai/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 65536
    },
    "x-ai/grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 65536
    },
    "z-ai/glm-4.6": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-4.7-flashx": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-5-turbo": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flashx": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5v-turbo": {
      "contextWindow": 200000,
      "maxTokens": 131072
    }
  },
  "ollama-cloud": {
    "beam": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepseek-v4-pro:0813": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash:1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "gemma4:31b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "glm-5.2": {
      "contextWindow": 976000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-oss:120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "gpt-oss:20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "inkling-2-small": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax-m2.7": {
      "contextWindow": 196608,
      "maxTokens": 196608
    },
    "minimax-m3": {
      "contextWindow": 512000,
      "maxTokens": 131072
    },
    "minimax-m3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "mistral-large-3:675b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral-large-4": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "nemotron-3-nano:30b": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "nemotron-3-super": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "nemotron-3-ultra": {
      "contextWindow": 262144,
      "maxTokens": 128000
    }
  },
  "openreason": {
    "deepseek-ai/deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "moonshotai/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    }
  },
  "opper": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemma-4-31b-it": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-oss-120b": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "gpt-oss-20b": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-build-0.1": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "minimax-m2.7": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "minimax-m3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "mistral-large-2512": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "mistral-small-2603": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "qwen3-coder-next": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.8-2.4t-a95b": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3.8-max": {
      "contextWindow": 983616,
      "maxTokens": 131072
    },
    "sonar": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "sonar-pro": {
      "contextWindow": 200000,
      "maxTokens": 8000
    },
    "sonar-reasoning-pro": {
      "contextWindow": 128000,
      "maxTokens": 4096
    }
  },
  "orcarouter": {
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4.5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek/deepseek-chat": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-reasoner": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-free": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-flash-lite-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview-customtools": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-flash-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-flash-lite-latest": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-robotics-er-1.6-preview": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "google/gemma-4-26b-a4b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "grok/grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "grok/grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "kimi/kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "kimi/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "kimi/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "meta/muse-spark-1.1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.5-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "openai/gpt-3.5-turbo": {
      "contextWindow": 16385,
      "maxTokens": 4096
    },
    "openai/gpt-4": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "openai/gpt-4-turbo": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-2024-05-13": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "openai/gpt-4o-2024-08-06": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-2024-11-20": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-chat-latest": {
      "contextWindow": 400000,
      "maxTokens": 100000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 272000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-chat-latest": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-chat-latest": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 100000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "orcarouter/auto": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "orcarouter/free": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "orcarouter/fusion": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "orcarouter/fusion-flash": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "orcarouter/fusion-mini": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "qwen/qwen3-max": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3-vl-235b-a22b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen/qwen3-vl-235b-a22b-thinking": {
      "contextWindow": 131072,
      "maxTokens": 40960
    },
    "qwen/qwen3.5-122b-a10b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "tencent/hy3": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "tencent/hy3-free": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "z-ai/glm-4.5": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "z-ai/glm-4.5-air": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "z-ai/glm-4.6": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "z-ai/glm-5.3-flash-free": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    }
  },
  "outerlabs": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  },
  "ovhcloud": {
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "gemma-4-26b-a4b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "laguna-xs-2.1": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "meta-llama-3_3-70b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "mistral-small-3.2-24b-instruct-2506": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "nemotron3-nano-30b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "nemotron3-omni-30b": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "olala-v1.0-translate": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "qwen2.5-vl-72b-instruct": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "qwen3-vl-30b-a3b": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "qwen3.5-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen3.5-9b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6-27b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen3guard-gen-0.6b": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "qwen3guard-gen-8b": {
      "contextWindow": 32768,
      "maxTokens": 16384
    }
  },
  "paraloncloud": {
    "qwen3.8-27b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    }
  },
  "pareto": {
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "pendra": {
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-4.7-flash": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "gpt-oss:120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "llama3.3:70b": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "qwen3-coder:30b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6:27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    }
  },
  "perplexity": {
    "sonar": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "sonar-deep-research": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "sonar-pro": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "sonar-reasoning-pro": {
      "contextWindow": 128000,
      "maxTokens": 4096
    }
  },
  "perplexity-agent": {
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4-6": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4-6": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "moonshot-ai/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshot-ai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nvidia/nemotron-3-super-120b-a12b": {
      "contextWindow": 1000000,
      "maxTokens": 32000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "perplexity/deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "perplexity/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "perplexity/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "perplexity/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "perplexity/nemotron-3.5-super-120b-a12b": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "perplexity/sonar": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "xai/grok-4-1-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "xai/grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    }
  },
  "phala": {
    "deepseek/deepseek-v3.2": {
      "contextWindow": 163840,
      "maxTokens": 64000
    },
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "meta-llama/llama-3.3-70b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "moonshotai/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "qwen/qwen-2.5-7b-instruct": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "qwen/qwen3-vl-30b-a3b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "qwen/qwen3.5-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "z-ai/glm-5.1": {
      "contextWindow": 202752,
      "maxTokens": 128000
    },
    "z-ai/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "phase": {
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "qwen3-coder-480b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    }
  },
  "pioneer": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-fast": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "fastino/GLiNER-2.5-Decide": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "fastino/gliguard-LLMGuardrails-300M": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "fastino/gliguard-PII-multi": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "fastino/gliner2-base-v1": {
      "contextWindow": 2048,
      "maxTokens": 2048
    },
    "fastino/gliner2-large-v1": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "fastino/gliner2-multi-large-v1": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "fastino/gliner2-multi-v1": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "fastino/gliner2-privacy-filter-PII-multi": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "fastino/gliner2.5-base-v1": {
      "contextWindow": 4096,
      "maxTokens": 4096
    },
    "fastino/gliner2.5-multi-v1": {
      "contextWindow": 4096,
      "maxTokens": 4096
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "moonshotai/Kimi-K3": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "moonshotai/Kimi-K3-Fast": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16": {
      "contextWindow": 65536,
      "maxTokens": 4096
    },
    "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4": {
      "contextWindow": 262144,
      "maxTokens": 4096
    },
    "zai-org/GLM-5.2": {
      "contextWindow": 1040000,
      "maxTokens": 128000
    }
  },
  "poe": {
    "anthropic/claude-haiku-3": {
      "contextWindow": 189096,
      "maxTokens": 8192
    },
    "anthropic/claude-haiku-3.5": {
      "contextWindow": 189096,
      "maxTokens": 8192
    },
    "anthropic/claude-haiku-4.5": {
      "contextWindow": 192000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4": {
      "contextWindow": 192512,
      "maxTokens": 28672
    },
    "anthropic/claude-opus-4.1": {
      "contextWindow": 196608,
      "maxTokens": 32000
    },
    "anthropic/claude-opus-4.5": {
      "contextWindow": 196608,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4.6": {
      "contextWindow": 983040,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.7": {
      "contextWindow": 1048576,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8": {
      "contextWindow": 1048576,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-3.5": {
      "contextWindow": 189096,
      "maxTokens": 8192
    },
    "anthropic/claude-sonnet-3.5-june": {
      "contextWindow": 189096,
      "maxTokens": 8192
    },
    "anthropic/claude-sonnet-3.7": {
      "contextWindow": 196608,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4": {
      "contextWindow": 983040,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4.5": {
      "contextWindow": 983040,
      "maxTokens": 32768
    },
    "anthropic/claude-sonnet-4.6": {
      "contextWindow": 983040,
      "maxTokens": 128000
    },
    "empiriolabs/deepseek-v4-flash-el": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "empiriolabs/deepseek-v4-pro-el": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "fireworks-ai/kimi-k2.5-fw": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "google/gemini-2.0-flash": {
      "contextWindow": 990000,
      "maxTokens": 8192
    },
    "google/gemini-2.0-flash-lite": {
      "contextWindow": 990000,
      "maxTokens": 8192
    },
    "google/gemini-2.5-flash": {
      "contextWindow": 1065535,
      "maxTokens": 65535
    },
    "google/gemini-2.5-flash-lite": {
      "contextWindow": 1024000,
      "maxTokens": 64000
    },
    "google/gemini-2.5-pro": {
      "contextWindow": 1065535,
      "maxTokens": 65535
    },
    "google/gemini-3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-omni-1.1-flash": {
      "contextWindow": 131072,
      "maxTokens": 57920
    },
    "google/gemma-4-31b": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "novita/glm-4.6v": {
      "contextWindow": 131000,
      "maxTokens": 32768
    },
    "novita/glm-4.7": {
      "contextWindow": 205000,
      "maxTokens": 131072
    },
    "novita/glm-4.7-flash": {
      "contextWindow": 200000,
      "maxTokens": 65500
    },
    "novita/glm-4.7-n": {
      "contextWindow": 205000,
      "maxTokens": 131072
    },
    "novita/glm-5": {
      "contextWindow": 205000,
      "maxTokens": 131072
    },
    "novita/kimi-k2.5": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "novita/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "novita/minimax-m2.1": {
      "contextWindow": 205000,
      "maxTokens": 131072
    },
    "openai/chatgpt-4o-latest": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "openai/gpt-3.5-turbo": {
      "contextWindow": 16384,
      "maxTokens": 2048
    },
    "openai/gpt-3.5-turbo-instruct": {
      "contextWindow": 3500,
      "maxTokens": 1024
    },
    "openai/gpt-3.5-turbo-raw": {
      "contextWindow": 4524,
      "maxTokens": 2048
    },
    "openai/gpt-4-turbo": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "openai/gpt-4o-aug": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "openai/gpt-4o-mini": {
      "contextWindow": 124096,
      "maxTokens": 4096
    },
    "openai/gpt-4o-mini-search": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "openai/gpt-4o-search": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-chat": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex-max": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-instant": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-instant": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5.2-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex-spark": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5.3-instant": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/o1": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o1-pro": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-deep-research": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-mini-high": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-pro": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o4-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o4-mini-deep-research": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "xai/grok-3": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "xai/grok-3-mini": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "xai/grok-4": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "xai/grok-4-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 128000
    },
    "xai/grok-4-fast-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 128000
    },
    "xai/grok-4.1-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "xai/grok-4.1-fast-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "xai/grok-code-fast-1": {
      "contextWindow": 256000,
      "maxTokens": 128000
    }
  },
  "poolside": {
    "poolside/laguna-m.1": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "poolside/laguna-s-2.1": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "poolside/laguna-xs-2.1": {
      "contextWindow": 262144,
      "maxTokens": 32768
    }
  },
  "powerspring": {
    "deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "gemma-4-26b-a4b": {
      "contextWindow": 262000,
      "maxTokens": 81920
    },
    "gemma-4-31b": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "gpt-oss-120b": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "gpt-oss-20b": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "qwen3.8-27b": {
      "contextWindow": 1000000,
      "maxTokens": 500000
    }
  },
  "primalabs": {
    "primalabs-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "primalabs-ai/GLM-5.3-Flash": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "primalabs-ai/Kimi-K3.1-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "primalabs-ai/MiMo-V2.6-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "primalabs-ai/Nemotron-3.5-Lightning-NVFP4": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "primalabs-ai/Nemotron-3.5-Super-VL-NVFP4": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "prime": {
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "google/gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "google/gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "google/gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "google/gemma-3-27b-it": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "meta-llama/llama-3.3-70b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 115200
    },
    "meta/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "mistralai/mistral-large-2512": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/mistral-nemo": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "mistralai/mistral-small-2603": {
      "contextWindow": 262144,
      "maxTokens": 209715
    },
    "mistralai/mixtral-8x22b-instruct": {
      "contextWindow": 65536,
      "maxTokens": 52428
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "moonshotai/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 942818
    },
    "openai/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "qwen/qwen3-30b-a3b-instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 235929
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "ricursiveai/ripple-65b-preview": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "thinkingmachines/inkling-2-small": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "thinkingmachines/inkling-2-small-fast": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "x-ai/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 450000
    },
    "x-ai/grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 450000
    },
    "z-ai/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "privatemode-ai": {
    "deepseek-ocr-2": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-flash-latest": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-latest": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-oss-120b": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "kimi-k2.6": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "kimi-latest": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "qwen3-embedding-4b": {
      "contextWindow": 32000,
      "maxTokens": 2560
    },
    "voxtral-mini-3b": {
      "contextWindow": 32000,
      "maxTokens": 32000
    },
    "whisper-large-v3": {
      "contextWindow": 448,
      "maxTokens": 448
    }
  },
  "proxystacks": {
    "deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "qihang-ai": {
    "claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-5-20251101": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-sonnet-4-5-20250929": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-flash-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3-pro-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65000
    },
    "gpt-5-mini": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    }
  },
  "qiniu-ai": {
    "MiniMax-M1": {
      "contextWindow": 1000000,
      "maxTokens": 80000
    },
    "claude-3.5-haiku": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "claude-3.5-sonnet": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "claude-3.7-sonnet": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "claude-4.0-opus": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-4.0-sonnet": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-4.1-opus": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "claude-4.5-haiku": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-4.5-opus": {
      "contextWindow": 200000,
      "maxTokens": 200000
    },
    "claude-4.5-sonnet": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "deepseek-r1": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "deepseek-r1-0528": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "deepseek-v3": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "deepseek-v3.1": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "deepseek/deepseek-math-v2": {
      "contextWindow": 160000,
      "maxTokens": 160000
    },
    "deepseek/deepseek-v3.1-terminus": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "deepseek/deepseek-v3.1-terminus-thinking": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "deepseek/deepseek-v3.2-251201": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "deepseek/deepseek-v3.2-exp": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "deepseek/deepseek-v3.2-exp-thinking": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "doubao-1.5-pro-32k": {
      "contextWindow": 128000,
      "maxTokens": 12000
    },
    "doubao-1.5-thinking-pro": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "doubao-1.5-vision-pro": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "doubao-seed-1.6": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "doubao-seed-1.6-flash": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "doubao-seed-1.6-thinking": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "doubao-seed-2.0-code": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "doubao-seed-2.0-lite": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "doubao-seed-2.0-mini": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "doubao-seed-2.0-pro": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "gemini-2.0-flash": {
      "contextWindow": 1048576,
      "maxTokens": 8192
    },
    "gemini-2.0-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 8192
    },
    "gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    },
    "gemini-2.5-flash-image": {
      "contextWindow": 65536,
      "maxTokens": 8192
    },
    "gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    },
    "gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.0-flash-preview": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "gemini-3.0-pro-image-preview": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "gemini-3.0-pro-preview": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "glm-4.5": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "glm-4.5-air": {
      "contextWindow": 131000,
      "maxTokens": 4096
    },
    "gpt-oss-20b": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "kimi-k2": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "kling-v2-6": {
      "contextWindow": 99999999,
      "maxTokens": 99999999
    },
    "meituan/longcat-flash-chat": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "meituan/longcat-flash-lite": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "mimo-v2-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "minimax/minimax-m2": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "minimax/minimax-m2.1": {
      "contextWindow": 204800,
      "maxTokens": 128000
    },
    "minimax/minimax-m2.5": {
      "contextWindow": 204800,
      "maxTokens": 128000
    },
    "minimax/minimax-m2.5-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 128000
    },
    "moonshotai/kimi-k2-0905": {
      "contextWindow": 256000,
      "maxTokens": 100000
    },
    "moonshotai/kimi-k2-thinking": {
      "contextWindow": 256000,
      "maxTokens": 100000
    },
    "moonshotai/kimi-k2.5": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "qwen-max-2025-01-25": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "qwen-turbo": {
      "contextWindow": 1000000,
      "maxTokens": 4096
    },
    "qwen-vl-max-2025-01-25": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "qwen2.5-vl-72b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "qwen3-235b-a22b": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "qwen3-235b-a22b-instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 64000
    },
    "qwen3-235b-a22b-thinking-2507": {
      "contextWindow": 262144,
      "maxTokens": 4096
    },
    "qwen3-30b-a3b": {
      "contextWindow": 40000,
      "maxTokens": 4096
    },
    "qwen3-30b-a3b-instruct-2507": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "qwen3-30b-a3b-thinking-2507": {
      "contextWindow": 126000,
      "maxTokens": 32000
    },
    "qwen3-32b": {
      "contextWindow": 40000,
      "maxTokens": 4096
    },
    "qwen3-coder-480b-a35b-instruct": {
      "contextWindow": 262000,
      "maxTokens": 4096
    },
    "qwen3-max": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3-max-preview": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "qwen3-next-80b-a3b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen3-next-80b-a3b-thinking": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "qwen3-vl-30b-a3b-thinking": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "qwen3.5-397b-a17b": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "stepfun-ai/gelab-zero-4b-preview": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "stepfun/step-3.5-flash": {
      "contextWindow": 64000,
      "maxTokens": 4096
    },
    "x-ai/grok-4-fast": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "x-ai/grok-4-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "x-ai/grok-4-fast-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "x-ai/grok-4.1-fast": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "x-ai/grok-4.1-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "x-ai/grok-4.1-fast-reasoning": {
      "contextWindow": 20000000,
      "maxTokens": 2000000
    },
    "x-ai/grok-code-fast-1": {
      "contextWindow": 256000,
      "maxTokens": 10000
    },
    "z-ai/autoglm-phone-9b": {
      "contextWindow": 12800,
      "maxTokens": 4096
    },
    "z-ai/glm-4.6": {
      "contextWindow": 200000,
      "maxTokens": 200000
    },
    "z-ai/glm-4.7": {
      "contextWindow": 200000,
      "maxTokens": 200000
    },
    "z-ai/glm-5": {
      "contextWindow": 200000,
      "maxTokens": 128000
    }
  },
  "qvac": {
    "gemma4-31b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "qwen3.5-0.8b": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "qwen3.5-2b": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "qwen3.5-4b": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "qwen3.5-9b": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "qwen3.6-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    }
  },
  "rayline": {
    "arc-sage-1.0": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "arc-swift-1.0": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    }
  },
  "reflection": {
    "Beam-1.0-501B-A23B": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "refuseless": {
    "deepseek-v4.1-flash-abliterated": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "deepseek-v4.1-flash-abliterated-free": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "deepseek-v4.1-flash-fast": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "glm-5.3-abliterated": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.3-flash-abliterated": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    }
  },
  "regolo-ai": {
    "apertus-70b": {
      "contextWindow": 30000,
      "maxTokens": 30000
    },
    "brick-complexity-pro": {
      "contextWindow": 100000,
      "maxTokens": 15000
    },
    "brick-v1-beta": {
      "contextWindow": 100000,
      "maxTokens": 15000
    },
    "deepseek-ocr-2": {
      "contextWindow": 4000,
      "maxTokens": 4000
    },
    "faster-whisper-large-v3": {
      "contextWindow": 448,
      "maxTokens": 448
    },
    "gemma4-31b": {
      "contextWindow": 100000,
      "maxTokens": 100000
    },
    "glm5.2": {
      "contextWindow": 96000,
      "maxTokens": 96000
    },
    "gpt-oss-120b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "gpt-oss-20b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "llama-3.3-70b-instruct": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "mistral-small-4-119b": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "qwen-image": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "qwen3-coder-next": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "qwen3-embedding-8b": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "qwen3-reranker-4b": {
      "contextWindow": 32768,
      "maxTokens": 8192
    },
    "qwen3.5-122b": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "qwen3.5-9b": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "qwen3.8-27b": {
      "contextWindow": 120000,
      "maxTokens": 120000
    }
  },
  "requesty": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5.1@eu": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5@eu": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-4-5@eu": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-5-5@eu": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-5@eu": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-6@eu": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7@eu": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8@eu": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5@eu": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5@eu": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-5@eu": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6@eu": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5@eu": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5@eu": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "deepseek-v4-flash-0731@eu": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro-0813@eu": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepseek-v4-pro@eu": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek-v4.1-flash-1017@eu": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "deepseek-v4.1-flash@eu": {
      "contextWindow": 1048576,
      "maxTokens": 393216
    },
    "devstral-latest": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "devstral-latest@eu": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "fugu-ultra": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "gemini-2.5-flash-lite@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-2.5-flash@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-2.5-pro@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3-pro-image": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "gemini-3.1-flash-image": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.1-flash-lite@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.5-flash-lite@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.5-flash@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.7-flash@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-3.8-flash@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-argon@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-carbon@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-hydrogen@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-hydrogen@us": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-neon@eu": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-neon@us": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemma-4-26b-a4b-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.2@eu": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "glm-5.3-flash@eu": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "glm-5.3@eu": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "gpt-4.1-mini@eu": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-nano@eu": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1@eu": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4o-mini@eu": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "gpt-5-mini@eu": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "gpt-5-nano@eu": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "gpt-5.1@eu": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4@eu": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5@eu": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna@eu": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol@eu": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra@eu": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5@eu": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna@eu": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol@eu": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol@eu": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-terra@eu": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-astra@eu": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-sol@eu": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "grok-4.2-beta": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "hy3": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "inkling": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "inkling-256k": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "kimi-k2.5@eu": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code@eu": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro-highspeed": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro@eu": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "kimi-k3@eu": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "mimo-v2.5": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "mimo-v2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax-m3": {
      "contextWindow": 512000,
      "maxTokens": 512000
    },
    "minimax-m3.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "minimax-m3.1-flash@eu": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "minimax-m3@eu": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "mistral-large-4": {
      "contextWindow": 524288,
      "maxTokens": 262144
    },
    "mistral-large-4@eu": {
      "contextWindow": 524288,
      "maxTokens": 262144
    },
    "mistral-medium-3-5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral-medium-3-5@eu": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistral-medium-latest": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "mistral-medium-latest@eu": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "mistral-small-2603": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "mistral-small-2603@eu": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "muse-glimmer-30b": {
      "contextWindow": 131072,
      "maxTokens": 20480
    },
    "muse-spark-1.3": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-wonder-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "nemotron-3-nano-omni-30b-a3b-reasoning": {
      "contextWindow": 131072,
      "maxTokens": 20480
    },
    "nemotron-3-ultra-550b-a55b": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "nemotron-3-ultra-nvfp4": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nemotron-3.5-lightning-30b-a3b": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "nemotron-lightning-3.5-30b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia-nemotron-3-super-120b-a12b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia-nemotron-3-ultra": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "o4-mini@eu": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "qwen3.5-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.5-2b": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "qwen3.5-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.7-max": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "qwen3.7-plus": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "qwen3.8-2.4T-A95B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen3.8-2.4T-A95B@eu": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "qwen3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "qwen3.8-flash-next": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen3.8-flash-next@eu": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen3.8-max": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "seed-1.8": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "seed-2.0-code": {
      "contextWindow": 256000,
      "maxTokens": 131072
    },
    "seed-2.0-mini": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "seed-2.0-pro": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "step-3.7-flash": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "step-5-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    }
  },
  "routing-run": {
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 32000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "glm-5.2": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "glm-5.2-nitro": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "kimi-k2.6": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "kimi-k2.6-nitro": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "kimi-k2.7-code": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "kimi-k2.7-code-nitro": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "nemotron-3-ultra": {
      "contextWindow": 131072,
      "maxTokens": 32000
    },
    "qwen3.5-9b": {
      "contextWindow": 262144,
      "maxTokens": 32000
    }
  },
  "ruapi": {
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  },
  "runcrate": {
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.8-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "deepseek-ai/DeepSeek-V3.2": {
      "contextWindow": 163840,
      "maxTokens": 16384
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "meta-llama/Llama-3.3-70B-Instruct-Turbo": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "moonshotai/Kimi-K2.6": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "runinfra": {
    "Inferact/Qwen3.8-2.4T-A95B-NVFP4": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Qwen/Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "ornith-ai/Ornith-1.5-35B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "stepfun-ai/Step-5-Preview": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    }
  },
  "sagg": {
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 400000,
      "maxTokens": 16000
    }
  },
  "sakana": {
    "fugu": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "fugu-ultra": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "fugu-ultra-20260615": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "sakana-namazu": {
      "contextWindow": 262144,
      "maxTokens": 65536
    }
  },
  "salad-cloud": {
    "qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    }
  },
  "sambanova": {
    "GLM-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "MiniMax-M3.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "gemma-4-31B-it": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    }
  },
  "sandbase": {
    "alibaba/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "alibaba/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "sap-ai-core": {
    "amazon--nova-lite": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "amazon--nova-micro": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "amazon--nova-pro": {
      "contextWindow": 300000,
      "maxTokens": 8192
    },
    "amazon--titan-embed-text": {
      "contextWindow": 8192,
      "maxTokens": 1536
    },
    "anthropic--claude-3-haiku": {
      "contextWindow": 200000,
      "maxTokens": 4096
    },
    "anthropic--claude-4-opus": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "anthropic--claude-4-sonnet": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic--claude-4.5-haiku": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic--claude-4.5-opus": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic--claude-4.5-sonnet": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic--claude-4.6-opus": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic--claude-4.6-sonnet": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic--claude-4.7-opus": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic--claude-4.8-opus": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "cohere--command-a-reasoning": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-embedding": {
      "contextWindow": 2048,
      "maxTokens": 1
    },
    "gemini-embedding-2": {
      "contextWindow": 8192,
      "maxTokens": 3072
    },
    "gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "mistralai--mistral-medium": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "mistralai--mistral-medium-instruct": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "mistralai--mistral-small": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "nvidia--llama-3.2-nv-embedqa-1b": {
      "contextWindow": 8192,
      "maxTokens": 4096
    },
    "nvidia--llama-nemotron-embed-1b": {
      "contextWindow": 8192,
      "maxTokens": 2048
    },
    "sap-abap-1": {
      "contextWindow": 32768,
      "maxTokens": 4096
    },
    "sonar": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "sonar-deep-research": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "sonar-pro": {
      "contextWindow": 200000,
      "maxTokens": 8192
    },
    "text-embedding-3-large": {
      "contextWindow": 8191,
      "maxTokens": 3072
    },
    "text-embedding-3-small": {
      "contextWindow": 8191,
      "maxTokens": 1536
    }
  },
  "sarvam": {
    "deepseekv4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseekv4.1-flash-1017-interactive": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "gemma4": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "glm5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "sarvam-105b": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "sarvam-105b-conversations": {
      "contextWindow": 32000,
      "maxTokens": 32000
    }
  },
  "scaleway": {
    "deepseek-v4-flash-0731": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "gemma-4-26b-a4b-it": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "glm-5.2": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "glm-5.3": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "gpt-oss-120b": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "lightonocr-3-0.8b": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "llama-3.3-70b-instruct": {
      "contextWindow": 100000,
      "maxTokens": 16384
    },
    "mistral-medium-3.5-128b": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "mistral-small-3.2-24b-instruct-2506": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "qwen3-235b-a22b-instruct-2507": {
      "contextWindow": 260000,
      "maxTokens": 16384
    },
    "qwen3.5-397b-a17b": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "qwen3.6-35b-a3b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    }
  },
  "scnet-token-plan": {
    "DeepSeek-V4-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "DeepSeek-V4-Flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "DeepSeek-V4-Pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "DeepSeek-V4-Pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "DeepSeek-V4.1-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "GLM-5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "GLM-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "GLM-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "GLM-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "GLM-5.3-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Kimi-K2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Kimi-K2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Kimi-K2.7-Code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Kimi-K3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "MiniMax-M2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "MiniMax-M3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "Qwen3.8-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Qwen3.8-Max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "scx-ai": {
    "DeepSeek-V4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "DeepSeek-V4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "DeepSeek-V4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "DeepSeek-V4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "GLM-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "GLM-5.2-Fast": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "GLM-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "GLM-5.3-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Kimi-K2.7-Code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Kimi-K3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "Kimi-K3.1-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "MiniMax-M2.7": {
      "contextWindow": 196608,
      "maxTokens": 196608
    },
    "Qwen3.8-Max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    }
  },
  "sensenova": {
    "deepseek-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "sensenova-6.8-flash-lite": {
      "contextWindow": 262144,
      "maxTokens": 65536
    }
  },
  "siliconflow": {
    "ByteDance-Seed/Seed-OSS-36B-Instruct": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "MiniMaxAI/MiniMax-M2.5": {
      "contextWindow": 197000,
      "maxTokens": 131000
    },
    "MiniMaxAI/MiniMax-M3": {
      "contextWindow": 1048576,
      "maxTokens": 131000
    },
    "Qwen/Qwen2.5-72B-Instruct": {
      "contextWindow": 33000,
      "maxTokens": 4000
    },
    "Qwen/Qwen2.5-7B-Instruct": {
      "contextWindow": 33000,
      "maxTokens": 4000
    },
    "Qwen/Qwen3-14B": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "Qwen/Qwen3-30B-A3B-Instruct-2507": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3-32B": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "Qwen/Qwen3-8B": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "Qwen/Qwen3-Coder-30B-A3B-Instruct": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3-VL-30B-A3B-Instruct": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3-VL-30B-A3B-Thinking": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3-VL-32B-Instruct": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3-VL-32B-Thinking": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3-VL-8B-Instruct": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3.5-122B-A10B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen/Qwen3.5-27B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen/Qwen3.5-35B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen/Qwen3.5-397B-A17B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen/Qwen3.5-9B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen/Qwen3.6-27B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen/Qwen3.6-35B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen/Qwen3.8-2.4T-A95B": {
      "contextWindow": 1049000,
      "maxTokens": 131000
    },
    "deepseek-ai/DeepSeek-R1": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "deepseek-ai/DeepSeek-V3": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "deepseek-ai/DeepSeek-V3.1": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "deepseek-ai/DeepSeek-V3.1-Terminus": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "deepseek-ai/DeepSeek-V3.2": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "deepseek-ai/DeepSeek-V3.2-Exp": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/gemma-4-12B-it": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "google/gemma-4-26B-A4B-it": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "google/gemma-4-31B-it": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "inclusionAI/Ling-flash-2.0": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "meituan-longcat/LongCat-2.0": {
      "contextWindow": 1049000,
      "maxTokens": 131072
    },
    "moonshotai/Kimi-K2.5": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "moonshotai/Kimi-K2.6": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "moonshotai/Kimi-K2.7-Code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/Kimi-K3": {
      "contextWindow": 1048576,
      "maxTokens": 262000
    },
    "nex-agi/Nex-N2-Pro": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131000,
      "maxTokens": 8000
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131000,
      "maxTokens": 8000
    },
    "stepfun-ai/Step-3.5-Flash": {
      "contextWindow": 262000,
      "maxTokens": 66000
    },
    "tencent/Hunyuan-A13B-Instruct": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "tencent/Hy3": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "zai-org/GLM-4.5-Air": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "zai-org/GLM-5": {
      "contextWindow": 205000,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.1": {
      "contextWindow": 205000,
      "maxTokens": 131000
    },
    "zai-org/GLM-5.2": {
      "contextWindow": 1049000,
      "maxTokens": 262000
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1049000,
      "maxTokens": 262000
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1049000,
      "maxTokens": 262000
    },
    "zai-org/GLM-5V-Turbo": {
      "contextWindow": 200000,
      "maxTokens": 131072
    }
  },
  "siliconflow-cn": {
    "ByteDance-Seed/Seed-OSS-36B-Instruct": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "PaddlePaddle/PaddleOCR-VL-1.5": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "Pro/deepseek-ai/DeepSeek-R1": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "Pro/deepseek-ai/DeepSeek-V3": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "Pro/deepseek-ai/DeepSeek-V3.1-Terminus": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "Pro/deepseek-ai/DeepSeek-V3.2": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "Pro/moonshotai/Kimi-K2.5": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Pro/moonshotai/Kimi-K2.6": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Pro/zai-org/GLM-5": {
      "contextWindow": 205000,
      "maxTokens": 205000
    },
    "Pro/zai-org/GLM-5.1": {
      "contextWindow": 205000,
      "maxTokens": 205000
    },
    "Qwen/Qwen2.5-72B-Instruct": {
      "contextWindow": 33000,
      "maxTokens": 4000
    },
    "Qwen/Qwen2.5-7B-Instruct": {
      "contextWindow": 33000,
      "maxTokens": 4000
    },
    "Qwen/Qwen3-14B": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "Qwen/Qwen3-30B-A3B-Instruct-2507": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3-32B": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "Qwen/Qwen3-8B": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "Qwen/Qwen3-Coder-30B-A3B-Instruct": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3-VL-30B-A3B-Instruct": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3-VL-30B-A3B-Thinking": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3-VL-32B-Instruct": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3-VL-32B-Thinking": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3-VL-8B-Instruct": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "Qwen/Qwen3.5-122B-A10B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.5-27B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.5-35B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.5-4B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.5-9B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.6-27B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.6-35B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "deepseek-ai/DeepSeek-OCR": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "deepseek-ai/DeepSeek-R1": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "deepseek-ai/DeepSeek-V3": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "deepseek-ai/DeepSeek-V3.1-Terminus": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "deepseek-ai/DeepSeek-V3.2": {
      "contextWindow": 164000,
      "maxTokens": 164000
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
      "contextWindow": 1049000,
      "maxTokens": 393000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "inclusionAI/Ling-flash-2.0": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "stepfun-ai/Step-3.5-Flash": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "tencent/Hunyuan-A13B-Instruct": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "zai-org/GLM-4.5-Air": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "zai-org/GLM-4.5V": {
      "contextWindow": 65536,
      "maxTokens": 16384
    },
    "zai-org/GLM-5.2": {
      "contextWindow": 1049000,
      "maxTokens": 262000
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "snowflake-cortex": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "deepseek-r1": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "gemini-3.1-pro": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "mistral-large2": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "openai-gpt-4.1": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "openai-gpt-5": {
      "contextWindow": 272000,
      "maxTokens": 8192
    },
    "openai-gpt-5-mini": {
      "contextWindow": 272000,
      "maxTokens": 8192
    },
    "openai-gpt-5-nano": {
      "contextWindow": 272000,
      "maxTokens": 8192
    },
    "openai-gpt-5.1": {
      "contextWindow": 272000,
      "maxTokens": 8192
    },
    "openai-gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai-gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "snowflake-llama3.3-70b": {
      "contextWindow": 128000,
      "maxTokens": 4096
    }
  },
  "sokkan": {
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "qwen/qwen3.5-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3.6-35b-a3b-eu": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 131072,
      "maxTokens": 32768
    }
  },
  "sparrowcodes": {
    "anthropic/claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "google/gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "qwen/qwen3.7-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "sparrow/auto": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "xiaomi/mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "z-ai/glm-4.7-flash": {
      "contextWindow": 200000,
      "maxTokens": 65536
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "stackit": {
    "Qwen/Qwen3-VL-235B-A22B-Instruct-FP8": {
      "contextWindow": 218000,
      "maxTokens": 16384
    },
    "Qwen/Qwen3-VL-Embedding-8B": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "Qwen/Qwen3.6-27B": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "cortecs/Llama-3.3-70B-Instruct-FP8-Dynamic": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "google/gemma-3-27b-it": {
      "contextWindow": 37000,
      "maxTokens": 4096
    },
    "intfloat/e5-mistral-7b-instruct": {
      "contextWindow": 4096,
      "maxTokens": 4096
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131000,
      "maxTokens": 8192
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 8192
    }
  },
  "standardcompute": {
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "anthropic/claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "anthropic/claude-haiku-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "anthropic/claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "anthropic/claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "google/gemini-2.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 50000
    },
    "google/gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 50000
    },
    "google/gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 50000
    },
    "google/gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 50000
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 50000
    },
    "minimax/minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 50000
    },
    "mistralai/mistral-large-4-0": {
      "contextWindow": 1048576,
      "maxTokens": 50000
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 50000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 50000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 50000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 50000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 50000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 50000
    },
    "qwen/qwen3.7-flash": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "qwen/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "qwen/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "qwen/qwen3.8-max-0902": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "standardcompute": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "x-ai/grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "xiaomi/mimo-v2.5": {
      "contextWindow": 1048576,
      "maxTokens": 50000
    },
    "xiaomi/mimo-v2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 50000
    },
    "xiaomi/mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 50000
    },
    "xiaomi/mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 50000
    },
    "z-ai/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 50000
    }
  },
  "steadyrouter": {
    "MiniMax-M3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "stepfun": {
    "step-1o-turbo-vision": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "step-3.5-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "step-3.5-flash-2603": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "step-3.7-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    }
  },
  "stepfun-ai": {
    "step-1o-turbo-vision": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "step-3.5-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "step-3.5-flash-2603": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "step-3.7-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "step-5-preview": {
      "contextWindow": 1024000,
      "maxTokens": 65536
    }
  },
  "stepfun-ai-step-plan": {
    "step-3.5-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "step-3.5-flash-2603": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "step-3.7-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    }
  },
  "stepfun-step-plan": {
    "step-3.5-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "step-3.5-flash-2603": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "step-3.7-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "step-router-v1": {
      "contextWindow": 256000,
      "maxTokens": 65536
    }
  },
  "stepping-stone": {
    "MiniMaxAI/MiniMax-M2.5": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "NVIDIA/NVIDIA-Nemotron-3-Super-120B-A12B": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "Qwen/Qwen3-Coder-Next": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.5-35B-A3B-FP8": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "allenai/olmOCR-2-7B": {
      "contextWindow": 8192,
      "maxTokens": 8192
    },
    "apertus-ai/Apertus-v1.5-8B": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 524288,
      "maxTokens": 384000
    },
    "google/gemma-4-31B-it": {
      "contextWindow": 163840,
      "maxTokens": 32768
    },
    "lightonai/LightOnOCR-2-1B": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "opendatalab/MinerU2.5-2509-1.2B": {
      "contextWindow": 16384,
      "maxTokens": 16384
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 262144,
      "maxTokens": 131072
    }
  },
  "subconscious": {
    "subconscious/deepseek-v4.1-flash-marathon": {
      "contextWindow": 5000000,
      "maxTokens": 384000
    },
    "subconscious/glm-5.3-marathon": {
      "contextWindow": 5000000,
      "maxTokens": 131072
    }
  },
  "submodel": {
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "Qwen/Qwen3-235B-A22B-Thinking-2507": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "deepseek-ai/DeepSeek-R1-0528": {
      "contextWindow": 75000,
      "maxTokens": 75000
    },
    "deepseek-ai/DeepSeek-V3-0324": {
      "contextWindow": 75000,
      "maxTokens": 75000
    },
    "deepseek-ai/DeepSeek-V3.1": {
      "contextWindow": 75000,
      "maxTokens": 75000
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "zai-org/GLM-4.5-Air": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "zai-org/GLM-4.5-FP8": {
      "contextWindow": 131072,
      "maxTokens": 131072
    }
  },
  "superbot-gg": {
    "superbot": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "superbot-fast": {
      "contextWindow": 500000,
      "maxTokens": 131072
    }
  },
  "synthetic": {
    "hf:Qwen/Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 524288,
      "maxTokens": 65536
    },
    "hf:moonshotai/Kimi-K3": {
      "contextWindow": 524288,
      "maxTokens": 65536
    },
    "hf:moonshotai/Kimi-K3.1-Pro": {
      "contextWindow": 524288,
      "maxTokens": 65536
    },
    "hf:openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "hf:zai-org/GLM-4.7-Flash": {
      "contextWindow": 196608,
      "maxTokens": 65536
    },
    "hf:zai-org/GLM-5.3": {
      "contextWindow": 524288,
      "maxTokens": 65536
    },
    "hf:zai-org/GLM-5.3-Flash": {
      "contextWindow": 524288,
      "maxTokens": 65536
    }
  },
  "synthorai": {
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "teamorouter": {
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "teapot-router": {
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  },
  "tencent-coding-plan": {
    "tc-code-latest": {
      "contextWindow": 131072,
      "maxTokens": 16384
    }
  },
  "tencent-token-plan": {
    "deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5-3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "hy3": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "hy3-202608": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "hy4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax-m-3-0": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    }
  },
  "tencent-tokenhub": {
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "hy3": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "hy4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k2.8-preview": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "minimax-m3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    }
  },
  "tensorx": {
    "deepseek/deepseek-r1-0528": {
      "contextWindow": 164000,
      "maxTokens": 8192
    },
    "deepseek/deepseek-v3.2": {
      "contextWindow": 163840,
      "maxTokens": 163840
    },
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "minimax/minimax-m2.5": {
      "contextWindow": 196608,
      "maxTokens": 65536
    },
    "minimax/minimax-m3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "moonshotai/kimi-k2.5": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "qwen/qwen3-235b-a22b-2507": {
      "contextWindow": 131000,
      "maxTokens": 131000
    },
    "qwen/qwen3.5-122b-a10b": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "qwen/qwen3.5-9b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen/qwen3.8-2.4t-a95b": {
      "contextWindow": 262144,
      "maxTokens": 64000
    },
    "qwen/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen/qwen3.8-flash-next": {
      "contextWindow": 262144,
      "maxTokens": 64000
    },
    "z-ai/glm-5": {
      "contextWindow": 202752,
      "maxTokens": 202752
    },
    "z-ai/glm-5-turbo": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "z-ai/glm-5.1": {
      "contextWindow": 202752,
      "maxTokens": 202752
    },
    "z-ai/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    },
    "z-ai/glm-5v-turbo": {
      "contextWindow": 202752,
      "maxTokens": 131072
    }
  },
  "tenstorrent": {
    "MiniMaxAI/MiniMax-M3.1-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "Qwen/Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1044480,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 262000,
      "maxTokens": 131000
    }
  },
  "the-grid-ai": {
    "agent-max": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "agent-prime": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "agent-standard": {
      "contextWindow": 128000,
      "maxTokens": 65536
    },
    "bytedance-pro-latest": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "claude-opus-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "code-max": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "code-prime": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "code-standard": {
      "contextWindow": 128000,
      "maxTokens": 65536
    },
    "deepseek-pro-latest": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gemini-pro-latest": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "glm-latest": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "gpt-sol-latest": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "kimi-latest": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "minimax-latest": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "text-max": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "text-prime": {
      "contextWindow": 196608,
      "maxTokens": 131072
    },
    "text-standard": {
      "contextWindow": 128000,
      "maxTokens": 65536
    }
  },
  "therouter": {
    "openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    }
  },
  "thinkingmachines": {
    "Qwen/Qwen3-8B": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "Qwen/Qwen3.5-35B-A3B-Base": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.5-397B-A17B": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.5-397B-A17B:peft:262144": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen/Qwen3.5-4B": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.5-4B:peft:262144": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen/Qwen3.5-9B": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.5-9B-Base": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.6-35B-A3B": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.6-35B-A3B:peft:262144": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen/Qwen3.8-27B": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.8-27B:peft:262144": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017:peft:262144": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "deepseek-ai/DeepSeek-V4.1-Flash:peft:262144": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/Kimi-K2.6": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "moonshotai/Kimi-K2.6:peft:131072": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "moonshotai/Kimi-K3.1-Pro:peft:262144": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16:peft:262144": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16:peft:262144": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16:peft:262144": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16:peft:262144": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "openai/gpt-oss-120b:peft:131072": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "thinkingmachines/Inkling": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "thinkingmachines/Inkling-2-Mini": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "thinkingmachines/Inkling-2-Mini:peft:262144": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "thinkingmachines/Inkling-2-Small": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "thinkingmachines/Inkling-2-Small:peft:262144": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "thinkingmachines/Inkling-Small": {
      "contextWindow": 65536,
      "maxTokens": 65536
    },
    "thinkingmachines/Inkling-Small:peft:262144": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "thinkingmachines/Inkling-Small:peft:262144:sampling-nvfp4": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "thinkingmachines/Inkling:peft:262144": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "thinkingmachines/Inkling:peft:262144:sampling-nvfp4": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "zai-org/GLM-5.3-Flash:peft:262144": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "zai-org/GLM-5.3:peft:262144": {
      "contextWindow": 262144,
      "maxTokens": 262144
    }
  },
  "tinfoil": {
    "deepseek-v4-1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "gemma4-31b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "glm-5-3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "gpt-oss-safeguard-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "inkling-2-small": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "kimi-k3-1-pro": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "llama3-3-70b": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "nomic-embed-text": {
      "contextWindow": 8192,
      "maxTokens": 768
    }
  },
  "toapis": {
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  },
  "togetherai": {
    "MiniMaxAI/MiniMax-M3.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "Prism-ML/Ternary-Bonsai-27B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.5-9B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.6-Plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.7-Max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Qwen/Qwen3.7-Plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "Qwen/Qwen3.8-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Qwen/Qwen4-Max": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017-fast": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "elorian-labs/glimpse-1.0": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "meta-models/Muse-Glimmer-30B": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "meta-models/Muse-Spark-Open-816B-A42B": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "moonshotai/Kimi-K3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/Kimi-K3.1-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nvidia/NVIDIA-Nemotron-3.5-Super-VL": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "reflection/Beam-1.0-501B-A23B": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "ricursive-ai/Ripple-65B-Preview": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "tencent/Hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "thinkingmachines/Inkling": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "thinkingmachines/Inkling-2-Small": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.2": {
      "contextWindow": 1048575,
      "maxTokens": 164000
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1048575,
      "maxTokens": 262144
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1048575,
      "maxTokens": 400000
    }
  },
  "tokengo": {
    "deepseek/deepseek-v3.1": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "deepseek/deepseek-v3.2": {
      "contextWindow": 128000,
      "maxTokens": 64000
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "minimax/minimax-m2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "moonshotai/kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "qwen/qwen3.5-397b-a17b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "z-ai/glm-5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "z-ai/glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "tokenify": {
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "z-ai/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "tokenlab": {
    "grok-4.20-non-reasoning": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    }
  },
  "tokenrouter": {
    "z-ai/glm-5.3-free": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "tokenwatt": {
    "qwen/qwen3-coder-30b-a3b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 65536
    }
  },
  "trustedrouter": {
    "trustedrouter/auto": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "trustedrouter/cheap": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "trustedrouter/e2e": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "trustedrouter/fast": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "trustedrouter/synth": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "trustedrouter/synth-code": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "trustedrouter/zdr": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "trustedtokens": {
    "Qwen/Qwen3.6-35B-A3B-FP8": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/diffusiongemma-26B-A4B-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "google/gemma-4-26B-A4B-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 230000,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "umans-ai": {
    "umans-coder": {
      "contextWindow": 1048576,
      "maxTokens": 393215
    },
    "umans-deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 393215
    },
    "umans-deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 393215
    },
    "umans-deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 393215
    },
    "umans-flash": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "umans-glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131071
    },
    "umans-glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131071
    },
    "umans-kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 131071
    },
    "umans-kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131071
    }
  },
  "unbiased": {
    "pareto": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "uncensuredai": {
    "deepseek-v4.1-flash-abliterated": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-abliterated": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.3-flash-abliterated": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "unorouter": {
    "claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-flash:free": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro:free": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemma-4-31b-it:free": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "glm-4.5-flash:free": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.2:free": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4:free": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.5:free": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "kimi-k2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m2.7:free": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "nemotron-3-ultra-550b-a55b:free": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "qwen3.5-397b-a17b:free": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "step-3.7-flash:free": {
      "contextWindow": 256000,
      "maxTokens": 256000
    }
  },
  "unrestricted": {
    "deepseek-v4.1-flash-uncensored": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "glm-5.3-flash-uncensored": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "mimo-v2.6-flash-uncensored": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "qwen3.8-27b-uncensored": {
      "contextWindow": 262144,
      "maxTokens": 32768
    }
  },
  "uplinkswitch": {
    "gemini-3.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-argon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "upstage": {
    "solar-mini": {
      "contextWindow": 32768,
      "maxTokens": 4096
    },
    "solar-mini4": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "solar-pro2": {
      "contextWindow": 65536,
      "maxTokens": 8192
    },
    "solar-pro3": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "solar-pro4": {
      "contextWindow": 524288,
      "maxTokens": 131072
    }
  },
  "vancine": {
    "MiniMax-M3": {
      "contextWindow": 1048576,
      "maxTokens": 512000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "venice": {
    "abliteration-abliterated-model-large-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "abliteration-abliterated-model-large-v2": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "aion-labs-aion-3-0": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "aion-labs-aion-3-0-mini": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "aion-labs-aion-3-5": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "aion-labs-aion-3-5-mini": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-5": {
      "contextWindow": 198000,
      "maxTokens": 32768
    },
    "claude-opus-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5-fast": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-fast": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v3.2": {
      "contextWindow": 160000,
      "maxTokens": 32768
    },
    "deepseek-v4-1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "deepseek-v4-1-flash-1017": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "deepseek-v4-1-flash-1017-ultrafast": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "deepseek-v4-1-flash-1017-uncensored": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "deepseek-v4-1-flash-uncensored": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "deepseek-v4-flash-0731-fast": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "gemini-3-1-pro-preview": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "gemini-3-5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemini-3-5-flash-lite": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemini-3-6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemini-3-7-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemini-3-8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemini-3-flash-preview": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "gemini-4-argon": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemini-4-carbon": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemini-4-hydrogen": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemini-4-neon": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gemma-4-uncensored": {
      "contextWindow": 256000,
      "maxTokens": 8192
    },
    "glm-5-3-flash-uncensored": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "google-gemma-3-27b-it": {
      "contextWindow": 198000,
      "maxTokens": 16384
    },
    "google-gemma-4-26b-a4b-it": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "google-gemma-4-31b-it": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "grok-4-20": {
      "contextWindow": 2000000,
      "maxTokens": 128000
    },
    "grok-4-20-multi-agent": {
      "contextWindow": 2000000,
      "maxTokens": 128000
    },
    "grok-4-3": {
      "contextWindow": 1000000,
      "maxTokens": 32000
    },
    "grok-4-5": {
      "contextWindow": 500000,
      "maxTokens": 32000
    },
    "grok-4-6": {
      "contextWindow": 500000,
      "maxTokens": 200000
    },
    "grok-4-7": {
      "contextWindow": 500000,
      "maxTokens": 200000
    },
    "hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    },
    "inkling-2-mini": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "kimi-k2-6": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "kimi-k2-7-code": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "kimi-k3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k3-1-pro": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k3-1-pro-highspeed": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k3-fast-api": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "llama-3.2-3b": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "llama-3.3-70b": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "minimax-m25": {
      "contextWindow": 198000,
      "maxTokens": 32768
    },
    "minimax-m27": {
      "contextWindow": 198000,
      "maxTokens": 32768
    },
    "minimax-m3-1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "minimax-m3-preview": {
      "contextWindow": 524288,
      "maxTokens": 131072
    },
    "mistral-small-3-2-24b-instruct": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-wonder": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "nvidia-nemotron-3-5-super-vl-120b-a12b": {
      "contextWindow": 262144,
      "maxTokens": 102400
    },
    "nvidia-nemotron-3-nano-30b-a3b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "nvidia-nemotron-3-ultra-550b-a55b": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "olafangensan-glm-4.7-flash-heretic": {
      "contextWindow": 200000,
      "maxTokens": 24000
    },
    "openai-gpt-4o-2024-11-20": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai-gpt-4o-mini-2024-07-18": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai-gpt-52": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "openai-gpt-53-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai-gpt-54": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "openai-gpt-54-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai-gpt-54-pro": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai-gpt-55": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "openai-gpt-55-pro": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai-gpt-56-luna": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai-gpt-56-luna-pro": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai-gpt-56-sol": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai-gpt-56-sol-pro": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai-gpt-56-terra": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai-gpt-56-terra-pro": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai-gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-6-astra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-61-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-61-sol-ultrafast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-61-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-62-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-62-astra-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-62-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-62-sol-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai-gpt-oss-120b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "pareto": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "qwen-3-6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen-3-7-max": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen-3-7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen-3-8-2-4t-a95b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen-3-8-27b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen-3-8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen-3-8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen-4-max": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "qwen3-235b-a22b-instruct-2507": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "qwen3-235b-a22b-thinking-2507": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "qwen3-5-35b-a3b": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "qwen3-5-397b-a17b": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "qwen3-6-27b": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "qwen3-6-35b-a3b": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "qwen3-coder-480b-a35b-instruct-turbo": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "qwen3-next-80b": {
      "contextWindow": 256000,
      "maxTokens": 16384
    },
    "qwen3-vl-235b-a22b": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "seed-2-1-turbo": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "venice-uncensored-1-2": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "venice-uncensored-role-play": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "xiaomi-mimo-v2-5": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "xiaomi-mimo-v2-6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai-glm-5-3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "z-ai-glm-5-3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai-glm-5-turbo": {
      "contextWindow": 200000,
      "maxTokens": 32768
    },
    "z-ai-glm-5v-turbo": {
      "contextWindow": 200000,
      "maxTokens": 32768
    },
    "zai-org-glm-4.6": {
      "contextWindow": 198000,
      "maxTokens": 16384
    },
    "zai-org-glm-4.7": {
      "contextWindow": 198000,
      "maxTokens": 16384
    },
    "zai-org-glm-5": {
      "contextWindow": 198000,
      "maxTokens": 32000
    },
    "zai-org-glm-5-1": {
      "contextWindow": 200000,
      "maxTokens": 80000
    },
    "zai-org-glm-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "vercel": {
    "alibaba/qwen-3-14b": {
      "contextWindow": 40960,
      "maxTokens": 16384
    },
    "alibaba/qwen-3-30b": {
      "contextWindow": 40960,
      "maxTokens": 16384
    },
    "alibaba/qwen-3-32b": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "alibaba/qwen3-coder-30b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "alibaba/qwen3-coder-next": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "alibaba/qwen3-next-80b-a3b-instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "alibaba/qwen3-vl-instruct": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "alibaba/qwen3.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "alibaba/qwen3.5-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "alibaba/qwen3.6-27b": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "alibaba/qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "alibaba/qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "alibaba/qwen3.7-flash": {
      "contextWindow": 991000,
      "maxTokens": 64000
    },
    "alibaba/qwen3.7-max": {
      "contextWindow": 991000,
      "maxTokens": 64000
    },
    "alibaba/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "alibaba/qwen3.8-2.4t-a95b": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "alibaba/qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "alibaba/qwen3.8-flash": {
      "contextWindow": 991000,
      "maxTokens": 128000
    },
    "alibaba/qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "alibaba/qwen3.8-max-0902": {
      "contextWindow": 991000,
      "maxTokens": 128000
    },
    "alibaba/qwen3.8-max-prime": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "alibaba/qwen3.8-omni-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "alibaba/qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "amazon/nova-2-lite": {
      "contextWindow": 1000000,
      "maxTokens": 65535
    },
    "amazon/nova-lite": {
      "contextWindow": 300000,
      "maxTokens": 8192
    },
    "amazon/nova-micro": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "amazon/nova-pro": {
      "contextWindow": 300000,
      "maxTokens": 8192
    },
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.2-fast": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-haiku-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8-fast": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5-fast": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5.5-fast": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4.5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "bfl/flux-2-max": {
      "contextWindow": 67300,
      "maxTokens": 67300
    },
    "bfl/flux-2-pro": {
      "contextWindow": 67300,
      "maxTokens": 67300
    },
    "bytedance/seed-2.1-turbo": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "callstack/apex": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "cohere/command-a": {
      "contextWindow": 256000,
      "maxTokens": 8000
    },
    "cohere/embed-v4.0": {
      "contextWindow": 128000,
      "maxTokens": 1536
    },
    "cohere/embed-v5.0-fast": {
      "contextWindow": 128000,
      "maxTokens": 2048
    },
    "cohere/embed-v5.0-pro": {
      "contextWindow": 128000,
      "maxTokens": 2048
    },
    "deepseek/deepseek-r1": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "deepseek/deepseek-v3.1": {
      "contextWindow": 163840,
      "maxTokens": 128000
    },
    "deepseek/deepseek-v3.2": {
      "contextWindow": 128000,
      "maxTokens": 8000
    },
    "deepseek/deepseek-v3.2-thinking": {
      "contextWindow": 128000,
      "maxTokens": 8000
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1048600,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro-0813": {
      "contextWindow": 1048600,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "deepseek/deepseek-v4.1-flash-1017-fast": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "deepseek/deepseek-v4.1-flash-1017-ultrafast": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepseek/deepseek-v4.1-flash-fast": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "elorian/glimpse": {
      "contextWindow": 220000,
      "maxTokens": 4096
    },
    "fireworks/ember-1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "google/gemini-2.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65535
    },
    "google/gemini-2.5-flash-image": {
      "contextWindow": 32768,
      "maxTokens": 32768
    },
    "google/gemini-2.5-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "google/gemini-2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 65535
    },
    "google/gemini-3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65000
    },
    "google/gemini-3-pro-image": {
      "contextWindow": 65536,
      "maxTokens": 32768
    },
    "google/gemini-3.1-flash-image": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "google/gemini-3.1-flash-lite": {
      "contextWindow": 1000000,
      "maxTokens": 65000
    },
    "google/gemini-3.1-flash-lite-image": {
      "contextWindow": 65536,
      "maxTokens": 4096
    },
    "google/gemini-3.1-pro-preview": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "google/gemini-3.5-flash-lite": {
      "contextWindow": 1000000,
      "maxTokens": 65000
    },
    "google/gemini-3.5-transcribe": {
      "contextWindow": 98304,
      "maxTokens": 32768
    },
    "google/gemini-3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "google/gemini-3.7-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65535
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65535
    },
    "google/gemini-3.8-flash-lite-tts": {
      "contextWindow": 8192,
      "maxTokens": 16384
    },
    "google/gemini-3.8-flash-tts": {
      "contextWindow": 8192,
      "maxTokens": 16384
    },
    "google/gemini-3.8-live": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "google/gemini-3.8-live-extended-thinking": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "google/gemini-4-argon": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-4-carbon": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-4-hydrogen": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-4-neon": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-4-neon-fast": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-embedding-001": {
      "contextWindow": 2048,
      "maxTokens": 1
    },
    "google/gemini-embedding-2": {
      "contextWindow": 8192,
      "maxTokens": 3072
    },
    "google/gemini-nano-banana-2.1": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "google/gemini-omni-1.2-flash": {
      "contextWindow": 131072,
      "maxTokens": 260640
    },
    "google/gemini-omni-flash-preview": {
      "contextWindow": 1000000,
      "maxTokens": 57920
    },
    "google/gemma-4-26b-a4b-it": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "google/gemma-4-31b-it": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "humansand/ampersand-v0.1": {
      "contextWindow": 1000000,
      "maxTokens": 32768
    },
    "inception/mercury-3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "inclusionai/ling-3.0-flash": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "inclusionai/ling-3.0-flash-fin": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "inclusionai/ling-3.0-flash-sante": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "inclusionai/ling-3.0-flash-vl": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "inclusionai/ling-3.1-flash": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "inclusionai/ling-3.1-flash-1019": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "inference-net/schematron-v2-small": {
      "contextWindow": 128000,
      "maxTokens": 4096
    },
    "inference-net/schematron-v2-turbo": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "interfaze/interfaze-beta": {
      "contextWindow": 1000000,
      "maxTokens": 32000
    },
    "liquid/lfm2.5-24b-a2b": {
      "contextWindow": 128000,
      "maxTokens": 8200
    },
    "meituan/longcat-2.5": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/llama-3.1-70b": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "meta/llama-3.1-8b": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "meta/llama-3.3-70b": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "meta/llama-4-maverick": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "meta/llama-4-scout": {
      "contextWindow": 128000,
      "maxTokens": 8192
    },
    "meta/muse-ember": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "meta/muse-glimmer-30b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.2-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "meta/muse-spark-1.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.3-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "meta/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-wonder-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.1": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.5": {
      "contextWindow": 1000000,
      "maxTokens": 8192
    },
    "minimax/minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m3": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "minimax/minimax-m3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 524288
    },
    "mistral/codestral": {
      "contextWindow": 128000,
      "maxTokens": 4000
    },
    "mistral/codestral-embed": {
      "contextWindow": 8192,
      "maxTokens": 3072
    },
    "mistral/ministral-14b": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "mistral/ministral-3b": {
      "contextWindow": 131072,
      "maxTokens": 4000
    },
    "mistral/ministral-8b": {
      "contextWindow": 262144,
      "maxTokens": 4000
    },
    "mistral/mistral-embed": {
      "contextWindow": 8000,
      "maxTokens": 3072
    },
    "mistral/mistral-large-3": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "mistral/mistral-large-4": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "mistral/mistral-medium-3.5": {
      "contextWindow": 262144,
      "maxTokens": 256000
    },
    "mistral/mistral-nemo": {
      "contextWindow": 131072,
      "maxTokens": 128000
    },
    "mistral/mistral-small": {
      "contextWindow": 262144,
      "maxTokens": 4000
    },
    "mixedbread/toast-1": {
      "contextWindow": 131000,
      "maxTokens": 4000
    },
    "moonshotai/kimi-k2": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "moonshotai/kimi-k2.5": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "moonshotai/kimi-k2.6": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "moonshotai/kimi-k2.7-code": {
      "contextWindow": 256000,
      "maxTokens": 32768
    },
    "moonshotai/kimi-k2.7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "moonshotai/kimi-k3-fast": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "moonshotai/kimi-k3.1-pro": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k3.1-pro-highspeed": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "morph/morph-v3-fast": {
      "contextWindow": 81920,
      "maxTokens": 16384
    },
    "morph/morph-v3-large": {
      "contextWindow": 81920,
      "maxTokens": 16384
    },
    "nvidia/nemotron-3-super-120b-a12b": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
      "contextWindow": 1000000,
      "maxTokens": 65000
    },
    "nvidia/nemotron-3.5-lightning": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "nvidia/nemotron-3.5-lightning-free": {
      "contextWindow": 1000000,
      "maxTokens": 65000
    },
    "nvidia/nemotron-3.5-super-vl": {
      "contextWindow": 1048576,
      "maxTokens": 8192
    },
    "nvidia/nemotron-nano-12b-v2-vl": {
      "contextWindow": 131072,
      "maxTokens": 128000
    },
    "nvidia/nemotron-nano-9b-v2": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/gpt-4.1": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-fast": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-mini-fast": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4.1-nano": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "openai/gpt-4o": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-fast": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini-fast": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "openai/gpt-4o-mini-transcribe": {
      "contextWindow": 16000,
      "maxTokens": 2000
    },
    "openai/gpt-4o-transcribe": {
      "contextWindow": 16000,
      "maxTokens": 2000
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-fast": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-mini-fast": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-pro": {
      "contextWindow": 400000,
      "maxTokens": 272000
    },
    "openai/gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex-max": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-thinking": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-thinking-fast": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-fast": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex-fast": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini-fast": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5-fast": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5-pro": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-luna-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-sol-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.1-terra-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-astra-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6.2-sol-fast": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "openai/gpt-oss-safeguard-120b": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "openai/gpt-oss-safeguard-20b": {
      "contextWindow": 128000,
      "maxTokens": 16000
    },
    "openai/gpt-realtime-1.5": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "openai/gpt-realtime-2": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "openai/gpt-realtime-2.1": {
      "contextWindow": 128000,
      "maxTokens": 32000
    },
    "openai/gpt-realtime-mini": {
      "contextWindow": 32000,
      "maxTokens": 4096
    },
    "openai/gpt-realtime-whisper": {
      "contextWindow": 16000,
      "maxTokens": 2000
    },
    "openai/o1": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-fast": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o3-pro": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "openai/o4-mini": {
      "contextWindow": 200000,
      "maxTokens": 100000
    },
    "paperinstruments/ultramarine-1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131000
    },
    "particle/particle-1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "perplexity/sonar": {
      "contextWindow": 127000,
      "maxTokens": 8000
    },
    "quiverai/arrow-2": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "quiverai/arrow-2-telos": {
      "contextWindow": 131072,
      "maxTokens": 65536
    },
    "recursive/flint-v1.0": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "reflection/beam": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "reflection/beam-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "sakana/fugu-max": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "sakana/fugu-ultra": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "sakana/fugu-ultra-v2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "sakana/namazu": {
      "contextWindow": 256000,
      "maxTokens": 65536
    },
    "scaledown/scaledown-extract-1": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "scaledown/scaledown-summarize-1": {
      "contextWindow": 1000000,
      "maxTokens": 1000
    },
    "spacexai/grok-4.20-multi-agent": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "spacexai/grok-4.20-multi-agent-beta": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "spacexai/grok-4.20-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "spacexai/grok-4.20-non-reasoning-beta": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "spacexai/grok-4.20-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "spacexai/grok-4.20-reasoning-beta": {
      "contextWindow": 2000000,
      "maxTokens": 2000000
    },
    "spacexai/grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 30000
    },
    "spacexai/grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "spacexai/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "spacexai/grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "spacexai/grok-tts": {
      "contextWindow": 15000,
      "maxTokens": 15000
    },
    "stealth/glyph-cluster": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "stepfun/step-3.7-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "stepfun/step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "tencent/hy-mt2-lite": {
      "contextWindow": 8000,
      "maxTokens": 4000
    },
    "tencent/hy-mt2-plus": {
      "contextWindow": 8000,
      "maxTokens": 4000
    },
    "tencent/hy-mt2-pro": {
      "contextWindow": 8000,
      "maxTokens": 4000
    },
    "tencent/hy3": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "tencent/hy4": {
      "contextWindow": 1024000,
      "maxTokens": 64000
    },
    "tencent/hy4-flash": {
      "contextWindow": 1024000,
      "maxTokens": 64000
    },
    "tencent/hy4-preview": {
      "contextWindow": 1024000,
      "maxTokens": 64000
    },
    "thinkingmachines/inkling": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "thinkingmachines/inkling-2-mini": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "thinkingmachines/inkling-2-small": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "thinkingmachines/inkling-small": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "xiaomi/mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-pro-ultraspeed": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai/glm-4.5": {
      "contextWindow": 128000,
      "maxTokens": 96000
    },
    "zai/glm-4.5-air": {
      "contextWindow": 128000,
      "maxTokens": 96000
    },
    "zai/glm-4.5v": {
      "contextWindow": 66000,
      "maxTokens": 16000
    },
    "zai/glm-4.6": {
      "contextWindow": 200000,
      "maxTokens": 96000
    },
    "zai/glm-4.7": {
      "contextWindow": 200000,
      "maxTokens": 120000
    },
    "zai/glm-4.7-flash": {
      "contextWindow": 200000,
      "maxTokens": 131000
    },
    "zai/glm-4.7-flashx": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "zai/glm-5": {
      "contextWindow": 202800,
      "maxTokens": 131100
    },
    "zai/glm-5-turbo": {
      "contextWindow": 202800,
      "maxTokens": 131072
    },
    "zai/glm-5.1": {
      "contextWindow": 202800,
      "maxTokens": 64000
    },
    "zai/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "zai/glm-5.2-fast": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "zai/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai/glm-5.3-fast": {
      "contextWindow": 1048576,
      "maxTokens": 262144
    },
    "zai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131000
    },
    "zai/glm-5.3-flashx": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai/glm-5.3-flashx-legal": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai/glm-5v-turbo": {
      "contextWindow": 200000,
      "maxTokens": 128000
    }
  },
  "verda": {
    "kimi-k3-1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "vispark": {
    "vispark/vision-large": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "vispark/vision-medium": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "vispark/vision-small": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    }
  },
  "vivgrid": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-v3.2": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro-0813": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "gemini-3.1-flash-lite-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.1-pro-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-3.8-flash": {
      "contextWindow": 1048576,
      "maxTokens": 128000
    },
    "gemini-4-carbon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-hydrogen": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "gemini-4-neon": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "gpt-5-mini": {
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.1-codex-max": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.2-astra": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-6.2-sol": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "hy4-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "kimi-k3": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "viv-fast": {
      "contextWindow": 1000000,
      "maxTokens": 256000
    }
  },
  "volcengine-coding-plan": {
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash-economy": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "doubao-seed-2.0-mini": {
      "contextWindow": 256000,
      "maxTokens": 131072
    },
    "doubao-seed-2.1-lite": {
      "contextWindow": 1024000,
      "maxTokens": 256000
    },
    "doubao-seed-2.1-pro": {
      "contextWindow": 1024000,
      "maxTokens": 256000
    },
    "doubao-seed-evolving": {
      "contextWindow": 1024000,
      "maxTokens": 256000
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "kimi-k2.8-preview": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "vultr": {
    "deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.x-menthol": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "laguna-s-2.1": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "mimo-v2.6-flash-rl": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro-rl": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax-m3": {
      "contextWindow": 524288,
      "maxTokens": 512000
    },
    "muse-glimmer-30b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "nemotron-3-nano-omni-30b-a3b-reasoning": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "nemotron-3.5-content-safety": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "qwen3.8-27b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "qwen3.8-flash-next": {
      "contextWindow": 262144,
      "maxTokens": 131072
    }
  },
  "wallaby": {
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/kimi-k3.1-pro-highspeed": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "wally": {
    "deepseek-v4-flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepseek-v4-pro-fast": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepseek-v4.1-flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "deepseek-v4.1-flash-fast": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "glm-5.3-fast": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "minimax-m3": {
      "contextWindow": 524287,
      "maxTokens": 131072
    }
  },
  "wandb": {
    "MiniMaxAI/MiniMax-M3": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen/Qwen3.6-35B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "Qwen/Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "deepseek-ai/DeepSeek-V3.1": {
      "contextWindow": 161000,
      "maxTokens": 161000
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "google/gemma-4-26B-A4B-it": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "google/gemma-4-31B-it": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "ibm-granite/granite-4.2-8b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "meta-llama/Llama-3.1-8B-Instruct": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "meta-llama/Llama-3.3-70B-Instruct": {
      "contextWindow": 128000,
      "maxTokens": 128000
    },
    "moonshotai/Kimi-K2.6": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/Kimi-K2.7-Code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "reflection/Beam-1.0-501B-A23B": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "zai-org/GLM-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    }
  },
  "watsonx": {
    "ibm/granite-4-h-small": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "meta-llama/llama-3-3-70b-instruct": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "meta-llama/llama-4-maverick-17b-128e-instruct-fp8": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "mistralai/mistral-small-3-1-24b-instruct-2503": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    }
  },
  "watt": {
    "DeepSeek-V4-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "DeepSeek-V4-Flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "DeepSeek-V4-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "DeepSeek-V4.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "GLM-5.1": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "GLM-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "GLM-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "GLM-5.3-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "Hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "Kimi-K2.5": {
      "contextWindow": 271360,
      "maxTokens": 180224
    },
    "Kimi-K2.7-Code": {
      "contextWindow": 271360,
      "maxTokens": 262144
    },
    "Kimi-K3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "MiniMax-M3": {
      "contextWindow": 524288,
      "maxTokens": 512000
    },
    "Qwen3.5-122B-A10B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen3.5-27B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen3.5-35B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen3.5-397B-A17B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    }
  },
  "xiaomi": {
    "mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro-ultraspeed": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "xiaomi-token-plan-ams": {
    "mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "xiaomi-token-plan-cn": {
    "mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "xiaomi-token-plan-sgp": {
    "mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "xpersona": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "gemini-3.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6": {
      "contextWindow": 372000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 372000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 372000,
      "maxTokens": 128000
    },
    "xpersona-frieren-coder": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "xpersona-gpt-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    }
  },
  "xxapi": {
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  },
  "zai-coding-plan": {
    "glm-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-5-turbo": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.2-highspeed": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-highspeed": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.4": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "zeldoc": {
    "zdev": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "zenifra": {
    "zenifra/deepseek-v4-flash-0731": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "zenifra/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 393216
    },
    "zenifra/glm-5.1": {
      "contextWindow": 202745,
      "maxTokens": 131072
    },
    "zenifra/glm-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zenifra/kimi-k2.5": {
      "contextWindow": 229376,
      "maxTokens": 16384
    },
    "zenifra/kimi-k2.7-code": {
      "contextWindow": 229376,
      "maxTokens": 16384
    },
    "zenifra/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "zenifra/qwen3.6-flash": {
      "contextWindow": 991808,
      "maxTokens": 65536
    },
    "zenifra/qwen3.6-plus": {
      "contextWindow": 991808,
      "maxTokens": 65536
    },
    "zenifra/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zenifra/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zenifra/qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zenifra/qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "zerogpu": {
    "deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "gpt-4.1-mini": {
      "contextWindow": 1047576,
      "maxTokens": 32768
    },
    "gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 272000,
      "maxTokens": 128000
    },
    "gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "llama-3.1-8b-instruct-fast": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "qwen3-30b-a3b-fp8": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "qwen3.6-35b-a3b": {
      "contextWindow": 262144,
      "maxTokens": 16384
    }
  },
  "zhipuai": {
    "glm-4.5": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "glm-4.5-air": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "glm-4.5-flash": {
      "contextWindow": 131072,
      "maxTokens": 98304
    },
    "glm-4.5v": {
      "contextWindow": 64000,
      "maxTokens": 16384
    },
    "glm-4.6": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-4.6v": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "glm-4.6v-flash": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "glm-4.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-4.7-flash": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-4.7-flashx": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flashx": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flashx-legal": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5v-turbo": {
      "contextWindow": 200000,
      "maxTokens": 131072
    }
  },
  "zhipuai-coding-plan": {
    "glm-4.6v": {
      "contextWindow": 128000,
      "maxTokens": 32768
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-highspeed": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.4": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "zro": {
    "deepseek-v4.1-flash": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    },
    "dolly1-security": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    },
    "dolly2-security": {
      "contextWindow": 1048576,
      "maxTokens": 131000
    },
    "glm-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131000
    },
    "glm-5.3-flash": {
      "contextWindow": 1048576,
      "maxTokens": 64000
    }
  },
  "commandcode": {
    "MiniMaxAI/MiniMax-M2.5": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "MiniMaxAI/MiniMax-M2.7": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "MiniMaxAI/MiniMax-M3": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "Qwen/Qwen3.6-Plus": {
      "contextWindow": 200000,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.7-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Qwen/Qwen3.7-Max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Qwen/Qwen3.7-Plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "Qwen/Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Qwen/Qwen3.8-Max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Qwen/Qwen3.8-Max-Prime": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Qwen/Qwen3.8-Omni-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash-fast": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/gemini-3.1-flash-lite": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-3.5-flash-lite": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-3.6-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "google/gemini-4-argon": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6.1-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "meta/muse-spark-1.1": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.2": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.2-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-1.3-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-spark-open": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "meta/muse-wonder-1.0": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mistral/mistral-large-4": {
      "contextWindow": 524288,
      "maxTokens": 262144
    },
    "moonshotai/Kimi-K2.5": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "moonshotai/Kimi-K2.6": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "moonshotai/Kimi-K2.7-Code": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "moonshotai/Kimi-K2.7-Code-Highspeed": {
      "contextWindow": 262000,
      "maxTokens": 262000
    },
    "moonshotai/Kimi-K3": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "moonshotai/Kimi-K3.1-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "nvidia/nemotron-3.5-super-vl": {
      "contextWindow": 262144,
      "maxTokens": 8192
    },
    "sakana/fugu-ultra": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "stealth/glyph-cluster:free": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "stepfun/Step-3.5-Flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "stepfun/Step-3.7-Flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "stepfun/Step-5-Preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "tencent/hy3-paid": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "thinkingmachines/inkling": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "thinkingmachines/inkling-small": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "xai/grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xai/grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "xiaomi/mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-pro-ultraspeed": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-5.3-flashx": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai-org/GLM-5": {
      "contextWindow": 200000,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.2-Fast": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-fable-5-1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-4-8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-opus-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-4-6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "claude-sonnet-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "Qwen/Qwen3.8-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Qwen/Qwen3.8-Max-0902": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "deepseek/deepseek-v4-flash-fast": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/gemini-3.7-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "inclusionai/ling-3.1-flash": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "meituan/LongCat-2.0": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "minimax/minimax-m3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "ornith/ornith-1.5-122b": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "tencent/hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  },
  "deepinfra": {
    "ByteDance/Seed-1.8": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "ByteDance/Seed-2.0-code": {
      "contextWindow": 256000,
      "maxTokens": 131072
    },
    "ByteDance/Seed-2.0-mini": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "ByteDance/Seed-2.0-pro": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "MiniMaxAI/MiniMax-M3": {
      "contextWindow": 524288,
      "maxTokens": 512000
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "Qwen/Qwen3-30B-A3B": {
      "contextWindow": 40960,
      "maxTokens": 16384
    },
    "Qwen/Qwen3-32B": {
      "contextWindow": 40960,
      "maxTokens": 16384
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo": {
      "contextWindow": 262144,
      "maxTokens": 66536
    },
    "Qwen/Qwen3-Next-80B-A3B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Qwen/Qwen3-VL-235B-A22B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Qwen/Qwen3-VL-30B-A3B-Instruct": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Qwen/Qwen3.5-27B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.5-35B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "Qwen/Qwen3.5-397B-A17B": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "Qwen/Qwen3.5-9B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.6-27B": {
      "contextWindow": 262144,
      "maxTokens": 65536
    },
    "Qwen/Qwen3.6-35B-A3B": {
      "contextWindow": 262144,
      "maxTokens": 81920
    },
    "Qwen/Qwen3.7-Max": {
      "contextWindow": 256000,
      "maxTokens": 131072
    },
    "Qwen/Qwen3.8-27B": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "Qwen/Qwen3.8-Flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "Qwen/Qwen3.8-Max": {
      "contextWindow": 256000,
      "maxTokens": 131072
    },
    "Qwen/Qwen4-Max": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "XiaomiMiMo/MiMo-V2.6-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "XiaomiMiMo/MiMo-V2.6-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "deepseek-ai/DeepSeek-R1-0528": {
      "contextWindow": 163840,
      "maxTokens": 64000
    },
    "deepseek-ai/DeepSeek-V3": {
      "contextWindow": 163840,
      "maxTokens": 8192
    },
    "deepseek-ai/DeepSeek-V3.1": {
      "contextWindow": 163840,
      "maxTokens": 8192
    },
    "deepseek-ai/DeepSeek-V3.2": {
      "contextWindow": 163840,
      "maxTokens": 64000
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 16384
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 16384
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "google/gemma-3-12b-it": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "google/gemma-3-27b-it": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "google/gemma-3-4b-it": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "google/gemma-4-26B-A4B-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "google/gemma-4-31B-it": {
      "contextWindow": 262144,
      "maxTokens": 32768
    },
    "google/gemma-4-31B-it-Ultra": {
      "contextWindow": 131072,
      "maxTokens": 8192
    },
    "google/gemma-4-31B-it-turbo": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "ibm-granite/granite-4.2-8b": {
      "contextWindow": 131072,
      "maxTokens": 117964
    },
    "inclusionAI/Ling-3.0-flash": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "inclusionAI/Ling-3.0-flash-VL": {
      "contextWindow": 131072,
      "maxTokens": 32768
    },
    "meta-llama/Llama-3.3-70B-Instruct-Turbo": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "meta-llama/Llama-4-Scout-17B-16E-Instruct": {
      "contextWindow": 327680,
      "maxTokens": 16384
    },
    "meta-llama/Llama-Guard-4-12B": {
      "contextWindow": 163840,
      "maxTokens": 163840
    },
    "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo": {
      "contextWindow": 131072,
      "maxTokens": 4096
    },
    "meta-models/Muse-Glimmer-30B": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "mistralai/Mistral-Nemo-Instruct-2407": {
      "contextWindow": 131072,
      "maxTokens": 128000
    },
    "mistralai/Mistral-Small-24B-Instruct-2501": {
      "contextWindow": 32768,
      "maxTokens": 16384
    },
    "mistralai/Mistral-Small-3.2-24B-Instruct-2506": {
      "contextWindow": 128000,
      "maxTokens": 16384
    },
    "moonshotai/Kimi-K2.6": {
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "moonshotai/Kimi-K3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "moonshotai/Kimi-K3.1-Pro": {
      "contextWindow": 1048576,
      "maxTokens": 943718
    },
    "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B": {
      "contextWindow": 262144,
      "maxTokens": 128000
    },
    "nvidia/NVIDIA-Nemotron-3.5-Lightning": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "openai/gpt-oss-120b": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/gpt-oss-120b-Ultra": {
      "contextWindow": 131072,
      "maxTokens": 131072
    },
    "openai/gpt-oss-20b": {
      "contextWindow": 131072,
      "maxTokens": 16384
    },
    "tencent/Hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "thinkingmachines/Inkling-2-Small": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "thinkingmachines/Inkling-Small": {
      "contextWindow": 524288,
      "maxTokens": 524288
    },
    "zai-org/GLM-4.6": {
      "contextWindow": 202752,
      "maxTokens": 131072
    },
    "zai-org/GLM-4.7": {
      "contextWindow": 202752,
      "maxTokens": 16384
    },
    "zai-org/GLM-5.2": {
      "contextWindow": 1048576,
      "maxTokens": 32768
    },
    "zai-org/GLM-5.3": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "zai-org/GLM-5.3-Flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  },
  "zenmux": {
    "baidu/ernie-5.0-thinking-preview": {
      "contextWindow": 128000,
      "maxTokens": 64000
    },
    "bytedance/doubao-seed-1.8": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "bytedance/doubao-seed-2.0-code": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "bytedance/doubao-seed-2.0-lite": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "bytedance/doubao-seed-2.0-mini": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "bytedance/doubao-seed-2.0-pro": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "bytedance/doubao-seed-code": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "deepseek/deepseek-v3.2": {
      "contextWindow": 128000,
      "maxTokens": 8000
    },
    "deepseek/deepseek-v3.2-exp": {
      "contextWindow": 163000,
      "maxTokens": 64000
    },
    "deepseek/deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek/deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "google/gemini-2.5-flash": {
      "contextWindow": 1048000,
      "maxTokens": 65535
    },
    "google/gemini-2.5-flash-lite": {
      "contextWindow": 1048000,
      "maxTokens": 65535
    },
    "google/gemini-2.5-pro": {
      "contextWindow": 1048000,
      "maxTokens": 65535
    },
    "google/gemini-3-flash-preview": {
      "contextWindow": 1048000,
      "maxTokens": 65535
    },
    "google/gemini-3.1-flash-lite": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "google/gemini-3.1-pro-preview": {
      "contextWindow": 1048000,
      "maxTokens": 65535
    },
    "google/gemini-3.5-flash": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "inclusionai/ring-2.6-1t": {
      "contextWindow": 262000,
      "maxTokens": 65000
    },
    "minimax/minimax-m2": {
      "contextWindow": 204000,
      "maxTokens": 128000
    },
    "minimax/minimax-m2.1": {
      "contextWindow": 204000,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.5": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.5-lightning": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax/minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 131070
    },
    "minimax/minimax-m2.7-highspeed": {
      "contextWindow": 204800,
      "maxTokens": 131070
    },
    "minimax/minimax-m3": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "minimax/minimax-m3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "moonshotai/kimi-k2.6": {
      "contextWindow": 262140,
      "maxTokens": 262140
    },
    "moonshotai/kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k2.7-code-highspeed": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "moonshotai/kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "openai/chat-latest": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.1-codex-mini": {
      "contextWindow": 400000,
      "maxTokens": 100000
    },
    "openai/gpt-5.2": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.2-pro": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.3-codex": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-mini": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-nano": {
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "openai/gpt-5.4-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.5-pro": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-5.6-terra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-astra": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "openai/gpt-6-sol": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "qwen/qwen3-coder-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen/qwen3-max": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "qwen/qwen3.5-flash": {
      "contextWindow": 1020000,
      "maxTokens": 1020000
    },
    "qwen/qwen3.5-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen/qwen3.6-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen/qwen3.7-max": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "qwen/qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "stepfun/step-3.5-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "stepfun/step-3.7-flash": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "volcengine/doubao-seed-1.8": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "volcengine/doubao-seed-2.0-code": {
      "contextWindow": 256000,
      "maxTokens": 32000
    },
    "volcengine/doubao-seed-2.0-lite": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "volcengine/doubao-seed-2.0-mini": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "volcengine/doubao-seed-2.0-pro": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "volcengine/doubao-seed-code": {
      "contextWindow": 256000,
      "maxTokens": 64000
    },
    "x-ai/grok-4.2-fast": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "x-ai/grok-4.2-fast-non-reasoning": {
      "contextWindow": 2000000,
      "maxTokens": 30000
    },
    "x-ai/grok-4.3": {
      "contextWindow": 1000000,
      "maxTokens": 1000000
    },
    "x-ai/grok-4.5": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "x-ai/grok-4.6": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "x-ai/grok-build-0.1": {
      "contextWindow": 256000,
      "maxTokens": 256000
    },
    "x-ai/grok-voice-stt-1.0": {
      "contextWindow": 15000,
      "maxTokens": 15000
    },
    "x-ai/grok-voice-tts-1.0": {
      "contextWindow": 15000,
      "maxTokens": 15000
    },
    "xiaomi/mimo-v2.5": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "xiaomi/mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "z-ai/glm-4.5": {
      "contextWindow": 128000,
      "maxTokens": 96000
    },
    "z-ai/glm-4.5-air": {
      "contextWindow": 128000,
      "maxTokens": 96000
    },
    "z-ai/glm-4.6": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-4.6v": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-4.6v-flash": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-4.6v-flash-free": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-4.7": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-4.7-flash-free": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-4.7-flashx": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-5": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-5-turbo": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-5.1": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "z-ai/glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "z-ai/glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "z-ai/glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "z-ai/glm-5.3-flashx": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "z-ai/glm-5v-turbo": {
      "contextWindow": 200000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-fable-5.1": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-haiku-4.5": {
      "contextWindow": 200000,
      "maxTokens": 64000
    },
    "anthropic/claude-opus-4.1": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "anthropic/claude-opus-4.5": {
      "contextWindow": 200000,
      "maxTokens": 32000
    },
    "anthropic/claude-opus-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.7": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-4.8": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-opus-5.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-4.5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    },
    "anthropic/claude-sonnet-4.6": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "anthropic/claude-sonnet-5": {
      "contextWindow": 1000000,
      "maxTokens": 64000
    }
  },
  "opencode-go": {
    "beam-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "cat-jam-free": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "deepseek-v4-pro": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "deepseek-v4.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 384000
    },
    "glm-5.2": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "glm-5.3-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "hy3": {
      "contextWindow": 256000,
      "maxTokens": 128000
    },
    "hy4": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "hy4-flash-free": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "hy4-preview": {
      "contextWindow": 1048576,
      "maxTokens": 65536
    },
    "iceman-contributor-free": {
      "contextWindow": 262144,
      "maxTokens": 131072
    },
    "kimi-k2.7-code": {
      "contextWindow": 262144,
      "maxTokens": 262144
    },
    "kimi-k3": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "kimi-k3.1-pro": {
      "contextWindow": 1048576,
      "maxTokens": 1048576
    },
    "longcat-2.0": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "longcat-2.5": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "longcat-2.5-free": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "longcat-2.5-preview-free": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "mimo-v2.5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "mimo-v2.5-pro": {
      "contextWindow": 1048576,
      "maxTokens": 128000
    },
    "mimo-v2.6-flash": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "mimo-v2.6-pro": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "minimax-m2.7": {
      "contextWindow": 204800,
      "maxTokens": 131072
    },
    "minimax-m3": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "minimax-m3.1-flash": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "minimax-m3.1-flash-free": {
      "contextWindow": 1000000,
      "maxTokens": 512000
    },
    "space-bunny": {
      "contextWindow": 1048576,
      "maxTokens": 524288
    },
    "step-5-preview": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "step-5-preview-free": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "claude-haiku-5-5": {
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    "qwen3.7-plus": {
      "contextWindow": 1000000,
      "maxTokens": 65536
    },
    "qwen3.8-flash": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen3.8-max": {
      "contextWindow": 1000000,
      "maxTokens": 131072
    },
    "qwen4-max": {
      "contextWindow": 1000000,
      "maxTokens": 262144
    },
    "gpt-5.6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "gpt-6-luna": {
      "contextWindow": 1050000,
      "maxTokens": 128000
    },
    "grok-4.7": {
      "contextWindow": 500000,
      "maxTokens": 500000
    },
    "muse-spark-1.2-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    },
    "muse-spark-1.3-contributor": {
      "contextWindow": 1048576,
      "maxTokens": 131072
    }
  }
});

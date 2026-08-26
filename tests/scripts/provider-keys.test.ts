/**
 * provider-keys mapping tests (plan postdeploy-review-feedback T3).
 *
 * The PROVIDERS table and providerEnvName() are pure and offline-testable;
 * the interactive picker / masked prompt / wrangler spawn are manual-smoke
 * only (they need a TTY and a wrangler session).
 */

import { describe, expect, test } from "bun:test";
import { listProviders, providerEnvName, PROVIDERS } from "../../scripts/provider-keys";

describe("PROVIDERS mapping table (T3)", () => {
  test("covers every omp built-in provider with its Worker env var name", () => {
    expect(PROVIDERS).toEqual({
      anthropic: { envName: "ANTHROPIC_API_KEY", label: "Anthropic" },
      openai: { envName: "OPENAI_API_KEY", label: "OpenAI" },
      gemini: { envName: "GEMINI_API_KEY", label: "Google Gemini" },
      groq: { envName: "GROQ_API_KEY", label: "Groq" },
      cerebras: { envName: "CEREBRAS_API_KEY", label: "Cerebras" },
      xai: { envName: "XAI_API_KEY", label: "xAI" },
      openrouter: { envName: "OPENROUTER_API_KEY", label: "OpenRouter" },
      kilo: { envName: "KILO_API_KEY", label: "Kilo" },
      mistral: { envName: "MISTRAL_API_KEY", label: "Mistral" },
      zai: { envName: "ZAI_API_KEY", label: "Z.AI" },
      minimax: { envName: "MINIMAX_API_KEY", label: "MiniMax" },
      opencode: { envName: "OPENCODE_API_KEY", label: "OpenCode" },
      cursor: { envName: "CURSOR_ACCESS_TOKEN", label: "Cursor" },
      "ai-gateway": { envName: "AI_GATEWAY_API_KEY", label: "AI Gateway" },
    });
  });

  test("every env name is a distinct, non-empty secret name", () => {
    const seen: Record<string, true> = {};
    for (const info of Object.values(PROVIDERS)) {
      expect(info.envName.length).toBeGreaterThan(0);
      expect(seen[info.envName]).toBeUndefined();
      seen[info.envName] = true;
    }
  });
});

describe("providerEnvName", () => {
  test("resolves known providers to their env var name", () => {
    expect(providerEnvName("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(providerEnvName("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(providerEnvName("cursor")).toBe("CURSOR_ACCESS_TOKEN");
    expect(providerEnvName("ai-gateway")).toBe("AI_GATEWAY_API_KEY");
  });

  test("returns undefined for unknown providers (fail closed)", () => {
    expect(providerEnvName("ark")).toBeUndefined();
    expect(providerEnvName("not-a-provider")).toBeUndefined();
    expect(providerEnvName("")).toBeUndefined();
  });
});

describe("listProviders", () => {
  test("renders one aligned row per provider with the env name", () => {
    const table = listProviders();
    const rows = table.split("\n");
    expect(rows).toHaveLength(Object.keys(PROVIDERS).length);
    expect(table).toContain("anthropic");
    expect(table).toContain("ANTHROPIC_API_KEY");
    expect(table).toContain("ai-gateway");
    expect(table).toContain("AI_GATEWAY_API_KEY");
  });
});

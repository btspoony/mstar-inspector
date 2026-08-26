/**
 * provider-keys mapping tests (plan postdeploy-review-feedback T3).
 *
 * The PROVIDERS table and providerEnvName() are pure and offline-testable;
 * the interactive picker / masked prompt / wrangler spawn are manual-smoke
 * only (they need a TTY and a wrangler session).
 */

import { describe, expect, test } from "bun:test";
import { listProviders, providerEnvName, PROVIDERS } from "../../scripts/provider-keys";
import { PROVIDERS as SHARED_PROVIDERS, PROVIDER_ENV_NAMES } from "../../src/pipeline/providers";

describe("PROVIDERS mapping table (T3)", () => {
  test("the script re-exports the shared src mapping — zero duplicated literals (BB-2)", () => {
    expect(PROVIDERS).toBe(SHARED_PROVIDERS);
    expect([...PROVIDER_ENV_NAMES]).toEqual(Object.values(PROVIDERS).map((info) => info.envName));
  });

  test("covers every omp built-in provider with its Worker env var name", () => {
    expect(PROVIDERS).toEqual({
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

  test("PROVIDERS covers every omp API-key provider env and only those (WF-004)", () => {
    // omp's authoritative built-in provider env list — `omp --help` renders
    // these from src/cli/help-extra.ts "Core Providers" + "Additional LLM
    // Providers". Hard-coded on purpose: a drift in PROVIDERS (or in omp)
    // must fail here rather than silently diverge.
    const OMP_API_KEY_ENVS = [
      // Core Providers
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "COPILOT_GITHUB_TOKEN",
      // Additional LLM Providers
      "AZURE_OPENAI_API_KEY",
      "GROQ_API_KEY",
      "CEREBRAS_API_KEY",
      "XAI_API_KEY",
      "OPENROUTER_API_KEY",
      "KILO_API_KEY",
      "MISTRAL_API_KEY",
      "ZAI_API_KEY",
      "UMANS_AI_CODING_PLAN_API_KEY",
      "MINIMAX_API_KEY",
      "OPENCODE_API_KEY",
      "CURSOR_ACCESS_TOKEN",
      "AI_GATEWAY_API_KEY",
      "WAFER_SERVERLESS_API_KEY",
    ] as const;
    // Deliberately OUT of PROVIDERS (different auth mechanisms, not omp
    // API-key providers): ark-plan (custom baseUrl), OAuth, AWS/Vertex,
    // search keys. Asserting absence guards against scope creep.
    const NON_API_KEY_ENVS = [
      "ARK_API_KEY",
      "ANTHROPIC_OAUTH_TOKEN",
      "AWS_PROFILE",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "EXA_API_KEY",
      "BRAVE_API_KEY",
      "PERPLEXITY_API_KEY",
      "PERPLEXITY_COOKIES",
      "TAVILY_API_KEY",
      "TINYFISH_API_KEY",
      "FIRECRAWL_API_KEY",
      "ANTHROPIC_SEARCH_API_KEY",
    ] as const;

    const covered: Record<string, true> = {};
    for (const info of Object.values(PROVIDERS)) covered[info.envName] = true;
    for (const env of OMP_API_KEY_ENVS) {
      expect(covered[env]).toBe(true);
    }
    for (const env of NON_API_KEY_ENVS) {
      expect(covered[env]).toBeUndefined();
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

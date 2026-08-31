/**
 * Shared provider mapping tests (bugbot BB-2): the allowlist picker the
 * queue consumer uses to forward provider keys into the review container.
 */

import { describe, expect, test } from "bun:test";
import { pickProviderKeys, PROVIDERS, PROVIDER_ENV_NAMES, providerEnvName , customProviderEnvName, CUSTOM_PROVIDER_ENV_PREFIX, CUSTOM_PROVIDER_ENV_SUFFIX } from "../../src/pipeline/providers";

describe("pickProviderKeys (BB-2 allowlist)", () => {
  test("forwards only known keys that are present AND non-empty", () => {
    expect(
      pickProviderKeys({
        ANTHROPIC_API_KEY: "sk-ant-1",
        OPENAI_API_KEY: "",
        GEMINI_API_KEY: undefined,
        COPILOT_GITHUB_TOKEN: "copilot-token",
        MISTRAL_API_KEY: " ",
      }),
    ).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-1",
      COPILOT_GITHUB_TOKEN: "copilot-token",
    });
  });

  test("never forwards keys outside the PROVIDERS allowlist", () => {
    expect(
      pickProviderKeys({
        ARBITRARY_SECRET: "leak",
        ARK_API_KEY: "ark-key", // NOT a built-in provider key (custom baseUrl provider)
        ANTHROPIC_OAUTH_TOKEN: "oauth", // deliberately absent (different auth mechanism)
      }),
    ).toEqual({});
  });

  test("every PROVIDER env name is picked through the allowlist", () => {
    const env: Record<string, string> = {};
    for (const name of PROVIDER_ENV_NAMES) env[name] = `v-${name}`;
    const picked = pickProviderKeys(env);
    expect(Object.keys(picked).sort()).toEqual([...PROVIDER_ENV_NAMES].sort());
    for (const name of PROVIDER_ENV_NAMES) expect(picked[name]).toBe(`v-${name}`);
  });
});

describe("shared provider mapping", () => {
  test("PROVIDER_ENV_NAMES is the frozen env-name snapshot of PROVIDERS", () => {
    expect([...PROVIDER_ENV_NAMES]).toEqual(Object.values(PROVIDERS).map((info) => info.envName));
    expect(Object.isFrozen(PROVIDER_ENV_NAMES)).toBe(true);
  });

  test("providerEnvName resolves known providers and fails closed otherwise", () => {
    expect(providerEnvName("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(providerEnvName("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(providerEnvName("not-a-provider")).toBeUndefined();
  });
});
describe("customProviderEnvName (plan 23 Task 3, AL-23-1)", () => {
  test("maps provider ids to CUSTOM_<UPPER_SNAKE>_API_KEY — hyphen → underscore, uppercased", () => {
    expect(customProviderEnvName("my-provider")).toBe("CUSTOM_MY_PROVIDER_API_KEY");
    expect(customProviderEnvName("ark")).toBe("CUSTOM_ARK_API_KEY");
    expect(customProviderEnvName("a1-b2")).toBe("CUSTOM_A1_B2_API_KEY");
    expect(customProviderEnvName("deep-model-x")).toBe("CUSTOM_DEEP_MODEL_X_API_KEY");
  });

  test("the prefix/suffix constants are the frozen contract fragments", () => {
    expect(CUSTOM_PROVIDER_ENV_PREFIX).toBe("CUSTOM_");
    expect(CUSTOM_PROVIDER_ENV_SUFFIX).toBe("_API_KEY");
    expect(customProviderEnvName("x")).toBe(`${CUSTOM_PROVIDER_ENV_PREFIX}X${CUSTOM_PROVIDER_ENV_SUFFIX}`);
  });
});

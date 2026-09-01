/**
 * Shared provider mapping tests (bugbot BB-2 → AL-24-5): the allowlist that
 * maps per-App BYOK provider ids to the env var names injected into the
 * review container. The global-env picker (`pickProviderKeys`) was retired
 * with the zero-global-fallback cutover (plan 24 Task 6): keys come only
 * from the App's per-App config, so there is nothing to pick from a
 * worker-env-shaped record anymore.
 */

import { describe, expect, test } from "bun:test";
import { PROVIDERS, PROVIDER_ENV_NAMES, providerEnvName, customProviderEnvName, CUSTOM_PROVIDER_ENV_PREFIX, CUSTOM_PROVIDER_ENV_SUFFIX } from "../../src/pipeline/providers";

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

  test("ark maps to ARK_API_KEY — the in-image ark-plan base provider's key env (AL-24-5)", () => {
    expect(PROVIDERS["ark"]).toEqual({ envName: "ARK_API_KEY", label: "Ark" });
    expect(providerEnvName("ark")).toBe("ARK_API_KEY");
    // The provider set is the SSOT the dashboard PROVIDER_IDS mirror locks
    // against (tests/worker/app-config.test.ts parity lock).
    expect(Object.keys(PROVIDERS)).toHaveLength(19);
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

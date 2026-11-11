/**
 * The one-shot seat-failover probe: it must NAME the gate that drops a
 * candidate, per gate, instead of inferring one from a failure message.
 *
 * The three gates are the runtime's own, in the runtime's order
 * (packages/runner/node_modules/@oh-my-pi/pi-coding-agent/src/session/turn-recovery.ts
 * `#findKeyedRetryFallback`): registry resolution → configured credential →
 * context fit. A probe that stops distinguishing them would name the wrong
 * seam, so every case below pins BOTH the verdict and the evidence the verdict
 * used.
 */
import { describe, expect, test } from "bun:test";
import { probeSeatFailover } from "../../packages/runner/src/seat-failover-probe";

/** The capability host a defaulted App's synthesized models.yml carries. */
const HOSTS = [
  {
    id: "ark-plan",
    catalogProviderId: "ark",
    apiKeyEnv: "ARK_API_KEY",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
    api: "anthropic-messages",
    auth: "apiKey",
    models: [
      {
        id: "deepseek-v4-flash",
        name: "Deepseek v4 flash 0731",
        reasoning: true,
        input: ["text"],
        contextWindow: 1_024_000,
        maxTokens: 65_536,
      },
    ],
  },
] as const;

/** A custom declaration (the post-037a shape) the synthesized file carries. */
const DECL = {
  provider_id: "my-gateway",
  base_url: "https://gateway.example.invalid/v1",
  api: "openai-completions" as const,
  model_ids: ["model-a", "model-b"],
};

const FAKE_KEY = "sk-probe-fake-0000";

describe("seat failover probe — the three gates stay distinguishable", () => {
  test("G1 registry: a selector no provider serves is dropped AT THE REGISTRY", async () => {
    const report = await probeSeatFailover({
      chain: "my-gateway/model-a, nowhere-provider/ghost-model",
      capabilityHosts: HOSTS,
      customProviders: [DECL],
      pool: { "my-gateway": [FAKE_KEY] },
      retryContextTokens: 50_000,
    });
    const ghost = report.selectors[1]!;
    expect(ghost.gate).toBe("registry");
    expect(ghost.registry.resolved).toBe(false);
    expect(ghost.registry.metadata).toBeNull();
    // An unresolved selector never reached the context gate: it reports "not
    // evaluated" (null), never "measured, does not fit".
    expect(ghost.context.fits).toBeNull();
    expect(report.droppedCandidate?.selector).toBe("nowhere-provider/ghost-model");
  });

  test("G3 pool key: a resolved model no transported pool covers is dropped AT THE POOL", async () => {
    const report = await probeSeatFailover({
      chain: "my-gateway/model-a",
      capabilityHosts: HOSTS,
      customProviders: [DECL],
      pool: {},
      retryContextTokens: 50_000,
    });
    const verdict = report.selectors[0]!;
    expect(verdict.gate).toBe("pool_key");
    expect(verdict.registry.resolved).toBe(true);
    expect(verdict.registry.metadata?.id).toBe("model-a");
    expect(verdict.poolKey.configured).toBe(false);
    // It never reached the context gate: the earlier gate already decided.
    expect(verdict.context.fits).toBe(true);
  });

  test("G2 context: a resolved, keyed model whose stated window cannot hold the retry context is dropped AT CONTEXT", async () => {
    const report = await probeSeatFailover({
      chain: "my-gateway/model-a",
      capabilityHosts: HOSTS,
      customProviders: [
        {
          ...DECL,
          model_ids: ["model-a"],
          models_meta: { "model-a": { contextWindow: 1_000, maxTokens: 128 } },
        },
      ],
      pool: { "my-gateway": [FAKE_KEY] },
      retryContextTokens: 50_000,
    });
    const verdict = report.selectors[0]!;
    expect(verdict.gate).toBe("context");
    expect(verdict.context.contextWindow).toBe(1_000);
    expect(verdict.context.retryContextTokens).toBe(50_000);
    expect(verdict.context.fitBudget).toBeLessThan(50_000);
    expect(verdict.poolKey.configured).toBe(true);
  });

  test("eligible: resolved, keyed and fitting — and missing metadata alone does NOT drop", async () => {
    // Compass D12: the pinned registry back-fills its own defaults for absent
    // metadata keys, so "the owner stated nothing" must not be read as "drop".
    const report = await probeSeatFailover({
      chain: "my-gateway/model-b",
      capabilityHosts: HOSTS,
      customProviders: [DECL],
      pool: { "my-gateway": [FAKE_KEY] },
      retryContextTokens: 50_000,
    });
    const verdict = report.selectors[0]!;
    expect(verdict.gate).toBe("eligible");
    expect(verdict.registry.resolved).toBe(true);
    expect(verdict.poolKey.configured).toBe(true);
    expect(verdict.context.fits).toBe(true);
    expect(report.droppedCandidate).toBeNull();
  });

  test("the three gates are INDEPENDENT: only the deciding evidence differs between them", async () => {
    const base = {
      chain: "my-gateway/model-a",
      capabilityHosts: HOSTS,
      retryContextTokens: 50_000,
    };
    const missing = await probeSeatFailover({ ...base, customProviders: [], pool: {} });
    const unkeyed = await probeSeatFailover({ ...base, customProviders: [DECL], pool: {} });
    const oversized = await probeSeatFailover({
      ...base,
      customProviders: [
        { ...DECL, model_ids: ["model-a"], models_meta: { "model-a": { contextWindow: 1_000, maxTokens: 128 } } },
      ],
      pool: { "my-gateway": [FAKE_KEY] },
    });
    const ok = await probeSeatFailover({ ...base, customProviders: [DECL], pool: { "my-gateway": [FAKE_KEY] } });

    expect([missing.selectors[0]!.gate, unkeyed.selectors[0]!.gate, oversized.selectors[0]!.gate, ok.selectors[0]!.gate]).toEqual([
      "registry",
      "pool_key",
      "context",
      "eligible",
    ]);
    // Every gate reports the evidence it used, and only that evidence fails.
    expect([missing.selectors[0]!.registry.resolved, unkeyed.selectors[0]!.registry.resolved]).toEqual([false, true]);
    // The unresolved entry's context is NOT EVALUATED (null); every entry that
    // DID resolve carries a measured verdict, whichever gate then drops it.
    expect(missing.selectors[0]!.context.fits).toBeNull();
    expect(unkeyed.selectors[0]!.context.fits).toBe(true);
    expect(oversized.selectors[0]!.context.fits).toBe(false);
    expect(ok.selectors[0]!.context.fits).toBe(true);
    expect([unkeyed.selectors[0]!.poolKey.configured, oversized.selectors[0]!.poolKey.configured]).toEqual([false, true]);
    expect([oversized.selectors[0]!.context.fits, ok.selectors[0]!.context.fits]).toEqual([false, true]);
  });
});

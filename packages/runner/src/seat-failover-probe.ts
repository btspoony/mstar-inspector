/**
 * Seat model-failover probe — a ONE-SHOT diagnostic, not a runtime path.
 *
 * When the first selector of an App's chain answers a quota `400`, the seat is
 * supposed to apply the next selector. Three gates can drop that candidate
 * before it is ever tried, and the failure message names none of them:
 *
 *   1. `registry`  — the model registry cannot resolve `provider/model`
 *                     (§ turn-recovery `find`/`resolveModelOverride`).
 *   2. `pool_key`  — the candidate resolves but no transported credential
 *                     covers its provider (`hasConfiguredAuth`).
 *   3. `context`   — it resolves and is keyed, but its window cannot hold the
 *                     round's retry context (`contextFitsModel`).
 *
 * The probe rebuilds the SAME inputs a real round builds — the synthesized
 * per-review `models.yml` (capability hosts + the App's custom declarations,
 * post-037a shape), the in-memory credential pool seeded exactly as the runner
 * seeds it from the stdin payload, and the chain as selectors — then walks the
 * runtime's own gate order and records, per selector, the first gate that
 * drops it together with the evidence that gate used.
 *
 * It is deliberately NOT a session run: a session proves "the candidate was
 * skipped" without naming why, which is how the wrong seam gets fixed.
 *
 * Boundaries: fake keys only (no real credential anywhere), no network, no
 * session, no SDK patch. The registered model metadata is the SDK's own
 * resolution — it back-fills its defaults for absent metadata keys, so this
 * probe never assumes "nothing was stated" means "dropped".
 */
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_COMPACTION_SETTINGS, resolveBudgetReserveTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { writePerReviewModelsYaml } from "./models-synthesis";
import { createInMemoryAuthStorage } from "./runner";
import { parseModelSelectors } from "./runtime-omp";
import type { CapabilityHost, CustomProviderDeclaration } from "../../shared/src/runtime";

/** The runtime's gates, in the order the retry walk applies them. */
export type ProbeGate = "registry" | "pool_key" | "context" | "eligible";

/** One resolved model, as the registry reports it. */
export type ProbeModelMetadata = {
  provider: string;
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: readonly string[];
};

export type ProbeSelectorVerdict = {
  selector: string;
  provider: string;
  modelId: string;
  /** The FIRST gate that drops this selector — `eligible` when none does. */
  gate: ProbeGate;
  registry: { resolved: boolean; metadata: ProbeModelMetadata | null };
  poolKey: { configured: boolean };
  context: {
    fits: boolean;
    retryContextTokens: number;
    contextWindow: number | null;
    /** `contextWindow - reserve`, the SDK's own fit budget (null when unresolved). */
    fitBudget: number | null;
  };
};

export type ProbeReport = {
  chain: readonly string[];
  selectors: readonly ProbeSelectorVerdict[];
  /** The first selector the gates drop — the candidate disposition. */
  droppedCandidate: ProbeSelectorVerdict | null;
};

export type ProbeInput = {
  /** The App's configured chain, verbatim (comma-separated selectors). */
  chain: string;
  /** The selected image's capability hosts — the synthesized base. */
  capabilityHosts: readonly CapabilityHost[];
  /** The App's custom declarations (the post-037a declaration shape). */
  customProviders?: readonly CustomProviderDeclaration[];
  /**
   * The transported pool exactly as the consumer ships it: provider id -> keys.
   * FAKE keys only; the probe never reaches a network.
   */
  pool: Record<string, readonly string[]>;
  /** The retry context the candidate must hold, in tokens. */
  retryContextTokens: number;
};

/**
 * `provider/model[:variant]` — the provider is the FIRST segment (model ids
 * may contain slashes), and a trailing `:variant` is a thinking suffix unless
 * the literal id resolves (the SDK tries the literal id first).
 */
function splitSelector(selector: string): { provider: string; modelId: string; literalThenBase: string[] } {
  const slash = selector.indexOf("/");
  if (slash <= 0) return { provider: selector, modelId: "", literalThenBase: [""] };
  const provider = selector.slice(0, slash);
  const modelId = selector.slice(slash + 1);
  const colon = modelId.lastIndexOf(":");
  const base = colon > 0 ? modelId.slice(0, colon) : modelId;
  return { provider, modelId, literalThenBase: base === modelId ? [modelId] : [modelId, base] };
}

/**
 * `SessionMaintenance.contextFitsModel`'s arithmetic against a given context
 * size: a non-positive window fits everything (the SDK's own first line), and
 * otherwise the retry context must fit under `window - reserve`.
 */
function contextFit(contextWindow: number, retryContextTokens: number): { fits: boolean; fitBudget: number } {
  if (contextWindow <= 0) return { fits: true, fitBudget: contextWindow };
  const fitBudget = Math.max(0, contextWindow - resolveBudgetReserveTokens(contextWindow, DEFAULT_COMPACTION_SETTINGS));
  return { fits: retryContextTokens <= fitBudget, fitBudget };
}

/**
 * Run the probe. Builds a throwaway `agentDir`, seeds the in-memory pool with
 * the SAME `{type:"api_key", source:"login"}` rows the runner loads, resolves
 * every selector through the session's registry, and returns one verdict per
 * selector. The `agentDir` is removed before returning (success or throw).
 */
export async function probeSeatFailover(input: ProbeInput): Promise<ProbeReport> {
  const chain = parseModelSelectors(input.chain);
  const agentDir = await writePerReviewModelsYaml(input.capabilityHosts, input.customProviders ?? []);
  const authStorage = await createInMemoryAuthStorage();
  try {
    for (const [providerId, keys] of Object.entries(input.pool)) {
      await authStorage.credentials.set(
        providerId,
        keys.map((key) => ({ type: "api_key" as const, key, source: "login" as const })),
      );
    }
    const registry = new ModelRegistry(authStorage, join(agentDir, "models.yml"));
    const selectors: ProbeSelectorVerdict[] = [];
    for (const selector of chain) {
      const { provider, modelId, literalThenBase } = splitSelector(selector);
      // The registry's own lookup — literal id first, then the thinking-suffix
      // base, exactly the order the SDK's resolver applies.
      const model = literalThenBase.map((id) => registry.find(provider, id)).find((entry) => entry !== undefined);
      if (model === undefined) {
        selectors.push({
          selector,
          provider,
          modelId,
          gate: "registry",
          registry: { resolved: false, metadata: null },
          poolKey: { configured: false },
          context: { fits: false, retryContextTokens: input.retryContextTokens, contextWindow: null, fitBudget: null },
        });
        continue;
      }
      const metadata: ProbeModelMetadata = {
        provider: model.provider,
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        contextWindow: model.contextWindow ?? 0,
        maxTokens: model.maxTokens ?? 0,
        reasoning: model.reasoning === true,
        input: [...(model.input ?? [])],
      };
      const configured = registry.hasConfiguredAuth(model);
      const fit = contextFit(metadata.contextWindow, input.retryContextTokens);
      selectors.push({
        selector,
        provider,
        modelId,
        // The runtime's gate order: resolution, then credential, then window.
        gate: !configured ? "pool_key" : !fit.fits ? "context" : "eligible",
        registry: { resolved: true, metadata },
        poolKey: { configured },
        context: {
          fits: fit.fits,
          retryContextTokens: input.retryContextTokens,
          contextWindow: metadata.contextWindow,
          fitBudget: fit.fitBudget,
        },
      });
    }
    return { chain, selectors, droppedCandidate: selectors.find((verdict) => verdict.gate !== "eligible") ?? null };
  } finally {
    authStorage.close();
    await rm(agentDir, { recursive: true, force: true });
  }
}

/** One line per selector: the verdict, then the evidence that produced it. */
export function formatProbeReport(report: ProbeReport): string {
  const lines = report.selectors.map((verdict) => {
    const meta = verdict.registry.metadata;
    return [
      `${verdict.selector} → ${verdict.gate.toUpperCase()}`,
      `  resolved: ${verdict.registry.resolved ? `${meta?.provider}/${meta?.id}` : "(unresolved)"}`,
      meta === null
        ? "  metadata: (none)"
        : `  metadata: contextWindow=${meta.contextWindow} maxTokens=${meta.maxTokens} name=${JSON.stringify(meta.name)} reasoning=${meta.reasoning} input=[${meta.input.join(", ")}] baseUrl=${meta.baseUrl}`,
      `  pool_key: ${verdict.poolKey.configured ? "configured" : "MISSING"}`,
      `  context: retry=${verdict.context.retryContextTokens} window=${verdict.context.contextWindow ?? "(n/a)"} fitBudget=${verdict.context.fitBudget ?? "(n/a)"} fits=${verdict.context.fits}`,
    ].join("\n");
  });
  lines.push(`DROPPED_BY=${report.droppedCandidate?.gate ?? "none"}`);
  return lines.join("\n");
}

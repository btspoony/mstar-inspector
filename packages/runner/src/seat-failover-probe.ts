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
    /** null = not evaluated (no live context was available to measure it). */
    fits: boolean | null;
    retryContextTokens: number | null;
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
 * otherwise the retry context must fit under `window - reserve`. An ABSENT
 * retry context means the gate cannot be judged (a failed round never exposes
 * its live context), so it reports `null` — never a pass and never a drop.
 */
function contextFit(
  contextWindow: number,
  retryContextTokens: number | undefined,
):
  | { fits: boolean; fitBudget: number }
  | { fits: null; fitBudget: number } {
  if (contextWindow <= 0) {
    return { fits: retryContextTokens === undefined ? null : true, fitBudget: contextWindow };
  }
  const fitBudget = Math.max(0, contextWindow - resolveBudgetReserveTokens(contextWindow, DEFAULT_COMPACTION_SETTINGS));
  if (retryContextTokens === undefined) return { fits: null, fitBudget };
  return { fits: retryContextTokens <= fitBudget, fitBudget };
}

/**
 * The runtime's gate walk, over an ALREADY-BUILT registry — the ONE place the
 * three rules are spelled. The one-shot probe (below) and the runner's failure
 * attribution both call this, so an attribution can never drift from the
 * diagnostic.
 */
export function walkSeatGates(opts: {
  registry: ModelRegistry;
  chain: readonly string[];
  /** The retry context, when the caller knows it; absent = context not judged. */
  retryContextTokens?: number;
}): ProbeSelectorVerdict[] {
  const { registry } = opts;
  const selectors: ProbeSelectorVerdict[] = [];
  for (const selector of opts.chain) {
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
        context: { fits: false, retryContextTokens: opts.retryContextTokens ?? null, contextWindow: null, fitBudget: null },
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
    const fit = contextFit(metadata.contextWindow, opts.retryContextTokens);
    selectors.push({
      selector,
      provider,
      modelId,
      // The runtime's gate order: resolution, then credential, then window.
      gate: !configured ? "pool_key" : fit.fits === false ? "context" : "eligible",
      registry: { resolved: true, metadata },
      poolKey: { configured },
      context: {
        fits: fit.fits,
        retryContextTokens: opts.retryContextTokens ?? null,
        contextWindow: metadata.contextWindow,
        fitBudget: fit.fitBudget,
      },
    });
  }
  return selectors;
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
    const selectors = walkSeatGates({ registry, chain, retryContextTokens: input.retryContextTokens });
    return { chain, selectors, droppedCandidate: selectors.find((verdict) => verdict.gate !== "eligible") ?? null };
  } finally {
    authStorage.close();
    await rm(agentDir, { recursive: true, force: true });
  }
}

/** One chain selector, as the failed round's attribution reports it. */
export type ChainAttribution = {
  selector: string;
  /** The selector the round ran; every other entry is a failover candidate. */
  role: "served" | "candidate";
  verdict: "served" | "dropped" | "eligible";
  gate: ProbeGate;
  /** Operator-actionable sentence — never key material, never a pool size. */
  reason: string;
};

/**
 * Turn the gate walk into the round's disposition: the FIRST selector served
 * the failed request, every later one is a candidate that either dropped at a
 * named gate or was eligible. A missing credential names the provider and says
 * the App stores none — that is the operator's action, not a code defect.
 */
export function attributeChain(verdicts: readonly ProbeSelectorVerdict[]): ChainAttribution[] {
  return verdicts.map((verdict, index): ChainAttribution => {
    if (index === 0) {
      return {
        selector: verdict.selector,
        role: "served",
        verdict: "served",
        gate: verdict.gate,
        reason: "served the failed request",
      };
    }
    if (verdict.gate === "registry") {
      return {
        selector: verdict.selector,
        role: "candidate",
        verdict: "dropped",
        gate: verdict.gate,
        reason: "dropped at registry: no provider in the synthesized file or the bundled catalog resolves this model",
      };
    }
    if (verdict.gate === "pool_key") {
      return {
        selector: verdict.selector,
        role: "candidate",
        verdict: "dropped",
        gate: verdict.gate,
        reason: `dropped at pool_key: the App stores no credential for provider ${verdict.provider}`,
      };
    }
    if (verdict.gate === "context") {
      return {
        selector: verdict.selector,
        role: "candidate",
        verdict: "dropped",
        gate: verdict.gate,
        reason: `dropped at context: the retry context does not fit the declared window (${verdict.context.contextWindow ?? "unknown"})`,
      };
    }
    return {
      selector: verdict.selector,
      role: "candidate",
      verdict: "eligible",
      gate: verdict.gate,
      reason:
        verdict.context.fits === null
          ? "eligible: registry and credential pass; context not evaluated (no live context at failure)"
          : "eligible: registry, credential and context all pass",
    };
  });
}

/**
 * The single stderr line a failed round carries after its provider error. It
 * is printed LAST so the Worker's bounded stderr tail (the only diagnosis a
 * non-zero exit keeps) contains it.
 */
export function formatChainAttribution(attributions: readonly ChainAttribution[]): string {
  if (attributions.length === 0) return "review: chain attribution: no model chain was configured";
  return `review: chain attribution: ${attributions.map((entry) => `${entry.selector} ${entry.reason}`).join("; ")}`;
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

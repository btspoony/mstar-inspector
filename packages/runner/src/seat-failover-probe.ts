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

/** One CONFIGURED chain selector, as the failed round's attribution reports it. */
export type ChainAttribution = {
  selector: string;
  /**
   * `served` is set ONLY from an observation the runtime supplied; a configured
   * entry the round never reported on is a `candidate`, whatever its position.
   */
  role: "served" | "candidate";
  verdict: "served" | "dropped" | "eligible";
  gate: ProbeGate;
  /** Operator-actionable sentence — never key material, never a pool size. */
  reason: string;
};

/**
 * Turn the gate walk into the failed round's disposition. EVERY entry is a
 * CONFIGURED selector with its own eligibility verdict — a missing credential
 * names the provider and says the App stores none, which is the operator's
 * action rather than a code defect.
 *
 * NOTHING here claims a selector SERVED unless `observed` names it: chain order
 * is configuration, not an observation. The runtime may fail before any prompt
 * was sent, a seat override may have replaced the chain, or a later fallback may
 * have been the one that failed — all cases where "index zero served" would be
 * an invented fact in a durable row. `observed` is only ever the runtime's own
 * applied-model answer for this round; the failure path normally has none.
 */
export function attributeChain(
  verdicts: readonly ProbeSelectorVerdict[],
  observed?: string,
): ChainAttribution[] {
  return verdicts.map((verdict): ChainAttribution => {
    if (observed !== undefined && observed === `${verdict.provider}/${verdict.modelId}`) {
      return {
        selector: verdict.selector,
        role: "served",
        verdict: "served",
        gate: verdict.gate,
        reason: "observed serving this round",
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
 * The failure representation's budget, in CHARACTERS, owned HERE (the runner)
 * rather than by whoever reads it. The Worker persists the last
 * `STDERR_TAIL_MAX` = 600 characters of stderr and nothing else, so the whole
 * block — cause first, disposition after — must fit well inside that with room
 * for the consumer's own prefix ("runner failed: exit N, stdout NB, stderr
 * tail: ", ~50 chars) and for redaction to only ever shrink it.
 */
export const FAILURE_BLOCK_BUDGET_CHARS = 500;

/** The cause's share of that budget: enough for a provider's own message. */
export const FAILURE_CAUSE_MAX_CHARS = 240;

/**
 * One entry's cap. An entry larger than this is TRUNCATED (with an ellipsis),
 * not dropped: a single oversized diagnostic — the exception path's
 * multi-kilobyte message — must still say what failed, and folding it away
 * would leave the block naming no cause at all.
 */
export const FAILURE_ENTRY_MAX_CHARS = 180;

/** The rendered form of one configured chain's attribution (the formatter takes plain lines). */
export function attributionEntries(attributions: readonly ChainAttribution[]): string[] {
  return attributions.map((entry) => `${entry.selector} ${entry.reason}`);
}

/** The counted fold that replaces the entries the budget could not carry. */
function omittedMarker(count: number): string {
  return `+${count} more chain ${count === 1 ? "entry" : "entries"} omitted`;
}

/**
 * The ONE bounded failure representation a failed round emits: the ORIGINAL
 * cause first (always preserved, truncated only when it alone would blow the
 * budget), then every configured selector's disposition in chain order until
 * the budget is reached, then a counted "N more entries omitted" fold.
 *
 * Why one block and one budget: the consumer keeps only the tail of stderr, so
 * an unbounded disposition printed after the cause would evict the cause — and
 * simply reordering would evict the disposition instead. Reserving the cause's
 * room HERE is the only version where both survive the tail.
 */
export function formatFailureAttribution(
  cause: string,
  entries: readonly string[],
  budgetChars: number = FAILURE_BLOCK_BUDGET_CHARS,
): string {
  const causeText = cause.trim();
  const causeLine =
    causeText.length <= FAILURE_CAUSE_MAX_CHARS
      ? `review: runtime failed: ${causeText}`
      : `review: runtime failed: ${causeText.slice(0, FAILURE_CAUSE_MAX_CHARS - 1)}…`;
  // No disposition to add: the cause alone IS the block — still bounded, so a
  // pathologically long cause cannot evict itself from the Worker's tail.
  if (entries.length === 0) return causeLine;
  const head = `\nreview: chain attribution (configured): `;
  // Each entry is bounded FIRST, so an oversized one is truncated rather than
  // folded away — the fold is for a count of entries, not for one long message.
  const bounded = entries.map((entry) =>
    entry.length <= FAILURE_ENTRY_MAX_CHARS ? entry : `${entry.slice(0, FAILURE_ENTRY_MAX_CHARS - 1)}…`,
  );
  // The LONGEST prefix whose folded form still fits: the fold's own length
  // depends on the count it states, so it is recomputed at every step.
  const assemble = (count: number): string => {
    const omitted = bounded.length - count;
    const body = bounded.slice(0, count).join("; ");
    const fold = omitted === 0 ? "" : count === 0 ? omittedMarker(omitted) : `; ${omittedMarker(omitted)}`;
    return `${causeLine}${head}${body}${fold}`;
  };
  for (let count = bounded.length; count >= 0; count--) {
    const candidate = assemble(count);
    if (candidate.length <= budgetChars) return candidate;
  }
  // Not even the bare fold fits (a pathologically long cause): keep the cause
  // and state the omission without an entry — never drop the fold itself.
  return assemble(0);
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

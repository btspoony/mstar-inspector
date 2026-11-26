/**
 * why: Pure token-usage aggregation for the review side document. Folds the
 * SDK's session entries (assistant `message` turns and off-transcript
 * `model_usage` records) plus settled subagent results into per-(provider,
 * model) buckets. The runner merges the two sources because they are
 * DISJOINT — a subagent's spend is never duplicated into the parent's
 * session entries (it lands in `getUsageStatistics()` only), so folding both
 * cannot double-count and folding neither silently drops the seats' spend.
 *
 * Everything here is a pure function over plain values: capture faults
 * degrade to fewer buckets, never to a thrown error that would fail a review.
 */
import type { SessionEntry, SingleResult } from "@oh-my-pi/pi-coding-agent";
import type { Usage } from "@oh-my-pi/pi-ai";

import type { TokenUsageBucket } from "../../shared/src/token-usage-wire";

/** The slice of a settled subagent result the fold needs — all-optional so an error-carried partial still folds. */
export type SubagentUsageSource = Partial<Pick<SingleResult, "usage" | "requests" | "resolvedModel" | "resolvedModelIdentity">>;

/** SDK thinking levels a `resolvedModel` may suffix as `:<level>` — anything else is part of the model id. */
export const THINKING_LEVELS: Record<string, true> = {
  auto: true,
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

function newBucket(provider: string, model: string): TokenUsageBucket {
  return {
    provider,
    model,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    requests: 0,
    costUsd: 0,
  };
}

function bucketFor(buckets: Map<string, TokenUsageBucket>, provider: string, model: string): TokenUsageBucket | undefined {
  if (provider.trim() === "" || model.trim() === "") return undefined;
  // JSON keeps (a, bcde) and (ab, cde) distinct — a bare `${provider}${model}`
  // concatenation merges them into one bucket.
  const key = JSON.stringify([provider, model]);
  let bucket = buckets.get(key);
  if (bucket === undefined) {
    bucket = newBucket(provider, model);
    buckets.set(key, bucket);
  }
  return bucket;
}

/**
 * why: Fold one provider-reported `Usage` into `bucket` plus one request.
 * A missing usage object still counts its request — the request happened even
 * when the provider declined to meter it (a usage-less assistant turn is the
 * recorded evidence of one). Non-finite fields degrade to 0: capture is
 * analysis data, never a gate, and never fabricates a number.
 */
function foldUsage(bucket: TokenUsageBucket, usage: Usage | undefined, requests: number): void {
  bucket.requests += requests;
  if (usage === undefined || usage === null) return;
  const count = (value: number | undefined): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  bucket.input += count(usage.input);
  bucket.output += count(usage.output);
  bucket.cacheRead += count(usage.cacheRead);
  bucket.cacheWrite += count(usage.cacheWrite);
  bucket.total += count(usage.totalTokens);
  bucket.costUsd += count(usage.cost?.total);
}

function sorted(buckets: Map<string, TokenUsageBucket>): TokenUsageBucket[] {
  return [...buckets.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );
}

/**
 * Fold a session's journaled entries into per-(provider, model) buckets:
 * `message` entries whose message is an assistant turn, and `model_usage`
 * entries (off-transcript calls — judgments, completions, cache refresh).
 * One folded entry is one request, whether or not the provider metered it.
 */
export function bucketsFromSession(entries: readonly SessionEntry[]): TokenUsageBucket[] {
  const buckets = new Map<string, TokenUsageBucket>();
  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message === null || typeof message !== "object" || message.role !== "assistant") continue;
      const bucket = bucketFor(buckets, message.provider, message.model);
      if (bucket !== undefined) foldUsage(bucket, message.usage, 1);
      continue;
    }
    if (entry.type === "model_usage") {
      const bucket = bucketFor(buckets, entry.provider, entry.model);
      if (bucket !== undefined) foldUsage(bucket, entry.usage, 1);
    }
  }
  return sorted(buckets);
}

/**
 * Fold one settled subagent `SingleResult`: its aggregate `usage` plus
 * `requests`, attributed to the `<provider>/<id>` in `resolvedModelIdentity` —
 * the identity never carries the thinking suffix, so a literal model id that
 * itself ends in `:<level>` (e.g. `coding-router:high`) stays intact.
 * `resolvedModel` (which may suffix `:<thinking>`) is the fallback for an
 * older result without the identity and is stripped as before. An absent,
 * blank or malformed resolved value yields no bucket — the caller drops the
 * result rather than invent a provider.
 */
export function bucketFromSubagent(result: SubagentUsageSource | undefined): TokenUsageBucket | undefined {
  const identity = result?.resolvedModelIdentity;
  const resolved = identity ?? result?.resolvedModel;
  if (resolved === undefined || resolved === null) return undefined;
  const slash = resolved.indexOf("/");
  if (slash < 0) return undefined;
  const provider = resolved.slice(0, slash);
  let model = resolved.slice(slash + 1);
  if (identity === undefined) {
    const suffix = model.lastIndexOf(":");
    if (suffix >= 0 && THINKING_LEVELS[model.slice(suffix + 1)] === true) {
      model = model.slice(0, suffix);
    }
  }
  if (provider.trim() === "" || model.trim() === "") return undefined;
  const bucket = newBucket(provider, model);
  const requests =
    typeof result?.requests === "number" && Number.isFinite(result.requests) && result.requests > 0
      ? result.requests
      : 0;
  foldUsage(bucket, result?.usage, requests);
  return bucket;
}
/**
 * Fold every settled subagent `SingleResult` into buckets — the child-seat
 * half of the fold. A result that yields no bucket drops out (see
 * `bucketFromSubagent`).
 */
export function bucketsFromSubagents(singles: readonly (SubagentUsageSource | undefined)[]): TokenUsageBucket[] {
  return singles.flatMap((single) => {
    const bucket = bucketFromSubagent(single);
    return bucket === undefined ? [] : [bucket];
  });
}

/**
 * Merge bucket lists into one sorted list — the session fold and each
 * subagent fold ride as inputs so the caller composes whatever sources the
 * run produced. Stable: equal (provider, model) pairs sum every bucket field.
 */
export function mergeBuckets(...sources: readonly (readonly TokenUsageBucket[])[]): TokenUsageBucket[] {
  const buckets = new Map<string, TokenUsageBucket>();
  for (const source of sources) {
    for (const item of source) {
      const bucket = bucketFor(buckets, item.provider, item.model);
      if (bucket === undefined) continue;
      bucket.input += item.input;
      bucket.output += item.output;
      bucket.cacheRead += item.cacheRead;
      bucket.cacheWrite += item.cacheWrite;
      bucket.total += item.total;
      bucket.requests += item.requests;
      bucket.costUsd += item.costUsd;
    }
  }
  return sorted(buckets);
}

/**
 * The slice of `sessionManager.getUsageStatistics()` the deep-seat remainder
 * needs — all-optional so a missing field degrades to 0. `totalTokens` is the
 * stats' name for the bucket's `total`; `cost` carries USD.
 */
export type UsageStatsSource = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: number;
} | undefined | null;

function remainderField(value: number | undefined, folded: number): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, raw - folded);
}

/**
 * why: The deep parent's `task`-dispatched review seats spend tokens the SDK
 * folds into `getUsageStatistics()` without journaling entries or reporting
 * subagent results, so `runTokenUsage` cannot see them. Emit ONE
 * `unattributed/deep-seat-spend` bucket carrying stats minus the folded
 * buckets, per field clamped at 0 — the seat spend that would otherwise be
 * silently dropped. `folded` must contain ONLY buckets whose spend is inside
 * `stats` — the recheck/report seats run in their own sessions, so their
 * buckets stay OUT of the parent's stats and subtracting them would erase
 * the remainder. `requests` is 0 because the stats expose no per-request
 * count (`premiumRequests` counts premium requests only, not the seats').
 * Deep path only: the quick path already folds its seat results and would
 * double-count. A remainder total of 0 emits nothing.
 */
export function deepSeatRemainder(
  stats: UsageStatsSource,
  folded: readonly TokenUsageBucket[],
): TokenUsageBucket | undefined {
  if (stats === undefined || stats === null) return undefined;
  const sum = (field: "input" | "output" | "cacheRead" | "cacheWrite" | "total" | "costUsd"): number =>
    folded.reduce((total, bucket) => total + bucket[field], 0);
  const bucket = newBucket("unattributed", "deep-seat-spend");
  bucket.input = remainderField(stats.input, sum("input"));
  bucket.output = remainderField(stats.output, sum("output"));
  bucket.cacheRead = remainderField(stats.cacheRead, sum("cacheRead"));
  bucket.cacheWrite = remainderField(stats.cacheWrite, sum("cacheWrite"));
  bucket.total = remainderField(stats.totalTokens, sum("total"));
  bucket.costUsd = remainderField(stats.cost, sum("costUsd"));
  return bucket.total > 0 ? bucket : undefined;
}

/**
 * why: The deep path's token-usage document: parent journaled buckets + the
 * recheck/report child buckets + the nested-seat remainder. The child seats
 * run in their own sessions — their spend is NOT inside the parent's
 * `getUsageStatistics()` — so the remainder subtracts ONLY the parent's own
 * journaled buckets; folding the child buckets into the subtraction would
 * under-count or erase the nested seat spend.
 */
export function deepTokenUsage(
  stats: UsageStatsSource,
  entries: readonly SessionEntry[],
  singles: readonly (SubagentUsageSource | undefined)[],
): TokenUsageBucket[] {
  const parentBuckets = bucketsFromSession(entries);
  const remainder = deepSeatRemainder(stats, parentBuckets);
  return mergeBuckets(
    parentBuckets,
    bucketsFromSubagents(singles),
    remainder === undefined ? [] : [remainder],
  );
}

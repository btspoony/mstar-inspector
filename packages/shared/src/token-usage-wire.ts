/**
 * The review run's token-usage side document (fixed in-image path). The
 * published envelope is the engine's schema and must not grow fields, so the
 * per-(provider, model) token spend crosses the container boundary as its OWN
 * document — mirrors `APPLIED_MODEL_PATH`. ABSENCE of the file means the run
 * produced no attributable usage (capture faults never fail the review). The
 * `nonce` binds the document to one consumer-issued run: a stale document a
 * failed clear left behind carries a foreign (or no) nonce and the reader
 * drops it — never this run reading a previous run's usage. `costUsd` is the
 * SDK catalogue estimate — informational, never invoice-grade.
 */
export const TOKEN_USAGE_PATH = "/workspace/review-token-usage.json";

/**
 * Byte bound on the side document — the consumer's bounded read and the
 * runner's own validation share it. Sized for a few dozen provider/model
 * buckets, never unbounded.
 */
export const TOKEN_USAGE_MAX_BYTES = 64 * 1024;

/** Bound on the bucket list — a run fans out to a handful of provider/model pairs. */
export const TOKEN_USAGE_MAX_BUCKETS = 64;

/** Bound on the provider/model labels the document may carry. */
export const TOKEN_USAGE_NAME_MAX_CHARS = 128;

/** One (provider, model)'s consumption for the run — counts are non-negative safe integers. */
export type TokenUsageBucket = {
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  requests: number;
  costUsd: number;
};

export type TokenUsageDoc = { version: 1; nonce: string; buckets: TokenUsageBucket[] };

export type TokenUsageGateResult = { ok: true; doc: TokenUsageDoc } | { ok: false; error: string };

const BUCKET_KEYS = [
  "provider",
  "model",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "total",
  "requests",
  "costUsd",
] as const;

const COUNT_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total", "requests"] as const;

function nameCheck(value: unknown, field: string): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: `${field} must be a string` };
  }
  if (value.trim() === "") {
    return { ok: false, error: `${field} must not be blank` };
  }
  if (value.length > TOKEN_USAGE_NAME_MAX_CHARS) {
    return {
      ok: false,
      error: `${field} is ${value.length} chars, over its ${TOKEN_USAGE_NAME_MAX_CHARS}-char budget`,
    };
  }
  return { ok: true, name: value };
}

/**
 * Validate one container-written token-usage document. Document-level
 * distrust: a non-object, an unknown/missing key, a wrong `version`, a
 * blank/over-long `nonce`, a count that is not a non-negative SAFE integer
 * (so downstream D1 aggregation can never overflow), a negative or non-finite
 * `costUsd`, a blank or over-long provider/model, or more buckets than the
 * bound rejects the WHOLE document. `nonce` is only shape-checked here — the
 * run-scoped equality check lives consumer-side. `total` is required and
 */
export function validateTokenUsageDoc(value: unknown): TokenUsageGateResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "document is not an object" };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "buckets" || keys[1] !== "nonce" || keys[2] !== "version") {
    return { ok: false, error: "keys must be exactly {version, nonce, buckets}" };
  }
  if (record["version"] !== 1) {
    return { ok: false, error: "version must be 1" };
  }
  const nonce = nameCheck(record["nonce"], "nonce");
  if (!nonce.ok) return nonce;

  const raw = record["buckets"];
  if (!Array.isArray(raw)) {
    return { ok: false, error: "buckets must be an array" };
  }
  if (raw.length > TOKEN_USAGE_MAX_BUCKETS) {
    return {
      ok: false,
      error: `buckets has ${raw.length} entries, over its ${TOKEN_USAGE_MAX_BUCKETS}-entry budget`,
    };
  }
  const expectedBucketKeys = [...BUCKET_KEYS].sort();
  const totals = new Map<(typeof COUNT_FIELDS)[number], number>(COUNT_FIELDS.map((field) => [field, 0]));
  const buckets: TokenUsageBucket[] = [];
  for (const [index, item] of raw.entries()) {
    const label = `buckets[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `${label} is not an object` };
    }
    const entry = item as Record<string, unknown>;
    const entryKeys = Object.keys(entry).sort();
    if (
      entryKeys.length !== expectedBucketKeys.length ||
      entryKeys.some((key, position) => key !== expectedBucketKeys[position])
    ) {
      return { ok: false, error: `${label} keys must be exactly {${BUCKET_KEYS.join(", ")}}` };
    }
    const provider = nameCheck(entry["provider"], `${label}.provider`);
    if (!provider.ok) return provider;
    const model = nameCheck(entry["model"], `${label}.model`);
    if (!model.ok) return model;
    const bucket = { provider: provider.name, model: model.name } as TokenUsageBucket;
    for (const field of COUNT_FIELDS) {
      const count = entry[field];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        return { ok: false, error: `${label}.${field} must be a non-negative safe integer` };
      }
      bucket[field] = count;
      const sum = (totals.get(field) ?? 0) + count;
      if (!Number.isSafeInteger(sum)) {
        return { ok: false, error: `${label}.${field} overflows the document's aggregate bound` };
      }
      totals.set(field, sum);
    }
    const costUsd = entry["costUsd"];
    if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
      return { ok: false, error: `${label}.costUsd must be a non-negative finite number` };
    }
    bucket.costUsd = costUsd;
    buckets.push(bucket);
  }
  return { ok: true, doc: { version: 1, nonce: nonce.name, buckets } };
}

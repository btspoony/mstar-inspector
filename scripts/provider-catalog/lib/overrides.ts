
/** Protocol api → the provider's live vocabulary for that protocol, verbatim. */
export type Override = {
  source: string;
  fetched: string;
  note?: string;
  buckets: Record<string, string[]>;
};

export type OverrideApplied = {
  provider: string;
  bucket: string;
  recordId: string;
  models: number;
  source: string;
  fetched: string;
};

type RecordRow = { id: string; api: string; models: string[] };

/**
 * The suffix the extractor (and the generator) append to a non-primary
 * protocol's record id: the primary protocol keeps the plain provider id.
 */
export const PROTOCOL_SUFFIX: Record<string, string> = {
  "anthropic-messages": "anthropic",
  "openai-responses": "responses",
  "openai-completions": "completions",
  typesafe: "typesafe",
  "google-generative-ai": "gemini",
};

/**
 * Apply the measured overrides. A bucket naming a record the extraction did not
 * produce is reported in `unmatched`, never invented: that is the signal that
 * omp stopped shipping the protocol (or the provider id moved), and silently
 * adding a record would publish a provider omp does not declare.
 */
export function applyOverrides<T extends RecordRow>(
  records: readonly T[],
  overrides: Record<string, Override>,
  protocolSuffix: Record<string, string> = PROTOCOL_SUFFIX,
): { records: T[]; applied: OverrideApplied[]; unmatched: string[] } {
  const applied: OverrideApplied[] = [];
  const unmatched: string[] = [];
  const next: T[] = records.map((record) => ({ ...record }));

  for (const [providerId, override] of Object.entries(overrides)) {
    for (const [api, models] of Object.entries(override.buckets)) {
      const record =
        next.find((candidate) => candidate.id === providerId && candidate.api === api) ??
        next.find(
          (candidate) =>
            candidate.id === `${providerId}-${protocolSuffix[api] ?? api}` && candidate.api === api,
        );
      if (record === undefined) {
        unmatched.push(`${providerId} ${api}`);
        continue;
      }
      record.models = [...models];
      applied.push({
        provider: providerId,
        bucket: api,
        recordId: record.id,
        models: record.models.length,
        source: override.source,
        fetched: override.fetched,
      });
    }
  }
  return { records: next, applied, unmatched };
}

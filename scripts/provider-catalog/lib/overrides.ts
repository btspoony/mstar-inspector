/**
 * The hand-measured override layer for the vendored omp provider snapshot.
 *
 * Why this exists: the snapshot used to be the package's vocabulary verbatim,
 * which made the generated catalog wrong whenever the package and the vendor's
 * live endpoint disagreed — and a hand edit to the generated JSON was destroyed
 * by the next `bun run provider:catalog`. The override file is that measurement
 * in a place regeneration READS instead of overwrites, so the pipeline stays
 * idempotent.
 *
 * A named protocol bucket replaces that record's `models` WHOLESALE, never a
 * union: the package and the vendor disagree about id dialects (one prefixes a
 * namespace, the other does not), so merging would publish ids the provider
 * rejects. Ids are carried verbatim in both directions — no prefix is invented
 * for a bare id and none is stripped from a namespaced one.
 *
 * This module is pure so it can be tested without running the extractor (whose
 * top level reads the installed package and writes files).
 */

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

/** The single-record shape this layer needs; the extractor's record is wider. */
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

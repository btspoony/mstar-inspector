/**
 * RFC 3339 (what GitHub stamps) → the ONE spelling every stored / compared
 * stamp uses. Shared contract: the webhook face gates the raw payload with it
 * and the PR-ledger store re-applies it, so a second caller cannot store an
 * unorderable spelling behind a lexical comparison.
 */

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Rewrite a GitHub timestamp to UTC ISO-8601 (`new Date(v).toISOString()`).
 * `RFC3339` admits numeric offsets (`+02:00`), which do NOT sort correctly as
 * text against `Z`; after this rewrite the payload's `head_at` and the
 * ledger's `head_at` compare byte-for-byte. Junk (and anything absent) →
 * `undefined`, never `now`: SQLite's `datetime()` silently returns NULL for
 * junk, which would let a "no timestamp" fallback masquerade as a real clock.
 */
export function normalizeRfc3339(value: string | null | undefined): string | undefined {
  if (!RFC3339.test(value ?? "")) return undefined;
  const time = new Date(value as string);
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString();
}

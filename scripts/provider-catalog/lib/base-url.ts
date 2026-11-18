/**
 * Which base URL a template row may prefill — the rule `extract-omp-snapshot.ts`
 * publishes in `source.rules`, kept pure here so it is testable without running
 * the extractor (whose top level reads the installed SDK and writes files).
 *
 * The declaration store requires https, so a candidate that only the local
 * machine can reach is unusable. Candidates are tried IN ORDER — the record's
 * most common model base URL first, then the authored seed base URL — so a
 * provider whose models all point at localhost still gets its authored URL
 * instead of `null`.
 */

/** Hosts only the local machine can reach (`localhost`, `127.0.0.0/8`, `::1`). */
const LOOPBACK_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;

/** The candidate a declaration can store, or null when it cannot. */
export function storableBaseUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return url.startsWith("https://") && !LOOPBACK_HOSTS.test(host) ? url : null;
}

/** The first storable candidate, in priority order; null when none is. */
export function declarationBaseUrl(candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    const storable = storableBaseUrl(candidate);
    if (storable !== null) return storable;
  }
  return null;
}

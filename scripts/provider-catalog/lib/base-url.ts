
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

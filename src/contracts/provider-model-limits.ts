/**
 * Does a declaration's base URL identify a catalog row? The vendor table's
 * numbers describe the vendor's ENDPOINT, so a declaration matches only when
 * its base URL IS that row's.
 *
 * Catalog URLs may carry runtime placeholders (`{account_id}`, `{gateway}`)
 * that the save flow substitutes; a placeholder matches one path segment.
 * Trailing slashes are insignificant. Zero imports: the Worker and the SPA both
 * evaluate this predicate.
 */
export function catalogBaseUrlMatches(
  catalogBaseUrl: string | null | undefined,
  declaredBaseUrl: string,
): boolean {
  if (catalogBaseUrl === null || catalogBaseUrl === undefined) return false;
  const trim = (url: string): string => url.trim().replace(/\/+$/, "");
  const template = trim(catalogBaseUrl);
  const declared = trim(declaredBaseUrl);
  if (!template.includes("{")) return template === declared;
  const pattern = template
    .split(/(\{[a-z_]+\})/g)
    .map((part) =>
      /^\{[a-z_]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${pattern}$`).test(declared);
}

/**
 * Does a declaration's base URL name ONE of a catalog row's own endpoints? A
 * mixed-protocol row serves several (one per protocol), and the vendor's
 * numbers describe each of them — a URL outside the set borrows nothing.
 */
export function catalogEndpointsMatch(
  catalogBaseUrls: readonly (string | null | undefined)[],
  declaredBaseUrl: string,
): boolean {
  return catalogBaseUrls.some((catalogBaseUrl) => catalogBaseUrlMatches(catalogBaseUrl, declaredBaseUrl));
}

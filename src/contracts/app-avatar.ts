/**
 * The App icon URL — ONE derivation for both sides of the bundle boundary.
 *
 * GitHub serves an App's uploaded logo at
 * `https://avatars.githubusercontent.com/in/<github_app_id>`: the same CDN
 * object the bot account's `avatar_url` points at, minus the request. An App
 * JWT is accepted only on `/app*` and the `/…/installation` routes, so there is
 * no API call that returns it — the numeric id is the whole input.
 *
 * Zero imports, no I/O: the dashboard's metadata sync caches this value and the
 * SPA derives it on read when the cache is empty, and both must produce the
 * exact same string (a drift here would silently show a broken image).
 */

/** The CDN namespace GitHub serves App icons from. */
export const APP_AVATAR_BASE_URL = "https://avatars.githubusercontent.com/in";

/**
 * The App's icon URL for a numeric GitHub App id. The size/version query keeps
 * the request small and busts a stale CDN cache the way the API's own
 * `avatar_url` values do.
 */
export function appAvatarUrl(githubAppId: number): string {
  return `${APP_AVATAR_BASE_URL}/${githubAppId}?s=120&v=4`;
}

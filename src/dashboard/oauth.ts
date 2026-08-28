/**
 * GitHub OAuth App (user-to-server) helpers for /dashboard login —
 * authorize URL, code→token exchange, user fetch.
 *
 * These credentials are DISTINCT from the review GitHub App
 * (APP_ID / PRIVATE_KEY / WEBHOOK_SECRET): dashboard login uses
 * GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET only
 * (.mstar/iterations/v0.3/guides/oauth-vs-github-app.md). Scope is locked
 * to `read:user` — identity only (product decision 7, plan 08).
 */

export const OAUTH_SCOPE = "read:user";

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "mstar-inspector",
} as const;

export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

/** null on any upstream failure or OAuth error payload (fail-closed). */
export async function exchangeCodeForToken(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<string | null> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { ...GITHUB_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: unknown };
  return typeof data.access_token === "string" && data.access_token.length > 0
    ? data.access_token
    : null;
}

export type GitHubUser = { login: string; name: string | null };

/** null on any upstream failure or unexpected payload (fail-closed). */
export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { login?: unknown; name?: unknown };
  if (typeof data.login !== "string" || data.login.length === 0) return null;
  return { login: data.login, name: typeof data.name === "string" ? data.name : null };
}

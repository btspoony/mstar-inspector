
import { GITHUB_CODE_SHAPE } from "./github-code-shape";

export const OAUTH_SCOPE = "read:user";

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "mstar-inspector",
} as const;
const GITHUB_FETCH_TIMEOUT_MS = 10_000;


/**
 * Structured operator log for OAuth verification failures (same convention as
 * webhooks.ts signature-reject logging). NEVER log codes/tokens/secrets —
 * stages, reasons, and upstream statuses are not secrets.
 */
export function logOAuthFailure(
  stage: "state_verify" | "callback" | "token_exchange" | "user_fetch" | "sign_in",
  reason: string,
  extra: Record<string, unknown> = {},
): void {
  console.warn(JSON.stringify({ event: "dashboard_oauth", stage, reason, ...extra }));
}

function errorType(err: unknown): string {
  if (err instanceof Error) return err.name;
  return String(err);
}

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
  if (!GITHUB_CODE_SHAPE.test(code)) {
    logOAuthFailure("token_exchange", "unsafe_code_shape");
    return null;
  }
  let res: Response;
  try {
    res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      headers: {
        ...GITHUB_HEADERS,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
  } catch (err) {
    logOAuthFailure("token_exchange", "fetch_failed", { error_type: errorType(err) });
    return null;
  }
  if (!res.ok) {
    const githubStatus = res.status;
    await res.body?.cancel();
    logOAuthFailure("token_exchange", "http_error", { github_status: githubStatus });
    return null;
  }
  const data = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
  if (data && typeof data.access_token === "string" && data.access_token.length > 0) {
    return data.access_token;
  }
  logOAuthFailure("token_exchange", "unexpected_payload");
  return null;
}

export type GitHubUser = { login: string; name: string | null };

/** null on any upstream failure or unexpected payload (fail-closed). */
export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser | null> {
  let res: Response;
  try {
    res = await fetch("https://api.github.com/user", {
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    logOAuthFailure("user_fetch", "fetch_failed", { error_type: errorType(err) });
    return null;
  }
  if (!res.ok) {
    const githubStatus = res.status;
    await res.body?.cancel();
    logOAuthFailure("user_fetch", "http_error", { github_status: githubStatus });
    return null;
  }
  const data = (await res.json().catch(() => null)) as {
    login?: unknown;
    name?: unknown;
  } | null;
  if (data && typeof data.login === "string" && data.login.length > 0) {
    return { login: data.login, name: typeof data.name === "string" ? data.name : null };
  }
  logOAuthFailure("user_fetch", "unexpected_payload");
  return null;
}

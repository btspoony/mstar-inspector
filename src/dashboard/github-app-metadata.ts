/**
 * Per-App GitHub metadata fetch — the dashboard-local `GET /app` face
 * (architect decision AD-531).
 *
 * Route-isolation red line (Q2 / AD-531): this module is dashboard-local —
 * it imports NOTHING from src/pipeline/, constructs NO createAppAuth, and
 * shares no module with the pipeline's octokit installation-token face (the
 * createAppAuth single-construction-point pin at src/pipeline/comment.ts
 * :1105 stays untouched; a raw JWT mint never enters that pin's scope).
 * The JWT is minted with pure WebCrypto RS256 (`crypto.subtle`, the only
 * signature primitive workerd offers), reusing the lock-L1 reserved
 * `normalizePrivateKey` copy from src/dashboard/private-key.ts — this is
 * its first src consumer (PKCS#1 → PKCS#8 wrap happens here; PKCS#8 passes
 * through; OpenSSH throws and is swallowed by the catch-all below).
 *
 * The same JWT answers the installation list (`GET /app/installations`) that
 * reconciles `bot_installations` against GitHub — see fetchAppInstallations.
 *
 * Flow: normalizePrivateKey(decryptedPem) → importKey("pkcs8") → RS256-sign
 * `{alg:RS256,typ:JWT}` / `{iat,exp,iss:<githubAppId>}` →
 * GET https://api.github.com/app (Bearer) → extract ONLY the public profile
 * fields the migration-0019/0036 columns cache (name / description / html_url
 * / slug — every URL scheme-gated to https: at extraction). Nothing else from
 * the response — not permissions/events, nothing secret-shaped — leaves this
 * module. The logo needs no request: the shared contract
 * (src/contracts/app-avatar.ts) derives it from the numeric App id — the same
 * CDN object the bot account's `avatar_url` points at. An App JWT is only
 * accepted on `/app*` and the `/…/installation` routes, so a bot-account
 * lookup could never have worked.
 *
 * Every GitHub fact here is MUTABLE (an operator renames the App and the HTML
 * URL follows the slug), so the columns are a cache refreshed on the 24h TTL,
 * never an identifier.
 *
 * Visibility probe: whether an App is public is NOT part of `GET /app`, so
 * the refresh rides a second, anonymous request — `GET
 * https://api.github.com/apps/{slug}`, no Authorization — whose status is the
 * whole answer (200 public, 404 private, anything else = no answer: `null`).
 * A `null` answer is the CALLER's to weigh, and both callers — the metadata
 * refresh and the allowlist save's forced probe — keep the stored value and
 * skip the write: admission never reads it, so a no-answer invalidates
 * nothing. It shares this module because it shares the
 * refresh's failure discipline and bounds, not because it shares the JWT path.
 *
 * Failure discipline (AD-531): ZERO retries, a per-request AbortSignal
 * timeout, and a total catch-all — every failure (OpenSSH key, garbage PEM,
 * import/sign error, network failure, timeout, non-200, unexpected payload)
 * collapses to the structured `{ ok: false }`.
 *
 * Cost bound of ONE real refresh (the fresh-TTL and key-missing paths cost
 * nothing): profile `GET /app` ≤5s, then the installation listing ≤5s for
 * its WHOLE leg (1–10 sequential pages sharing one deadline, 100 ids each),
 * then the visibility probe ≤3s. Worst case ≈13s serial; the TTL keeps that
 * to ≤1/App/day once a sync succeeds. This function NEVER throws: the settings read
 * path wraps decrypt → this fetch → saveGithubMetadata in its own
 * catch-all (fail-open by structure), so a metadata refresh can never
 * surface as a route 5xx. The PEM itself is the caller's decryption result
 * (last-responsible-moment) — this module never sees the envelope, the
 * encryption key, or any webhook secret, and never logs.
 */
import { appAvatarUrl } from "../contracts/app-avatar";
import { normalizePrivateKey } from "./private-key";
import type { GithubAppMetadataInput } from "./apps-store";

const GITHUB_APP_API_URL = "https://api.github.com/app";
const GITHUB_APPS_PUBLIC_URL = "https://api.github.com/apps";
const GITHUB_APP_INSTALLATIONS_URL = "https://api.github.com/app/installations";
const MAX_INSTALLATION_PAGES = 10;
const LISTING_BUDGET_MS = 5_000;
const FETCH_TIMEOUT_MS = 5_000;
const VISIBILITY_TIMEOUT_MS = 3_000;
const JWT_TTL_SEC = 8 * 60;
const JWT_CLOCK_SKEW_SEC = 60;

const enc = new TextEncoder();

/**
 * Lazy-refresh budget (AD-531 lock): a cached profile is served as-is
 * for 24h since `github_metadata_synced_at`; past that the settings read path
 * refreshes once. A row whose `github_slug` is still NULL (never synced) is
 * stale regardless of that timestamp, bounded instead by
 * `github_metadata_attempted_at` (migration 0037) — so an App that cannot sync
 * costs one fetch per TTL window, never one per read. `force: true` (the
 * manager's manual refresh) bypasses both bounds. Together with the zero-retry
 * fetch discipline below this is the whole refresh-policy surface: ≤1 fetch per
 * request, ≤1/App/TTL — no cron/queue exists.
 */
export const GITHUB_METADATA_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the cached GitHub profile needs a lazy refresh. The
 * column is SQLite `datetime('now')` TEXT — `YYYY-MM-DD HH:MM:SS` in UTC —
 * which `Date.parse` alone would read as LOCAL time, so the space form is
 * normalized to ISO-8601 UTC before parsing (the last_webhook_at TEXT
 * convention is UTC everywhere). Anything unreadable (NULL, empty, garbage,
 * a future timestamp) is stale: the worst case is one doomed refresh attempt,
 * never a wrong "fresh" verdict. Pure — the route pins the behavior; no DB.
 */
export function isGithubMetadataStale(
  syncedAt: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (typeof syncedAt !== "string" || syncedAt.length === 0) return true;
  const parsedMs = Date.parse(`${syncedAt.replace(" ", "T")}Z`);
  if (Number.isNaN(parsedMs)) return true;
  const ageMs = nowMs - parsedMs;
  return ageMs < 0 || ageMs >= GITHUB_METADATA_TTL_MS;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return base64ToBytes(body);
}

async function mintAppJwt(githubAppId: number, decryptedPem: string): Promise<string> {
  const pkcs8Pem = normalizePrivateKey(decryptedPem);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pkcs8Pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const nowSec = Math.floor(Date.now() / 1000);
  const header = bytesToBase64Url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = bytesToBase64Url(
    enc.encode(
      JSON.stringify({
        iat: nowSec - JWT_CLOCK_SKEW_SEC,
        exp: nowSec + JWT_TTL_SEC,
        iss: githubAppId,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    enc.encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/**
 * Derive the App slug from `GET /app`'s `html_url`
 * (`https://github.com/apps/<slug>`). Fallback for a degraded payload that
 * omits `slug`; anything else — non-https, a host other than github.com, a
 * different path shape, multiple segments after `apps` — yields null, because
 * a guessed slug would become the bot-mention target.
 */
export function githubAppSlugFromHtmlUrl(htmlUrl: string | null | undefined): string | null {
  if (typeof htmlUrl !== "string" || !htmlUrl.startsWith("https://")) return null;
  let url: URL;
  try {
    url = new URL(htmlUrl);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com") return null;
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  return segments.length === 2 && segments[0] === "apps" ? segments[1]! : null;
}

/**
 * The fetch result: `{ ok: true, metadata }` carries exactly the cached
 * profile fields — the `saveGithubMetadata` input shape, so the caller
 * persists it verbatim. `{ ok: false }` = any failure of the App request
 * (bad key, network/timeout, non-200, unexpected payload); the caller keeps
 * its cached values and responds fail-open.
 */
export type FetchAppMetadataResult =
  | { ok: true; metadata: GithubAppMetadataInput }
  | { ok: false };

/**
 * Fetch one App's public GitHub profile with a freshly minted App JWT.
 * `githubAppId` is the numeric GitHub App id
 * (`github_apps.github_app_id` — the JWT `iss` claim, NOT the row UUID);
 * `decryptedPem` is the already-secretbox-decrypted App private key
 * (decryption happens at the caller — the last responsible moment).
 *
 * Never throws; zero retries; 5s timeout (AD-531).
 */
export async function fetchAppMetadata(
  githubAppId: number,
  decryptedPem: string,
): Promise<FetchAppMetadataResult> {
  try {
    const jwt = await mintAppJwt(githubAppId, decryptedPem);
    const headers = {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mstar-inspector",
    };
    const res = await fetch(GITHUB_APP_API_URL, {
      method: "GET",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false };
    }
    const data = (await res.json().catch(() => null)) as {
      name?: unknown;
      description?: unknown;
      html_url?: unknown;
      slug?: unknown;
    } | null;
    if (!data || typeof data.name !== "string" || data.name.length === 0) {
      return { ok: false };
    }
    const githubHtmlUrl =
      typeof data.html_url === "string" && data.html_url.startsWith("https://")
        ? data.html_url
        : null;
    const slug =
      typeof data.slug === "string" && data.slug.length > 0
        ? data.slug
        : githubAppSlugFromHtmlUrl(githubHtmlUrl);
    return {
      ok: true,
      metadata: {
        githubName: data.name,
        githubDescription: typeof data.description === "string" ? data.description : null,
        githubHtmlUrl,
        githubAvatarUrl: appAvatarUrl(githubAppId),
        githubSlug: slug,
      },
    };
  } catch {
    return { ok: false };
  }
}

/**
 * The authoritative installation list for this App, reduced to the ids the
 * local `bot_installations` rows are keyed by. `{ ok: false }` = the whole
 * answer is unusable (bad key, network/timeout, non-200, a payload that is not
 * an id array); the caller then changes NO row and keeps its own result.
 */
export type FetchAppInstallationsResult =
  | { ok: true; installationIds: number[] }
  | { ok: false };

type NextInstallationsPage = { kind: "none" } | { kind: "next"; url: string } | { kind: "unusable" };

function nextListPage(linkHeader: string | null, allowedPrefix: string): NextInstallationsPage {
  if (!linkHeader) return { kind: "none" };
  for (const segment of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(segment.trim());
    if (match) {
      return match[1]!.startsWith(allowedPrefix)
        ? { kind: "next", url: match[1]! }
        : { kind: "unusable" };
    }
  }
  return { kind: "none" };
}

/**
 * Fetch this App's installation ids — `GET /app/installations?per_page=100`
 * with a freshly minted App JWT, following `Link rel="next"` up to
 * {@link MAX_INSTALLATION_PAGES} pages.
 *
 * All-or-nothing: the result is the COMPLETE list or `{ ok: false }`. A
 * truncated list would reach `reconcileInstallations`, which stamps every
 * active row absent from the set as removed — so hitting the page cap while a
 * next page still exists, or a next link we refuse to follow, is a failure
 * rather than a partial success.
 *
 * Same failure discipline as {@link fetchAppMetadata}: zero retries and a
 * total catch-all, so a reconcile can never turn the settings read into a 5xx
 * or a failed refresh.
 * Only each entry's numeric `id` leaves this module.
 */
export async function fetchAppInstallations(
  githubAppId: number,
  decryptedPem: string,
): Promise<FetchAppInstallationsResult> {
  try {
    const jwt = await mintAppJwt(githubAppId, decryptedPem);
    const headers = {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mstar-inspector",
    };
    const installationIds: number[] = [];
    let url: string | null = `${GITHUB_APP_INSTALLATIONS_URL}?per_page=100`;
    const deadline = Date.now() + LISTING_BUDGET_MS;
    for (let page = 0; url !== null; page++) {
      if (page >= MAX_INSTALLATION_PAGES) return { ok: false };
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return { ok: false };
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remainingMs)),
        headers,
      });
      if (!res.ok) {
        await res.body?.cancel();
        return { ok: false };
      }
      const data = (await res.json().catch(() => null)) as unknown;
      if (!Array.isArray(data)) return { ok: false };
      for (const entry of data) {
        const id = (entry as { id?: unknown } | null)?.id;
        if (typeof id !== "number") return { ok: false };
        installationIds.push(id);
      }
      const next = nextListPage(res.headers.get("link"), `${GITHUB_APP_INSTALLATIONS_URL}?`);
      if (next.kind === "unusable") return { ok: false };
      url = next.kind === "next" ? next.url : null;
    }
    return { ok: true, installationIds };
  } catch {
    return { ok: false };
  }
}

/** One repository an installation grants — the add-repository dialog's option. */
export type InstallationRepository = { repo_id: number; owner: string; name: string };

/**
 * One installation's repositories, or `null` when that installation's answer
 * was unusable. The caller decides whether a partial answer is degraded.
 */
export type FetchInstallationRepositoriesResult = InstallationRepository[] | null;

const GITHUB_INSTALLATION_REPOSITORIES_URL = "https://api.github.com/installation/repositories";
const MAX_REPOSITORY_PAGES = 5;

/**
 * Mint one installation's access token — `POST
 * /app/installations/{id}/access_tokens` with the App JWT. That token, not the
 * App JWT, is what the repository listing accepts.
 *
 * `null` is "no usable token": non-2xx, a body that is not an object, a
 * missing/blank `token`, network failure or timeout. Zero retries, nothing
 * thrown — the caller counts it as that installation's failure.
 */
export async function mintInstallationAccessToken(
  installationId: number,
  appJwt: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${GITHUB_APP_INSTALLATIONS_URL}/${installationId}/access_tokens`, {
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "mstar-inspector",
      },
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const data = (await res.json().catch(() => null)) as unknown;
    if (typeof data !== "object" || data === null || !("token" in data)) return null;
    const token = data.token;
    if (typeof token !== "string" || token.trim() === "") return null;
    return token;
  } catch {
    return null;
  }
}

/**
 * Fetch one installation's repositories — `GET
 * /installation/repositories?per_page=100` with that installation's access
 * token, walking `Link rel="next"` within this module's budgets.
 *
 * `[]` is a real answer (the installation grants no repository); `null` is
 * "no usable answer" — bad token, network failure, non-200, a payload that is
 * not a repository list, a foreign next link, or the page cap. Callers count
 * nulls to report `degraded`, so this function never invents an empty list on
 * failure. Same failure discipline as the other fetches here: zero retries, a
 * total catch-all, nothing thrown.
 */
export async function fetchInstallationRepositories(
  installationToken: string,
): Promise<FetchInstallationRepositoriesResult> {
  const base = GITHUB_INSTALLATION_REPOSITORIES_URL;
  try {
    const headers = {
      Authorization: `Bearer ${installationToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mstar-inspector",
    };
    const repositories: InstallationRepository[] = [];
    let url: string | null = `${base}?per_page=100`;
    const deadline = Date.now() + LISTING_BUDGET_MS;
    for (let page = 0; url !== null; page++) {
      if (page >= MAX_REPOSITORY_PAGES) return null;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return null;
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remainingMs)),
        headers,
      });
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      const data = (await res.json().catch(() => null)) as unknown;
      if (typeof data !== "object" || data === null || !("repositories" in data)) return null;
      const pageRepositories = data.repositories;
      if (!Array.isArray(pageRepositories)) return null;
      for (const entry of pageRepositories) {
        const row = entry as { id?: unknown; name?: unknown; owner?: { login?: unknown } } | null;
        const repoId = row?.id;
        const name = row?.name;
        const owner = row?.owner?.login;
        if (typeof repoId !== "number" || typeof name !== "string" || typeof owner !== "string") return null;
        repositories.push({ repo_id: repoId, owner, name });
      }
      const next = nextListPage(res.headers.get("link"), `${base}?`);
      if (next.kind === "unusable") return null;
      url = next.kind === "next" ? next.url : null;
    }
    return repositories;
  } catch {
    return null;
  }
}

/** The GitHub account an installation is installed on. */
export type InstallationAccount = { login: string; type: string };

/**
 * One installation's account — `GET /app/installations/{id}` with the App JWT.
 * `null` is "no usable answer"; zero retries, nothing thrown.
 */
export async function fetchInstallationAccount(
  installationId: number,
  appJwt: string,
): Promise<InstallationAccount | null> {
  try {
    const res = await fetch(`${GITHUB_APP_INSTALLATIONS_URL}/${installationId}`, {
      method: "GET",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "mstar-inspector",
      },
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const data = (await res.json().catch(() => null)) as { account?: { login?: unknown; type?: unknown } } | null;
    const login = data?.account?.login;
    const type = data?.account?.type;
    if (typeof login !== "string" || login === "" || typeof type !== "string") return null;
    return { login, type };
  } catch {
    return null;
  }
}

/** Mint the App JWT these installation reads share (throws on an unusable key). */
export async function mintInstallationJwt(githubAppId: number, decryptedPem: string): Promise<string> {
  return mintAppJwt(githubAppId, decryptedPem);
}

/**
 * The two states an anonymous `GET /apps/{slug}` can prove. `null` from
 * {@link fetchAppVisibility} is not a third state — it means "no answer", and
 * every caller keeps the stored value on it.
 */
export type GithubAppVisibilityProbe = "public" | "private";

/**
 * Probe one App's visibility anonymously — `GET https://api.github.com/apps/{slug}`
 * with NO Authorization header (the App JWT face accepts only `/app*`; the
 * public App listing needs no credential at all).
 *
 * Mapping (GitHub answers 200 for a public App and 404 for a private one):
 *   200 → `"public"`, 404 → `"private"`, anything else (5xx, rate limit,
 *   network failure, 3s timeout) → `null`, which is "no answer" — never
 *   "private". Every caller keeps the last stored value on it. Never
 *   throws, zero retries — the metadata refresh that calls it is already
 *   failure-tolerant and TTL-bounded.
 */
export async function fetchAppVisibility(slug: string): Promise<GithubAppVisibilityProbe | null> {
  try {
    const res = await fetch(`${GITHUB_APPS_PUBLIC_URL}/${encodeURIComponent(slug)}`, {
      method: "GET",
      signal: AbortSignal.timeout(VISIBILITY_TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "mstar-inspector",
      },
    });
    await res.body?.cancel();
    if (res.status === 200) return "public";
    if (res.status === 404) return "private";
    return null;
  } catch {
    return null;
  }
}

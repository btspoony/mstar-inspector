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
 * A `null` answer is the CALLER's to weigh, and the two callers weigh it
 * differently: the metadata refresh keeps the stored value, while the
 * allowlist save's forced probe stores `unknown` so its notice reports the
 * state that save just produced. It shares this module because it shares the
 * refresh's failure discipline and bounds, not because it shares the JWT path.
 *
 * Failure discipline (AD-531): ZERO retries (the caller's 24h TTL bounds
 * the cost to ≤1 fetch per request; ≤1/App/day once a sync succeeds), a
 * 5s AbortSignal timeout, and a total
 * catch-all — every failure (OpenSSH key, garbage PEM, import/sign error,
 * network failure, timeout, non-200, unexpected payload) collapses to the
 * structured `{ ok: false }`. This function NEVER throws: the settings read
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
/** Upstream budget (AD-531 lock): 5 seconds, zero retries. */
const FETCH_TIMEOUT_MS = 5_000;
/**
 * Visibility probe budget: an anonymous GET answers from the public App
 * listing, so a miss is cheap — 3 seconds, zero retries, and any non-answer
 * is `null`: the metadata refresh keeps the last stored value instead of
 * clearing it, the allowlist save's forced probe stores `unknown`.
 */
const VISIBILITY_TIMEOUT_MS = 3_000;
/**
 * JWT lifetime — well under GitHub's 10-minute App-JWT cap (no refresh
 * path exists: one fetch, one token, zero retries).
 */
const JWT_TTL_SEC = 8 * 60;
/** Backdate iat for clock drift (the GitHub App auth docs' recommendation). */
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

/** Standard base64 → bytes (PEM body decoding; the private-key.ts helper). */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Bytes → base64url (JWT segments carry no padding). */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strip PEM armor + whitespace → DER bytes (the PKCS#8 body). */
function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return base64ToBytes(body);
}

/**
 * Mint one GitHub App JWT (RS256, `iss` = the numeric GitHub App id) from
 * the decrypted App PEM. Throws on any key problem — the caller's
 * catch-all turns that into `{ ok: false }`.
 */
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
      // Consume the failed body so the connection is released promptly
      // (the manifest.ts convention).
      await res.body?.cancel();
      return { ok: false };
    }
    const data = (await res.json().catch(() => null)) as {
      name?: unknown;
      description?: unknown;
      html_url?: unknown;
      slug?: unknown;
    } | null;
    // Shape gate: `name` is the identity field — without it the payload is
    // not the GET /app shape (STOP clause: a structural change degrades,
    // never breaks). Every other field degrades per-item into the nullable
    // columns (the SPA renders local fields when they read NULL). The URL
    // fields are additionally scheme-gated to https: — the SPA renders them
    // as href/img, so a non-conforming value degrades to null like any other
    // absent field, at the single write source.
    if (!data || typeof data.name !== "string" || data.name.length === 0) {
      return { ok: false };
    }
    const githubHtmlUrl =
      typeof data.html_url === "string" && data.html_url.startsWith("https://")
        ? data.html_url
        : null;
    // `slug` is the authoritative source; html_url derivation covers a
    // payload that drops it, and the fallback reads the scheme-gated URL only.
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
    // Total catch-all (AD-531): normalizePrivateKey throw (OpenSSH format),
    // import/sign errors, network failure, abort timeout — one shape.
    return { ok: false };
  }
}

/**
 * The two states an anonymous `GET /apps/{slug}` can prove. `null` from
 * {@link fetchAppVisibility} is not a third state — it means "no answer", and
 * each caller decides what that leaves: the metadata refresh keeps the stored
 * value, the allowlist save's forced probe stores `unknown`.
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
 *   "private". The caller weighs it: the metadata refresh keeps the last
 *   stored value, the allowlist save's forced probe stores `unknown`. Never
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
    // The payload is irrelevant — only the status carries the fact. Release
    // the connection in every branch (the failed-body convention above).
    await res.body?.cancel();
    if (res.status === 200) return "public";
    if (res.status === 404) return "private";
    return null;
  } catch {
    // Network failure / timeout / malformed response — one shape: "no
    // answer", which the caller weighs (keep the stored value, or `unknown`).
    return null;
  }
}

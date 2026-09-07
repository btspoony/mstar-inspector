/**
 * Per-App GitHub metadata fetch — the dashboard-local `GET /app` face
 * (plan 53 Task 1, architect decision AD-531).
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
 * fields the migration-0019 columns cache (name / description / html_url /
 * owner.avatar_url). Nothing else from the response — not the slug, not
 * permissions/events, nothing secret-shaped — leaves this module.
 *
 * Failure discipline (AD-531): ZERO retries (the caller's 24h TTL bounds
 * the cost to ≤1 fetch/App/day), a 5s AbortSignal timeout, and a total
 * catch-all — every failure (OpenSSH key, garbage PEM, import/sign error,
 * network failure, timeout, non-200, unexpected payload) collapses to the
 * structured `{ ok: false }`. This function NEVER throws: the settings read
 * path wraps decrypt → this fetch → saveGithubMetadata in its own
 * catch-all (fail-open by structure), so a metadata refresh can never
 * surface as a route 5xx. The PEM itself is the caller's decryption result
 * (last-responsible-moment) — this module never sees the envelope, the
 * encryption key, or any webhook secret, and never logs.
 */
import { normalizePrivateKey } from "./private-key";
import type { GithubAppMetadataInput } from "./apps-store";

const GITHUB_APP_API_URL = "https://api.github.com/app";
/** Upstream budget (AD-531 lock): 5 seconds, zero retries. */
const FETCH_TIMEOUT_MS = 5_000;
/**
 * JWT lifetime — well under GitHub's 10-minute App-JWT cap (no refresh
 * path exists: one fetch, one token, zero retries).
 */
const JWT_TTL_SEC = 8 * 60;
/** Backdate iat for clock drift (the GitHub App auth docs' recommendation). */
const JWT_CLOCK_SKEW_SEC = 60;

const enc = new TextEncoder();

/**
 * Lazy-refresh budget (AD-531 lock, plan 53): a cached profile is served as-is
 * for 24h since `github_metadata_synced_at`; past that (or when the column is
 * NULL — never synced) the settings read path refreshes once. This bounds the
 * egress to ≤1 fetch/App/day and, with the zero-retry fetch discipline below,
 * is the whole refresh-policy surface — no cron/queue exists.
 */
export const GITHUB_METADATA_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the cached GitHub profile needs a lazy refresh (plan 53 A4). The
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
 * The fetch result: `{ ok: true, metadata }` carries exactly the four
 * migration-0019 profile fields — the `saveGithubMetadata` input shape, so
 * the caller persists it verbatim. `{ ok: false }` = any failure (bad key,
 * network/timeout, non-200, unexpected payload); the caller keeps its
 * cached values and responds fail-open.
 */
export type FetchAppMetadataResult =
  | { ok: true; metadata: GithubAppMetadataInput }
  | { ok: false };

/**
 * Fetch one App's public GitHub profile with a freshly minted App JWT
 * (plan 53 A3). `githubAppId` is the numeric GitHub App id
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
    const res = await fetch(GITHUB_APP_API_URL, {
      method: "GET",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "mstar-inspector",
      },
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
      owner?: { avatar_url?: unknown } | null;
    } | null;
    // Shape gate: `name` is the identity field — without it the payload is
    // not the GET /app shape (STOP clause: a structural change degrades,
    // never breaks). Every other field degrades per-item into the nullable
    // columns (the SPA renders local fields when they read NULL).
    if (!data || typeof data.name !== "string" || data.name.length === 0) {
      return { ok: false };
    }
    return {
      ok: true,
      metadata: {
        githubName: data.name,
        githubDescription: typeof data.description === "string" ? data.description : null,
        githubHtmlUrl:
          typeof data.html_url === "string" && data.html_url.length > 0 ? data.html_url : null,
        githubAvatarUrl:
          data.owner &&
          typeof data.owner.avatar_url === "string" &&
          data.owner.avatar_url.length > 0
            ? data.owner.avatar_url
            : null,
      },
    };
  } catch {
    // Total catch-all (AD-531): normalizePrivateKey throw (OpenSSH format),
    // import/sign errors, network failure, abort timeout — one shape.
    return { ok: false };
  }
}

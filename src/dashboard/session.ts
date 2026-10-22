/**
 * Dashboard signed-cookie sessions (architect decision Q1).
 *
 * Cookie value format: `base64url(payload).base64url(sig)` where
 * sig = HMAC-SHA256(payload, DASHBOARD_SESSION_SECRET) via WebCrypto
 * `crypto.subtle`. Signature comparison is byte-wise XOR accumulation —
 * non-constant-time comparison is a red line. The payload
 * carries `iat`/`exp` (seconds) and is rejected once expired. No KV/D1
 * session store (plan non-goal); no reuse of GITHUB_OAUTH_CLIENT_SECRET
 * as the signing key (rotation must stay decoupled).
 *
 * `__Host-` prefix contract for both cookies: HttpOnly + Secure +
 * SameSite=Lax + Path=/ and NO Domain attribute.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const SESSION_COOKIE = "__Host-mstar-session";
export const OAUTH_STATE_COOKIE = "__Host-mstar-oauth-state";
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7d
export const OAUTH_STATE_MAX_AGE_SEC = 600;
/**
 * One-shot carrier of "this sign-in created the instance's first account"
 * from the OAuth callback (the last moment the `users` table is empty) to the
 * shell it redirects to. Signed with the session secret so the guidance
 * cannot be claimed by a later request, and short-lived because the shell
 * expires it on read.
 */
export const FIRST_INSTANCE_COOKIE = "__Host-mstar-first-instance";
export const FIRST_INSTANCE_MAX_AGE_SEC = 120;

export type SessionPayload = {
  login: string;
  name?: string;
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch. */
  exp: number;
};

// --- base64url (runtime-pure: btoa/atob exist in workers + Bun) ---

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64urlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Byte-wise XOR accumulation — never short-circuits (timing-safe). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function hmacSign(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** `base64url(payload).base64url(HMAC-SHA256(payload, secret))` */
export async function signValue(payload: string, secret: string): Promise<string> {
  const body = base64urlEncode(enc.encode(payload));
  const sig = await hmacSign(secret, body);
  return `${body}.${base64urlEncode(sig)}`;
}

/** Returns the payload when the signature verifies, null otherwise. */
export async function verifyValue(value: string, secret: string): Promise<string | null> {
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const sig = base64urlDecode(value.slice(dot + 1));
  if (!sig) return null;
  const expected = await hmacSign(secret, body);
  if (!timingSafeEqual(sig, expected)) return null;
  const payloadBytes = base64urlDecode(body);
  if (!payloadBytes) return null;
  return dec.decode(payloadBytes);
}

// --- session payload ---

export async function createSessionValue(
  login: string,
  name: string | null | undefined,
  secret: string,
  nowMs = Date.now(),
): Promise<string> {
  const nowSec = Math.floor(nowMs / 1000);
  const payload: SessionPayload = {
    login,
    ...(name ? { name } : {}),
    iat: nowSec,
    exp: nowSec + SESSION_MAX_AGE_SEC,
  };
  return signValue(JSON.stringify(payload), secret);
}

/** Valid signature + shape + not expired → payload; anything else → null. */
export async function readSessionValue(
  value: string | undefined,
  secret: string,
  nowMs = Date.now(),
): Promise<SessionPayload | null> {
  if (!value) return null;
  const raw = await verifyValue(value, secret);
  if (!raw) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(raw) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.login !== "string" || payload.login.length === 0) return null;
  if (typeof payload.exp !== "number") return null;
  if (payload.exp <= Math.floor(nowMs / 1000)) return null;
  return payload;
}

// --- first-account marker (self-hosted empty-instance guidance) ---

/**
 * Mint the marker for the login that just created this instance's first
 * account. Bound to that login: the shell only honours it for the same
 * session, so a copied cookie cannot tell another account the instance story.
 */
export async function createFirstInstanceValue(
  login: string,
  secret: string,
  nowMs = Date.now(),
): Promise<string> {
  const nowSec = Math.floor(nowMs / 1000);
  return signValue(
    JSON.stringify({ login, iat: nowSec, exp: nowSec + FIRST_INSTANCE_MAX_AGE_SEC }),
    secret,
  );
}

/** Whether the marker is valid for THIS login (bad signature / expired / another login → false). */
export async function readFirstInstanceValue(
  value: string | undefined,
  login: string,
  secret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!value) return false;
  const raw = await verifyValue(value, secret);
  if (!raw) return false;
  let payload: { login?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(raw) as { login?: unknown; exp?: unknown };
  } catch {
    return false;
  }
  if (payload.login !== login) return false;
  if (typeof payload.exp !== "number") return false;
  return payload.exp > Math.floor(nowMs / 1000);
}

// --- OAuth CSRF state ---
/** Random token via crypto.getRandomValues (a security red line). */
export function randomToken(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

/**
 * OAuth CSRF state: HMAC-signed random token. The signed value doubles as
 * both the state cookie value and the `state` authorize param.
 */
export async function createStateValue(secret: string): Promise<string> {
  return signValue(randomToken(), secret);
}

/** Callback check: state param must equal the cookie value AND verify. */
export async function verifyStateValue(
  cookieValue: string | undefined,
  stateParam: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!cookieValue || !stateParam) return false;
  if (!timingSafeEqual(enc.encode(cookieValue), enc.encode(stateParam))) return false;
  return (await verifyValue(cookieValue, secret)) !== null;
}

// --- cookie serialization (__Host- attribute set is fixed on purpose) ---

export function serializeCookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

export function expireCookie(name: string): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

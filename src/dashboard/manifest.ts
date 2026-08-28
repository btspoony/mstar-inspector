/**
 * GitHub App Manifest flow (plan 11 B1 Task 1): start → GitHub form POST →
 * callback → code conversion → encrypted hold cookie. The Cloudflare secret
 * write (commit) is Task 2 — this module never calls the Cloudflare API.
 *
 * Architect locks (spec dashboard-b1-manifest.md § L7/L9):
 * - CSRF state cookie `__Host-mstar-manifest-state`: reuses the B0 HMAC
 *   createStateValue/verifyStateValue, single-use, Max-Age 600; DISTINCT from
 *   B0's `__Host-mstar-oauth-state`. `state` rides the GitHub form-action
 *   query (GitHub echoes it into the redirect_url next to `code`).
 * - Conversion: POST https://api.github.com/app-manifests/{code}/conversions
 *   with Accept: application/vnd.github+json + X-GitHub-Api-Version
 *   2022-11-28 and NO Authorization header (the code is the credential; a
 *   bearer returns 406).
 * - PEM/webhook_secret hold: AES-256-GCM encrypted cookie
 *   `__Host-mstar-manifest-hold`, key = HKDF-SHA256(DASHBOARD_SESSION_SECRET,
 *   info "mstar-manifest-hold"), Max-Age 600, single-use (consumed in T2).
 *   Payload NEVER enters HTML, logs, or D1.
 */
import { base64urlDecode, base64urlEncode } from "./session";

export const MANIFEST_STATE_COOKIE = "__Host-mstar-manifest-state";
export const MANIFEST_HOLD_COOKIE = "__Host-mstar-manifest-hold";
export const MANIFEST_STATE_MAX_AGE_SEC = 600;
export const MANIFEST_HOLD_MAX_AGE_SEC = 600;
export const GITHUB_MANIFEST_CREATE_URL = "https://github.com/settings/apps/new";

const enc = new TextEncoder();
const dec = new TextDecoder();

// Upstream GitHub calls are bounded (same convention as oauth.ts).
const GITHUB_FETCH_TIMEOUT_MS = 10_000;

// Architect lock spec L9: documented Accept + pinned GA API version; the
// code itself is the credential, so NO Authorization header (a bearer
// triggers HTTP 406).
const GITHUB_MANIFEST_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "mstar-inspector",
} as const;

/**
 * Structured operator log for manifest-flow failures (same convention as
 * oauth.ts logOAuthFailure). NEVER log codes, PEM, webhook_secret, or cookie
 * values — stages, reasons, and upstream statuses are not secrets.
 */
export function logManifestFailure(
  stage: "state_verify" | "callback" | "conversion",
  reason: string,
  extra: Record<string, unknown> = {},
): void {
  console.warn(JSON.stringify({ event: "dashboard_manifest", stage, reason, ...extra }));
}

function errorType(err: unknown): string {
  if (err instanceof Error) return err.name;
  return String(err);
}

// --- manifest content (product lock, spec § Manifest 内容) ---

export type ManifestPayload = {
  name: string;
  url: string;
  hook_attributes: { url: string };
  redirect_url: string;
  public: false;
  default_events: ["pull_request", "issue_comment"];
  default_permissions: {
    contents: "read";
    metadata: "read";
    pull_requests: "write";
    issues: "write";
  };
};

/**
 * Manifest JSON for the locked review permission set (mirrors the
 * `.env.example` permission comment; no extra permissions, no OAuth App
 * fields). `redirect_url` stays the bare callback — CSRF `state` rides the
 * form-action query instead (GitHub echoes it back next to `code`).
 */
export function buildManifest(origin: string, login: string): ManifestPayload {
  return {
    name: `mstar-inspector-${login}`,
    url: origin,
    hook_attributes: { url: `${origin}/webhook` },
    redirect_url: `${origin}/dashboard/manifest/callback`,
    public: false,
    default_events: ["pull_request", "issue_comment"],
    default_permissions: {
      contents: "read",
      metadata: "read",
      pull_requests: "write",
      issues: "write",
    },
  };
}

/** GitHub form-action URL carrying the CSRF state (official manifest flow). */
export function buildManifestCreateUrl(state: string): string {
  const url = new URL(GITHUB_MANIFEST_CREATE_URL);
  url.searchParams.set("state", state);
  return url.toString();
}

// --- code → conversion ---

export type ManifestConversion = {
  id: number;
  name: string;
  pem: string;
  webhook_secret: string;
};

/** null on any upstream failure or unexpected payload (fail-closed). */
export async function exchangeManifestCode(code: string): Promise<ManifestConversion | null> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      headers: { ...GITHUB_MANIFEST_HEADERS },
    });
  } catch (err) {
    logManifestFailure("conversion", "fetch_failed", { error_type: errorType(err) });
    return null;
  }
  if (!res.ok) {
    const githubStatus = res.status;
    // Consume the failed body so the connection is released promptly.
    await res.body?.cancel();
    logManifestFailure("conversion", "http_error", { github_status: githubStatus });
    return null;
  }
  const data = (await res.json().catch(() => null)) as {
    id?: unknown;
    name?: unknown;
    pem?: unknown;
    webhook_secret?: unknown;
  } | null;
  if (
    data &&
    typeof data.id === "number" &&
    typeof data.name === "string" &&
    data.name.length > 0 &&
    typeof data.pem === "string" &&
    data.pem.length > 0 &&
    typeof data.webhook_secret === "string" &&
    data.webhook_secret.length > 0
  ) {
    return { id: data.id, name: data.name, pem: data.pem, webhook_secret: data.webhook_secret };
  }
  logManifestFailure("conversion", "unexpected_payload");
  return null;
}

// --- encrypted hold cookie (architect lock spec L7) ---

export type ManifestHoldPayload = {
  id: number;
  name: string;
  login: string;
  pem: string;
  webhook_secret: string;
  /** Expiry, seconds since epoch (server-side double-check beside Max-Age). */
  exp: number;
};

/** HKDF-SHA256(DASHBOARD_SESSION_SECRET, info "mstar-manifest-hold") → AES-256-GCM key. */
async function holdKey(secret: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      // RFC 5869: no salt provisioned → zeros of HashLen.
      salt: new Uint8Array(32),
      info: enc.encode("mstar-manifest-hold"),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * `base64url(12B IV ‖ AES-256-GCM ciphertext‖16B tag)`. RSA-2048 PEM ≈ 1.7KB
 * → serialized value ≈ 2.4KB, under the 4096B single-cookie budget.
 */
export async function createHoldValue(
  conversion: ManifestConversion,
  login: string,
  secret: string,
  nowMs = Date.now(),
): Promise<string> {
  const payload: ManifestHoldPayload = {
    id: conversion.id,
    name: conversion.name,
    login,
    pem: conversion.pem,
    webhook_secret: conversion.webhook_secret,
    exp: Math.floor(nowMs / 1000) + MANIFEST_HOLD_MAX_AGE_SEC,
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await holdKey(secret);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(payload))),
  );
  const value = new Uint8Array(iv.length + ciphertext.length);
  value.set(iv, 0);
  value.set(ciphertext, iv.length);
  return base64urlEncode(value);
}

/** Decrypts + shape/expiry check; anything off → null (treat as flow expired). */
export async function readHoldValue(
  value: string | undefined,
  secret: string,
  nowMs = Date.now(),
): Promise<ManifestHoldPayload | null> {
  if (!value) return null;
  const bytes = base64urlDecode(value);
  // 12B IV + 16B tag + at least 1B ciphertext.
  if (!bytes || bytes.length <= 12 + 16) return null;
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const key = await holdKey(secret);
  let plaintext: Uint8Array;
  try {
    // GCM tag verification failure throws — fail closed.
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext));
  } catch {
    return null;
  }
  let payload: ManifestHoldPayload;
  try {
    payload = JSON.parse(dec.decode(plaintext)) as ManifestHoldPayload;
  } catch {
    return null;
  }
  if (typeof payload.id !== "number") return null;
  if (typeof payload.name !== "string" || payload.name.length === 0) return null;
  if (typeof payload.login !== "string" || payload.login.length === 0) return null;
  if (typeof payload.pem !== "string" || payload.pem.length === 0) return null;
  if (typeof payload.webhook_secret !== "string" || payload.webhook_secret.length === 0) return null;
  if (typeof payload.exp !== "number") return null;
  if (payload.exp <= Math.floor(nowMs / 1000)) return null;
  return payload;
}

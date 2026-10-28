/**
 * GitHub App Manifest flow (start → GitHub form POST →
 * callback → code conversion → encrypted hold cookie; the commit writes
 * the encrypted `github_apps` D1 row — the dashboard's
 * Cloudflare API dependency is retired, spec § Multi-App 契约).
 *
 * Architect locks (spec dashboard-b1-manifest.md § L6/L7/L8/L9 + L1):
 * - CSRF state cookie `__Host-mstar-manifest-state`: reuses the B0 HMAC
 *   signValue/verifyValue discipline (createStateValue), single-use,
 *   Max-Age 600; DISTINCT from B0's `__Host-mstar-oauth-state`. `state`
 *   rides the GitHub form-action query (GitHub echoes it into the
 *   redirect_url next to `code`). B5: the value CARRIES the webhook path
 *   minted at start — the path survives start → callback only through
 *   this signed carrier (the manifest form is client-editable, so it is
 *   not a trusted carrier).
 * - Conversion: POST https://api.github.com/app-manifests/{code}/conversions
 *   with Accept: application/vnd.github+json + X-GitHub-Api-Version
 *   2022-11-28 and NO Authorization header (the code is the credential; a
 *   bearer returns 406).
 * - PEM/webhook_secret hold: AES-256-GCM encrypted cookie
 *   `__Host-mstar-manifest-hold`, key = HKDF-SHA256(DASHBOARD_SESSION_SECRET,
 *   info "mstar-manifest-hold"), Max-Age 600; bound to the callback session
 *   login, kept across retryable commit outcomes (500/502), burned on
 *   success, login mismatch, bad hold, or logout.
 *   Payload NEVER enters HTML, logs, or D1. B5: the payload also carries
 *   the webhook path (so the commit can write the D1 row after the state
 *   cookie is burned) and GitHub's own App slug (the bot mention target).
 * - Storage口径 (lock L1): the conversion PEM is stored VERBATIM
 *   (encrypted) — normalization to PKCS#8 stays at createReviewCommenter
 *   construction on the consumer side.
 */
import { base64urlDecode, base64urlEncode, signValue, timingSafeEqual, verifyValue } from "./session";
import { GITHUB_CODE_SHAPE } from "./github-code-shape";

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
  stage: "state_verify" | "callback" | "conversion" | "confirm" | "commit",
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
    contents: "write";
    metadata: "read";
    pull_requests: "write";
    issues: "write";
    checks: "write";
  };
};
/** Manifest App name prefix; GitHub rejects App names over 34 characters. */
export const APP_NAME_PREFIX = "mstar-inspector-";
export const GITHUB_APP_NAME_MAX_LENGTH = 34;

/**
 * Manifest App name: prefix + login, truncated to GitHub's 34-char cap.
 * Without the cap a long login makes GitHub reject the manifest POST and no
 * callback ever fires (the App is never created).
 */
export function buildAppName(login: string): string {
  return `${APP_NAME_PREFIX}${login}`.slice(0, GITHUB_APP_NAME_MAX_LENGTH);
}

// --- webhook path (per-App webhook URL, spec § Multi-App 契约) ---

/**
 * The row's only locally minted identifier — and therefore its primary key:
 * it must exist BEFORE GitHub creates the App (the manifest form needs the
 * hook URL), so it can derive from nothing GitHub owns. A UUID is opaque,
 * URL-safe, and collision-free without a pre-resolve read. The manifest
 * commit reuses it as `github_apps.id`, so one App keeps ONE identity.
 */
export function randomWebhookPath(): string {
  return crypto.randomUUID();
}

/**
 * Manifest JSON for the locked review permission set (spec §7.6:
 * `contents: "write"` is authorized for Worker-side thread resolution —
 * Worker-only; the `checks: "write"` grant covers the advisory Check run;
 * mirrors the `.env.example` permission comment; no extra permissions, no
 * OAuth App fields, no old-App migration branch).
 * `redirect_url` stays the bare callback — CSRF `state` rides the
 * form-action query instead (GitHub echoes it back next to `code`). B5: the
 * webhook is the App's OWN route `{origin}/webhook/{webhookPath}` — the path
 * is minted at start and carried to the commit through the signed state.
 */
export function buildManifest(origin: string, login: string, webhookPath: string): ManifestPayload {
  return {
    name: buildAppName(login),
    url: origin,
    hook_attributes: { url: `${origin}/webhook/${webhookPath}` },
    redirect_url: `${origin}/dashboard/manifest/callback`,
    public: false,
    default_events: ["pull_request", "issue_comment"],
    default_permissions: {
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      issues: "write",
      checks: "write",
    },
  };
}

/** GitHub form-action URL carrying the CSRF state (official manifest flow). */
export function buildManifestCreateUrl(state: string): string {
  const url = new URL(GITHUB_MANIFEST_CREATE_URL);
  url.searchParams.set("state", state);
  return url.toString();
}

// --- webhook-path-carrying CSRF state (B5: same createStateValue HMAC discipline) ---

export type ManifestStatePayload = {
  webhookPath: string;
  /**
   * The STABLE `workspaces.id` the flow creates the App in, decided at start
   * from the request context and carried through the signed state so the
   * callback commits into the SAME workspace the operator started in. The id,
   * never the slug: a slug can be renamed mid-flow, or reused by a workspace
   * created later, and either would move the App to the wrong tenant.
   */
  workspaceId: string;
};

/**
 * Signed manifest state carrying the webhook path minted at start plus the
 * target workspace. Same discipline as B0's createStateValue: HMAC-signed with
 * DASHBOARD_SESSION_SECRET, used as BOTH the state cookie value and the
 * form-action query param, single-use (expired at the callback).
 */
export async function createManifestStateValue(
  secret: string,
  webhookPath: string,
  workspaceId: string,
): Promise<string> {
  return signValue(JSON.stringify({ webhookPath, workspaceId }), secret);
}

/**
 * Callback check (verifyStateValue discipline): cookie === param byte-compare
 * (timing-safe), HMAC verify, then payload shape. Anything off → null.
 */
export async function readManifestStateValue(
  cookieValue: string | undefined,
  stateParam: string | null | undefined,
  secret: string,
): Promise<ManifestStatePayload | null> {
  if (!cookieValue || !stateParam) return null;
  if (!timingSafeEqual(enc.encode(cookieValue), enc.encode(stateParam))) return null;
  const raw = await verifyValue(cookieValue, secret);
  if (raw === null) return null;
  let payload: ManifestStatePayload;
  try {
    payload = JSON.parse(raw) as ManifestStatePayload;
  } catch {
    return null;
  }
  if (typeof payload.webhookPath !== "string" || !/^[a-zA-Z0-9-]+$/.test(payload.webhookPath)) {
    return null;
  }
  if (typeof payload.workspaceId !== "string" || payload.workspaceId.length === 0) return null;
  return payload;
}

// --- code → conversion ---

export type ManifestConversion = {
  id: number;
  name: string;
  /**
   * GitHub's own App slug — the bot mention target; never derived from the
   * name. Nullable because GitHub has ALREADY created the App by conversion
   * time: an absent slug must not fail the exchange and orphan it. The first
   * metadata refresh fills it from `GET /app`.
   */
  slug: string | null;
  pem: string;
  webhook_secret: string;
};

/** null on any upstream failure or unexpected payload (fail-closed). */
export async function exchangeManifestCode(code: string): Promise<ManifestConversion | null> {
  // GitHub manifest conversion codes are opaque URL-safe tokens; reject any
  // other shape BEFORE the upstream call — bounded upstream calls,
  // defense-in-depth beside the fixed api.github.com endpoint.
  if (!GITHUB_CODE_SHAPE.test(code)) {
    logManifestFailure("conversion", "unsafe_code_shape");
    return null;
  }
  // The code rides as ONE encodeURIComponent-encoded path segment on the
  // fixed api.github.com host (segment-assembled, never template-interpolated).
  const conversionUrl = [
    "https://api.github.com/app-manifests/",
    encodeURIComponent(code),
    "/conversions",
  ].join("");
  let res: Response;
  try {
    res = await fetch(conversionUrl, {
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
    slug?: unknown;
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
    return {
      id: data.id,
      name: data.name,
      // Absent/blank slug is not a failure: the App already exists upstream,
      // so the row must land and the next metadata refresh fills github_slug.
      slug: typeof data.slug === "string" && data.slug.length > 0 ? data.slug : null,
      pem: data.pem,
      webhook_secret: data.webhook_secret,
    };
  }
  logManifestFailure("conversion", "unexpected_payload");
  return null;
}

// --- encrypted hold cookie (architect lock spec L7) ---

export type ManifestHoldPayload = {
  id: number;
  name: string;
  login: string;
  /** GitHub's App slug from the conversion — the bot mention target; null until the first metadata sync. */
  slug: string | null;
  /** Webhook path minted at start (carried from the signed state). */
  webhookPath: string;
  /** Target workspace id (carried from the signed state); the commit maps the App here. */
  workspaceId: string;
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
 * Build the plaintext hold payload (the callback auto-commit
 * consumes the payload directly while ALSO minting the cookie string, so
 * the payload construction is shared instead of built twice).
 */
export function buildHoldPayload(
  conversion: ManifestConversion,
  login: string,
  webhookPath: string,
  workspaceId: string,
  nowMs = Date.now(),
): ManifestHoldPayload {
  return {
    id: conversion.id,
    name: conversion.name,
    login,
    slug: conversion.slug,
    webhookPath,
    workspaceId,
    pem: conversion.pem,
    webhook_secret: conversion.webhook_secret,
    exp: Math.floor(nowMs / 1000) + MANIFEST_HOLD_MAX_AGE_SEC,
  };
}

/**
 * `base64url(12B IV ‖ AES-256-GCM ciphertext‖16B tag)`. RSA-2048 PEM ≈ 1.7KB
 * → serialized value ≈ 2.4KB, under the 4096B single-cookie budget.
 */
export async function encryptHoldValue(payload: ManifestHoldPayload, secret: string): Promise<string> {
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

/** Cookie string for a fresh conversion (signature kept for tests/callers). */
export async function createHoldValue(
  conversion: ManifestConversion,
  login: string,
  secret: string,
  webhookPath: string,
  workspaceId: string,
  nowMs = Date.now(),
): Promise<string> {
  return encryptHoldValue(buildHoldPayload(conversion, login, webhookPath, workspaceId, nowMs), secret);
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
  if (payload.slug !== null && (typeof payload.slug !== "string" || payload.slug.length === 0)) {
    return null;
  }
  if (typeof payload.webhookPath !== "string" || payload.webhookPath.length === 0) return null;
  if (typeof payload.workspaceId !== "string" || payload.workspaceId.length === 0) return null;
  if (typeof payload.pem !== "string" || payload.pem.length === 0) return null;
  if (typeof payload.webhook_secret !== "string" || payload.webhook_secret.length === 0) return null;
  if (typeof payload.exp !== "number") return null;
  if (payload.exp <= Math.floor(nowMs / 1000)) return null;
  return payload;
}

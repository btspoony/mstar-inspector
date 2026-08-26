/**
 * Worker fetchPrDiff — GitHub App installation-token authenticated PR diff
 * pull (plan 04 Task 3; contract along M0 `src/gateway/diff.ts`).
 *
 * Contract (plan Module contracts / compass contracts B):
 *   createDiffFetcher(auth) → { fetchPrDiff(installationId, owner, repo, prNumber): Promise<string> }
 *
 * `fetchPrDiff` keeps the 4-parameter contract; the octokit is obtained via
 * the injected `auth` (tests mock it; production binds `createAppAuthFromEnv`).
 * Success value is a non-empty string starting with "diff --git". Errors from
 * the octokit layer reject — never swallowed.
 *
 * Auth: `@octokit/auth-app` `createAppAuth` (JWT → installation access token,
 * cached per installation until expiry — auth-app default). The production
 * binding resolves `PRIVATE_KEY` in two forms (plan Clarify #6 / runbook):
 * inline PEM, or a `~`-expanded file path (read lazily via a dynamic
 * `node:fs` import — workerd local supports it; the key never enters logs or
 * the queue payload).
 *
 * Key format: GitHub's App settings download is a PKCS#1 PEM
 * (`-----BEGIN RSA PRIVATE KEY-----`). workerd's WebCrypto `importKey("pkcs8")`
 * (used by `universal-github-app-jwt`'s `#crypto` default condition) only
 * accepts PKCS#8, so PKCS#1 keys are converted here with a pure-JS DER wrap
 * (no `node:crypto` — identical behavior on Bun and workerd). The wrap is
 * byte-identical to `openssl pkcs8 -topk8 -nocrypt`.
 */
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Env } from "./env";

const DIFF_PREFIX = "diff --git";
/** DER tag for a SEQUENCE (0x30). */
const DER_SEQUENCE = 0x30;
/** DER tag for an OCTET STRING (0x04). */
const DER_OCTET_STRING = 0x04;
/** DER tag for an INTEGER (0x02). */
const DER_INTEGER = 0x02;
/** DER tag for an OBJECT IDENTIFIER (0x06). */
const DER_OID = 0x06;
/** DER tag for NULL (0x05). */
const DER_NULL = 0x05;
/** rsaEncryption OID (1.2.840.113549.1.1.1) — the only algorithm PKCS#1 keys use. */
const RSA_ENCRYPTION_OID = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
/** PKCS#8 version 0 (single-version, no attributes). */
const PKCS8_VERSION_ZERO = new Uint8Array([0x00]);

/** DER length encoding: short form (< 0x80) or long form (0x80 | byte count). */
function derLength(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  const bytes: number[] = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

/** DER TLV element: tag byte + length + body. */
function derElement(tag: number, body: Uint8Array): Uint8Array {
  const len = derLength(body.length);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

/** Concatenate byte arrays (DER building blocks). */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Base64 → bytes (PEM body decoding; `atob` is available in Bun and workerd). */
function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Bytes → base64 (PEM body encoding). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Wrap a PKCS#1 RSA private key DER in a PKCS#8 `PrivateKeyInfo` container
 * (version 0, rsaEncryption algorithm, OCTET STRING payload). Pure JS — no
 * `node:crypto` — so Bun and workerd behave identically. The output is
 * byte-identical to `openssl pkcs8 -topk8 -nocrypt` for RSA keys.
 */
export function pkcs1ToPkcs8(pkcs1Pem: string): string {
  const body = pkcs1Pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const pkcs1Der = base64ToBytes(body);
  const algorithm = derElement(DER_SEQUENCE, concatBytes(derElement(DER_OID, RSA_ENCRYPTION_OID), derElement(DER_NULL, new Uint8Array(0))));
  const wrappedKey = derElement(DER_OCTET_STRING, pkcs1Der);
  const pkcs8Der = derElement(DER_SEQUENCE, concatBytes(derElement(DER_INTEGER, PKCS8_VERSION_ZERO), algorithm, wrappedKey));
  const b64 = bytesToBase64(pkcs8Der);
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Normalize a private key PEM to PKCS#8 (the only format workerd WebCrypto
 * `importKey` accepts):
 * - PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`) → wrapped to PKCS#8;
 * - PKCS#8 (`-----BEGIN PRIVATE KEY-----`) → returned as-is;
 * - OpenSSH (`-----BEGIN OPENSSH PRIVATE KEY-----`) → hard error with the
 *   conversion command (WebCrypto cannot consume it).
 */
export function normalizePrivateKey(pem: string): string {
  if (pem.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    return pkcs1ToPkcs8(pem);
  }
  if (pem.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) {
    throw new Error(
      "PRIVATE_KEY is in OpenSSH format, which WebCrypto cannot sign with. Convert it to PKCS#8: openssl pkcs8 -topk8 -nocrypt -in <key> -out <key>.pkcs8.pem",
    );
  }
  return pem;
}

/** Params accepted by `rest.pulls.get` (octokit REST API). */
export type PullsGetParams = {
  owner: string;
  repo: string;
  pull_number: number;
  mediaType?: { format?: string; previews?: string[] };
};

/**
 * Structural octokit surface sufficient for pulls.get (plan ASSUMPTION,
 * verified at T3). Keeps the fetcher mockable AND compatible with the real
 * octokit (the real `rest.pulls.get` is assignable to this shape).
 */
export type OctokitLike = {
  rest?: { pulls?: { get?: (params: PullsGetParams) => Promise<{ data: unknown }> } };
};

/**
 * Structural auth surface sufficient for installation-scoped octokit
 * creation. The real `createAppAuth` result is assignable: `auth({ type:
 * "installation", installationId, factory })` resolves with whatever the
 * factory returns — here an `Octokit` whose requests carry the installation
 * access token.
 */
export type AppAuth = (options: {
  type: "installation";
  installationId: number;
  factory: (options: unknown) => OctokitLike;
}) => Promise<OctokitLike>;

/** Extracts the unified-diff string from an octokit pulls.get response. */
function extractDiff(data: unknown): string {
  // octokit with mediaType.format "diff" returns the diff directly as `data`
  // (string) or nested under `data.data` (string) — handle both.
  const candidate = typeof data === "string" ? data : (data as { data?: unknown } | null)?.data;
  if (typeof candidate !== "string" || candidate.length === 0 || !candidate.startsWith(DIFF_PREFIX)) {
    throw new Error(
      "pulls.get did not return a unified diff (expected non-empty string starting with 'diff --git'); check the Accept/mediaType header",
    );
  }
  return candidate;
}

/** Expand a leading `~/` to the given home directory (pure, testable). */
export function expandHomePath(value: string, home: string): string {
  return value.startsWith("~/") ? `${home}/${value.slice(2)}` : value;
}

/**
 * Resolve the PRIVATE_KEY secret to PEM text. Two forms are accepted
 * (plan Clarify #6 / runbook direction):
 * - inline PEM (contains a BEGIN marker) → returned as-is;
 * - a file path (optionally `~`-prefixed) → expanded and read from disk.
 * The read is lazy (per call) so a rotated key file is picked up without a
 * redeploy; the resolved PEM is never logged or stored.
 */
export async function resolvePrivateKey(value: string): Promise<string> {
  if (value.includes("-----BEGIN")) {
    return normalizePrivateKey(value);
  }
  // Platform-specific: node:fs/node:os exist in workerd local dev and Bun,
  // but not in every Workers runtime — dynamic import keeps the module
  // boundary honest (no static Node-only imports in src/worker).
  const { readFileSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  return normalizePrivateKey(readFileSync(expandHomePath(value, homedir()), "utf8"));
}

/** The `createAppAuth` strategy instance (owns the installation-token cache). */
type AppAuthStrategy = AppAuth;

/**
 * Production auth binding: `createAppAuth` (APP_ID + resolved PRIVATE_KEY)
 * → per-installation octokit via the documented factory pattern. The
 * `createAppAuth` instance is memoized so its installation-token cache is
 * shared across calls (auth-app default: tokens cached until expiry). The
 * key is resolved once, on first use; rotation requires a new binding
 * (redeploy).
 */
export function createAppAuthFromEnv(env: Pick<Env, "APP_ID" | "PRIVATE_KEY">): AppAuth {
  let appAuth: AppAuthStrategy | null = null;
  return async ({ type, installationId, factory }) => {
    if (appAuth === null) {
      const privateKey = await resolvePrivateKey(env.PRIVATE_KEY);
      appAuth = createAppAuth({ appId: env.APP_ID, privateKey });
    }
    return appAuth({ type, installationId, factory });
  };
}

export function createDiffFetcher(auth: AppAuth): {
  fetchPrDiff: (
    installationId: number,
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<string>;
} {
  return {
    async fetchPrDiff(installationId, owner, repo, prNumber) {
      const octokit = await auth({
        type: "installation",
        installationId,
        factory: (options) => new Octokit({ authStrategy: createAppAuth, auth: options }),
      });
      const pullsGet = octokit.rest?.pulls?.get;
      if (!pullsGet) {
        throw new Error(
          "octokit is missing rest.pulls.get — cannot fetch the PR diff; check the injected auth surface",
        );
      }
      const response = await pullsGet({
        owner,
        repo,
        pull_number: prNumber,
        mediaType: { format: "diff" },
      });
      return extractDiff(response.data);
    },
  };
}

/**
 * Plan 53 Task 1 (T1.2) unit tests for src/dashboard/github-app-metadata.ts
 * — the per-App JWT mint + `GET /app` metadata fetch (architect decision
 * AD-531). Pinned here:
 *   - the JWT face: header `{alg:RS256,typ:JWT}`, claims
 *     `{iat,exp,iss:<githubAppId>}`, TTL within GitHub's 10-minute cap,
 *     iat backdated for clock drift, and the signature VERIFIABLE with the
 *     public key of the key whose PEM was handed in;
 *   - key formats: PKCS#8 and PKCS#1 PEMs both accepted (the
 *     normalizePrivateKey reuse — the lock-L1 copy's first src consumer);
 *   - failure injection → structured `{ok:false}`, NEVER a throw: OpenSSH
 *     PEM, garbage/empty PEM, fetch rejection (network/abort), HTTP
 *     non-200, and an unexpected payload (missing name);
 *   - extraction: ONLY the four migration-0019 profile fields survive
 *     (slug/permissions/events/owner.login never leave the module);
 *     per-item degradation to null for absent optional fields, with the
 *     URL fields additionally scheme-gated to https: (non-conforming
 *     values drop to null);
 *   - upstream face: GET https://api.github.com/app, Accept
 *     application/vnd.github+json, pinned API version, User-Agent, Bearer
 *     JWT, and an AbortSignal (the 5s AD-531 budget).
 *
 * Network is fully stubbed via globalThis.fetch (the
 * tests/worker/entry.test.ts precedent) — no test touches the real API.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { fetchAppMetadata, GITHUB_METADATA_TTL_MS, isGithubMetadataStale } from "../../src/dashboard/github-app-metadata";

// --- test RSA key material (generated per test; no fixtures) ---

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

/** DER bytes → armored PEM (64-col base64, the standard wrap). */
function toPem(der: Uint8Array, label: string): string {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const b64 = btoa(binary);
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

/** base64url → bytes (JWT segment decoding). */
function base64UrlToBytes(segment: string): Uint8Array<ArrayBuffer> {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (segment.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Unwrap the PKCS#8 PrivateKeyInfo container to its PKCS#1 RSAPrivateKey
 * payload (minimal sequential DER walk — the structure WebCrypto produces
 * is deterministic: SEQUENCE { INTEGER 0, SEQUENCE {rsaEncryption}, OCTET
 * STRING {pkcs1} }). Only used to BUILD a PKCS#1 test PEM; the module
 * under test does the inverse wrap via normalizePrivateKey.
 */
function pkcs8DerToPkcs1Der(pkcs8: Uint8Array): Uint8Array {
  let i = 0;
  const readLen = (): number => {
    const first = pkcs8[i++]!;
    if (first < 0x80) return first;
    const n = first & 0x7f;
    let len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + pkcs8[i++]!;
    return len;
  };
  if (pkcs8[i++] !== 0x30) throw new Error("test key: not a PKCS#8 SEQUENCE");
  readLen(); // outer SEQUENCE length
  if (pkcs8[i++] !== 0x02) throw new Error("test key: version INTEGER missing");
  const versionLen = readLen();
  i += versionLen; // version 0 — NOT `i += readLen()`: readLen mutates i itself
  if (pkcs8[i++] !== 0x30) throw new Error("test key: algorithm SEQUENCE missing");
  const algLen = readLen();
  i += algLen; // rsaEncryption AlgorithmIdentifier
  if (pkcs8[i++] !== 0x04) throw new Error("test key: OCTET STRING missing");
  const keyLen = readLen();
  return pkcs8.slice(i, i + keyLen);
}

/** A fresh PKCS#8 PEM (the modern export format) + its public key. */
async function pkcs8Fixture(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const { privateKey, publicKey } = await generateKeyPair();
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer);
  return { pem: toPem(der, "PRIVATE KEY"), publicKey };
}

/** A fresh PKCS#1 PEM (the manifest-conversion PEM format) + its public key. */
async function pkcs1Fixture(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const { privateKey, publicKey } = await generateKeyPair();
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer);
  return { pem: toPem(pkcs8DerToPkcs1Der(der), "RSA PRIVATE KEY"), publicKey };
}

// --- fetch stubbing (tests/worker/entry.test.ts precedent) ---

type FetchCall = { url: string; init: RequestInit | undefined };

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { calls };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** A realistic GET /app body — public profile + fields that must NOT leak. */
const GITHUB_PROFILE = {
  id: 1001,
  slug: "acme-inspector",
  name: "Acme Inspector",
  description: "PR review bot for Acme",
  external_url: "https://acme.example",
  html_url: "https://github.com/apps/acme-inspector",
  created_at: "2026-01-01T00:00:00Z",
  permissions: { contents: "read", metadata: "read", pull_requests: "write", issues: "write" },
  events: ["pull_request", "issue_comment"],
  owner: { login: "acme", id: 1, avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" },
};

/** Decode a JWT and verify its signature against the fixture's public key. */
async function decodeAndVerifyJwt(
  jwt: string,
  publicKey: CryptoKey,
): Promise<{ header: Record<string, unknown>; claims: Record<string, unknown>; valid: boolean }> {
  const parts = jwt.split(".");
  expect(parts).toHaveLength(3);
  const dec = new TextDecoder();
  const header = JSON.parse(dec.decode(base64UrlToBytes(parts[0]!))) as Record<string, unknown>;
  const claims = JSON.parse(dec.decode(base64UrlToBytes(parts[1]!))) as Record<string, unknown>;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    base64UrlToBytes(parts[2]!),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  return { header, claims, valid };
}

const origFetch = globalThis.fetch;
const origAbortTimeout = AbortSignal.timeout;
afterEach(() => {
  globalThis.fetch = origFetch;
  AbortSignal.timeout = origAbortTimeout;
});

describe("fetchAppMetadata (plan 53 T1.2, AD-531)", () => {
  test("mints a verifiable RS256 App JWT and extracts ONLY the public profile fields (PKCS#8 PEM)", async () => {
    const { pem, publicKey } = await pkcs8Fixture();
    const { calls } = stubFetch(() => jsonResponse(GITHUB_PROFILE));
    // Capture the AbortSignal.timeout argument while delegating to the real
    // implementation (the signal stays genuine) — pins the locked AD-531
    // 5s budget by value, not just by signal type.
    let timeoutMs: number | undefined;
    AbortSignal.timeout = ((ms: number) => {
      timeoutMs = ms;
      return origAbortTimeout.call(AbortSignal, ms);
    }) as typeof AbortSignal.timeout;

    const result = await fetchAppMetadata(1001, pem);

    // Exactly the four migration-0019 fields — slug/permissions/events and
    // the rest of the response body never leave the module.
    expect(result).toEqual({
      ok: true,
      metadata: {
        githubName: "Acme Inspector",
        githubDescription: "PR review bot for Acme",
        githubHtmlUrl: "https://github.com/apps/acme-inspector",
        githubAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      },
    });

    // Upstream face: one GET to the /app endpoint, documented headers, and
    // the AD-531 abort budget attached.
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.github.com/app");
    expect(call.init!.method).toBe("GET");
    const headers = new Headers(call.init!.headers);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("user-agent")).toBe("mstar-inspector");
    expect(call.init!.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutMs).toBe(5000); // the 5s AD-531 budget, exactly

    // JWT: pinned header/claims + signature verifiable with the fixture's
    // own public key.
    const auth = headers.get("authorization")!;
    expect(auth.startsWith("Bearer ")).toBe(true);
    const { header, claims, valid } = await decodeAndVerifyJwt(auth.slice("Bearer ".length), publicKey);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims.iss).toBe(1001);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(claims.iat).toBeLessThanOrEqual(nowSec); // backdated, never in the future
    expect(nowSec - (claims.iat as number)).toBeGreaterThanOrEqual(59);
    expect(nowSec - (claims.iat as number)).toBeLessThan(120);
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(600); // GitHub's 10-min cap
    expect(claims.exp).toBeGreaterThan(nowSec);
    expect(valid).toBe(true);
  });

  test("accepts a PKCS#1 PEM (the manifest-conversion format) and signs with the same key", async () => {
    const { pem, publicKey } = await pkcs1Fixture();
    stubFetch(() => jsonResponse(GITHUB_PROFILE));

    const result = await fetchAppMetadata(1001, pem);

    expect(result).toEqual({
      ok: true,
      metadata: {
        githubName: "Acme Inspector",
        githubDescription: "PR review bot for Acme",
        githubHtmlUrl: "https://github.com/apps/acme-inspector",
        githubAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      },
    });
  });

  test("the PKCS#1 JWT signature also verifies with the matching public key", async () => {
    const { pem, publicKey } = await pkcs1Fixture();
    let bearer = "";
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bearer = new Headers(init!.headers).get("authorization")!;
      return jsonResponse(GITHUB_PROFILE);
    }) as typeof fetch;

    const result = await fetchAppMetadata(1001, pem);

    expect(result.ok).toBe(true);
    const { valid } = await decodeAndVerifyJwt(bearer.slice("Bearer ".length), publicKey);
    expect(valid).toBe(true);
  });

  test("an OpenSSH-format PEM → {ok:false} with the mint error swallowed BEFORE any network call", async () => {
    const { calls } = stubFetch(() => jsonResponse(GITHUB_PROFILE));
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n";

    const result = await fetchAppMetadata(1001, pem);

    expect(result).toEqual({ ok: false });
    expect(calls).toHaveLength(0); // normalizePrivateKey's hard error fires pre-fetch
  });

  test("garbage / empty PEM (what a corrupt envelope yields) → {ok:false}, never throws", async () => {
    stubFetch(() => jsonResponse(GITHUB_PROFILE));
    expect(await fetchAppMetadata(1001, "not a pem at all")).toEqual({ ok: false });
    expect(await fetchAppMetadata(1001, "")).toEqual({ ok: false });
    expect(await fetchAppMetadata(1001, "-----BEGIN PRIVATE KEY-----\n@@@\n-----END PRIVATE KEY-----\n")).toEqual({
      ok: false,
    });
  });

  test("HTTP non-200 → {ok:false}, zero retries", async () => {
    const { calls } = stubFetch(() => jsonResponse({ message: "Not Found" }, 404));
    const { pem } = await pkcs8Fixture();
    expect(await fetchAppMetadata(1001, pem)).toEqual({ ok: false });
    expect(calls).toHaveLength(1); // the zero-retry lock (AD-531)
  });

  test("fetch rejection (network failure / abort) → {ok:false}, zero retries", async () => {
    const abort = stubFetch(() => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const { pem } = await pkcs8Fixture();
    expect(await fetchAppMetadata(1001, pem)).toEqual({ ok: false });
    expect(abort.calls).toHaveLength(1);

    const reject = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchAppMetadata(1001, pem)).toEqual({ ok: false });
    expect(reject.calls).toHaveLength(1);
  });

  test("unexpected payload (missing / empty name, non-JSON body) → {ok:false}, zero retries", async () => {
    const { pem } = await pkcs8Fixture();
    const missingName = stubFetch(() => jsonResponse({ slug: "acme-inspector" }));
    expect(await fetchAppMetadata(1001, pem)).toEqual({ ok: false });
    expect(missingName.calls).toHaveLength(1);
    const emptyName = stubFetch(() => jsonResponse({ name: "" }));
    expect(await fetchAppMetadata(1001, pem)).toEqual({ ok: false });
    expect(emptyName.calls).toHaveLength(1);
    const nonJson = stubFetch(() => new Response("<html>gateway error</html>", { status: 200 }));
    expect(await fetchAppMetadata(1001, pem)).toEqual({ ok: false });
    expect(nonJson.calls).toHaveLength(1);
  });

  test("nullable upstream fields degrade per-item to null metadata", async () => {
    const { pem } = await pkcs8Fixture();
    stubFetch(() => jsonResponse({ name: "Bare App", description: null }));

    expect(await fetchAppMetadata(1001, pem)).toEqual({
      ok: true,
      metadata: {
        githubName: "Bare App",
        githubDescription: null,
        githubHtmlUrl: null,
        githubAvatarUrl: null,
      },
    });
  });

  test("non-https html_url / avatar_url are dropped to null (the extraction scheme gate)", async () => {
    const { pem } = await pkcs8Fixture();
    stubFetch(() =>
      jsonResponse({
        name: "Odd App",
        html_url: "http://github.com/apps/odd",
        owner: { login: "odd", avatar_url: "javascript:alert(1)" },
      }),
    );

    // The name still passes the shape gate; the non-https URLs degrade to
    // null exactly like absent fields (the SPA renders them as href/img).
    expect(await fetchAppMetadata(1001, pem)).toEqual({
      ok: true,
      metadata: {
        githubName: "Odd App",
        githubDescription: null,
        githubHtmlUrl: null,
        githubAvatarUrl: null,
      },
    });
  });
});

describe("isGithubMetadataStale (plan 53 A4 TTL — the settings read path's refresh gate)", () => {
  // Fixed clock; `utcText` formats a UTC instant as the SQLite
  // `datetime('now')` TEXT convention (`YYYY-MM-DD HH:MM:SS`, UTC).
  const NOW_MS = Date.UTC(2026, 8, 8, 12, 0, 0);
  const utcText = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

  test("NULL / empty / garbage / wrong-type synced_at is stale (refresh attempted, never a wrong 'fresh')", () => {
    expect(isGithubMetadataStale(null, NOW_MS)).toBe(true);
    expect(isGithubMetadataStale(undefined, NOW_MS)).toBe(true);
    expect(isGithubMetadataStale("", NOW_MS)).toBe(true);
    expect(isGithubMetadataStale("not a timestamp", NOW_MS)).toBe(true);
    expect(isGithubMetadataStale(12 as unknown as string, NOW_MS)).toBe(true);
  });

  test("the 24h boundary: inside TTL is fresh, past it is stale", () => {
    expect(GITHUB_METADATA_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(isGithubMetadataStale(utcText(NOW_MS - GITHUB_METADATA_TTL_MS + 60_000), NOW_MS)).toBe(false);
    expect(isGithubMetadataStale(utcText(NOW_MS - GITHUB_METADATA_TTL_MS - 60_000), NOW_MS)).toBe(true);
    // At exactly the TTL the cache is expired (the window is [0, 24h)).
    expect(isGithubMetadataStale(utcText(NOW_MS - GITHUB_METADATA_TTL_MS), NOW_MS)).toBe(true);
  });

  test("the space-form TEXT is parsed as UTC (the datetime('now') convention)", () => {
    // 23h old in UTC → fresh; if the space form were read as local time the
    // wall-clock shift would flip the verdict on any non-UTC machine.
    const twentyThreeHoursOld = utcText(NOW_MS - 23 * 60 * 60 * 1000);
    expect(isGithubMetadataStale(twentyThreeHoursOld, NOW_MS)).toBe(false);
    expect(twentyThreeHoursOld).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // A future timestamp is stale (doomed refresh attempt, never trusted).
    expect(isGithubMetadataStale(utcText(NOW_MS + 60_000), NOW_MS)).toBe(true);
  });
});

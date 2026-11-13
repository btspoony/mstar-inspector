/**
 * Unit tests for src/dashboard/github-app-metadata.ts
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
 *   - extraction: ONLY the cached profile fields survive
 *     (permissions/events/owner.login never leave the module); per-item
 *     degradation to null for absent optional fields, with every URL
 *     scheme-gated to https: (non-conforming values drop to null);
 *   - the App slug: `slug` from GET /app, else derived from html_url (the
 *     single `/apps/<slug>` segment, https: only);
 *   - the App icon: derived from the numeric App id
 *     (`avatars.githubusercontent.com/in/<id>`), so the sync issues exactly
 *     ONE upstream request — an App JWT is rejected everywhere but `/app*`
 *     and the `/…/installation` routes;
 *   - upstream face: GET https://api.github.com/app, Accept
 *     application/vnd.github+json, pinned API version, User-Agent, Bearer
 *     JWT, and an AbortSignal (the 5s AD-531 budget).
 *
 * Network is fully stubbed via globalThis.fetch (the
 * tests/worker/entry.test.ts precedent) — no test touches the real API.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchAppInstallations,
  fetchAppMetadata,
  fetchAppVisibility,
  githubAppSlugFromHtmlUrl,
  GITHUB_METADATA_TTL_MS,
  isGithubMetadataStale,
} from "../../src/dashboard/github-app-metadata";
import { appAvatarUrl } from "../../src/contracts/app-avatar";
import { fakePem } from "../helpers/fake-secrets";

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

/**
 * The icon URL: asserted through the SHARED contract the SPA also consumes, so
 * a drift in that one derivation cannot pass both sides green.
 */
const AVATAR_URL = (appId: number): string => appAvatarUrl(appId);

/**
 * The ONE upstream face a metadata sync may touch. Any other URL throws, so a
 * second request (the retired bot-account lookup) fails the test loudly
 * instead of passing silently.
 */
function stubApp(profile: () => Response): { calls: FetchCall[] } {
  return stubFetch((url) => {
    if (url === "https://api.github.com/app") return profile();
    throw new Error(`unexpected fetch: ${url}`);
  });
}

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

describe("fetchAppMetadata (AD-531)", () => {
  test("mints a verifiable RS256 App JWT and extracts ONLY the public profile fields (PKCS#8 PEM)", async () => {
    const { pem, publicKey } = await pkcs8Fixture();
    const { calls } = stubApp(() => jsonResponse(GITHUB_PROFILE));
    // Capture the AbortSignal.timeout argument while delegating to the real
    // implementation (the signal stays genuine) — pins the locked AD-531
    // 5s budget by value, not just by signal type.
    let timeoutMs: number | undefined;
    AbortSignal.timeout = ((ms: number) => {
      timeoutMs = ms;
      return origAbortTimeout.call(AbortSignal, ms);
    }) as typeof AbortSignal.timeout;

    const result = await fetchAppMetadata(1001, pem);

    // Exactly the cached profile fields — permissions/events and the rest of
    // the response body never leave the module. The icon is derived from the
    // numeric App id (no CDN request).
    expect(result).toEqual({
      ok: true,
      metadata: {
        githubName: "Acme Inspector",
        githubDescription: "PR review bot for Acme",
        githubHtmlUrl: "https://github.com/apps/acme-inspector",
        githubAvatarUrl: AVATAR_URL(1001),
        githubSlug: "acme-inspector",
      },
    });

    // Upstream face: exactly ONE request (GET /app), documented headers, and
    // the AD-531 abort budget attached to it.
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
    stubApp(() => jsonResponse(GITHUB_PROFILE));

    const result = await fetchAppMetadata(1001, pem);

    expect(result).toEqual({
      ok: true,
      metadata: {
        githubName: "Acme Inspector",
        githubDescription: "PR review bot for Acme",
        githubHtmlUrl: "https://github.com/apps/acme-inspector",
        githubAvatarUrl: AVATAR_URL(1001),
        githubSlug: "acme-inspector",
      },
    });
  });

  test("the PKCS#1 JWT signature also verifies with the matching public key", async () => {
    const { pem, publicKey } = await pkcs1Fixture();
    const { calls } = stubApp(() => jsonResponse(GITHUB_PROFILE));

    const result = await fetchAppMetadata(1001, pem);

    expect(result.ok).toBe(true);
    const bearer = new Headers(calls[0]!.init!.headers).get("authorization")!;
    const { valid } = await decodeAndVerifyJwt(bearer.slice("Bearer ".length), publicKey);
    expect(valid).toBe(true);
  });

  test("an OpenSSH-format PEM → {ok:false} with the mint error swallowed BEFORE any network call", async () => {
    const { calls } = stubFetch((url) => {
      throw new Error(`unexpected fetch: ${url}`);
    });
    const pem = fakePem("b3BlbnNzaC1rZXktdjEAAAAA", "OPENSSH PRIVATE KEY");

    const result = await fetchAppMetadata(1001, pem);

    expect(result).toEqual({ ok: false });
    expect(calls).toHaveLength(0); // normalizePrivateKey's hard error fires pre-fetch
  });

  test("garbage / empty PEM (what a corrupt envelope yields) → {ok:false}, never throws", async () => {
    stubFetch(() => jsonResponse(GITHUB_PROFILE));
    expect(await fetchAppMetadata(1001, "not a pem at all")).toEqual({ ok: false });
    expect(await fetchAppMetadata(1001, "")).toEqual({ ok: false });
    expect(await fetchAppMetadata(1001, fakePem("@@@"))).toEqual({
      ok: false,
    });
  });

  test("HTTP non-200 on GET /app → {ok:false}, zero retries, no bot request", async () => {
    const { calls } = stubFetch(() => jsonResponse({ message: "Not Found" }, 404));
    const { pem } = await pkcs8Fixture();
    expect(await fetchAppMetadata(1001, pem)).toEqual({ ok: false });
    expect(calls).toHaveLength(1); // the zero-retry lock (AD-531), and no avatar leg
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

  test("nullable upstream fields degrade per-item — the icon still derives from the App id", async () => {
    const { pem } = await pkcs8Fixture();
    const { calls } = stubFetch(() => jsonResponse({ name: "Bare App", description: null }));

    expect(await fetchAppMetadata(1001, pem)).toEqual({
      ok: true,
      metadata: {
        githubName: "Bare App",
        githubDescription: null,
        githubHtmlUrl: null,
        githubAvatarUrl: AVATAR_URL(1001),
        githubSlug: null,
      },
    });
    expect(calls).toHaveLength(1); // no slug from either source, and no logo lookup to make
  });

  test("non-https html_url is dropped to null and yields no derived slug", async () => {
    const { pem } = await pkcs8Fixture();
    const { calls } = stubFetch(() =>
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
        githubAvatarUrl: AVATAR_URL(1001),
        githubSlug: null,
      },
    });
    expect(calls).toHaveLength(1);
  });

  test("a payload without `slug` derives it from html_url", async () => {
    const { pem } = await pkcs8Fixture();
    const { calls } = stubApp(() =>
      jsonResponse({ name: "Acme Inspector", html_url: "https://github.com/apps/acme-inspector" }),
    );

    const result = await fetchAppMetadata(1001, pem);

    expect(result).toEqual({
      ok: true,
      metadata: {
        githubName: "Acme Inspector",
        githubDescription: null,
        githubHtmlUrl: "https://github.com/apps/acme-inspector",
        githubAvatarUrl: AVATAR_URL(1001),
        githubSlug: "acme-inspector",
      },
    });
    expect(calls).toHaveLength(1);
  });

  test("`slug` in the payload wins over the html_url derivation", async () => {
    const { pem } = await pkcs8Fixture();
    stubApp(() =>
      // A renamed App: the API slug is current while html_url still trails it.
      jsonResponse({
        name: "Renamed App",
        slug: "renamed-app",
        html_url: "https://github.com/apps/old-app",
      }),
    );

    const result = await fetchAppMetadata(1001, pem);

    expect(result).toEqual({
      ok: true,
      metadata: {
        githubName: "Renamed App",
        githubDescription: null,
        githubHtmlUrl: "https://github.com/apps/old-app",
        githubAvatarUrl: AVATAR_URL(1001),
        githubSlug: "renamed-app",
      },
    });
  });

  test("the icon tracks the App id, not the slug — a rename keeps the same CDN object", async () => {
    const { pem } = await pkcs8Fixture();
    stubApp(() => jsonResponse(GITHUB_PROFILE));

    // App id 987654 ≠ the fixture's slug: the derived URL uses the id alone.
    const result = await fetchAppMetadata(987654, pem);

    expect(result.ok && result.metadata.githubAvatarUrl).toBe(AVATAR_URL(987654));
    expect(result.ok && result.metadata.githubSlug).toBe("acme-inspector");
  });
});

describe("githubAppSlugFromHtmlUrl (the html_url fallback)", () => {
  test("reads the single segment after /apps", () => {
    expect(githubAppSlugFromHtmlUrl("https://github.com/apps/wood-s-pr-inspector")).toBe(
      "wood-s-pr-inspector",
    );
    // Trailing slash / query / fragment are not part of the slug.
    expect(githubAppSlugFromHtmlUrl("https://github.com/apps/acme/")).toBe("acme");
    expect(githubAppSlugFromHtmlUrl("https://github.com/apps/acme?tab=1#readme")).toBe("acme");
  });

  test("anything but a single /apps segment is null (a guessed slug would target a real bot)", () => {
    expect(githubAppSlugFromHtmlUrl(null)).toBeNull();
    expect(githubAppSlugFromHtmlUrl(undefined)).toBeNull();
    expect(githubAppSlugFromHtmlUrl("")).toBeNull();
    expect(githubAppSlugFromHtmlUrl("http://github.com/apps/acme")).toBeNull(); // scheme gate
    expect(githubAppSlugFromHtmlUrl("javascript:alert(1)//github.com/apps/acme")).toBeNull();
    expect(githubAppSlugFromHtmlUrl("not a url")).toBeNull();
    expect(githubAppSlugFromHtmlUrl("https://github.com/apps")).toBeNull();
    expect(githubAppSlugFromHtmlUrl("https://github.com/apps/acme/installations")).toBeNull();
    expect(githubAppSlugFromHtmlUrl("https://github.com/acme")).toBeNull();
  });

  test("the host is pinned to github.com — a look-alike host cannot smuggle a slug in", () => {
    expect(githubAppSlugFromHtmlUrl("https://evil.example/apps/acme")).toBeNull();
    expect(githubAppSlugFromHtmlUrl("https://github.com.evil.example/apps/acme")).toBeNull();
    expect(githubAppSlugFromHtmlUrl("http://github.com/apps/acme")).toBeNull();
    expect(githubAppSlugFromHtmlUrl("https://github.com/apps/acme")).toBe("acme");
  });
});

describe("isGithubMetadataStale (TTL — the settings read path's refresh gate)", () => {
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

describe("fetchAppVisibility (anonymous GET /apps/{slug})", () => {
  test("200 → public, with no credential, the slug in the URL and a 3s budget", async () => {
    let timeoutMs: number | undefined;
    AbortSignal.timeout = ((ms: number) => {
      timeoutMs = ms;
      return origAbortTimeout.call(AbortSignal, ms);
    }) as typeof AbortSignal.timeout;
    const { calls } = stubFetch(() => new Response("{}", { status: 200 }));

    expect(await fetchAppVisibility("acme-inspector")).toBe("public");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/apps/acme-inspector");
    const headers = new Headers(calls[0]!.init!.headers);
    // Anonymous on purpose: the probe never mints or sends an App JWT.
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(timeoutMs).toBe(3_000);
  });

  test("404 → private (a private App has no public listing entry)", async () => {
    stubFetch(() => new Response(null, { status: 404 }));
    expect(await fetchAppVisibility("acme-inspector")).toBe("private");
  });

  test("any other status → null, so the caller keeps the stored value", async () => {
    for (const status of [500, 403, 301]) {
      const { calls } = stubFetch(() => new Response(null, { status }));
      expect(await fetchAppVisibility("acme-inspector")).toBeNull();
      expect(calls).toHaveLength(1);
    }
  });

  test("a network failure → null, never a throw", async () => {
    stubFetch(() => {
      throw new TypeError("network down");
    });
    expect(await fetchAppVisibility("acme-inspector")).toBeNull();
  });
});

describe("fetchAppInstallations (the reconcile face)", () => {
  const INSTALLATIONS_URL = "https://api.github.com/app/installations?per_page=100";

  test("one 200 page → its installation ids, one Bearer-authenticated GET with the 5s budget", async () => {
    const { pem, publicKey } = await pkcs8Fixture();
    const { calls } = stubFetch(() =>
      jsonResponse([
        { id: 500, account: { login: "octo-org" }, target_type: "Organization" },
        { id: 501, account: { login: "octocat" }, target_type: "User" },
      ]),
    );

    expect(await fetchAppInstallations(1001, pem)).toEqual({ ok: true, installationIds: [500, 501] });
    expect(calls).toHaveLength(1); // zero retries
    const call = calls[0]!;
    expect(call.url).toBe(INSTALLATIONS_URL);
    expect(call.init!.method).toBe("GET");
    expect(call.init!.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(call.init!.headers);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("user-agent")).toBe("mstar-inspector");
    const auth = headers.get("authorization")!;
    expect(auth.startsWith("Bearer ")).toBe(true);
    const { valid } = await decodeAndVerifyJwt(auth.slice("Bearer ".length), publicKey);
    expect(valid).toBe(true);
  });

  test("follows ONE Link rel=next page and merges both pages' ids", async () => {
    const { pem } = await pkcs8Fixture();
    const page2 = "https://api.github.com/app/installations?per_page=100&page=2";
    const { calls } = stubFetch((url) => {
      if (url === INSTALLATIONS_URL) {
        return new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), {
          status: 200,
          headers: {
            "content-type": "application/json",
            link: `<${page2}>; rel="next", <${page2}>; rel="last"`,
          },
        });
      }
      if (url === page2) return jsonResponse([{ id: 3 }]);
      throw new Error(`unexpected fetch: ${url}`);
    });

    expect(await fetchAppInstallations(1001, pem)).toEqual({ ok: true, installationIds: [1, 2, 3] });
    expect(calls.map((call) => call.url)).toEqual([INSTALLATIONS_URL, page2]);
  });

  test("a next link on another host makes the whole answer unusable — never a partial success", async () => {
    const { pem } = await pkcs8Fixture();
    // The rejected target may be hiding every later page, so the ids collected
    // so far are a subset — and a subset must never reach the reconcile.
    const { calls } = stubFetch(() =>
      new Response(JSON.stringify([{ id: 7 }]), {
        status: 200,
        headers: { "content-type": "application/json", link: '<https://evil.example/steal>; rel="next"' },
      }),
    );

    expect(await fetchAppInstallations(1001, pem)).toEqual({ ok: false });
    expect(calls).toHaveLength(1); // the rejected target is never fetched
  });

  test("ten pages each still carrying a next link → {ok:false}: the cap is a hard stop, never a truncated list", async () => {
    const { pem } = await pkcs8Fixture();
    const { calls } = stubFetch((url) => {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const nextUrl = `${url.split("?")[0]}?per_page=100&page=${page + 1}`;
      return new Response(JSON.stringify([{ id: page }]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          link: `<${nextUrl}>; rel="next"`,
        },
      });
    });

    expect(await fetchAppInstallations(1001, pem)).toEqual({ ok: false });
    expect(calls).toHaveLength(10); // no 11th request, and no ids escaped
  });

  test("non-200, malformed payload and an abort all collapse to {ok:false} — never a throw", async () => {
    const { pem } = await pkcs8Fixture();
    const notOk = stubFetch(() => jsonResponse({ message: "Bad credentials" }, 401));
    expect(await fetchAppInstallations(1001, pem)).toEqual({ ok: false });
    expect(notOk.calls).toHaveLength(1);

    stubFetch(() => jsonResponse({ id: 1 })); // an object, not the id array
    expect(await fetchAppInstallations(1001, pem)).toEqual({ ok: false });

    stubFetch(() => jsonResponse([{ account: { login: "octo-org" } }])); // no numeric id
    expect(await fetchAppInstallations(1001, pem)).toEqual({ ok: false });

    stubFetch(() => new Response("<html>gateway error</html>", { status: 200 }));
    expect(await fetchAppInstallations(1001, pem)).toEqual({ ok: false });

    stubFetch(() => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    });
    expect(await fetchAppInstallations(1001, pem)).toEqual({ ok: false });
  });
});

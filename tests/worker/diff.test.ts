/**
 * Worker diff fetcher tests (plan 04 Task 3).
 *
 * The auth surface is injected and mocked — no real token, no network.
 * Contract under test (plan Module contracts):
 *   createDiffFetcher(auth) → { fetchPrDiff(installationId, owner, repo, prNumber): Promise<string> }
 * Success value MUST be a non-empty string starting with "diff --git".
 * Errors from the octokit layer MUST reject (never swallowed).
 *
 * Key-format lock (I1 fix): GitHub's App settings download is a PKCS#1 PEM,
 * which workerd's WebCrypto `importKey("pkcs8")` rejects. The committed
 * fixtures `tests/fixtures/github-app-pkcs1.pem` (PKCS#1) and
 * `github-app-pkcs8.pem` (openssl `pkcs8 -topk8 -nocrypt` of the same key)
 * prove the pure-JS wrap is byte-identical to openssl, that a JWT minted
 * from the PKCS#1 fixture verifies against the matching public key, and
 * that the full production binding mints the installation token from the
 * PKCS#1 fixture.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAppAuthFromEnv,
  createDiffFetcher,
  expandHomePath,
  normalizePrivateKey,
  pkcs1ToPkcs8,
  resolvePrivateKey,
  type AppAuth,
  type OctokitLike,
  type PullsGetParams,
} from "../../src/worker/diff";

const DIFF = `diff --git a/README.md b/README.md
index 0100000..0200000 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 hello
+world
`;

/** Committed PKCS#1 fixture (GitHub App download shape). */
const PKCS1_FIXTURE = await Bun.file(
  new URL("../../tests/fixtures/github-app-pkcs1.pem", import.meta.url),
).text();
/** openssl `pkcs8 -topk8 -nocrypt` of the same key — expected wrap output. */
const PKCS8_FIXTURE = await Bun.file(
  new URL("../../tests/fixtures/github-app-pkcs8.pem", import.meta.url),
).text();
/** Public key matching the fixtures (signature verification). */
const PUB_FIXTURE = await Bun.file(
  new URL("../../tests/fixtures/github-app-pkcs1.pub.pem", import.meta.url),
).text();

/** Throwaway PKCS#8 key (WebCrypto — no openssl dependency in tests). */
async function makePemKey(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const b64 = Buffer.from(pkcs8).toString("base64");
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/** Octokit mock whose `rest.pulls.get` resolves to the given response. */
function makeOctokit(response: { data: unknown }): OctokitLike {
  return {
    rest: {
      pulls: {
        get: async () => response,
      },
    },
  };
}

/** Auth mock: records installation ids, returns the octokit. */
function makeAuth(octokit: OctokitLike) {
  const calls: number[] = [];
  const auth: AppAuth = async ({ installationId }) => {
    calls.push(installationId);
    return octokit;
  };
  return { auth, calls };
}

describe("createDiffFetcher", () => {
  test("returns the unified diff string when octokit data is already the diff", async () => {
    const { auth } = makeAuth(makeOctokit({ data: DIFF }));
    const { fetchPrDiff } = createDiffFetcher(auth);

    const result = await fetchPrDiff(12345, "acme", "inspector", 42);

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result.startsWith("diff --git")).toBe(true);
    expect(result).toBe(DIFF);
  });

  test("handles octokit responses where the diff is nested under data.data", async () => {
    const { auth } = makeAuth(makeOctokit({ data: { data: DIFF } }));
    const { fetchPrDiff } = createDiffFetcher(auth);

    const result = await fetchPrDiff(12345, "acme", "inspector", 42);

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result.startsWith("diff --git")).toBe(true);
    expect(result).toBe(DIFF);
  });

  test("passes installationId to auth and owner/repo/prNumber to pulls.get with diff media type", async () => {
    const octokit = makeOctokit({ data: DIFF });
    const { auth, calls } = makeAuth(octokit);
    const { fetchPrDiff } = createDiffFetcher(auth);

    const getCalls: unknown[] = [];
    const originalGet = octokit.rest?.pulls?.get;
    octokit.rest = {
      pulls: {
        get: async (params: PullsGetParams) => {
          getCalls.push(params);
          return originalGet!(params);
        },
      },
    };

    await fetchPrDiff(12345, "acme", "inspector", 42);

    expect(calls).toEqual([12345]);
    expect(getCalls).toEqual([
      {
        owner: "acme",
        repo: "inspector",
        pull_number: 42,
        mediaType: { format: "diff" },
      },
    ]);
  });

  test("rejects when the octokit call throws (errors are not swallowed)", async () => {
    const octokit: OctokitLike = {
      rest: {
        pulls: {
          get: async () => {
            throw new Error("boom: rate limited");
          },
        },
      },
    };
    const { auth } = makeAuth(octokit);
    const { fetchPrDiff } = createDiffFetcher(auth);

    await expect(fetchPrDiff(12345, "acme", "inspector", 42)).rejects.toThrow(
      "boom: rate limited",
    );
  });

  test("rejects a 404 (PR not found) from the octokit layer", async () => {
    const octokit: OctokitLike = {
      rest: {
        pulls: {
          get: async () => {
            const err = new Error("Not Found") as Error & { status?: number };
            err.status = 404;
            throw err;
          },
        },
      },
    };
    const { auth } = makeAuth(octokit);
    const { fetchPrDiff } = createDiffFetcher(auth);

    await expect(fetchPrDiff(12345, "acme", "inspector", 9999)).rejects.toThrow("Not Found");
  });

  test("rejects when auth itself throws", async () => {
    const auth: AppAuth = async () => {
      throw new Error("auth failed");
    };
    const { fetchPrDiff } = createDiffFetcher(auth);

    await expect(fetchPrDiff(12345, "acme", "inspector", 42)).rejects.toThrow("auth failed");
  });

  test("rejects with a clear error when the octokit surface is missing rest.pulls.get", async () => {
    const { auth } = makeAuth({});
    const { fetchPrDiff } = createDiffFetcher(auth);

    await expect(fetchPrDiff(12345, "acme", "inspector", 42)).rejects.toThrow(
      /octokit is missing rest\.pulls\.get/,
    );
  });

  test("rejects a JSON patch response instead of treating it as success", async () => {
    const { auth } = makeAuth(makeOctokit({ data: { id: 1, title: "PR" } }));
    const { fetchPrDiff } = createDiffFetcher(auth);

    await expect(fetchPrDiff(12345, "acme", "inspector", 42)).rejects.toThrow(
      /unified diff/,
    );
  });

  test("rejects an HTML/error-page string that is not a unified diff", async () => {
    const { auth } = makeAuth(makeOctokit({ data: "<html><body>Not Found</body></html>" }));
    const { fetchPrDiff } = createDiffFetcher(auth);

    await expect(fetchPrDiff(12345, "acme", "inspector", 42)).rejects.toThrow(
      /unified diff/,
    );
  });

  test("rejects an empty diff string", async () => {
    const { auth } = makeAuth(makeOctokit({ data: "" }));
    const { fetchPrDiff } = createDiffFetcher(auth);

    await expect(fetchPrDiff(12345, "acme", "inspector", 42)).rejects.toThrow(
      /unified diff/,
    );
  });
});

describe("resolvePrivateKey", () => {
  test("returns inline PEM as-is", async () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n";
    expect(await resolvePrivateKey(pem)).toBe(pem);
  });

  test("reads a plain file path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-key-"));
    const path = join(dir, "key.pem");
    writeFileSync(path, "-----BEGIN PRIVATE KEY-----\nfile-key\n-----END PRIVATE KEY-----\n");
    expect(await resolvePrivateKey(path)).toContain("file-key");
  });

  test("expands a ~-prefixed path via homedir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-key-"));
    const path = join(dir, "key.pem");
    writeFileSync(path, "-----BEGIN PRIVATE KEY-----\nhome-key\n-----END PRIVATE KEY-----\n");
    const { homedir } = await import("node:os");
    const home = homedir();
    // ~ expansion resolves relative to the real homedir; place the key under
    // the home when the temp dir is inside it, otherwise assert the prefix
    // is stripped and the remainder is resolved against homedir.
    if (dir.startsWith(home)) {
      const rel = path.slice(home.length + 1);
      expect(await resolvePrivateKey(`~/${rel}`)).toContain("home-key");
    } else {
      const rel = path.replace(/^\//, "");
      await expect(resolvePrivateKey(`~/${rel}`)).rejects.toThrow();
    }
  });

  test("expandHomePath expands ~/ and leaves other paths untouched", () => {
    expect(expandHomePath("~/keys/app.pem", "/home/user")).toBe("/home/user/keys/app.pem");
    expect(expandHomePath("/abs/keys/app.pem", "/home/user")).toBe("/abs/keys/app.pem");
    expect(expandHomePath("keys/app.pem", "/home/user")).toBe("keys/app.pem");
  });
});

describe("pkcs1ToPkcs8 / normalizePrivateKey (I1 key-format lock)", () => {
  test("wraps the PKCS#1 fixture byte-identically to openssl pkcs8 -topk8 -nocrypt", () => {
    expect(pkcs1ToPkcs8(PKCS1_FIXTURE)).toBe(PKCS8_FIXTURE);
  });

  test("mints a JWT from the PKCS#1 fixture via WebCrypto and the signature verifies against the public key", async () => {
    const converted = normalizePrivateKey(PKCS1_FIXTURE);
    expect(converted.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);

    // Decode the PKCS#8 DER and import it exactly as universal-github-app-jwt
    // does on the workerd path (crypto.subtle.importKey("pkcs8", ...)).
    const body = converted
      .replace(/-----BEGIN PRIVATE KEY-----/, "")
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\s+/g, "");
    const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
      false,
      ["sign"],
    );

    const b64url = (buf: ArrayBuffer | Uint8Array) =>
      btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    const header = { alg: "RS256", typ: "JWT" };
    const payload = { iat: 1, exp: 2, iss: "123456" };
    const message = `${b64url(new TextEncoder().encode(JSON.stringify(header)))}.${b64url(new TextEncoder().encode(JSON.stringify(payload)))}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(message));
    const jwt = `${message}.${b64url(signature)}`;

    expect(jwt.split(".")).toHaveLength(3);
    expect(jwt.startsWith("eyJ")).toBe(true);

    // Verify the signature against the matching public key — proves the
    // wrapped key is the same RSA key, not just a structurally valid PEM.
    const pubBody = PUB_FIXTURE
      .replace(/-----BEGIN PUBLIC KEY-----/, "")
      .replace(/-----END PUBLIC KEY-----/, "")
      .replace(/\s+/g, "");
    const pubDer = Uint8Array.from(atob(pubBody), (c) => c.charCodeAt(0));
    const pubKey = await crypto.subtle.importKey(
      "spki",
      pubDer,
      { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
      false,
      ["verify"],
    );
    const [h, p, s] = jwt.split(".") as [string, string, string];
    const sigBytes = Uint8Array.from(
      atob(s.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    expect(
      await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pubKey, sigBytes, new TextEncoder().encode(`${h}.${p}`)),
    ).toBe(true);
  });

  test("normalizePrivateKey passes PKCS#8 through unchanged", () => {
    expect(normalizePrivateKey(PKCS8_FIXTURE)).toBe(PKCS8_FIXTURE);
  });

  test("normalizePrivateKey hard-fails OpenSSH keys with the conversion command", () => {
    expect(() =>
      normalizePrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n"),
    ).toThrow(/OpenSSH format.*openssl pkcs8 -topk8 -nocrypt/s);
  });

  test("resolvePrivateKey converts an inline PKCS#1 PEM to PKCS#8", async () => {
    expect(await resolvePrivateKey(PKCS1_FIXTURE)).toBe(PKCS8_FIXTURE);
  });

  test("resolvePrivateKey converts a PKCS#1 key read from a file path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-key-"));
    const keyPath = join(dir, "app.pem");
    writeFileSync(keyPath, PKCS1_FIXTURE);
    expect(await resolvePrivateKey(keyPath)).toBe(PKCS8_FIXTURE);
  });
});

describe("createAppAuthFromEnv (production binding)", () => {
  const origFetch = globalThis.fetch;
  const requests: Array<{ url: string; auth: string | null }> = [];
  const logLines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    console.warn = origWarn;
    requests.length = 0;
    logLines.length = 0;
  });

  function stubFetch(token: string) {
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ url: u, auth: headers.authorization ?? null });
      if (u.includes("/app/installations/")) {
        return new Response(
          JSON.stringify({
            token,
            expires_at: new Date(Date.now() + 3600e3).toISOString(),
            permissions: {},
            repository_selection: "all",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(DIFF, { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
  }

  test("inline PEM: fetches a non-empty diff with the installation token, cached across calls", async () => {
    const pem = await makePemKey();
    stubFetch("super-secret-installation-token-xyz");
    console.log = mock((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    }) as typeof console.log;
    console.warn = mock((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    }) as typeof console.warn;

    const auth = createAppAuthFromEnv({ APP_ID: "123456", PRIVATE_KEY: pem });
    const { fetchPrDiff } = createDiffFetcher(auth);

    const first = await fetchPrDiff(999, "acme", "inspector", 42);
    const second = await fetchPrDiff(999, "acme", "inspector", 43);

    expect(first.startsWith("diff --git")).toBe(true);
    expect(first.length).toBeGreaterThan(0);
    expect(second.startsWith("diff --git")).toBe(true);

    const tokenCalls = requests.filter((r) => r.url.includes("access_tokens"));
    expect(tokenCalls).toHaveLength(1); // cached — auth-app default
    const diffAuths = requests.filter((r) => r.url.includes("/pulls/")).map((r) => r.auth);
    expect(diffAuths).toEqual(["token super-secret-installation-token-xyz", "token super-secret-installation-token-xyz"]);

    // Token never enters logs.
    const allLogs = logLines.join("\n");
    expect(allLogs).not.toContain("super-secret-installation-token-xyz");
    expect(allLogs).not.toContain("-----BEGIN");
  });
  test("path-form PRIVATE_KEY: reads the key file and fetches a non-empty diff", async () => {
    const pem = await makePemKey();
    const dir = mkdtempSync(join(tmpdir(), "mstar-key-"));
    const keyPath = join(dir, "key.pem");
    writeFileSync(keyPath, pem);
    stubFetch("path-form-token-abc");
    console.log = mock((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    }) as typeof console.log;

    const auth = createAppAuthFromEnv({ APP_ID: "123456", PRIVATE_KEY: keyPath });
    const { fetchPrDiff } = createDiffFetcher(auth);

    const result = await fetchPrDiff(999, "acme", "inspector", 42);

    expect(result.startsWith("diff --git")).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    const diffAuths = requests.filter((r) => r.url.includes("/pulls/")).map((r) => r.auth);
    expect(diffAuths).toEqual(["token path-form-token-abc"]);
    expect(logLines.join("\n")).not.toContain("path-form-token-abc");
  });

  test("PKCS#1 fixture (GitHub App download shape): mints the installation token and fetches a non-empty diff", async () => {
    stubFetch("pkcs1-fixture-token-xyz");
    console.log = mock((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    }) as typeof console.log;

    const auth = createAppAuthFromEnv({ APP_ID: "123456", PRIVATE_KEY: PKCS1_FIXTURE });
    const { fetchPrDiff } = createDiffFetcher(auth);

    const result = await fetchPrDiff(999, "acme", "inspector", 42);

    expect(result.startsWith("diff --git")).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    const tokenCalls = requests.filter((r) => r.url.includes("access_tokens"));
    expect(tokenCalls).toHaveLength(1);
    const diffAuths = requests.filter((r) => r.url.includes("/pulls/")).map((r) => r.auth);
    expect(diffAuths).toEqual(["token pkcs1-fixture-token-xyz"]);
    // The JWT (Authorization on the access_tokens call) and the PEM never
    // enter logs.
    const allLogs = logLines.join("\n");
    expect(allLogs).not.toContain("pkcs1-fixture-token-xyz");
    expect(allLogs).not.toContain("-----BEGIN");
    expect(allLogs).not.toContain("eyJ");
  });
});

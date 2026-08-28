/**
 * Plan 08 Task 2 tests: signed session cookie + OAuth state CSRF, through
 * the real worker mount (app.route("/dashboard", dashboardApp)). Plan 11
 * Task 1 adds the GitHub App Manifest start/callback coverage (state CSRF,
 * locked conversion headers, encrypted hold cookie, no-secret HTML).
 *
 * The end-to-end callback network path is exercised only in live smoke
 * (user-gated); here callback coverage stops at the fail-closed state/code
 * checks, and the GitHub helpers (code exchange, user fetch, manifest
 * conversion) are unit-tested with stubbed fetch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { exchangeCodeForToken, fetchGitHubUser } from "../../src/dashboard/oauth";
import type { Env } from "../../src/worker/env";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  createSessionValue,
  createStateValue,
  readSessionValue,
  signValue,
  verifyValue,
} from "../../src/dashboard/session";
import {
  MANIFEST_HOLD_COOKIE,
  MANIFEST_STATE_COOKIE,
  createHoldValue,
  exchangeManifestCode,
  readHoldValue,
} from "../../src/dashboard/manifest";

const SESSION_SECRET = "test-dashboard-session-secret-32-bytes!";
const CLIENT_ID = "oauth-client-id";
const CLIENT_SECRET = "oauth-client-secret";

// RSA-2048-shaped PEM (~1.7KB) for the cookie-size budget — not a real key.
const FAKE_PEM = `-----BEGIN RSA PRIVATE KEY-----\n${Array.from({ length: 26 }, () => "A".repeat(64)).join("\n")}\n-----END RSA PRIVATE KEY-----\n`;
const FAKE_WEBHOOK_SECRET = "test-manifest-webhook-secret";
const CONVERSION = {
  id: 123456,
  name: "mstar-inspector-octocat",
  pem: FAKE_PEM,
  webhook_secret: FAKE_WEBHOOK_SECRET,
};

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ID: "123",
    PRIVATE_KEY: "private-key",
    WEBHOOK_SECRET: "s3cret-webhook-secret",
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: {
      get: async () => null,
      put: async () => {},
    } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: CLIENT_ID,
    GITHUB_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    ...overrides,
  };
}

function dashboardRequest(path: string, cookie?: string): Request {
  return new Request(`https://worker.local${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}
/**
 * Unambiguously invalid tamper: replace the base64url HMAC with zeros.
 * A last-char flip is NOT reliable — the final base64url char of a 32-byte
 * HMAC carries only 4 data bits, so flipping within its low 2 padding bits
 * (any char ≡ 0 mod 4 → "A") decodes to identical bytes and still verifies
 * (~25% flake per run since `iat` makes the signature run-dependent).
 */
function tamperSignature(value: string): string {
  const dot = value.lastIndexOf(".");
  return `${value.slice(0, dot + 1)}${"A".repeat(value.length - dot - 1)}`;
}
// Structured-log assertions: capture console.warn JSON lines for one test.
const origWarn = console.warn;
afterEach(() => {
  console.warn = origWarn;
});

function spyOnWarn(): string[] {
  const warns: string[] = [];
  console.warn = (msg: unknown) => {
    warns.push(String(msg));
  };
  return warns;
}

describe("signed session cookie (session.ts)", () => {
  test("signValue/verifyValue round trip", async () => {
    const value = await signValue('{"login":"octocat"}', SESSION_SECRET);
    expect(await verifyValue(value, SESSION_SECRET)).toBe('{"login":"octocat"}');
  });

  test("wrong secret is rejected", async () => {
    const value = await signValue("payload", SESSION_SECRET);
    expect(await verifyValue(value, "another-secret")).toBeNull();
  });

  test("tampered payload or signature is rejected", async () => {
    const value = await signValue("payload", SESSION_SECRET);
    const [body, sig] = value.split(".");
    expect(await verifyValue(`${body}x.${sig}`, SESSION_SECRET)).toBeNull();
    expect(await verifyValue(`${body}.${sig}x`, SESSION_SECRET)).toBeNull();
    expect(await verifyValue("no-separator", SESSION_SECRET)).toBeNull();
  });

  test("expired session is rejected", async () => {
    const past = Date.now() - 8 * 24 * 60 * 60 * 1000; // minted 8d ago, 7d TTL
    const value = await createSessionValue("octocat", null, SESSION_SECRET, past);
    expect(await readSessionValue(value, SESSION_SECRET)).toBeNull();
  });

  test("fresh session reads back login and name", async () => {
    const value = await createSessionValue("octocat", "The Octocat", SESSION_SECRET);
    const session = await readSessionValue(value, SESSION_SECRET);
    expect(session?.login).toBe("octocat");
    expect(session?.name).toBe("The Octocat");
  });
});

describe("exchangeCodeForToken (oauth.ts, stubbed fetch)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("requests the token URL with Accept: application/json and returns the token", async () => {
    let seenUrl = "";
    let seenAccept = "";
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenAccept = ((init?.headers ?? {}) as Record<string, string>).Accept ?? "";
      return new Response(JSON.stringify({ access_token: "gho_token", scope: "read:user" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const token = await exchangeCodeForToken("code", CLIENT_ID, CLIENT_SECRET, "https://cb");
    expect(seenUrl).toBe("https://github.com/login/oauth/access_token");
    expect(seenAccept).toBe("application/json");
    expect(token).toBe("gho_token");
  });

  test("form-urlencoded (non-JSON) response returns null without throwing", async () => {
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) =>
      new Response("access_token=gho_token&scope=read%3Auser", {
        status: 200,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      })) as typeof fetch;
    expect(await exchangeCodeForToken("code", CLIENT_ID, CLIENT_SECRET, "https://cb")).toBeNull();
  });

  test("JSON payload missing access_token returns null", async () => {
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: "bad_verification_code" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    expect(await exchangeCodeForToken("code", CLIENT_ID, CLIENT_SECRET, "https://cb")).toBeNull();
  });

  test("network failure (fetch rejects) returns null without throwing", async () => {
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await exchangeCodeForToken("code", CLIENT_ID, CLIENT_SECRET, "https://cb")).toBeNull();
  });

  test("fetch is bounded by an AbortSignal (W-1)", async () => {
    let seenSignal: unknown;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seenSignal = init?.signal;
      return new Response(JSON.stringify({ access_token: "gho_token" }), { status: 200 });
    }) as typeof fetch;
    await exchangeCodeForToken("code", CLIENT_ID, CLIENT_SECRET, "https://cb");
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  test("non-OK response consumes the body and logs stage + github_status without secrets (W-1/W-2)", async () => {
    let bodyCancelled = false;
    const failedResponse = {
      ok: false,
      status: 401,
      body: {
        cancel: async () => {
          bodyCancelled = true;
        },
      },
    } as unknown as Response;
    globalThis.fetch = (async () => failedResponse) as unknown as typeof fetch;
    const warns = spyOnWarn();
    const token = await exchangeCodeForToken("secret-code-value", CLIENT_ID, CLIENT_SECRET, "https://cb");
    expect(token).toBeNull();
    expect(bodyCancelled).toBe(true);
    expect(warns).toHaveLength(1);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.event).toBe("dashboard_oauth");
    expect(entry.stage).toBe("token_exchange");
    expect(entry.reason).toBe("http_error");
    expect(entry.github_status).toBe(401);
    expect(warns[0]).not.toContain(CLIENT_SECRET);
    expect(warns[0]).not.toContain("secret-code-value");
  });

  test("fetch throw is logged with error_type, never the secret (W-2)", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const warns = spyOnWarn();
    expect(await exchangeCodeForToken("code", CLIENT_ID, CLIENT_SECRET, "https://cb")).toBeNull();
    expect(warns).toHaveLength(1);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.stage).toBe("token_exchange");
    expect(entry.reason).toBe("fetch_failed");
    expect(entry.error_type).toBe("TypeError");
    expect(warns[0]).not.toContain(CLIENT_SECRET);
  });
});

describe("fetchGitHubUser (oauth.ts, stubbed fetch)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("returns login/name and sends a bounded AbortSignal (W-1)", async () => {
    let seenSignal: unknown;
    let seenAuth = "";
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seenSignal = init?.signal;
      seenAuth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
      return new Response(JSON.stringify({ login: "octocat", name: null }), { status: 200 });
    }) as typeof fetch;
    const user = await fetchGitHubUser("gho_token");
    expect(user).toEqual({ login: "octocat", name: null });
    expect(seenAuth).toBe("Bearer gho_token");
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  test("non-OK response consumes the body and logs github_status (W-1/W-2)", async () => {
    let bodyCancelled = false;
    const failedResponse = {
      ok: false,
      status: 403,
      body: {
        cancel: async () => {
          bodyCancelled = true;
        },
      },
    } as unknown as Response;
    globalThis.fetch = (async () => failedResponse) as unknown as typeof fetch;
    const warns = spyOnWarn();
    expect(await fetchGitHubUser("gho_token")).toBeNull();
    expect(bodyCancelled).toBe(true);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.stage).toBe("user_fetch");
    expect(entry.reason).toBe("http_error");
    expect(entry.github_status).toBe(403);
  });

  test("payload without login returns null and logs unexpected_payload", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 1 }), { status: 200 })) as unknown as typeof fetch;
    const warns = spyOnWarn();
    expect(await fetchGitHubUser("gho_token")).toBeNull();
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.stage).toBe("user_fetch");
    expect(entry.reason).toBe("unexpected_payload");
  });

  test("network failure (fetch rejects) returns null and logs fetch_failed", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const warns = spyOnWarn();
    expect(await fetchGitHubUser("gho_token")).toBeNull();
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.stage).toBe("user_fetch");
    expect(entry.reason).toBe("fetch_failed");
    expect(entry.error_type).toBe("TypeError");
  });
});

describe("/dashboard routes", () => {
  test("GET /dashboard without cookie → 302 to /dashboard/login", async () => {
    const res = await worker.fetch(dashboardRequest("/dashboard"), makeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("GET /dashboard with a valid session cookie → 200 shell", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      dashboardRequest("/dashboard", `${SESSION_COOKIE}=${session}`),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Signed in as octocat");
    // B1: the GitHub App section is live — a submit to the manifest start
    // route, not a disabled placeholder button.
    expect(body).toContain('action="/dashboard/manifest/start"');
    expect(body).toContain('<button type="submit" class="primary">Create GitHub App</button>');
    // BYOK / Review stay inert placeholders (AC-S11-placeholders).
    expect(body).toContain("Not in this iteration (B2).");
    expect(body).toContain("Not in this iteration (B3).");
    expect(body).toContain('aria-disabled="true"');
    expect(body).not.toContain("Not in B0");
  });

  test("GET /dashboard with a tampered session cookie → 302 (treated as logged out)", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      dashboardRequest("/dashboard", `${SESSION_COOKIE}=${tamperSignature(session)}`),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("GET /dashboard/login → 302 to GitHub authorize with signed state cookie", async () => {
    const res = await worker.fetch(dashboardRequest("/dashboard/login"), makeEnv());
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("scope")).toBe("read:user");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://worker.local/dashboard/oauth/callback",
    );
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    const cookie = setCookie[0] ?? "";
    expect(cookie).toContain(`${OAUTH_STATE_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).not.toContain("Domain");
    // The authorize `state` param is exactly the signed cookie value.
    const cookiePair = cookie.split(";")[0] ?? "";
    const stateValue = cookiePair.slice(OAUTH_STATE_COOKIE.length + 1);
    expect(location.searchParams.get("state")).toBe(stateValue);
  });

  test("GET /dashboard/login with a live session → 302 back to /dashboard", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      dashboardRequest("/dashboard/login", `${SESSION_COOKIE}=${session}`),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
  });

  test("callback without state cookie → 400 and no session cookie (fail-closed)", async () => {
    const res = await worker.fetch(
      dashboardRequest("/dashboard/oauth/callback?code=x&state=y"),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    for (const cookie of res.headers.getSetCookie()) {
      expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(false);
    }
  });

  test("callback with mismatched state → 400 and no session cookie (fail-closed)", async () => {
    const state = await createStateValue(SESSION_SECRET);
    const other = await createStateValue(SESSION_SECRET);
    const res = await worker.fetch(
      dashboardRequest(`/dashboard/oauth/callback?code=x&state=${other}`, `${OAUTH_STATE_COOKIE}=${state}`),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    for (const cookie of res.headers.getSetCookie()) {
      expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(false);
    }
    // The state cookie is invalidated on the callback (single-use).
    expect(
      res.headers.getSetCookie().some((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
  });

  test("callback with forged state signature → 400", async () => {
    const forged = await signValue("forged-state", "wrong-secret");
    const res = await worker.fetch(
      dashboardRequest(`/dashboard/oauth/callback?code=x&state=${forged}`, `${OAUTH_STATE_COOKIE}=${forged}`),
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });
  test("callback state mismatch logs a structured state_verify warning (W-2)", async () => {
    const warns = spyOnWarn();
    const res = await worker.fetch(
      dashboardRequest("/dashboard/oauth/callback?code=x&state=y"),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.event).toBe("dashboard_oauth");
    expect(entry.stage).toBe("state_verify");
    expect(entry.reason).toBe("state_mismatch");
  });

  test("callback with valid state but no code → 400 and a structured missing_code warning (W-2)", async () => {
    const state = await createStateValue(SESSION_SECRET);
    const warns = spyOnWarn();
    const res = await worker.fetch(
      dashboardRequest(`/dashboard/oauth/callback?state=${state}`, `${OAUTH_STATE_COOKIE}=${state}`),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.event).toBe("dashboard_oauth");
    expect(entry.stage).toBe("callback");
    expect(entry.reason).toBe("missing_code");
  });

  test("GET /dashboard/logout → 302 to login and session cookie expired", async () => {
    const res = await worker.fetch(dashboardRequest("/dashboard/logout"), makeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    const cookie = setCookie[0] ?? "";
    expect(cookie.startsWith(`${SESSION_COOKIE}=;`)).toBe(true);
    expect(cookie).toContain("Max-Age=0");
  });

  test("dashboard routes fail closed when OAuth secrets are unset", async () => {
    const env = makeEnv({
      GITHUB_OAUTH_CLIENT_ID: undefined,
      GITHUB_OAUTH_CLIENT_SECRET: undefined,
      DASHBOARD_SESSION_SECRET: undefined,
    });
    expect((await worker.fetch(dashboardRequest("/dashboard"), env)).status).toBe(500);
    expect((await worker.fetch(dashboardRequest("/dashboard/login"), env)).status).toBe(500);
  });

  test("POST /dashboard logged in → 405 (placeholder actions never succeed)", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${session}` },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(405);
  });

  test("POST to a placeholder subpath logged in → 405", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/github-app", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${session}` },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(405);
  });

  test("POST /dashboard without a session → 302 to login (IA routing table)", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard", { method: "POST" }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("POST /dashboard with a tampered session → 302 (treated as logged out)", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard", {
        method: "POST",
        headers: {
          Cookie: `${SESSION_COOKIE}=${tamperSignature(session)}`,
        },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("POST placeholder fails closed when the session secret is unset → 500", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard", { method: "POST" }),
      makeEnv({ DASHBOARD_SESSION_SECRET: undefined }),
    );
    expect(res.status).toBe(500);
  });
});

describe("manifest hold cookie (manifest.ts)", () => {
  test("round trip carries id/name/login/pem/webhook_secret", async () => {
    const value = await createHoldValue(CONVERSION, "octocat", SESSION_SECRET);
    const payload = await readHoldValue(value, SESSION_SECRET);
    expect(payload).toEqual({ ...CONVERSION, login: "octocat", exp: expect.any(Number) });
  });

  test("serialized value stays under the 4096B cookie budget with an RSA-2048-size PEM", async () => {
    expect(FAKE_PEM.length).toBeGreaterThan(1500); // realistic key size, else the budget test is vacuous
    const value = await createHoldValue(CONVERSION, "octocat", SESSION_SECRET);
    expect(value.length).toBeLessThan(4096);
  });

  test("wrong secret fails closed", async () => {
    const value = await createHoldValue(CONVERSION, "octocat", SESSION_SECRET);
    expect(await readHoldValue(value, "another-secret")).toBeNull();
  });

  test("tampered ciphertext fails closed (GCM tag)", async () => {
    const value = await createHoldValue(CONVERSION, "octocat", SESSION_SECRET);
    // Flip a mid-string character: unlike the last base64url char (padding
    // bits), this always changes the decoded bytes → GCM tag must fail.
    const at = 24;
    const tampered = `${value.slice(0, at)}${value[at] === "A" ? "B" : "A"}${value.slice(at + 1)}`;
    expect(await readHoldValue(tampered, SESSION_SECRET)).toBeNull();
  });

  test("expired hold fails closed (server-side exp beside Max-Age)", async () => {
    const past = Date.now() - 10 * 60 * 1000; // minted 10min ago, 600s TTL
    const value = await createHoldValue(CONVERSION, "octocat", SESSION_SECRET, past);
    expect(await readHoldValue(value, SESSION_SECRET)).toBeNull();
  });

  test("missing, garbage, and truncated values fail closed", async () => {
    expect(await readHoldValue(undefined, SESSION_SECRET)).toBeNull();
    expect(await readHoldValue("!!!", SESSION_SECRET)).toBeNull();
    expect(await readHoldValue("AAAA", SESSION_SECRET)).toBeNull(); // < IV+tag
  });
});

describe("exchangeManifestCode (manifest.ts, stubbed fetch)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("POSTs the conversion with the locked headers and NO Authorization header (spec L9)", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenHeaders: Record<string, string> = {};
    let seenSignal: unknown;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = init?.method ?? "";
      seenHeaders = { ...((init?.headers ?? {}) as Record<string, string>) };
      seenSignal = init?.signal;
      return new Response(JSON.stringify(CONVERSION), { status: 201 });
    }) as typeof fetch;
    const conversion = await exchangeManifestCode("manifest-code");
    expect(seenUrl).toBe("https://api.github.com/app-manifests/manifest-code/conversions");
    expect(seenMethod).toBe("POST");
    expect(seenHeaders.Accept).toBe("application/vnd.github+json");
    expect(seenHeaders["X-GitHub-Api-Version"]).toBe("2022-11-28");
    // The code itself is the credential — a bearer header returns 406.
    expect(seenHeaders.Authorization).toBeUndefined();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(conversion).toEqual(CONVERSION);
  });

  test("non-OK response consumes the body and logs github_status, never the code (W-1/W-2)", async () => {
    let bodyCancelled = false;
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 422,
        body: {
          cancel: async () => {
            bodyCancelled = true;
          },
        },
      }) as unknown as Response) as unknown as typeof fetch;
    const warns = spyOnWarn();
    expect(await exchangeManifestCode("secret-manifest-code")).toBeNull();
    expect(bodyCancelled).toBe(true);
    expect(warns).toHaveLength(1);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.event).toBe("dashboard_manifest");
    expect(entry.stage).toBe("conversion");
    expect(entry.reason).toBe("http_error");
    expect(entry.github_status).toBe(422);
    expect(warns[0]).not.toContain("secret-manifest-code");
  });

  test("network failure returns null and logs fetch_failed with error_type", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const warns = spyOnWarn();
    expect(await exchangeManifestCode("code")).toBeNull();
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.stage).toBe("conversion");
    expect(entry.reason).toBe("fetch_failed");
    expect(entry.error_type).toBe("TypeError");
  });

  test("payload missing pem/webhook_secret returns null and logs unexpected_payload", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 1, name: "x" }), { status: 201 })) as unknown as typeof fetch;
    const warns = spyOnWarn();
    expect(await exchangeManifestCode("code")).toBeNull();
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.stage).toBe("conversion");
    expect(entry.reason).toBe("unexpected_payload");
  });
});

describe("/dashboard manifest routes (plan 11 Task 1)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function stubFetchMustNotBeCalled(): { calls: () => number } {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("secret API must not be called on this path");
    }) as unknown as typeof fetch;
    return { calls: () => calls };
  }

  /** Authenticated manifest start; returns the minted state + parsed manifest. */
  async function startManifest() {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/start", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${session}` },
      }),
      makeEnv(),
    );
    const body = await res.text();
    const stateCookie =
      res.headers.getSetCookie().find((c) => c.startsWith(`${MANIFEST_STATE_COOKIE}=`)) ?? "";
    const state = (stateCookie.split(";")[0] ?? "").slice(MANIFEST_STATE_COOKIE.length + 1);
    // Hidden-field value is HTML-escaped JSON; reverse escapeHtml exactly
    // (& last, since escapeHtml escapes & first).
    const field = /name="manifest" value="([^"]*)"/.exec(body)?.[1] ?? "";
    const manifest = JSON.parse(
      field
        .replaceAll("&#39;", "'")
        .replaceAll("&quot;", '"')
        .replaceAll("&gt;", ">")
        .replaceAll("&lt;", "<")
        .replaceAll("&amp;", "&"),
    ) as Record<string, unknown>;
    return { res, body, session, state, stateCookie, manifest };
  }

  function callbackRequest(session: string, state: string, query: string): Request {
    return dashboardRequest(
      `/dashboard/manifest/callback?${query}`,
      `${SESSION_COOKIE}=${session}; ${MANIFEST_STATE_COOKIE}=${state}`,
    );
  }

  test("POST /dashboard/manifest/start without a session → 302 to login, no state cookie", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/start", { method: "POST" }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  test("authenticated start → zero-JS form POST to settings/apps/new with the locked manifest", async () => {
    const { res, body, state, stateCookie, manifest } = await startManifest();
    expect(res.status).toBe(200);
    // State cookie: __Host- attribute set, Max-Age 600, no Domain.
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("Secure");
    expect(stateCookie).toContain("SameSite=Lax");
    expect(stateCookie).toContain("Path=/");
    expect(stateCookie).toContain("Max-Age=600");
    expect(stateCookie).not.toContain("Domain");
    expect(state.length).toBeGreaterThan(0);
    // State cookie is distinct from B0's OAuth state cookie (spec L7).
    expect(MANIFEST_STATE_COOKIE).not.toBe(OAUTH_STATE_COOKIE);
    // The form POSTs to GitHub; state rides the action query (official flow).
    expect(body).toContain('method="post"');
    expect(body).toContain(`action="https://github.com/settings/apps/new?state=${state}"`);
    // Locked manifest content (spec § Manifest 内容).
    expect(manifest.name).toBe("mstar-inspector-octocat");
    expect(manifest.url).toBe("https://worker.local");
    expect(manifest.hook_attributes).toEqual({ url: "https://worker.local/webhook" });
    expect(manifest.redirect_url).toBe("https://worker.local/dashboard/manifest/callback");
    expect(manifest.public).toBe(false);
    expect(manifest.default_events).toEqual(["pull_request", "issue_comment"]);
    expect(manifest.default_permissions).toEqual({
      contents: "read",
      metadata: "read",
      pull_requests: "write",
      issues: "write",
    });
  });

  test("callback without a session → 302 to login (IA routing table)", async () => {
    const res = await worker.fetch(
      dashboardRequest("/dashboard/manifest/callback?code=x&state=y"),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("callback without a state cookie → 400, zero conversion fetch, no hold cookie", async () => {
    const guard = stubFetchMustNotBeCalled();
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      dashboardRequest("/dashboard/manifest/callback?code=x&state=y", `${SESSION_COOKIE}=${session}`),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(guard.calls()).toBe(0);
    for (const cookie of res.headers.getSetCookie()) {
      expect(cookie.startsWith(`${MANIFEST_HOLD_COOKIE}=`)).toBe(false);
    }
  });

  test("callback with mismatched state → 400, zero fetch, state cookie expired (single-use)", async () => {
    const guard = stubFetchMustNotBeCalled();
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const state = await createStateValue(SESSION_SECRET);
    const other = await createStateValue(SESSION_SECRET);
    const res = await worker.fetch(callbackRequest(session, state, `code=x&state=${other}`), makeEnv());
    expect(res.status).toBe(400);
    expect(guard.calls()).toBe(0);
    const cookies = res.headers.getSetCookie();
    expect(
      cookies.some((c) => c.startsWith(`${MANIFEST_STATE_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=`))).toBe(false);
  });

  test("callback with a forged state signature → 400, zero fetch", async () => {
    const guard = stubFetchMustNotBeCalled();
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const forged = await signValue("forged-state", "wrong-secret");
    const res = await worker.fetch(
      callbackRequest(session, forged, `code=x&state=${forged}`),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(guard.calls()).toBe(0);
  });

  test("callback with valid state but no code → 400, zero fetch, structured missing_code log", async () => {
    const guard = stubFetchMustNotBeCalled();
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const state = await createStateValue(SESSION_SECRET);
    const warns = spyOnWarn();
    const res = await worker.fetch(callbackRequest(session, state, `state=${state}`), makeEnv());
    expect(res.status).toBe(400);
    expect(guard.calls()).toBe(0);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.event).toBe("dashboard_manifest");
    expect(entry.stage).toBe("callback");
    expect(entry.reason).toBe("missing_code");
  });

  test("callback success → conversion exchanged, hold cookie set, HTML carries no secrets", async () => {
    const { session, state } = await startManifest();
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = { ...((init?.headers ?? {}) as Record<string, string>) };
      return new Response(JSON.stringify(CONVERSION), { status: 201 });
    }) as typeof fetch;
    const res = await worker.fetch(
      callbackRequest(session, state, `code=manifest-code&state=${state}`),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    // Conversion per Global Constraints (spec L9).
    expect(seenUrl).toBe("https://api.github.com/app-manifests/manifest-code/conversions");
    expect(seenHeaders.Accept).toBe("application/vnd.github+json");
    expect(seenHeaders["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(seenHeaders.Authorization).toBeUndefined();
    const cookies = res.headers.getSetCookie();
    // State cookie single-use: expired on the callback.
    expect(
      cookies.some((c) => c.startsWith(`${MANIFEST_STATE_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
    // Hold cookie: __Host- attribute set, Max-Age 600, value < 4096B.
    const holdCookie = cookies.find((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=`)) ?? "";
    expect(holdCookie).toContain("HttpOnly");
    expect(holdCookie).toContain("Secure");
    expect(holdCookie).toContain("SameSite=Lax");
    expect(holdCookie).toContain("Path=/");
    expect(holdCookie).toContain("Max-Age=600");
    expect(holdCookie).not.toContain("Domain");
    const holdValue = (holdCookie.split(";")[0] ?? "").slice(MANIFEST_HOLD_COOKIE.length + 1);
    expect(holdValue.length).toBeGreaterThan(0);
    expect(holdValue.length).toBeLessThan(4096);
    // Hold round-trips to the converted credentials for the T2 commit gate.
    const payload = await readHoldValue(holdValue, SESSION_SECRET);
    expect(payload?.id).toBe(CONVERSION.id);
    expect(payload?.name).toBe(CONVERSION.name);
    expect(payload?.login).toBe("octocat");
    expect(payload?.pem).toBe(CONVERSION.pem);
    expect(payload?.webhook_secret).toBe(CONVERSION.webhook_secret);
    // AC-S11-html: the confirm HTML never carries PEM or webhook_secret.
    const body = await res.text();
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_PEM);
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
    expect(body).toContain(`<span class="id">${CONVERSION.id}</span>`);
    // Locked confirm copy (spec § 确认页文案) — wired commit lands in T2.
    expect(body).toContain(
      "This will overwrite the existing APP_ID, PRIVATE_KEY, and WEBHOOK_SECRET secrets on this Worker.",
    );
    expect(body).toContain('name="confirm" value="overwrite"');
  });

  test("conversion failure → 502, no hold cookie, HTML carries no secrets", async () => {
    const { session, state } = await startManifest();
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await worker.fetch(
      callbackRequest(session, state, `code=x&state=${state}`),
      makeEnv(),
    );
    expect(res.status).toBe(502);
    for (const cookie of res.headers.getSetCookie()) {
      expect(cookie.startsWith(`${MANIFEST_HOLD_COOKIE}=`)).toBe(false);
    }
    const body = await res.text();
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
  });
});

describe("existing routes unaffected", () => {
  test("GET /healthz still returns 200 ok", async () => {
    const res = await worker.fetch(new Request("https://worker.local/healthz"), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("POST /webhook with a bad signature still returns 401 (dashboard mount does not intercept it)", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": "sha256=deadbeef", "x-github-event": "pull_request" },
        body: "{}",
      }),
      // REVIEW_ENABLED "true" so the kill-switch ignore path does not mask
      // signature verification (classifyWebhook checks the switch first).
      makeEnv({ REVIEW_ENABLED: "true" }),
    );
    expect(res.status).toBe(401);
  });
});

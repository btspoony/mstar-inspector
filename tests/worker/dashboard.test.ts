/**
 * Plan 08 Task 2 tests: signed session cookie + OAuth state CSRF, through
 * the real worker mount (app.route("/dashboard", dashboardApp)). Plan 11
 * Task 1 adds the GitHub App Manifest start/callback coverage (state CSRF,
 * locked conversion headers, encrypted hold cookie, no-secret HTML); Task 2
 * adds the commit coverage (confirm gate, session-bound retry-aware hold, ONE secrets-bulk
 * PATCH, fail-closed Cloudflare config, no-secret success HTML).
 *
 * The end-to-end callback network path is exercised only in live smoke
 * (user-gated); here callback coverage stops at the fail-closed state/code
 * checks, and the GitHub helpers (code exchange, user fetch, manifest
 * conversion) are unit-tested with stubbed fetch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../../src/worker/index";
import { exchangeCodeForToken, fetchGitHubUser } from "../../src/dashboard/oauth";
import type { Env } from "../../src/worker/env";
import {
  bootstrapDashboardAccess,
  countAdmins,
  countUsers,
  createUser,
  deleteUser,
  getUserByLogin,
  listUsers,
  parseAdminLogins,
  type DashboardD1,
  type DashboardD1Statement,
} from "../../src/dashboard/users";
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
  DEFAULT_CLOUDFLARE_WORKER_NAME,
  MANIFEST_HOLD_COOKIE,
  MANIFEST_HOLD_MAX_AGE_SEC,
  MANIFEST_STATE_COOKIE,
  buildAppName,
  createHoldValue,
  exchangeManifestCode,
  readHoldValue,
} from "../../src/dashboard/manifest";
import { normalizePrivateKey } from "../../src/dashboard/private-key";
import { normalizePrivateKey as pipelineNormalizePrivateKey } from "../../src/pipeline/comment";

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

function baseEnv(overrides: Partial<Env> = {}): Env {
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

/**
 * Plan 12 T2: every /dashboard route sits behind the per-request membership
 * guard, so each session-bearing request resolves a users row through D1.
 * The default env therefore ships a store seeded with exactly the logins the
 * existing route tests sign in as (the "existing tests pass unchanged with a
 * seeded member" AC). Tests that need different membership pass their own DB
 * via makeDbEnv; baseEnv is the DB-less env for unbound-D1 premises.
 */
const DEFAULT_SEEDED_MEMBERS: Array<[login: string, role: "admin" | "member"]> = [
  ["octocat", "admin"],
  ["octocat-with-a-long-login", "member"],
  ["mallory", "member"],
];

function seededDashboardD1(): DashboardD1 & { raw: Database } {
  const db = createDashboardTestD1();
  const insert = db.raw.prepare(
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, ?, ?, NULL)",
  );
  for (const [login, role] of DEFAULT_SEEDED_MEMBERS) {
    insert.run(crypto.randomUUID(), login, role, new Date().toISOString());
  }
  return db;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { ...baseEnv(overrides), DB: seededDashboardD1() } as Env;
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

  test("GET /dashboard/logout → 302 to login; session, manifest hold, and manifest state cookies expired", async () => {
    // Plan 12 T2: /logout is guarded (spec L5 — not exempt), so a real logout
    // arrives with a member session (the shell header link); without one the
    // guard 302s before the cookie-expiry route (asserted in the guard suite).
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      dashboardRequest("/dashboard/logout", `${SESSION_COOKIE}=${session}`),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(3);
    // Parked manifest credentials must die with the session (qc2 F-001).
    for (const name of [SESSION_COOKIE, MANIFEST_HOLD_COOKIE, MANIFEST_STATE_COOKIE]) {
      const cookie = setCookie.find((c) => c.startsWith(`${name}=;`));
      expect(cookie, name).toBeDefined();
      expect(cookie).toContain("Max-Age=0");
    }
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
  async function startManifest(login = "octocat") {
    const session = await createSessionValue(login, null, SESSION_SECRET);
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
  test("long login: manifest name is capped at 34 chars and the start page shows the truncated name", async () => {
    const { body, manifest } = await startManifest("octocat-with-a-long-login");
    const name = manifest.name as string;
    expect(name.length).toBeLessThanOrEqual(34);
    expect(name.startsWith("mstar-inspector-")).toBe(true);
    // The start copy names the App GitHub will actually register — never the
    // untruncated name that GitHub would reject.
    expect(body).toContain(`<strong>${name}</strong>`);
    expect(body).not.toContain("mstar-inspector-octocat-with-a-long-login");
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

describe("buildAppName (manifest.ts, GitHub 34-char App-name cap)", () => {
  test("short login keeps the full name unchanged", () => {
    expect(buildAppName("octocat")).toBe("mstar-inspector-octocat");
  });

  test("18+ char login is truncated to ≤34 chars, prefix kept", () => {
    const name = buildAppName("octocat-with-a-long-login");
    expect(name.length).toBeLessThanOrEqual(34);
    expect(name.startsWith("mstar-inspector-")).toBe(true);
  });
});

describe("/dashboard confirm resume (Bugbot: confirm step must be resumable)", () => {
  const freshHold = () => createHoldValue(CONVERSION, "octocat", SESSION_SECRET);

  function resumeRequest(path: string, session: string, hold?: string): Request {
    const cookies = hold ? `${SESSION_COOKIE}=${session}; ${MANIFEST_HOLD_COOKIE}=${hold}` : `${SESSION_COOKIE}=${session}`;
    return dashboardRequest(path, cookies);
  }

  test("GET /dashboard with a valid hold renders the confirm gate, never PEM/webhook_secret", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(resumeRequest("/dashboard", session, await freshHold()), makeEnv());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('name="confirm" value="overwrite"');
    expect(body).toContain(`<span class="id">${CONVERSION.id}</span>`);
    expect(body).toContain(CONVERSION.name);
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_PEM);
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
    // A hold-bearing operator never lands on the dead shell start form.
    expect(body).not.toContain('action="/dashboard/manifest/start"');
  });

  test("after a retryable 400, GET /dashboard still shows the confirm gate (error page links to it)", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const hold = await freshHold();
    const rejected = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/commit", {
        method: "POST",
        headers: {
          Cookie: `${SESSION_COOKIE}=${session}; ${MANIFEST_HOLD_COOKIE}=${hold}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "", // confirm checkbox not ticked → retryable 400, hold kept
      }),
      makeEnv(),
    );
    expect(rejected.status).toBe(400);
    // The retryable error page links back to the confirm surface.
    expect(await rejected.text()).toContain('href="/dashboard/manifest/confirm"');
    // Resume via the shell URL: the confirm gate comes back with the same hold.
    const resumed = await worker.fetch(resumeRequest("/dashboard", session, hold), makeEnv());
    expect(resumed.status).toBe(200);
    const body = await resumed.text();
    expect(body).toContain('name="confirm" value="overwrite"');
    expect(body).toContain(`<span class="id">${CONVERSION.id}</span>`);
  });

  test("hold bound to a different login → dashboard shell, no confirm, no secrets", async () => {
    const session = await createSessionValue("mallory", null, SESSION_SECRET);
    const res = await worker.fetch(resumeRequest("/dashboard", session, await freshHold()), makeEnv());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('action="/dashboard/manifest/start"');
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
  });

  test("GET /dashboard/manifest/confirm: valid hold → 200 confirm; no hold → 302 to the shell", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const ok = await worker.fetch(
      resumeRequest("/dashboard/manifest/confirm", session, await freshHold()),
      makeEnv(),
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('name="confirm" value="overwrite"');
    const noHold = await worker.fetch(
      resumeRequest("/dashboard/manifest/confirm", session),
      makeEnv(),
    );
    expect(noHold.status).toBe(302);
    expect(noHold.headers.get("Location")).toBe("/dashboard");
  });
});

describe("dashboard private-key normalization (private-key.ts)", () => {
  test("L8 default worker name is pinned to the wrangler.jsonc name", () => {
    expect(DEFAULT_CLOUDFLARE_WORKER_NAME).toBe("mstar-inspector");
  });

  test("PKCS#1 wraps to PKCS#8, byte-identical to the pipeline implementation", () => {
    const wrapped = normalizePrivateKey(FAKE_PEM);
    // The dashboard copy must never drift from the pipeline one (Q2 route
    // isolation forbids the import, so the test pins the equivalence).
    expect(wrapped).toBe(pipelineNormalizePrivateKey(FAKE_PEM));
    expect(wrapped.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
    expect(wrapped).not.toContain("RSA PRIVATE KEY");
  });

  test("PKCS#8 passes through unchanged; OpenSSH is a hard error", () => {
    const pkcs8 = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
    expect(normalizePrivateKey(pkcs8)).toBe(pkcs8);
    expect(() =>
      normalizePrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----"),
    ).toThrow();
  });

  test(".env.example documents the Cloudflare commit env vars and the default worker name", async () => {
    const example = await Bun.file(new URL("../../.env.example", import.meta.url)).text();
    expect(example).toContain("CLOUDFLARE_API_TOKEN");
    expect(example).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(example).toContain(DEFAULT_CLOUDFLARE_WORKER_NAME);
  });
});

describe("/dashboard manifest commit (plan 11 Task 2)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const CF_TOKEN = "cf-api-token";
  const CF_ACCOUNT = "cf-account-id";

  function commitEnv(overrides: Partial<Env> = {}): Env {
    return makeEnv({
      CLOUDFLARE_API_TOKEN: CF_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT,
      ...overrides,
    });
  }

  /** Records every fetch call and serves a canned Cloudflare response. */
  function stubCloudflareFetch(status = 200) {
    const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ success: status < 400, errors: [], messages: [] }), {
        status,
      });
    }) as unknown as typeof fetch;
    return calls;
  }

  const freshHold = () => createHoldValue(CONVERSION, "octocat", SESSION_SECRET);

  /** POST /dashboard/manifest/commit; holdValue=null omits the hold cookie. */
  async function doCommit(args: {
    env?: Env;
    withSession?: boolean;
    sessionLogin?: string;
    holdValue?: string | null;
    body?: string;
  }): Promise<Response> {
    const cookies: string[] = [];
    if (args.withSession ?? true) {
      cookies.push(
        `${SESSION_COOKIE}=${await createSessionValue(args.sessionLogin ?? "octocat", null, SESSION_SECRET)}`,
      );
    }
    if (args.holdValue) cookies.push(`${MANIFEST_HOLD_COOKIE}=${args.holdValue}`);
    return worker.fetch(
      new Request("https://worker.local/dashboard/manifest/commit", {
        method: "POST",
        headers: {
          Cookie: cookies.join("; "),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: args.body ?? "confirm=overwrite",
      }),
      args.env ?? commitEnv(),
    );
  }

  function expectHoldExpired(res: Response): void {
    const cookies = res.headers.getSetCookie();
    expect(
      cookies.some((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
  }

  /** Retryable outcomes (400/500/502) must NOT burn the hold (qc3 F-01). */
  function expectHoldKept(res: Response): void {
    const cookies = res.headers.getSetCookie();
    expect(
      cookies.some((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(false);
  }

  test("without confirm=overwrite → 400, zero Cloudflare requests, hold KEPT for retry", async () => {
    const calls = stubCloudflareFetch();
    const warns = spyOnWarn();
    for (const body of ["", "confirm=yes"]) {
      const res = await doCommit({ holdValue: await freshHold(), body });
      expect(res.status).toBe(400);
      expectHoldKept(res);
    }
    expect(calls).toHaveLength(0);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.event).toBe("dashboard_manifest");
    expect(entry.stage).toBe("commit");
    expect(entry.reason).toBe("confirm_missing");
  });

  test("a hold kept by a retryable 400 still commits on retry", async () => {
    const calls = stubCloudflareFetch(200);
    const hold = await freshHold();
    const rejected = await doCommit({ holdValue: hold, body: "" });
    expect(rejected.status).toBe(400);
    expectHoldKept(rejected);
    expect(calls).toHaveLength(0);
    // Same hold, checkbox ticked this time → the write goes through.
    const retried = await doCommit({ holdValue: hold });
    expect(retried.status).toBe(200);
    expect(calls).toHaveLength(1);
    expectHoldExpired(retried); // burned on success
  });

  test("logged out → 302 to login, zero writes, hold kept (operator can sign back in)", async () => {
    const calls = stubCloudflareFetch();
    const res = await doCommit({ withSession: false, holdValue: await freshHold() });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    expect(calls).toHaveLength(0);
    expectHoldKept(res);
  });

  test("missing hold cookie → 302 back to the flow start, zero writes, hold cleared", async () => {
    const calls = stubCloudflareFetch();
    const res = await doCommit({ holdValue: null });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(calls).toHaveLength(0);
    expectHoldExpired(res);
  });

  test("tampered or expired hold cookie → 302 back to the flow start, zero writes", async () => {
    const calls = stubCloudflareFetch();
    const hold = await freshHold();
    const tampered = `${hold.slice(0, 20)}${hold[20] === "A" ? "B" : "A"}${hold.slice(21)}`;
    const expired = await createHoldValue(
      CONVERSION,
      "octocat",
      SESSION_SECRET,
      Date.now() - (MANIFEST_HOLD_MAX_AGE_SEC + 100) * 1000,
    );
    for (const holdValue of [tampered, expired]) {
      const res = await doCommit({ holdValue });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/dashboard");
      expectHoldExpired(res); // bad hold is burned, not retried
    }
    expect(calls).toHaveLength(0);
  });

  test("hold.login ≠ session.login → 403, zero writes, hold burned", async () => {
    const calls = stubCloudflareFetch();
    const warns = spyOnWarn();
    // Hold minted for "octocat" presented by a different logged-in operator.
    const res = await doCommit({ holdValue: await freshHold(), sessionLogin: "mallory" });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
    expectHoldExpired(res);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.event).toBe("dashboard_manifest");
    expect(entry.stage).toBe("commit");
    expect(entry.reason).toBe("login_mismatch");
    const html = await res.text();
    expect(html).not.toContain("BEGIN");
    expect(html).not.toContain(FAKE_WEBHOOK_SECRET);
  });

  test("missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID → 5xx, zero writes, hold KEPT", async () => {
    const calls = stubCloudflareFetch();
    const noToken = await doCommit({
      holdValue: await freshHold(),
      env: makeEnv({ CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT }),
    });
    expect(noToken.status).toBe(500);
    expectHoldKept(noToken);
    const noAccount = await doCommit({
      holdValue: await freshHold(),
      env: makeEnv({ CLOUDFLARE_API_TOKEN: CF_TOKEN }),
    });
    expect(noAccount.status).toBe(500);
    expectHoldKept(noAccount);
    expect(calls).toHaveLength(0);
    const body = await noToken.text();
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
  });

  test("a hold kept by a retryable 500 still commits once the env is fixed", async () => {
    const calls = stubCloudflareFetch(200);
    const hold = await freshHold();
    const misconfigured = await doCommit({
      holdValue: hold,
      env: makeEnv({ CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT }),
    });
    expect(misconfigured.status).toBe(500);
    expectHoldKept(misconfigured);
    expect(calls).toHaveLength(0);
    // Same hold against a configured Worker → the write goes through.
    const retried = await doCommit({ holdValue: hold });
    expect(retried.status).toBe(200);
    expect(calls).toHaveLength(1);
    expectHoldExpired(retried);
  });

  test("confirm → exactly one secrets-bulk PATCH writing exactly the three secrets, PKCS#8 PEM", async () => {
    const calls = stubCloudflareFetch(200);
    const res = await doCommit({ holdValue: await freshHold() });
    expect(res.status).toBe(200);
    // AC-S11-secrets / L6: ONE PATCH to the locked bulk endpoint (L8 base+auth).
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("PATCH");
    expect(call.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/workers/scripts/${DEFAULT_CLOUDFLARE_WORKER_NAME}/secrets-bulk`,
    );
    expect(call.headers.Authorization).toBe(`Bearer ${CF_TOKEN}`);
    const payload = JSON.parse(call.body) as {
      secrets: Record<string, { name: string; text: string; type: string }>;
    };
    // Exactly the three names — never REVIEW_ENABLED or model keys.
    expect(Object.keys(payload.secrets).sort()).toEqual(["APP_ID", "PRIVATE_KEY", "WEBHOOK_SECRET"]);
    expect(call.body).not.toContain("REVIEW_ENABLED");
    expect(payload.secrets.APP_ID).toEqual({
      name: "APP_ID",
      text: String(CONVERSION.id),
      type: "secret_text",
    });
    expect(payload.secrets.WEBHOOK_SECRET).toEqual({
      name: "WEBHOOK_SECRET",
      text: FAKE_WEBHOOK_SECRET,
      type: "secret_text",
    });
    // PEM normalized: PKCS#1 → PKCS#8 wrap per normalizePrivateKey.
    expect(payload.secrets.PRIVATE_KEY).toEqual({
      name: "PRIVATE_KEY",
      text: normalizePrivateKey(FAKE_PEM),
      type: "secret_text",
    });
    expect(payload.secrets.PRIVATE_KEY?.text.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
    // Hold cookie is single-use: expired on success too.
    expectHoldExpired(res);
    // Locked success copy; AC-S11-html: no PEM / webhook_secret in the HTML.
    const html = await res.text();
    expect(html).toContain(`GitHub App <span class="id">${CONVERSION.id}</span> credentials stored.`);
    expect(html).toContain("Credentials take effect as the new Worker version rolls out — deployed automatically, no manual redeploy step.");
    expect(html).not.toContain("BEGIN");
    expect(html).not.toContain(FAKE_PEM);
    expect(html).not.toContain(FAKE_WEBHOOK_SECRET);
  });

  test("CLOUDFLARE_WORKER_NAME override changes the script path", async () => {
    const calls = stubCloudflareFetch(200);
    const res = await doCommit({
      holdValue: await freshHold(),
      env: commitEnv({ CLOUDFLARE_WORKER_NAME: "custom-worker" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/workers/scripts/custom-worker/secrets-bulk`,
    );
  });

  test("Cloudflare 403 (token misconfiguration) → 502 error page, one request, no secrets in HTML", async () => {
    const calls = stubCloudflareFetch(403);
    const warns = spyOnWarn();
    const res = await doCommit({ holdValue: await freshHold() });
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(1);
    expectHoldKept(res); // CF/network failure must not burn the hold (qc3 F-01)
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.stage).toBe("secret_write");
    expect(entry.reason).toBe("http_error");
    expect(entry.cf_status).toBe(403);
    const html = await res.text();
    expect(html).not.toContain("BEGIN");
    expect(html).not.toContain(FAKE_WEBHOOK_SECRET);
  });
});

describe("/dashboard placeholder lock + DESIGN alignment (plan 11 Task 3)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("GitHub App section is enabled: primary submit, not aria-disabled (AC-S11-design)", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      dashboardRequest("/dashboard", `${SESSION_COOKIE}=${session}`),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Spec § DESIGN.md 意图: the enabled GitHub App section is NOT
    // aria-disabled and its constructive primary (blue-700) is a live submit.
    const appSection = body.split('<section class="enabled">')[1]?.split("</section>")[0] ?? "";
    expect(appSection).toContain('action="/dashboard/manifest/start"');
    expect(appSection).toContain('<button type="submit" class="primary">Create GitHub App</button>');
    expect(appSection).not.toContain("aria-disabled");
    expect(appSection).not.toContain("disabled");
  });

  test("BYOK / Review placeholder POSTs → 405, zero fetch, zero env writes, no stale B0 copy", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return new Response("{}");
    }) as unknown as typeof fetch;
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const env = makeEnv({ REVIEW_ENABLED: "false" });
    for (const path of ["/dashboard/model-keys", "/dashboard/review"]) {
      const res = await worker.fetch(
        new Request(`https://worker.local${path}`, {
          method: "POST",
          headers: { Cookie: `${SESSION_COOKIE}=${session}` },
        }),
        env,
      );
      // AC-S11-placeholders: still 405 (B0 behavior kept); the stale "in B0"
      // wording is gone (plan 11 T1 review minor).
      expect(res.status).toBe(405);
      expect(await res.text()).not.toContain("B0");
    }
    // Zero outbound requests — no CF secret write, no GitHub call — and the
    // Worker env is untouched: REVIEW_ENABLED never flips on this path.
    expect(calls).toHaveLength(0);
    expect(env.REVIEW_ENABLED).toBe("false");
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

// --- plan 12 T1: D1 fixture + dashboard membership --------------------------
// Local mirror of tests/store/helpers.ts createTestD1 (which pins 0001+0002
// only and sits outside this plan's file set): the users migration must
// apply on a DB that ALREADY has 0001/0002 rows, so the fixture seeds a
// review row between 0002 and 0003 (plan 12 T1 AC).

function applyMigrationFile(db: Database, name: string): void {
  db.exec(readFileSync(join(import.meta.dir, "../../migrations", name), "utf8"));
}

function createDashboardTestD1(): DashboardD1 & { raw: Database } {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  applyMigrationFile(db, "0001_reviews.sql");
  applyMigrationFile(db, "0002_mstar_review_v1.sql");
  db.exec(
    `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md)
     VALUES ('review-1', 123, 'acme', 'widgets', 42, '0123456789abcdef0123456789abcdef01234567', 'comment', 'No blocking issues.')`,
  );
  applyMigrationFile(db, "0003_dashboard_users.sql");
  return {
    raw: db,
    prepare(query: string): DashboardD1Statement {
      let bound: unknown[] = [];
      const stmt = db.prepare(query);
      return {
        bind(...values: unknown[]) {
          bound = values;
          return this;
        },
        async first<T = Record<string, unknown>>(): Promise<T | null> {
          return (stmt.get(...(bound as [])) as T | undefined) ?? null;
        },
        async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
          return { results: stmt.all(...(bound as [])) as T[] };
        },
        async run<T = Record<string, unknown>>(): Promise<{
          results: T[];
          meta: { changes: number; last_row_id: number };
        }> {
          const info = stmt.run(...(bound as []));
          return {
            results: [] as T[],
            meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
          };
        },
      };
    },
  };
}

function userCount(db: DashboardD1 & { raw: Database }): number {
  return (db.raw.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

/**
 * The D1 binding is runtime-real (wrangler.jsonc `d1_databases` binding DB)
 * but the fetch-face Env deliberately does not declare it (plan 12 keeps
 * src/worker/env.ts changes to ADMIN_LOGINS only) — the callback reads it
 * through a local intersection type, and the test env carries it the same
 * way.
 */
function makeDbEnv(db: DashboardD1, overrides: Partial<Env> = {}): Env {
  return { ...baseEnv(overrides), DB: db } as Env;
}

describe("migrations/0003_dashboard_users.sql (plan 12 T1)", () => {
  test("creates the users table per spec § Data model — no status column (removal = delete row)", () => {
    const db = createDashboardTestD1();
    const cols = db.raw.query("PRAGMA table_info(users)").all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    const byName: Record<string, { notnull: number; pk: number }> = Object.fromEntries(
      cols.map((c) => [c.name, { notnull: c.notnull, pk: c.pk }]),
    );
    expect(Object.keys(byName).sort()).toEqual(["created_at", "github_login", "id", "invited_by", "role"]);
    expect(byName["id"]?.pk).toBe(1); // TEXT PRIMARY KEY (caller-supplied UUID)
    expect(byName["github_login"]?.notnull).toBe(1);
    expect(byName["role"]?.notnull).toBe(1);
    expect(byName["created_at"]?.notnull).toBe(1);
    expect("status" in byName).toBe(false);
  });

  test("applies on a DB that already has 0001/0002 rows — the seeded review row survives", () => {
    const db = createDashboardTestD1();
    const review = db.raw.query("SELECT id, owner, repo FROM reviews").get() as {
      id: string;
      owner: string;
      repo: string;
    };
    expect(review).toEqual({ id: "review-1", owner: "acme", repo: "widgets" });
  });

  test("UNIQUE github_login rejects a second row for the same login", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    await expect(
      db
        .prepare("INSERT INTO users (id, github_login, role, created_at) VALUES (?, ?, ?, ?)")
        .bind("users-2", "octocat", "member", "2026-01-01T00:00:00.000Z")
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  test("CHECK pins role to admin|member", async () => {
    const db = createDashboardTestD1();
    await expect(
      db
        .prepare("INSERT INTO users (id, github_login, role, created_at) VALUES (?, ?, ?, ?)")
        .bind("users-3", "mallory", "owner", "2026-01-01T00:00:00.000Z")
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe("dashboard users store (plan 12 T1, users.ts)", () => {
  test("createUser + getUserByLogin round trip (bootstrapped admin shape)", async () => {
    const db = createDashboardTestD1();
    const created = await createUser(db, { login: "octocat", role: "admin" });
    expect(created.github_login).toBe("octocat");
    expect(created.role).toBe("admin");
    expect(created.invited_by).toBeNull(); // bootstrapped, not invited
    expect(created.id).toBeTruthy();
    expect(created.created_at).toBeTruthy();
    expect(await getUserByLogin(db, "octocat")).toEqual(created);
  });

  test("createUser records invitedBy for invited members", async () => {
    const db = createDashboardTestD1();
    const row = await createUser(db, { login: "hubot", role: "member", invitedBy: "octocat" });
    expect(row.role).toBe("member");
    expect(row.invited_by).toBe("octocat");
  });

  test("getUserByLogin is case-insensitive; a missing login returns null", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "member" });
    expect((await getUserByLogin(db, "OCTOCAT"))?.github_login).toBe("octocat");
    expect(await getUserByLogin(db, "nobody")).toBeNull();
  });

  test("createUser is idempotent on an exact-case UNIQUE race (first row wins)", async () => {
    const db = createDashboardTestD1();
    const first = await createUser(db, { login: "octocat", role: "admin" });
    const raced = await createUser(db, { login: "octocat", role: "member", invitedBy: "someone" });
    expect(raced.id).toBe(first.id);
    expect(userCount(db)).toBe(1);
  });

  test("listUsers / deleteUser / countUsers / countAdmins", async () => {
    const db = createDashboardTestD1();
    const admin = await createUser(db, { login: "octocat", role: "admin" });
    const member = await createUser(db, { login: "hubot", role: "member" });
    expect(await countUsers(db)).toBe(2);
    expect(await countAdmins(db)).toBe(1);
    const logins = (await listUsers(db)).map((u) => u.github_login).sort();
    expect(logins).toEqual(["hubot", "octocat"]);
    expect(await deleteUser(db, member.id)).toBe(true);
    expect(await deleteUser(db, member.id)).toBe(false); // already gone
    expect(await deleteUser(db, "missing-id")).toBe(false);
    expect(await countUsers(db)).toBe(1);
    expect((await getUserByLogin(db, admin.github_login))?.id).toBe(admin.id);
  });

  test("parseAdminLogins trims entries, drops empties, treats unset/blank as not configured", () => {
    expect(parseAdminLogins(undefined)).toEqual([]);
    expect(parseAdminLogins("")).toEqual([]);
    expect(parseAdminLogins("   ")).toEqual([]);
    expect(parseAdminLogins(" octocat , Hubot ,, ada ")).toEqual(["octocat", "Hubot", "ada"]);
  });
});

describe("bootstrapDashboardAccess precedence matrix (plan 12 T1, spec § AuthZ)", () => {
  test("1. row exists → allow, zero writes, no promotion (ADMIN_LOGINS does not outrank the row)", async () => {
    const db = createDashboardTestD1();
    const existing = await createUser(db, { login: "octocat", role: "member" });
    const decision = await bootstrapDashboardAccess(db, "octocat", "octocat");
    expect(decision).toEqual({ outcome: "allow", user: existing, created: false });
    expect(userCount(db)).toBe(1);
  });

  test("1b. row lookup is case-insensitive", async () => {
    const db = createDashboardTestD1();
    const existing = await createUser(db, { login: "octocat", role: "member" });
    const decision = await bootstrapDashboardAccess(db, "OCTOCAT", undefined);
    expect(decision).toEqual({ outcome: "allow", user: existing, created: false });
  });

  test("2. ADMIN_LOGINS hit (no row) → creates an invited_by=NULL admin", async () => {
    const db = createDashboardTestD1();
    const decision = await bootstrapDashboardAccess(db, "octocat", "  Ada , octocat ");
    expect(decision.outcome).toBe("allow");
    if (decision.outcome === "allow") {
      expect(decision.created).toBe(true);
      expect(decision.user.role).toBe("admin");
      expect(decision.user.invited_by).toBeNull();
    }
    expect(userCount(db)).toBe(1);
  });

  test("2b. ADMIN_LOGINS comparison is case-insensitive (GitHub logins are)", async () => {
    const db = createDashboardTestD1();
    const decision = await bootstrapDashboardAccess(db, "OCTOCAT", "octocat");
    expect(decision.outcome).toBe("allow");
  });

  test("3. empty table && ADMIN_LOGINS unset → first login bootstraps as admin", async () => {
    const db = createDashboardTestD1();
    const decision = await bootstrapDashboardAccess(db, "deployer", undefined);
    expect(decision.outcome).toBe("allow");
    if (decision.outcome === "allow") expect(decision.user.role).toBe("admin");
    // Whitespace-only counts as unset for the fallback.
    const blank = createDashboardTestD1();
    expect((await bootstrapDashboardAccess(blank, "deployer", "   ")).outcome).toBe("allow");
  });

  test("4. deny: populated table, unknown login → deny with ZERO writes", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    expect(await bootstrapDashboardAccess(db, "mallory", undefined)).toEqual({ outcome: "deny" });
    expect(userCount(db)).toBe(1); // no user row created
  });

  test("4b. deny: empty table but ADMIN_LOGINS configured without the login", async () => {
    const db = createDashboardTestD1();
    expect(await bootstrapDashboardAccess(db, "mallory", "octocat")).toEqual({ outcome: "deny" });
    expect(userCount(db)).toBe(0);
  });
});

describe("/dashboard/oauth/callback bootstrap + deny (plan 12 T1)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  /** Successful identity: token exchange then /user for the given login. */
  function stubGitHubIdentity(login: string): void {
    globalThis.fetch = (async (url: unknown) => {
      const target = String(url);
      if (target === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "gho_test-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (target === "https://api.github.com/user") {
        return new Response(JSON.stringify({ login, name: null }), { status: 200 });
      }
      throw new Error(`unexpected fetch target: ${target}`);
    }) as unknown as typeof fetch;
  }

  async function oauthCallback(login: string, env: Env): Promise<Response> {
    const state = await createStateValue(SESSION_SECRET);
    return worker.fetch(
      dashboardRequest(
        `/dashboard/oauth/callback?code=x&state=${state}`,
        `${OAUTH_STATE_COOKIE}=${state}`,
      ),
      env,
    );
  }

  test("unknown login, populated table, ADMIN_LOGINS unset → 403 invite-only page, ZERO Set-Cookie, zero user writes", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    stubGitHubIdentity("mallory");
    const res = await oauthCallback("mallory", makeDbEnv(db));
    expect(res.status).toBe(403);
    const body = await res.text();
    // Locked deny copy (spec § User-visible behavior 1).
    expect(body).toContain("This deployment is invite-only. Ask an admin to add mallory.");
    // Zero cookies — not even the single-use state expiry (spec: 零 cookie、零写入).
    expect(res.headers.getSetCookie()).toHaveLength(0);
    // Zero D1 writes on deny.
    expect(userCount(db)).toBe(1);
  });

  test("ADMIN_LOGINS hit → 302 /dashboard, session cookie minted, admin row created", async () => {
    const db = createDashboardTestD1();
    stubGitHubIdentity("octocat");
    const res = await oauthCallback("octocat", makeDbEnv(db, { ADMIN_LOGINS: "octocat" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    expect((await getUserByLogin(db, "octocat"))?.role).toBe("admin");
  });

  test("empty-table fallback (ADMIN_LOGINS unset) → first login becomes admin", async () => {
    const db = createDashboardTestD1();
    stubGitHubIdentity("deployer");
    const res = await oauthCallback("deployer", makeDbEnv(db));
    expect(res.status).toBe(302);
    expect((await getUserByLogin(db, "deployer"))?.role).toBe("admin");
  });

  test("existing member row → 302 with no second row (row-hit precedence)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "member" });
    stubGitHubIdentity("octocat");
    const res = await oauthCallback("octocat", makeDbEnv(db));
    expect(res.status).toBe(302);
    expect(userCount(db)).toBe(1);
  });

  test("session payload unchanged on allow (login/iat/exp — no new claims)", async () => {
    const db = createDashboardTestD1();
    stubGitHubIdentity("octocat");
    const res = await oauthCallback("octocat", makeDbEnv(db, { ADMIN_LOGINS: "octocat" }));
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    const value = cookie.split(";")[0]?.slice(SESSION_COOKIE.length + 1) ?? "";
    const payload = await readSessionValue(value, SESSION_SECRET);
    expect(payload?.login).toBe("octocat");
    expect(Object.keys(payload ?? {}).sort()).toEqual(["exp", "iat", "login"]);
  });

  test("missing D1 binding on the post-identity path → 500 fail-closed, no session cookie", async () => {
    stubGitHubIdentity("octocat");
    // baseEnv (no D1): makeEnv ships the default seeded store for the guarded
    // routes — the callback's unbound-D1 premise needs the bare env.
    const res = await oauthCallback("octocat", baseEnv({ ADMIN_LOGINS: "octocat" }));
    expect(res.status).toBe(500);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
  });

  test(".env.example documents ADMIN_LOGINS (a var, not a secret)", async () => {
    const example = await Bun.file(new URL("../../.env.example", import.meta.url)).text();
    expect(example).toContain("ADMIN_LOGINS");
    expect(example).toContain("not a secret");
  });
});

describe("per-request allowlist guard (plan 12 T2, spec § AuthZ + lock L5)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  /**
   * Removed-member fixture: a seeded store where mallory's row was deleted
   * through the real revocation path (deleteUser — removal = row delete, no
   * status column). Mallory still holds a cryptographically valid session
   * cookie: the stateless session cannot see the removal, the guard must.
   */
  async function removedMemberEnv(): Promise<Env> {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const mallory = await createUser(db, { login: "mallory", role: "member" });
    await deleteUser(db, mallory.id);
    return makeDbEnv(db);
  }

  const mallorySession = () => createSessionValue("mallory", null, SESSION_SECRET);

  test("removed member with a valid cookie → 403 on every route family (shell, manifest start/confirm/commit, catch-all)", async () => {
    // Zero network behind the guard: the 403 must short-circuit BEFORE the
    // manifest conversion / Cloudflare secrets paths.
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls++;
      throw new Error("no network may run behind the guard");
    }) as unknown as typeof fetch;
    const env = await removedMemberEnv();
    const cookie = `${SESSION_COOKIE}=${await mallorySession()}`;
    // GET shell (B0)
    const shell = await worker.fetch(dashboardRequest("/dashboard", cookie), env);
    expect(shell.status).toBe(403);
    // POST manifest start (B1)
    const start = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/start", {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      env,
    );
    expect(start.status).toBe(403);
    // GET manifest confirm (B1 resume gate)
    const confirm = await worker.fetch(dashboardRequest("/dashboard/manifest/confirm", cookie), env);
    expect(confirm.status).toBe(403);
    // POST manifest commit (B1 confirm gate) — guard fires before secret work
    const commit = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/commit", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: "confirm=overwrite",
      }),
      env,
    );
    expect(commit.status).toBe(403);
    // POST catch-all placeholder — the single use("*") mount auto-covers
    // routes that do not exist yet (plan 13/14 will add /dashboard/* routes).
    const future = await worker.fetch(
      new Request("https://worker.local/dashboard/some-future-route", {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      env,
    );
    expect(future.status).toBe(403);
    expect(networkCalls).toBe(0);
    const body = await shell.text();
    // Removed-member page (not the shell): no identity header, no sections.
    expect(body).toContain("Your dashboard access was removed. Ask an admin to re-invite mallory.");
    expect(body).not.toContain("Signed in as");
    expect(body).not.toContain('action="/dashboard/manifest/start"');
  });

  test("/dashboard/logout stays guarded: removed member → 403 with zero Set-Cookie", async () => {
    // Spec L5: the exempt set is exactly /login + /oauth/callback, so a
    // removed member cannot even burn their cookies via logout — the page
    // 403s and every cookie stays as-is.
    const res = await worker.fetch(
      dashboardRequest("/dashboard/logout", `${SESSION_COOKIE}=${await mallorySession()}`),
      await removedMemberEnv(),
    );
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  test("session-less /dashboard/logout → 302 to login with zero Set-Cookie (guard branch, route never runs)", async () => {
    const res = await worker.fetch(dashboardRequest("/dashboard/logout"), makeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  test("the two pre-session routes stay exempt: /login works and the callback reaches its own checks", async () => {
    const env = await removedMemberEnv(); // even a store with no mallory row
    // /login: guard exempt → the route's OAuth flow runs (302 to GitHub).
    const login = await worker.fetch(dashboardRequest("/dashboard/login"), env);
    expect(login.status).toBe(302);
    expect(new URL(login.headers.get("Location") ?? "").host).toBe("github.com");
    // /oauth/callback: guard exempt → the route's state check decides (400),
    // NOT a guard 302/403 — this request is what establishes the session.
    const callback = await worker.fetch(
      dashboardRequest("/dashboard/oauth/callback?code=x&state=y"),
      env,
    );
    expect(callback.status).toBe(400);
  });

  test("member requests pass the guard and reach the routes unchanged (B0 shell + B1 manifest)", async () => {
    const env = makeEnv();
    const cookie = `${SESSION_COOKIE}=${await createSessionValue("octocat", null, SESSION_SECRET)}`;
    const shell = await worker.fetch(dashboardRequest("/dashboard", cookie), env);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("Signed in as octocat");
    const start = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/start", {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      env,
    );
    expect(start.status).toBe(200);
    // Logout is reachable for a member: the guarded route expires all three cookies.
    const out = await worker.fetch(dashboardRequest("/dashboard/logout", cookie), env);
    expect(out.status).toBe(302);
    expect(out.headers.get("Location")).toBe("/dashboard/login");
    expect(out.headers.getSetCookie()).toHaveLength(3);
  });

  test("membership lookup is case-insensitive: session login case variant of a member row passes", async () => {
    // Session carries the GitHub-verified casing; the row was invited with
    // another casing — getUserByLogin is COLLATE NOCASE (spec § AuthZ).
    const session = await createSessionValue("OctoCat", null, SESSION_SECRET);
    const res = await worker.fetch(
      dashboardRequest("/dashboard", `${SESSION_COOKIE}=${session}`),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Signed in as OctoCat");
  });

  test("guard fails closed when D1 is unbound: valid session → 500, route never runs", async () => {
    const res = await worker.fetch(
      dashboardRequest(
        "/dashboard",
        `${SESSION_COOKIE}=${await createSessionValue("octocat", null, SESSION_SECRET)}`,
      ),
      baseEnv(), // no DB binding
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("dashboard storage is not configured");
  });

  test("removed-member denial logs a structured not_a_member warning (login only, no secrets)", async () => {
    const warns = spyOnWarn();
    await worker.fetch(
      dashboardRequest("/dashboard", `${SESSION_COOKIE}=${await mallorySession()}`),
      await removedMemberEnv(),
    );
    expect(warns).toHaveLength(1);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.event).toBe("dashboard_access");
    expect(entry.stage).toBe("guard");
    expect(entry.reason).toBe("not_a_member");
    expect(entry.login).toBe("mallory");
  });
});

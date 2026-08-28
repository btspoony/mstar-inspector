/**
 * Plan 08 Task 2 tests: signed session cookie + OAuth state CSRF, through
 * the real worker mount (app.route("/dashboard", dashboardApp)).
 *
 * The GitHub code-exchange/user-fetch network path is exercised only in
 * live smoke (user-gated); here callback coverage stops at the fail-closed
 * state checks, which run before any network call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { exchangeCodeForToken } from "../../src/dashboard/oauth";
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

const SESSION_SECRET = "test-dashboard-session-secret-32-bytes!";
const CLIENT_ID = "oauth-client-id";
const CLIENT_SECRET = "oauth-client-secret";

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
    expect(body).toContain("Not in B0");
  });

  test("GET /dashboard with a tampered session cookie → 302 (treated as logged out)", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      dashboardRequest(
        "/dashboard",
        // Flip the last signature char deterministically (appending a fixed
        // char is a no-op 1/64 of the time when the char already matches).
        `${SESSION_COOKIE}=${session.slice(0, -1)}${session.endsWith("A") ? "B" : "A"}`,
      ),
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
          Cookie: `${SESSION_COOKIE}=${session.slice(0, -1)}${session.endsWith("A") ? "B" : "A"}`,
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

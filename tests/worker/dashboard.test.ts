/**
 * Plan 08 Task 2 tests: signed session cookie + OAuth state CSRF, through
 * the real worker mount (app.route("/dashboard", dashboardApp)). Plan 11
 * Task 1 adds the GitHub App Manifest start/callback coverage (state CSRF,
 * locked conversion headers, encrypted hold cookie, no-secret HTML); plan 13
 * B5 T3 rewrites the commit coverage: slug-carrying signed state, hold-bound
 * D1 write of the encrypted github_apps row (AAD rowKey = row PK), the
 * commit-time slug-conflict 409 burn (never remap — the manifest registered
 * the webhook URL), fail-closed DASHBOARD_ENCRYPTION_KEY, zero
 * api.cloudflare.com calls, no-secret summary HTML.
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
  deleteUserUnlessLastAdmin,
  DuplicateLoginError,
  getUserByLogin,
  listUsers,
  parseAdminLogins,
  updateUserRoleUnlessLastAdmin,
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
  MANIFEST_HOLD_COOKIE,
  MANIFEST_HOLD_MAX_AGE_SEC,
  MANIFEST_STATE_COOKIE,
  buildAppName,
  buildAppSlug,
  createHoldValue,
  createManifestStateValue,
  exchangeManifestCode,
  readHoldValue,
} from "../../src/dashboard/manifest";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { createAppsStore } from "../../src/dashboard/apps-store";
import { normalizePrivateKey } from "../../src/dashboard/private-key";
import { normalizePrivateKey as pipelineNormalizePrivateKey } from "../../src/pipeline/comment";
import { reviewedAt, mondayOf } from "../../src/dashboard/insights-dates";
import { LOCALE_COOKIE } from "../../src/i18n";
import { SPA_BOOT_MARKER, htmlGet, withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = "test-dashboard-session-secret-32-bytes!";
const CLIENT_ID = "oauth-client-id";
const CLIENT_SECRET = "oauth-client-secret";
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

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

function seededDashboardD1(
  through: number = DASHBOARD_MIGRATION_SEQUENCE.length,
): DashboardD1 & { raw: Database } {
  const db = createDashboardTestD1(through);
  const insert = db.raw.prepare(
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, ?, ?, NULL)",
  );
  for (const [login, role] of DEFAULT_SEEDED_MEMBERS) {
    insert.run(crypto.randomUUID(), login, role, new Date().toISOString());
  }
  return db;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  // `as unknown`: the test D1 double is the narrow DashboardD1 face + raw —
  // not comparable to the full D1Database the T4 fetch-face Env.DB declares.
  return { ...baseEnv(overrides), DB: seededDashboardD1() } as unknown as Env;
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
  test("GET /dashboard without a session → 302 to login (plan 33 T3)", async () => {
    const res = await worker.fetch(dashboardRequest("/dashboard"), withSpaAssets(makeEnv()));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("GET /dashboard with a valid session cookie → 200 SPA shell (boot-injected)", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      dashboardRequest("/dashboard", `${SESSION_COOKIE}=${session}`),
      withSpaAssets(makeEnv()),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).toContain('"login":"octocat"');
    // qc1/qc2 F-001: octocat is an admin (default seed) — the boot carries
    // the admin role so the SPA renders the Members entry.
    expect(body).toContain('"role":"admin"');
    // The legacy three-card home is retired (plan 30 T4): no SSR sections,
    // no manifest start form, no REVIEW_ENABLED copy.
    expect(body).not.toContain("Model keys");
    expect(body).not.toContain("Not in this iteration (B3).");
    expect(body).not.toContain('action="/dashboard/manifest/start"');
    expect(body).not.toContain("REVIEW_ENABLED");
  });

  test("the SPA home document title is the SPA index title (plan 30 T4)", async () => {
    const indexHtml = readFileSync(join(import.meta.dir, "../../src/spa/index.html"), "utf8");
    expect(indexHtml).toContain("<title>Morning Star Inspector</title>");
    expect(indexHtml).not.toContain("Dashboard —");
  });

  test("boot role is admin-aware: member sessions carry role member, not admin (F-001)", async () => {
    const admin = await worker.fetch(
      dashboardRequest("/dashboard", `${SESSION_COOKIE}=${await createSessionValue("octocat", null, SESSION_SECRET)}`),
      withSpaAssets(makeEnv()),
    );
    expect(admin.status).toBe(200);
    expect(await admin.text()).toContain('"role":"admin"');
    const member = await worker.fetch(
      dashboardRequest("/dashboard", `${SESSION_COOKIE}=${await createSessionValue("mallory", null, SESSION_SECRET)}`),
      withSpaAssets(makeEnv()),
    );
    expect(member.status).toBe(200);
    const memberBody = await member.text();
    expect(memberBody).toContain('"login":"mallory"');
    expect(memberBody).toContain('"role":"member"');
    expect(memberBody).not.toContain('"role":"admin"');
  });

  test("GET /dashboard with a tampered session cookie → 302 to login (treated as logged out)", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      dashboardRequest("/dashboard", `${SESSION_COOKIE}=${tamperSignature(session)}`),
      withSpaAssets(makeEnv()),
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

  test("POST /dashboard/login (SPA sign-in) → 302 to GitHub authorize", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
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
    // Plan 33 T3: no session secret = no valid session → the shell path 302s
    // to login (no null-boot flash); the login/API routes behind it still
    // fail closed.
    const shell = await worker.fetch(dashboardRequest("/dashboard"), withSpaAssets(env));
    expect(shell.status).toBe(302);
    expect(shell.headers.get("Location")).toBe("/dashboard/login");
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

describe("/dashboard/locale (plan 29 T2)", () => {
  const sessionCookie = async () =>
    `${SESSION_COOKIE}=${await createSessionValue("octocat", null, SESSION_SECRET)}`;

  test("POST valid form locale → 302 to sanitized Referer path + mstar_locale Set-Cookie", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/locale", {
        method: "POST",
        headers: {
          Cookie: await sessionCookie(),
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://worker.local/dashboard/insights",
        },
        body: "locale=zh_CN",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    // same-origin absolute Referer is sanitized to its path+query — never echoed as a URL
    expect(res.headers.get("Location")).toBe("/dashboard/insights");
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toContain(`${LOCALE_COOKIE}=zh_CN`);
    expect(setCookie[0]).toContain("HttpOnly");
    expect(setCookie[0]).toContain("Secure");
    expect(setCookie[0]).toContain("SameSite=Lax");
    expect(setCookie[0]).toContain("Path=/dashboard");
  });

  test("POST with off-origin absolute Referer → 302 to /dashboard (no open redirect), cookie set", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/locale", {
        method: "POST",
        headers: {
          Cookie: await sessionCookie(),
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://evil.example/phish",
        },
        body: "locale=zh_CN",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(res.headers.getSetCookie()).toHaveLength(1);
  });

  test("POST with protocol-relative Referer → 302 to /dashboard (no open redirect), cookie set", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/locale", {
        method: "POST",
        headers: {
          Cookie: await sessionCookie(),
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "//evil.example/phish",
        },
        body: "locale=zh_CN",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(res.headers.getSetCookie()).toHaveLength(1);
  });

  test("POST with backslash-prefixed Referer (/\\evil.example) → 302 to /dashboard (no open redirect), cookie set", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/locale", {
        method: "POST",
        headers: {
          Cookie: await sessionCookie(),
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "/\\evil.example",
        },
        body: "locale=zh_CN",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    // WHATWG: /\/evil.example parses as https://evil.example/ (backslash → slash → authority)
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(res.headers.getSetCookie()).toHaveLength(1);
  });

  test("POST with same-origin absolute Referer containing backslash (https://worker.local/\\evil.example) → 302 to /dashboard (no open redirect), cookie set", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/locale", {
        method: "POST",
        headers: {
          Cookie: await sessionCookie(),
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://worker.local/\\evil.example",
        },
        body: "locale=zh_CN",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    // WHATWG: backslash in the path normalizes to /, yielding pathname //evil.example (protocol-relative)
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(res.headers.getSetCookie()).toHaveLength(1);
  });

  test("POST with empty-string Referer → 302 to /dashboard (treated as missing), cookie set", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/locale", {
        method: "POST",
        headers: {
          Cookie: await sessionCookie(),
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "",
        },
        body: "locale=zh_CN",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(res.headers.getSetCookie()).toHaveLength(1);
  });

  test("POST valid JSON locale without Referer → 302 to /dashboard + Set-Cookie", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/locale", {
        method: "POST",
        headers: {
          Cookie: await sessionCookie(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ locale: "en" }),
      }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toContain(`${LOCALE_COOKIE}=en`);
  });

  test("POST invalid locale → 400, no Set-Cookie", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/locale", {
        method: "POST",
        headers: {
          Cookie: await sessionCookie(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "locale=fr",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  test("POST malformed JSON → 400, no Set-Cookie", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/locale", {
        method: "POST",
        headers: {
          Cookie: await sessionCookie(),
          "Content-Type": "application/json",
        },
        body: "{not json",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  test("POST without a session (login-page toggle) → 302 back + mstar_locale Set-Cookie", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/locale", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://worker.local/dashboard/login",
        },
        body: "locale=zh_CN",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toContain(`${LOCALE_COOKIE}=zh_CN`);
    expect(setCookie[0]).toContain("Path=/dashboard");
  });

  test("POST with a row-less session still sets mstar_locale (membership-exempt)", async () => {
    const cookie = `${SESSION_COOKIE}=${await createSessionValue("stranger", null, SESSION_SECRET)}`;
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/locale", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://worker.local/dashboard/login",
        },
        body: "locale=en",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    const setCookie = res.headers.getSetCookie();
    expect(setCookie.some((v) => v.includes(`${LOCALE_COOKIE}=en`))).toBe(true);
  });
});

describe("manifest hold cookie (manifest.ts)", () => {
  const freshHold = (login = "octocat", nowMs = Date.now()) =>
    createHoldValue(CONVERSION, login, SESSION_SECRET, buildAppSlug(login), nowMs);

  test("round trip carries id/name/login/slug/pem/webhook_secret", async () => {
    const value = await freshHold();
    const payload = await readHoldValue(value, SESSION_SECRET);
    expect(payload).toEqual({
      ...CONVERSION,
      login: "octocat",
      slug: buildAppSlug("octocat"),
      exp: expect.any(Number),
    });
  });

  test("serialized value stays under the 4096B cookie budget with an RSA-2048-size PEM", async () => {
    expect(FAKE_PEM.length).toBeGreaterThan(1500); // realistic key size, else the budget test is vacuous
    const value = await freshHold();
    expect(value.length).toBeLessThan(4096);
  });

  test("wrong secret fails closed", async () => {
    const value = await freshHold();
    expect(await readHoldValue(value, "another-secret")).toBeNull();
  });

  test("tampered ciphertext fails closed (GCM tag)", async () => {
    const value = await freshHold();
    // Flip a mid-string character: unlike the last base64url char (padding
    // bits), this always changes the decoded bytes → GCM tag must fail.
    const at = 24;
    const tampered = `${value.slice(0, at)}${value[at] === "A" ? "B" : "A"}${value.slice(at + 1)}`;
    expect(await readHoldValue(tampered, SESSION_SECRET)).toBeNull();
  });

  test("expired hold fails closed (server-side exp beside Max-Age)", async () => {
    const past = Date.now() - 10 * 60 * 1000; // minted 10min ago, 600s TTL
    const value = await freshHold("octocat", past);
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
    // Locked manifest content (spec § Manifest 内容); B5: the webhook URL is
    // the App's OWN route /webhook/{slug} with the login-derived slug.
    expect(manifest.name).toBe("mstar-inspector-octocat");
    expect(manifest.url).toBe("https://worker.local");
    expect(manifest.hook_attributes).toEqual({ url: "https://worker.local/webhook/mstar-inspector-octocat" });
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
  test("Accept-Language zh renders the start page in zh_CN (plan 29 T5)", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/start", {
        method: "POST",
        headers: {
          Cookie: `${SESSION_COOKIE}=${session}`,
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('lang="zh-CN"');
    expect(body).toContain("在 GitHub 上继续");
    expect(body).toContain("创建 GitHub App");
    expect(body).toContain('method="post"');
    expect(body).toContain("https://github.com/settings/apps/new");
    expect(body).toContain('name="manifest"');
    expect(body).not.toContain("REVIEW_ENABLED");
    expect(body).not.toContain("Continue on GitHub");
  });

  test("long login: manifest name is capped at 34 chars and the start page shows the truncated name", async () => {
    const { body, manifest } = await startManifest("octocat-with-a-long-login");
    const name = manifest.name as string;
    expect(name.length).toBeLessThanOrEqual(34);
    expect(name.startsWith("mstar-inspector-")).toBe(true);
    // The start copy names the App GitHub will actually register — never the
    // untruncated name that GitHub would reject.
    expect(body).toContain(`<strong>${name}</strong>`);
    // B5: the webhook SLUG is login-derived and uncapped — it is a URL path
    // segment, not the GitHub App name, so it legitimately carries the full
    // login inside the hook URL.
    expect(manifest.hook_attributes).toEqual({
      url: "https://worker.local/webhook/mstar-inspector-octocat-with-a-long-login",
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
    // B5: a valid manifest state carries the slug (createStateValue alone is
    // a B0 OAuth state and must NOT verify here).
    const state = await createManifestStateValue(SESSION_SECRET, "mstar-inspector-octocat");
    const warns = spyOnWarn();
    const res = await worker.fetch(callbackRequest(session, state, `state=${state}`), makeEnv());
    expect(res.status).toBe(400);
    expect(guard.calls()).toBe(0);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.event).toBe("dashboard_manifest");
    expect(entry.stage).toBe("callback");
    expect(entry.reason).toBe("missing_code");
  });

  test("callback success → conversion exchanged, App auto-committed, 302 to onboarding, hold burned, no secrets (plan 31 T5)", async () => {
    // The callback now runs the commit itself (AC4b — no second click), so
    // it needs the commit-shaped env: encryption key + D1.
    const env = makeEnv({ DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });
    const { session, state } = await startManifest();
    const calls: string[] = [];
    let seenHeaders: Record<string, string> = {};
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url) !== "https://api.github.com/app-manifests/manifest-code/conversions") {
        throw new Error(`unexpected upstream: ${String(url)}`);
      }
      seenHeaders = { ...((init?.headers ?? {}) as Record<string, string>) };
      return new Response(JSON.stringify(CONVERSION), { status: 201 });
    }) as typeof fetch;
    const res = await worker.fetch(
      callbackRequest(session, state, `code=manifest-code&state=${state}`),
      env,
    );
    // One conversion fetch, nothing else — the auto-commit writes locally.
    expect(calls).toEqual(["https://api.github.com/app-manifests/manifest-code/conversions"]);
    // Conversion per Global Constraints (spec L9).
    expect(seenHeaders.Accept).toBe("application/vnd.github+json");
    expect(seenHeaders["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(seenHeaders.Authorization).toBeUndefined();
    // Success lands on the App's onboarding page — no confirm click required.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/apps/mstar-inspector-octocat/onboarding");
    const cookies = res.headers.getSetCookie();
    // State cookie single-use: expired on the callback.
    expect(
      cookies.some((c) => c.startsWith(`${MANIFEST_STATE_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
    // The auto-commit success BURNS the hold — no parked hold cookie.
    expect(
      cookies.some((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=`) && !c.includes("Max-Age=0"))).toBe(false);
    // Exactly one encrypted github_apps row with the state-carried slug.
    const rows = dbOf(env).raw.query("SELECT slug, github_app_id, created_by FROM github_apps").all() as Array<{
      slug: string;
      github_app_id: number;
      created_by: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe("mstar-inspector-octocat");
    expect(rows[0]!.github_app_id).toBe(CONVERSION.id);
    expect(rows[0]!.created_by).toBe("octocat");
    // Landing page: name / id / slug / webhook URL + the Settings CTA, never
    // secrets, never REVIEW_ENABLED.
    const landing = await worker.fetch(
      dashboardRequest("/dashboard/apps/mstar-inspector-octocat/onboarding", `${SESSION_COOKIE}=${session}`),
      env,
    );
    expect(landing.status).toBe(200);
    const body = await landing.text();
    expect(body).toContain(`<span class="id">${CONVERSION.id}</span>`);
    expect(body).toContain(CONVERSION.name);
    expect(body).toContain("https://worker.local/webhook/mstar-inspector-octocat");
    expect(body).toContain('href="/dashboard/apps/mstar-inspector-octocat/settings"');
    expect(body).toContain(">Open Settings</a>");
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_PEM);
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
    expect(body).not.toContain("REVIEW_ENABLED");
    // The retired overwrite-confirm semantics stay gone.
    expect(body).not.toContain("overwrite");
    expect(body).not.toContain("APP_ID");
    expect(body).not.toContain('class="danger"');
  });

  test("callback auto-commit already-connected (github_app_id taken) → 409 error page, hold burned, zero new rows (plan 31 T5)", async () => {
    const env = makeEnv({ DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });
    // The same GitHub App is already connected on this deployment.
    await envDb(env).createApp({
      id: crypto.randomUUID(),
      slug: "mstar-inspector-earlier",
      githubAppId: CONVERSION.id,
      name: "earlier",
      privateKeyEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      webhookSecretEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      createdBy: "someone-else",
    });
    const { session, state } = await startManifest();
    globalThis.fetch = (async () => new Response(JSON.stringify(CONVERSION), { status: 201 })) as unknown as typeof fetch;
    const warns = spyOnWarn();
    const res = await worker.fetch(
      callbackRequest(session, state, `code=manifest-code&state=${state}`),
      env,
    );
    expect(res.status).toBe(409);
    // Non-retryable conflict: the hold is burned (expired cookie emitted).
    expect(
      res.headers.getSetCookie().some((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
    expect(appRowCount(env)).toBe(1); // only the pre-existing row
    const body = await res.text();
    expect(body).toContain("already connected");
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.stage).toBe("commit");
    expect(entry.reason).toBe("github_app_id_conflict");
  });

  test("callback auto-commit slug race → 409 error page, hold burned, zero rows for the held App (plan 31 T5)", async () => {
    const env = makeEnv({ DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });
    // Hold carries the base slug, but the slug got claimed before the write.
    await envDb(env).createApp({
      id: crypto.randomUUID(),
      slug: "mstar-inspector-octocat",
      githubAppId: 999,
      name: "raced",
      privateKeyEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      webhookSecretEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      createdBy: "someone-else",
    });
    const { session, state } = await startManifest();
    globalThis.fetch = (async () => new Response(JSON.stringify(CONVERSION), { status: 201 })) as unknown as typeof fetch;
    const res = await worker.fetch(
      callbackRequest(session, state, `code=manifest-code&state=${state}`),
      env,
    );
    expect(res.status).toBe(409);
    expect(
      res.headers.getSetCookie().some((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
    const rows = dbOf(env).raw.query("SELECT slug FROM github_apps WHERE github_app_id = ?").all(CONVERSION.id) as Array<{ slug: string }>;
    expect(rows).toHaveLength(0);
    const body = await res.text();
    expect(body).toContain("not connected");
    expect(body).not.toContain("BEGIN");
  });

  test("callback retryable 500 (missing encryption key) → resumable page, hold cookie parked, confirm gate reachable (plan 31 T5)", async () => {
    // No DASHBOARD_ENCRYPTION_KEY → the inline commit fails closed at
    // encryption: 500, zero rows, and the hold lands in a cookie so the
    // operator can resume from the confirm page.
    const env = makeEnv();
    const { session, state } = await startManifest();
    globalThis.fetch = (async () => new Response(JSON.stringify(CONVERSION), { status: 201 })) as unknown as typeof fetch;
    const res = await worker.fetch(
      callbackRequest(session, state, `code=manifest-code&state=${state}`),
      env,
    );
    expect(res.status).toBe(500);
    expect(appRowCount(env)).toBe(0);
    const body = await res.text();
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
    // Hold cookie: __Host- attribute set, Max-Age 600, value < 4096B, and
    // it round-trips to the converted credentials + the state-carried slug.
    const holdCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=`)) ?? "";
    expect(holdCookie).toContain("HttpOnly");
    expect(holdCookie).toContain("Secure");
    expect(holdCookie).toContain("SameSite=Lax");
    expect(holdCookie).toContain("Path=/");
    expect(holdCookie).toContain("Max-Age=600");
    expect(holdCookie).not.toContain("Domain");
    const holdValue = (holdCookie.split(";")[0] ?? "").slice(MANIFEST_HOLD_COOKIE.length + 1);
    expect(holdValue.length).toBeGreaterThan(0);
    expect(holdValue.length).toBeLessThan(4096);
    const payload = await readHoldValue(holdValue, SESSION_SECRET);
    expect(payload?.id).toBe(CONVERSION.id);
    expect(payload?.name).toBe(CONVERSION.name);
    expect(payload?.login).toBe("octocat");
    expect(payload?.slug).toBe("mstar-inspector-octocat");
    expect(payload?.pem).toBe(CONVERSION.pem);
    expect(payload?.webhook_secret).toBe(CONVERSION.webhook_secret);
    // The resumable error page links to the confirm gate...
    expect(body).toContain('href="/dashboard/manifest/confirm"');
    // ...and the confirm gate re-renders with the parked hold.
    const resumed = await worker.fetch(
      dashboardRequest(
        "/dashboard/manifest/confirm",
        `${SESSION_COOKIE}=${session}; ${MANIFEST_HOLD_COOKIE}=${holdValue}`,
      ),
      env,
    );
    expect(resumed.status).toBe(200);
    const resumedBody = await resumed.text();
    expect(resumedBody).toContain('action="/dashboard/manifest/commit"');
    expect(resumedBody).not.toContain(FAKE_PEM);
    expect(resumedBody).not.toContain(FAKE_WEBHOOK_SECRET);
  });

  test("callback retryable 500 (unbound D1) → resumable page, hold cookie parked, confirm gate reachable (plan 31 QC F-005)", async () => {
    // Encryption is configured so this isolates db_unbound from encrypt_failed.
    // The membership guard skips unbound-D1 fail-closed on callback/confirm so
    // the hold can park and the confirm link stays reachable.
    const env = baseEnv({ DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });
    const { session, state } = await startManifest();
    globalThis.fetch = (async () => new Response(JSON.stringify(CONVERSION), { status: 201 })) as unknown as typeof fetch;
    const res = await worker.fetch(
      callbackRequest(session, state, `code=manifest-code&state=${state}`),
      env,
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("Dashboard storage is not configured");
    expect(body).toContain('href="/dashboard/manifest/confirm"');
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
    const holdCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=`)) ?? "";
    expect(holdCookie).toContain("HttpOnly");
    expect(holdCookie).toContain("Max-Age=600");
    const holdValue = (holdCookie.split(";")[0] ?? "").slice(MANIFEST_HOLD_COOKIE.length + 1);
    expect(holdValue.length).toBeGreaterThan(0);
    const payload = await readHoldValue(holdValue, SESSION_SECRET);
    expect(payload?.id).toBe(CONVERSION.id);
    expect(payload?.slug).toBe("mstar-inspector-octocat");
    const resumed = await worker.fetch(
      dashboardRequest(
        "/dashboard/manifest/confirm",
        `${SESSION_COOKIE}=${session}; ${MANIFEST_HOLD_COOKIE}=${holdValue}`,
      ),
      env,
    );
    expect(resumed.status).toBe(200);
    const resumedBody = await resumed.text();
    expect(resumedBody).toContain('action="/dashboard/manifest/commit"');
    expect(resumedBody).not.toContain(FAKE_PEM);
    expect(resumedBody).not.toContain(FAKE_WEBHOOK_SECRET);
  });

  test("callback retryable 500 (github_apps missing) → hold parked, confirm gate reachable (plan 31 T5)", async () => {
    // through=3: a pre-plan-13 DB (users only — no github_apps table). The
    // guard passes (membership reads users), the inline commit fails on the
    // missing table: retryable, hold parked for the resume path.
    const env = {
      ...baseEnv({ DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      DB: seededDashboardD1(3),
    } as unknown as Env;
    const { session, state } = await startManifest();
    globalThis.fetch = (async () => new Response(JSON.stringify(CONVERSION), { status: 201 })) as unknown as typeof fetch;
    const res = await worker.fetch(
      callbackRequest(session, state, `code=manifest-code&state=${state}`),
      env,
    );
    expect(res.status).toBe(500);
    const holdCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=`)) ?? "";
    expect(holdCookie).toBeTruthy();
    const holdValue = (holdCookie.split(";")[0] ?? "").slice(MANIFEST_HOLD_COOKIE.length + 1);
    const resumed = await worker.fetch(
      dashboardRequest(
        "/dashboard/manifest/confirm",
        `${SESSION_COOKIE}=${session}; ${MANIFEST_HOLD_COOKIE}=${holdValue}`,
      ),
      env,
    );
    expect(resumed.status).toBe(200);
    expect(await resumed.text()).toContain('action="/dashboard/manifest/commit"');
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
  const freshHold = () =>
    createHoldValue(CONVERSION, "octocat", SESSION_SECRET, buildAppSlug("octocat"));

  function resumeRequest(path: string, session: string, hold?: string): Request {
    const cookies = hold ? `${SESSION_COOKIE}=${session}; ${MANIFEST_HOLD_COOKIE}=${hold}` : `${SESSION_COOKIE}=${session}`;
    return dashboardRequest(path, cookies);
  }

  test("GET /dashboard/manifest/confirm with a valid hold renders the confirm gate, never PEM/webhook_secret", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      resumeRequest("/dashboard/manifest/confirm", session, await freshHold()),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('action="/dashboard/manifest/commit"');
    expect(body).toContain(">Create App</button>");
    expect(body).toContain(`<span class="id">${CONVERSION.id}</span>`);
    expect(body).toContain(CONVERSION.name);
    expect(body).toContain("mstar-inspector-octocat");
    expect(body).toContain("https://worker.local/webhook/mstar-inspector-octocat");
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_PEM);
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
    // A hold-bearing operator never lands on the dead shell start form.
    expect(body).not.toContain('action="/dashboard/manifest/start"');
  });

  test("after a retryable 500 (missing encryption key), the confirm route still shows the confirm gate", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const hold = await freshHold();
    const rejected = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/commit", {
        method: "POST",
        headers: {
          Cookie: `${SESSION_COOKIE}=${session}; ${MANIFEST_HOLD_COOKIE}=${hold}`,
        },
        body: "",
      }),
      makeEnv({ DASHBOARD_ENCRYPTION_KEY: undefined }),
    );
    expect(rejected.status).toBe(500);
    // The retryable error page links back to the confirm surface.
    expect(await rejected.text()).toContain('href="/dashboard/manifest/confirm"');
    // Resume via the confirm route: the gate comes back with the same hold.
    const resumed = await worker.fetch(resumeRequest("/dashboard/manifest/confirm", session, hold), makeEnv());
    expect(resumed.status).toBe(200);
    const body = await resumed.text();
    expect(body).toContain('action="/dashboard/manifest/commit"');
    expect(body).toContain(`<span class="id">${CONVERSION.id}</span>`);
  });

  test("hold bound to a different login → 302 to the shell, no confirm, no secrets", async () => {
    const session = await createSessionValue("mallory", null, SESSION_SECRET);
    const res = await worker.fetch(
      resumeRequest("/dashboard/manifest/confirm", session, await freshHold()),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(await res.text()).not.toContain("BEGIN");
    expect(await res.text()).not.toContain(FAKE_WEBHOOK_SECRET);
  });

  test("GET /dashboard/manifest/confirm: valid hold → 200 confirm; no hold → 302 to the shell", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const ok = await worker.fetch(
      resumeRequest("/dashboard/manifest/confirm", session, await freshHold()),
      makeEnv(),
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('action="/dashboard/manifest/commit"');
    const noHold = await worker.fetch(
      resumeRequest("/dashboard/manifest/confirm", session),
      makeEnv(),
    );
    expect(noHold.status).toBe(302);
    expect(noHold.headers.get("Location")).toBe("/dashboard");
  });

  test("Accept-Language zh renders the confirm page in zh_CN (plan 29 T7)", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const hold = await freshHold();
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/confirm", {
        headers: {
          Cookie: `${SESSION_COOKIE}=${session}; ${MANIFEST_HOLD_COOKIE}=${hold}`,
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('lang="zh-CN"');
    expect(body).toContain("创建 App");
    expect(body).not.toContain("Create App");
    expect(body).not.toContain("REVIEW_ENABLED");
  });
});

describe("dashboard private-key normalization (private-key.ts)", () => {
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

  test("AC-B5-nocf: CLOUDFLARE_* is gone from the dashboard deps (env.ts + .env.example); the encryption key remains", async () => {
    const example = await Bun.file(new URL("../../.env.example", import.meta.url)).text();
    expect(example).not.toContain("CLOUDFLARE_");
    expect(example).toContain("DASHBOARD_ENCRYPTION_KEY");
    const envTs = await Bun.file(new URL("../../src/worker/env.ts", import.meta.url)).text();
    expect(envTs).not.toContain("CLOUDFLARE_");
    // The dashboard module surface carries no Cloudflare API path either.
    const manifestTs = await Bun.file(new URL("../../src/dashboard/manifest.ts", import.meta.url)).text();
    expect(manifestTs).not.toContain("api.cloudflare.com");
    expect(manifestTs).not.toContain("secrets-bulk");
  });
});

describe("/dashboard manifest commit (plan 13 B5 T3: manifest → D1, zero CF API)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  /**
   * Recording fetch stub: EVERY upstream URL is captured, and anything that
   * is not the pinned GitHub conversion endpoint throws. The D1 write is
   * local, so the commit phase must record ZERO calls — this is the
   * no-Cloudflare-API + no-unexpected-upstream contract for every path.
   */
  function stubFetchRecording(): { urls: string[] } {
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      throw new Error(`no upstream may be called on this path (${String(url)})`);
    }) as unknown as typeof fetch;
    return { urls };
  }

  function stubGitHubConversionOnly(): { urls: string[] } {
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      if (String(url) === "https://api.github.com/app-manifests/manifest-code/conversions") {
        return new Response(JSON.stringify(CONVERSION), { status: 201 });
      }
      throw new Error(`unexpected upstream: ${String(url)}`);
    }) as unknown as typeof fetch;
    return { urls };
  }

  const freshHold = () =>
    createHoldValue(CONVERSION, "octocat", SESSION_SECRET, buildAppSlug("octocat"));

  function commitEnv(overrides: Partial<Env> = {}): Env {
    // makeEnv seeds the default members (octocat is an admin) and the
    // production-shaped plan-13 DB — the commit writes github_apps.
    return makeEnv({ DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, ...overrides });
  }

  /** POST /dashboard/manifest/commit; holdValue=null omits the hold cookie. */
  async function doCommit(args: {
    env?: Env;
    withSession?: boolean;
    sessionLogin?: string;
    holdValue?: string | null;
    extraHeaders?: Record<string, string>;
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
        headers: { Cookie: cookies.join("; "), ...args.extraHeaders },
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

  /** Retryable outcomes (500) must NOT burn the hold (qc3 F-01 discipline). */
  function expectHoldKept(res: Response): void {
    const cookies = res.headers.getSetCookie();
    expect(
      cookies.some((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(false);
  }

  test("missing hold cookie → 302 back to the flow start, zero writes, zero fetch, hold cleared", async () => {
    const rec = stubFetchRecording();
    const env = commitEnv();
    const res = await doCommit({ holdValue: null });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(rec.urls).toHaveLength(0);
    expectHoldExpired(res);
    expect(appRowCount(env)).toBe(0);
  });

  test("tampered or expired hold cookie → 302 back to the flow start, zero writes", async () => {
    const rec = stubFetchRecording();
    const hold = await freshHold();
    const tampered = `${hold.slice(0, 20)}${hold[20] === "A" ? "B" : "A"}${hold.slice(21)}`;
    const expired = await createHoldValue(
      CONVERSION,
      "octocat",
      SESSION_SECRET,
      buildAppSlug("octocat"),
      Date.now() - (MANIFEST_HOLD_MAX_AGE_SEC + 100) * 1000,
    );
    for (const holdValue of [tampered, expired]) {
      const res = await doCommit({ holdValue });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/dashboard");
      expectHoldExpired(res); // bad hold is burned, not retried
    }
    expect(rec.urls).toHaveLength(0);
  });

  test("hold.login ≠ session.login → 403, zero writes, hold burned", async () => {
    const rec = stubFetchRecording();
    const warns = spyOnWarn();
    // Hold minted for "octocat" presented by a different logged-in operator.
    const res = await doCommit({ holdValue: await freshHold(), sessionLogin: "mallory" });
    expect(res.status).toBe(403);
    expect(rec.urls).toHaveLength(0);
    expectHoldExpired(res);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.event).toBe("dashboard_manifest");
    expect(entry.stage).toBe("commit");
    expect(entry.reason).toBe("login_mismatch");
    const html = await res.text();
    expect(html).not.toContain("BEGIN");
    expect(html).not.toContain(FAKE_WEBHOOK_SECRET);
  });

  test("missing DASHBOARD_ENCRYPTION_KEY → 500 fail-closed, zero rows, zero fetch, hold KEPT (AC-SEC)", async () => {
    const rec = stubFetchRecording();
    const res = await doCommit({
      env: commitEnv({ DASHBOARD_ENCRYPTION_KEY: undefined }),
      holdValue: await freshHold(),
    });
    expect(res.status).toBe(500);
    expectHoldKept(res); // retryable: fix the env and resubmit
    expect(rec.urls).toHaveLength(0);
    const body = await res.text();
    expect(body).toContain("DASHBOARD_ENCRYPTION_KEY");
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
  });

  test("migrations not applied (no github_apps table) → 500 fail-closed, hold KEPT", async () => {
    const rec = stubFetchRecording();
    // through=3: a pre-plan-13 DB (users only — no github_apps table).
    const res = await doCommit({
      env: {
        ...baseEnv({ DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
        DB: seededDashboardD1(3),
      } as unknown as Env,
      holdValue: await freshHold(),
    });
    expect(res.status).toBe(500);
    expectHoldKept(res);
    expect(rec.urls).toHaveLength(0);
  });

  test("e2e start→callback AUTO-COMMIT (plan 31 T5): encrypted github_apps row, PEM verbatim (L1), AAD rowKey = row PK, onboarding shows slug/webhook URL/id, ZERO api.cloudflare.com calls, no secrets in HTML", async () => {
    const rec = stubGitHubConversionOnly();
    const env = commitEnv();
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    // 1. start: mint the slug-carrying state + manifest with the per-App hook URL.
    const start = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/start", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${session}` },
      }),
      env,
    );
    expect(start.status).toBe(200);
    const stateCookie =
      start.headers.getSetCookie().find((c) => c.startsWith(`${MANIFEST_STATE_COOKIE}=`)) ?? "";
    const state = (stateCookie.split(";")[0] ?? "").slice(MANIFEST_STATE_COOKIE.length + 1);
    // 2. callback: conversion + the write happen in THIS request — the exact
    // one upstream call of the whole flow.
    const callback = await worker.fetch(
      dashboardRequest(
        `/dashboard/manifest/callback?code=manifest-code&state=${state}`,
        `${SESSION_COOKIE}=${session}; ${MANIFEST_STATE_COOKIE}=${state}`,
      ),
      env,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/dashboard/apps/mstar-inspector-octocat/onboarding");
    // AC-B5-nocf: no api.cloudflare.com anywhere in the whole flow.
    for (const url of rec.urls) expect(url).not.toContain("api.cloudflare.com");
    expect(rec.urls).toEqual([
      "https://api.github.com/app-manifests/manifest-code/conversions",
    ]);
    // Hold burned on success (single-success semantics preserved).
    expectHoldExpired(callback);
    // The row: exactly one, slug = the state-carried slug, encrypted columns.
    const db = dbOf(env);
    const rows = db.raw.query("SELECT * FROM github_apps").all() as Array<{
      id: string;
      slug: string;
      github_app_id: number;
      name: string;
      private_key_enc: string;
      webhook_secret_enc: string;
      created_by: string;
      status: string;
      deleted_at: string | null;
    }>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.slug).toBe("mstar-inspector-octocat");
    expect(row.github_app_id).toBe(CONVERSION.id);
    expect(row.name).toBe(CONVERSION.name);
    expect(row.created_by).toBe("octocat");
    expect(row.status).toBe("active");
    expect(row.deleted_at).toBeNull();
    expect(row.private_key_enc.startsWith("v1.primary.")).toBe(true);
    expect(row.webhook_secret_enc.startsWith("v1.primary.")).toBe(true);
    // Lock L1: ciphertext only in D1; decrypt with the AAD rowKey = row PK.
    const box = createSecretbox(TEST_ENCRYPTION_KEY);
    expect(
      await box.decryptSecret(row.private_key_enc, `github_apps.private_key_enc:${row.id}`),
    ).toBe(CONVERSION.pem);
    expect(
      await box.decryptSecret(row.webhook_secret_enc, `github_apps.webhook_secret_enc:${row.id}`),
    ).toBe(FAKE_WEBHOOK_SECRET);
    // L1 storage口径: the PEM is stored VERBATIM — NOT PKCS#8-normalized
    // (normalization stays at createReviewCommenter construction).
    expect(row.private_key_enc.startsWith("v1.")).toBe(true);
    const decryptedPem = await box.decryptSecret(
      row.private_key_enc,
      `github_apps.private_key_enc:${row.id}`,
    );
    expect(decryptedPem.startsWith("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(decryptedPem).not.toBe(normalizePrivateKey(FAKE_PEM));
    // Landing HTML: slug + webhook URL + numeric id; never the secrets.
    const landing = await worker.fetch(
      dashboardRequest("/dashboard/apps/mstar-inspector-octocat/onboarding", `${SESSION_COOKIE}=${session}`),
      env,
    );
    expect(landing.status).toBe(200);
    const html = await landing.text();
    expect(html).toContain("mstar-inspector-octocat");
    expect(html).toContain("https://worker.local/webhook/mstar-inspector-octocat");
    expect(html).toContain(`<span class="id">${CONVERSION.id}</span>`);
    expect(html).not.toContain("BEGIN");
    expect(html).not.toContain(FAKE_PEM);
    expect(html).not.toContain(FAKE_WEBHOOK_SECRET);
  });

  test("POST /manifest/commit stays an idempotent-recovery path: after a retryable callback 500, the SAME hold resubmits → 302 onboarding + one row (plan 31 T5)", async () => {
    // 1. Callback with a key-less env: the auto-commit fails at encryption and
    // parks the hold cookie (500, zero rows). The signed state carries the
    // slug exactly as /manifest/start would have minted it.
    const brokeEnv = makeEnv();
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const state = await createManifestStateValue(SESSION_SECRET, "mstar-inspector-octocat");
    globalThis.fetch = (async () => new Response(JSON.stringify(CONVERSION), { status: 201 })) as unknown as typeof fetch;
    const failed = await worker.fetch(
      dashboardRequest(
        `/dashboard/manifest/callback?code=manifest-code&state=${state}`,
        `${SESSION_COOKIE}=${session}; ${MANIFEST_STATE_COOKIE}=${state}`,
      ),
      brokeEnv,
    );
    expect(failed.status).toBe(500);
    const holdCookie =
      failed.headers.getSetCookie().find((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=`)) ?? "";
    const holdValue = (holdCookie.split(";")[0] ?? "").slice(MANIFEST_HOLD_COOKIE.length + 1);
    expect(holdValue.length).toBeGreaterThan(0);
    // 2. Operator fixes the deployment (key present) and resubmits through
    // the pinned POST — the direct /manifest/commit route (recovery path).
    const env = commitEnv();
    const committed = await doCommit({
      env: { ...env, DB: dbOf(brokeEnv) } as unknown as Env,
      holdValue,
    });
    expect(committed.status).toBe(302);
    expect(committed.headers.get("Location")).toBe("/dashboard/apps/mstar-inspector-octocat/onboarding");
    expectHoldExpired(committed);
    const rows = dbOf(brokeEnv).raw.query("SELECT slug FROM github_apps WHERE github_app_id = ?").all(CONVERSION.id) as Array<{ slug: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe("mstar-inspector-octocat");
    // 3. Replaying the same hold after success is the already-connected 409
    // (the row is single-write): zero NEW rows, matching the long-standing
    // "already connected" conflict semantics — never a double-write.
    const replay = await doCommit({ env: { ...env, DB: dbOf(brokeEnv) } as unknown as Env, holdValue });
    expect(replay.status).toBe(409);
    expect(appRowCount({ ...env, DB: dbOf(brokeEnv) } as unknown as Env)).toBe(1);
  });

  test("slug collision at start: the taken base slug is pre-resolved with a suffix and the row lands on the SAME slug (webhook URL displayed matches route)", async () => {
    const env = commitEnv();
    const db = dbOf(env);
    // Someone already owns the login-derived base slug.
    await envDb(env).createApp({
      id: crypto.randomUUID(),
      slug: "mstar-inspector-octocat",
      githubAppId: 999,
      name: "occupied",
      privateKeyEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      webhookSecretEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      createdBy: "someone-else",
    });
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const start = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/start", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${session}` },
      }),
      env,
    );
    const body = await start.text();
    const field = /name="manifest" value="([^"]*)"/.exec(body)?.[1] ?? "";
    const manifest = JSON.parse(
      field
        .replaceAll("&#39;", "'")
        .replaceAll("&quot;", '"')
        .replaceAll("&gt;", ">")
        .replaceAll("&lt;", "<")
        .replaceAll("&amp;", "&"),
    ) as { hook_attributes: { url: string } };
    const startUrl = manifest.hook_attributes.url;
    expect(startUrl).not.toBe("https://worker.local/webhook/mstar-inspector-octocat");
    expect(startUrl.startsWith("https://worker.local/webhook/mstar-inspector-octocat-")).toBe(true);
    // The auto-commit reads the suffixed slug from the state and lands on
    // the suffixed onboarding URL.
    const stateCookie =
      start.headers.getSetCookie().find((c) => c.startsWith(`${MANIFEST_STATE_COOKIE}=`)) ?? "";
    const state = (stateCookie.split(";")[0] ?? "").slice(MANIFEST_STATE_COOKIE.length + 1);
    stubGitHubConversionOnly();
    const callback = await worker.fetch(
      dashboardRequest(
        `/dashboard/manifest/callback?code=manifest-code&state=${state}`,
        `${SESSION_COOKIE}=${session}; ${MANIFEST_STATE_COOKIE}=${state}`,
      ),
      env,
    );
    expect(callback.status).toBe(302);
    const rows = db.raw.query("SELECT slug, github_app_id FROM github_apps WHERE github_app_id = ?").all(CONVERSION.id) as Array<{ slug: string; github_app_id: number }>;
    expect(rows).toHaveLength(1);
    // The committed slug equals the URL the manifest registered with GitHub.
    expect(`https://worker.local/webhook/${rows[0]!.slug}`).toBe(startUrl);
    const landing = await worker.fetch(
      dashboardRequest(`/dashboard/apps/${rows[0]!.slug}/onboarding`, `${SESSION_COOKIE}=${session}`),
      env,
    );
    expect(landing.status).toBe(200);
    const html = await landing.text();
    expect(html).toContain(rows[0]!.slug);
    expect(html).toContain(startUrl);
  });

  test("commit-time slug race (row appeared after start) → 409, hold burned, zero rows (never remap: the manifest registered the webhook URL)", async () => {
    const rec = stubFetchRecording();
    const env = commitEnv();
    const db = dbOf(env);
    // Hold carries the base slug as if start had seen a free namespace.
    const holdValue = await createHoldValue(
      CONVERSION,
      "octocat",
      SESSION_SECRET,
      "mstar-inspector-octocat",
    );
    // …but the slug got taken before the commit landed (the race).
    await envDb(env).createApp({
      id: crypto.randomUUID(),
      slug: "mstar-inspector-octocat",
      githubAppId: 999,
      name: "raced",
      privateKeyEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      webhookSecretEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      createdBy: "someone-else",
    });
    const warns = spyOnWarn();
    const res = await doCommit({ env, holdValue });
    expect(res.status).toBe(409);
    expectHoldExpired(res); // the hold can never commit correctly — burned
    // Zero rows written for the held App, and the only row in the table is
    // the racer's pre-existing one.
    const rows = db.raw.query("SELECT slug FROM github_apps WHERE github_app_id = ?").all(CONVERSION.id) as Array<{ slug: string }>;
    expect(rows).toHaveLength(0);
    expect(appRowCount(env)).toBe(1);
    // No remap, no upstream rescue (no webhook PATCH path) — zero fetch.
    expect(rec.urls).toHaveLength(0);
    // Copy: the App was created on GitHub but NOT connected + how to recover.
    const html = await res.text();
    expect(html).toContain("not connected");
    expect(html).toContain("delete the just-created App on GitHub");
    expect(html).not.toContain("BEGIN");
    expect(html).not.toContain(FAKE_WEBHOOK_SECRET);
    // Structured log names the reason for operators.
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.event).toBe("dashboard_manifest");
    expect(entry.stage).toBe("commit");
    expect(entry.reason).toBe("slug_conflict");
  });

  test("github_app_id already connected → 409, zero new rows, hold burned (non-retryable)", async () => {
    const rec = stubFetchRecording();
    const env = commitEnv();
    await envDb(env).createApp({
      id: crypto.randomUUID(),
      slug: "mstar-inspector-earlier",
      githubAppId: CONVERSION.id,
      name: "earlier",
      privateKeyEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      webhookSecretEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      createdBy: "someone-else",
    });
    const res = await doCommit({ env, holdValue: await freshHold() });
    expect(res.status).toBe(409);
    expectHoldExpired(res);
    expect(rec.urls).toHaveLength(0);
    expect(appRowCount(env)).toBe(1);
    const html = await res.text();
    expect(html).toContain("already connected");
    expect(html).not.toContain("BEGIN");
    expect(html).not.toContain(FAKE_WEBHOOK_SECRET);
  });

  test("logged out → 302 to login, zero writes, hold kept (operator can sign back in)", async () => {
    const rec = stubFetchRecording();
    const res = await doCommit({ withSession: false, holdValue: await freshHold() });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    expect(rec.urls).toHaveLength(0);
    expectHoldKept(res);
  });

  test("Accept-Language zh renders the onboarding page after a successful commit (plan 31 T5)", async () => {
    stubFetchRecording();
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const env = commitEnv();
    const res = await doCommit({
      env,
      holdValue: await freshHold(),
      extraHeaders: { "Accept-Language": "zh-CN,zh;q=0.9" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/apps/mstar-inspector-octocat/onboarding");
    const landing = await worker.fetch(
      new Request("https://worker.local/dashboard/apps/mstar-inspector-octocat/onboarding", {
        headers: { Cookie: `${SESSION_COOKIE}=${session}`, "Accept-Language": "zh-CN,zh;q=0.9" },
      }),
      env,
    );
    expect(landing.status).toBe(200);
    const body = await landing.text();
    expect(body).toContain('lang="zh-CN"');
    expect(body).toContain("GitHub App 已连接");
    expect(body).toContain("下一步：打开设置并配置 provider");
    expect(body).not.toContain("GitHub App connected");
    expect(body).not.toContain("REVIEW_ENABLED");
  });

  test("Accept-Language zh renders the retryable commit error in zh_CN (plan 29 T7)", async () => {
    stubFetchRecording();
    const res = await doCommit({
      env: commitEnv({ DASHBOARD_ENCRYPTION_KEY: undefined }),
      holdValue: await freshHold(),
      extraHeaders: { "Accept-Language": "zh-CN,zh;q=0.9" },
    });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('lang="zh-CN"');
    expect(body).toContain("GitHub App 设置失败");
    expect(body).not.toContain("GitHub App setup failed");
    expect(body).not.toContain("REVIEW_ENABLED");
  });
});

describe("/dashboard placeholder lock + legacy home retirement (plan 11 Task 3 + plan 30 T4)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("legacy three-card home is retired: no dashboardPage/section code remains (plan 30 T4)", () => {
    const views = readFileSync(join(import.meta.dir, "../../src/dashboard/views.ts"), "utf8");
    for (const symbol of ["dashboardPage", "placeholderSection", "githubAppSection", "modelKeysSection"]) {
      expect(views, symbol).not.toContain(symbol);
    }
    // The import line is gone from index.ts (the retirement comment may
    // still name the symbol narratively).
    const index = readFileSync(join(import.meta.dir, "../../src/dashboard/index.ts"), "utf8");
    expect(index).not.toContain("dashboardPage,");
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

  test("bare POST /webhook is 404 — the legacy face is retired and the dashboard mount does not intercept it", async () => {
    const db = createDashboardTestD1();
    applyMigrationFile(db.raw, "0011_webhook_deliveries.sql");
    const sent: unknown[] = [];
    const env = makeDbEnv(db, {
      REVIEW_ENABLED: "true",
      REVIEW_QUEUE: { send: async (msg: unknown) => { sent.push(msg); } } as unknown as Env["REVIEW_QUEUE"],
    });
    const res = await worker.fetch(
      new Request("https://worker.local/webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": "sha256=deadbeef", "x-github-event": "pull_request" },
        body: "{}",
      }),
      env,
    );
    // No bare route exists (plan 24 Task 1) — Hono's default 404, zero
    // enqueue, zero delivery rows; the dashboard mount never intercepts it.
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
    const rows = db.raw.query("SELECT COUNT(*) AS n FROM webhook_deliveries").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

// --- plan 12 T1 + plan 13 T3: D1 fixture + dashboard membership --------------
// Local mirror of tests/store/helpers.ts createTestD1 (which pins 0001+0002
// and sits outside this plan's file set): migrations apply over a DB that
// ALREADY holds rows, so the fixture seeds a review row between 0002 and
// 0003 (plan 12 T1 AC). Plan 13 B5 extends the production shape through
// 0005 — /dashboard routes (manifest start/commit, apps UI) read/write
// github_apps — with a `through` index kept for pre-plan-13 DB premises.

function applyMigrationFile(db: Database, name: string): void {
  db.exec(readFileSync(join(import.meta.dir, "../../migrations", name), "utf8"));
}

const DASHBOARD_MIGRATION_SEQUENCE = [
  "0001_reviews.sql",
  "0002_mstar_review_v1.sql",
  "0003_dashboard_users.sql",
  "0004_github_apps.sql",
  "0005_reviews_app_id.sql",
  "0016_users_login_nocase_unique.sql",
] as const;

function createDashboardTestD1(
  through: number = DASHBOARD_MIGRATION_SEQUENCE.length,
): DashboardD1 & { raw: Database } {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const [index, name] of DASHBOARD_MIGRATION_SEQUENCE.entries()) {
    if (index >= through) break;
    // The seeded review row lands between 0002 and 0003 (see block comment).
    if (index === 2) {
      db.exec(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md)
         VALUES ('review-1', 123, 'acme', 'widgets', 42, '0123456789abcdef0123456789abcdef01234567', 'comment', 'No blocking issues.')`,
      );
    }
    applyMigrationFile(db, name);
  }
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

type DashboardTestDb = DashboardD1 & { raw: Database };

/** Commit-flow envs carry a full plan-13 DB — pull it back out for asserts. */
function dbOf(env: Env): DashboardTestDb {
  return (env as Env & { DB: DashboardTestDb }).DB;
}

function appRowCount(env: Env): number {
  return (dbOf(env).raw.query("SELECT COUNT(*) AS n FROM github_apps").get() as { n: number }).n;
}

/** Apps store over the env's DB (seeding colliding rows before a commit). */
function envDb(env: Env) {
  return createAppsStore(dbOf(env));
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

describe("GET /dashboard/apps/:slug/onboarding (plan 31 T5, AC4b)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function seedApp(env: Env, overrides: Partial<{ slug: string; githubAppId: number; name: string; createdBy: string; deletedAt: string | null }> = {}) {
    return envDb(env).createApp({
      id: crypto.randomUUID(),
      slug: overrides.slug ?? "mstar-inspector-octocat",
      githubAppId: overrides.githubAppId ?? CONVERSION.id,
      name: overrides.name ?? CONVERSION.name,
      privateKeyEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      webhookSecretEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      createdBy: overrides.createdBy ?? "octocat",
    }).then(async (row) => {
      if (!overrides.deletedAt) return row;
      await dbOf(env).raw
        .prepare(`UPDATE github_apps SET deleted_at = ? WHERE id = ?`)
        .run(overrides.deletedAt, row.id);
      return row;
    });
  }

  function onboardingRequest(slug: string, login = "octocat"): Promise<Request> {
    return createSessionValue(login, null, SESSION_SECRET).then((session) =>
      dashboardRequest(`/dashboard/apps/${slug}/onboarding`, `${SESSION_COOKIE}=${session}`),
    );
  }

  test("no session → 302 to login", async () => {
    const res = await worker.fetch(
      dashboardRequest("/dashboard/apps/mstar-inspector-octocat/onboarding"),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("unknown slug → 404 (settings-family unknown-app shape)", async () => {
    const res = await worker.fetch(await onboardingRequest("no-such-app"), makeEnv());
    expect(res.status).toBe(404);
  });

  test("soft-deleted App → 404", async () => {
    const env = makeEnv();
    await seedApp(env, { deletedAt: new Date().toISOString() });
    const res = await worker.fetch(await onboardingRequest("mstar-inspector-octocat"), env);
    expect(res.status).toBe(404);
  });

  test("member without manage (not the creator, not admin) → 403 forbidden page", async () => {
    const env = makeEnv();
    await seedApp(env, { createdBy: "someone-else" });
    const res = await worker.fetch(await onboardingRequest("mstar-inspector-octocat", "mallory"), env);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain(CONVERSION.name);
    expect(body).not.toContain(FAKE_PEM);
  });

  test("creator (member role) → 200 with name / id / slug / webhook URL + Settings CTA, no secrets", async () => {
    const env = makeEnv();
    const row = await seedApp(env, { createdBy: "octocat-with-a-long-login" });
    const res = await worker.fetch(await onboardingRequest(row.slug, "octocat-with-a-long-login"), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("mstar-inspector-octocat");
    expect(body).toContain(`<span class="id">${CONVERSION.id}</span>`);
    expect(body).toContain(`https://worker.local/webhook/${row.slug}`);
    expect(body).toContain(`href="/dashboard/apps/${row.slug}/settings"`);
    expect(body).toContain(">Open Settings</a>");
    expect(body).toContain("Next: open Settings and configure a provider");
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_PEM);
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
    expect(body).not.toContain("REVIEW_ENABLED");
  });

  test("admin views any App's onboarding page", async () => {
    const env = makeEnv();
    await seedApp(env, { createdBy: "someone-else" });
    const res = await worker.fetch(await onboardingRequest("mstar-inspector-octocat"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/dashboard/apps/mstar-inspector-octocat/settings"');
  });

  test("Accept-Language zh renders the onboarding page in zh_CN (plan 31 T5)", async () => {
    const env = makeEnv();
    await seedApp(env);
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const zh = await worker.fetch(
      new Request("https://worker.local/dashboard/apps/mstar-inspector-octocat/onboarding", {
        headers: { Cookie: `${SESSION_COOKIE}=${session}`, "Accept-Language": "zh-CN,zh;q=0.9" },
      }),
      env,
    );
    expect(zh.status).toBe(200);
    const body = await zh.text();
    expect(body).toContain('lang="zh-CN"');
    expect(body).toContain("GitHub App 已连接");
    expect(body).toContain("打开设置");
    expect(body).not.toContain("GitHub App connected");
    expect(body).not.toContain("Open Settings");
    expect(body).not.toContain("REVIEW_ENABLED");
  });
});

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

  test("createUser rejects a case-variant insert — the concurrent loser's 409 source (W-1, migration 0016)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "Alice", role: "member" });
    // Migration 0016 NOCASE unique index: a case-variant row cannot be
    // inserted even when the 0003 BINARY UNIQUE does not fire. The store
    // surfaces the conflict as DuplicateLoginError — the invite route maps
    // it to 409 duplicate-invite semantics.
    await expect(createUser(db, { login: "alice", role: "member" })).rejects.toThrow(DuplicateLoginError);
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

  test("deleteUserUnlessLastAdmin: members and non-last admins delete; the sole admin is refused (qc1 hardening)", async () => {
    const db = createDashboardTestD1();
    const admin = await createUser(db, { login: "octocat", role: "admin" });
    const member = await createUser(db, { login: "hubot", role: "member" });
    // Member row: unconditional delete.
    expect(await deleteUserUnlessLastAdmin(db, member.id)).toBe(true);
    expect(await getUserByLogin(db, "hubot")).toBeNull();
    // Sole admin: the conditional statement refuses, row intact.
    expect(await deleteUserUnlessLastAdmin(db, admin.id)).toBe(false);
    expect((await getUserByLogin(db, "octocat"))?.id).toBe(admin.id);
    expect(await countAdmins(db)).toBe(1);
    // With a second admin present, either row is deletable again.
    await createUser(db, { login: "ada", role: "admin" });
    expect(await deleteUserUnlessLastAdmin(db, admin.id)).toBe(true);
    expect(await countAdmins(db)).toBe(1);
    expect(await deleteUserUnlessLastAdmin(db, "missing-id")).toBe(false);
  });

  test("updateUserRoleUnlessLastAdmin: promotes members, demotes non-last admins, refuses the sole admin (plan 34 T1)", async () => {
    const db = createDashboardTestD1();
    const admin = await createUser(db, { login: "octocat", role: "admin" });
    const member = await createUser(db, { login: "hubot", role: "member" });
    // Member → admin promotion.
    expect(await updateUserRoleUnlessLastAdmin(db, member.id, "admin")).toBe(true);
    expect((await getUserByLogin(db, "hubot"))?.role).toBe("admin");
    // With two admins, either row is demotable.
    expect(await updateUserRoleUnlessLastAdmin(db, member.id, "member")).toBe(true);
    expect(await countAdmins(db)).toBe(1);
    expect((await getUserByLogin(db, "hubot"))?.role).toBe("member");
    // Now octocat IS the sole admin — demotion must refuse, row intact.
    expect(await updateUserRoleUnlessLastAdmin(db, admin.id, "member")).toBe(false);
    expect((await getUserByLogin(db, "octocat"))?.role).toBe("admin");
    expect(await countAdmins(db)).toBe(1);
    // Missing id → false; same-role set → false (no-op, changes === 0).
    expect(await updateUserRoleUnlessLastAdmin(db, "missing-id", "admin")).toBe(false);
    expect(await updateUserRoleUnlessLastAdmin(db, admin.id, "admin")).toBe(false);
    expect((await getUserByLogin(db, "octocat"))?.role).toBe("admin");
  });

  test("concurrent demotions of the last two admins cannot both land (TOCTOU closed by the single conditional UPDATE, plan 34 T1)", async () => {
    const db = createDashboardTestD1();
    const octocat = await createUser(db, { login: "octocat", role: "admin" });
    const ada = await createUser(db, { login: "ada", role: "admin" });
    // Interleaved demotions of the two admins: the single conditional
    // UPDATE serializes the last-admin check with the write, so exactly
    // one lands and the loser sees changes === 0 — no read-check-write
    // window (deleteUserUnlessLastAdmin precedent, qc1).
    const [a, b] = await Promise.all([
      updateUserRoleUnlessLastAdmin(db, octocat.id, "member"),
      updateUserRoleUnlessLastAdmin(db, ada.id, "member"),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await countAdmins(db)).toBe(1);
  });

  test("listUsers breaks created_at ties by github_login (deterministic order, qc1/qc3)", async () => {
    const db = createDashboardTestD1();
    const insert = db.raw.prepare(
      "INSERT INTO users (id, github_login, role, created_at) VALUES (?, ?, 'member', ?)",
    );
    const sameTs = "2026-01-01T00:00:00.000Z";
    insert.run("u-3", "zeta", sameTs);
    insert.run("u-1", "Alpha", sameTs);
    insert.run("u-2", "midway", sameTs);
    expect((await listUsers(db)).map((u) => u.github_login)).toEqual(["Alpha", "midway", "zeta"]);
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

  test("removed member with a valid cookie → 403 + expired session on API/fetch, 302 + expired session on HTML navigation (shell, manifest start/confirm/commit, catch-all)", async () => {
    // Zero network behind the guard: the denial must short-circuit BEFORE
    // the manifest conversion / Cloudflare secrets paths.
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls++;
      throw new Error("no network may run behind the guard");
    }) as unknown as typeof fetch;
    // Plan 30 W-001: production ALWAYS binds ASSETS, so GET /dashboard hits
    // spa-dispatch's own membership gate before the guard — the plan-12 403
    // contract is preserved there (PM decision), not only via the legacy
    // fall-through. Bind ASSETS so this test models production.
    const env = withSpaAssets(await removedMemberEnv());
    const cookie = `${SESSION_COOKIE}=${await mallorySession()}`;
    // GET shell (B0) — non-HTML Accept variants keep the removedPage 403
    // (plan 33 T3: a fetch must not silently follow a 302 into the HTML
    // login page), each with the session cookie expired.
    for (const accept of [undefined, "application/json"]) {
      const headers: Record<string, string> = { Cookie: cookie };
      if (accept) headers.Accept = accept;
      const shell = await worker.fetch(new Request("https://worker.local/dashboard", { headers }), env);
      expect(shell.status, accept ?? "no Accept").toBe(403);
      const body = await shell.text();
      // Removed-member page (not the shell): no identity header, no sections.
      expect(body).toContain("Your dashboard access was removed. Ask an admin to re-invite mallory.");
      expect(body).not.toContain("Signed in as");
      expect(body).not.toContain('action="/dashboard/manifest/start"');
      const setCookie = shell.headers.getSetCookie();
      expect(setCookie, accept ?? "no Accept").toHaveLength(1);
      expect(setCookie[0]).toContain(`${SESSION_COOKIE}=;`);
      expect(setCookie[0]).toContain("Max-Age=0");
    }
    // HTML navigation on the shell path → expire + 302 login (plan 33 T3).
    const htmlShell = await worker.fetch(
      new Request("https://worker.local/dashboard", {
        headers: { Cookie: cookie, Accept: "text/html" },
      }),
      env,
    );
    expect(htmlShell.status).toBe(302);
    expect(htmlShell.headers.get("Location")).toBe("/dashboard/login");
    expect(htmlShell.headers.getSetCookie()).toHaveLength(1);
    // POST manifest start (B1) — fetch → 403 + expired session
    const start = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/start", {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      env,
    );
    expect(start.status).toBe(403);
    expect(start.headers.getSetCookie()).toHaveLength(1);
    // GET manifest confirm (B1 resume gate) — non-HTML → 403 + expired session
    const confirm = await worker.fetch(dashboardRequest("/dashboard/manifest/confirm", cookie), env);
    expect(confirm.status).toBe(403);
    expect(confirm.headers.getSetCookie()).toHaveLength(1);
    // POST manifest commit (B1 confirm gate) — guard fires before secret work
    // (no body: the commit route retired the confirm=overwrite requirement in
    // plan 13 T3, and the guard 403s before any handler logic anyway).
    const commit = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/commit", {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      env,
    );
    expect(commit.status).toBe(403);
    expect(commit.headers.getSetCookie()).toHaveLength(1);
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
    expect(future.headers.getSetCookie()).toHaveLength(1);
    expect(networkCalls).toBe(0);
  });

  test("removed member HTML navigation on a non-enumerated route → expire + 302 login (guard, plan 33 T3)", async () => {
    // GET /dashboard/manifest/confirm is not an enumerated SPA page, so it
    // falls through to the legacy guard — HTML navigation there must expire
    // the session and 302 to login, not render the removedPage.
    const env = withSpaAssets(await removedMemberEnv());
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/confirm", {
        headers: { Cookie: `${SESSION_COOKIE}=${await mallorySession()}`, Accept: "text/html" },
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toContain(`${SESSION_COOKIE}=;`);
    expect(setCookie[0]).toContain("Max-Age=0");
  });

  test("removed member CAN log out: logout is session-gated, not membership-gated (qc2 F-002)", async () => {
    // L5: /logout is NOT in the exempt set — a session-less visitor still
    // 302s (pinned below). But a VALID session with no user row must reach
    // the route so its owner can burn the stale cookie: the normal
    // expired-cookie response (session + manifest hold + state), 302 login.
    const res = await worker.fetch(
      dashboardRequest("/dashboard/logout", `${SESSION_COOKIE}=${await mallorySession()}`),
      await removedMemberEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(3);
    for (const name of [SESSION_COOKIE, MANIFEST_HOLD_COOKIE, MANIFEST_STATE_COOKIE]) {
      const cookie = setCookie.find((c) => c.startsWith(`${name}=;`));
      expect(cookie, name).toBeDefined();
      expect(cookie).toContain("Max-Age=0");
    }
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

  test("member requests pass the guard and reach the routes unchanged (SPA shell + B1 manifest)", async () => {
    const env = makeEnv();
    const cookie = `${SESSION_COOKIE}=${await createSessionValue("octocat", null, SESSION_SECRET)}`;
    const shell = await worker.fetch(dashboardRequest("/dashboard", cookie), withSpaAssets(env));
    expect(shell.status).toBe(200);
    const shellBody = await shell.text();
    expect(shellBody).toContain("window.__BOOT__=");
    expect(shellBody).toContain('"login":"octocat"');
    // Plan 30 W-001: the shell gate's shared D1 lookup still resolves the
    // role for valid members (octocat is the seeded admin).
    expect(shellBody).toContain('"role":"admin"');
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
      withSpaAssets(makeEnv()),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"login":"OctoCat"');
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
    // Plan 30 W-001: ASSETS is always bound in production, so the shell-path
    // denial fires in spa-dispatch's membership gate (stage spa_dispatch), not
    // the legacy guard — the structured event is identical otherwise.
    const warns = spyOnWarn();
    await worker.fetch(
      dashboardRequest("/dashboard", `${SESSION_COOKIE}=${await mallorySession()}`),
      withSpaAssets(await removedMemberEnv()),
    );
    expect(warns).toHaveLength(1);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.event).toBe("dashboard_access");
    expect(entry.stage).toBe("spa_dispatch");
    expect(entry.reason).toBe("not_a_member");
    expect(entry.login).toBe("mallory");
  });
});

// --- plan 12 T3: members page (admin-only) + DESIGN mapping ------------------

describe("members page (plan 12 T3, admin-only)", () => {
  const adminCookie = async () =>
    `${SESSION_COOKIE}=${await createSessionValue("octocat", null, SESSION_SECRET)}`;
  const memberCookie = async () =>
    `${SESSION_COOKIE}=${await createSessionValue("mallory", null, SESSION_SECRET)}`;

  // Plan 29 T6/T7: /dashboard/members is SPA-owned (shared spa helper).

  async function membersGet(cookie: string, env?: Env): Promise<Response> {
    return await worker.fetch(dashboardRequest("/dashboard/members", cookie), env ?? makeEnv());
  }

  async function membersPost(
    path: string,
    cookie: string,
    body: string,
    env?: Env,
  ): Promise<Response> {
    return await worker.fetch(
      new Request(`https://worker.local/dashboard/members/${path}`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
      env ?? makeEnv(),
    );
  }

  test("the pinned POSTs sit behind the guard: no session → 302 to login; the HTML GET 302s too (plan 33 T3)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    // HTML navigation GET without a session → 302 login (plan 33 T3 — the
    // old null-boot shell was the render-then-kick flash source).
    const get = await htmlGet("/dashboard/members", "", withSpaAssets(makeDbEnv(db)));
    expect(get.status).toBe(302);
    expect(get.headers.get("Location")).toBe("/dashboard/login");
    const post = await membersPost("invite", "", "login=hubot", makeDbEnv(db));
    expect(post.status).toBe(302);
    expect(post.headers.get("Location")).toBe("/dashboard/login");
  });

  test("the legacy SSR handler is gone: a non-HTML GET falls through to the legacy app (guard 302)", async () => {
    const db = createDashboardTestD1();
    const res = await membersGet("", makeDbEnv(db));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("admin HTML GET → 200 SPA index (the members data contract lives on GET /api/members)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const res = await htmlGet("/dashboard/members", await adminCookie(), withSpaAssets(makeDbEnv(db)));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).not.toContain(SPA_BOOT_MARKER);
  });

  test("non-admin HTML GET → 200 SPA index (the 403 face is the API route, tested in spa-page-apis)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    await createUser(db, { login: "mallory", role: "member" });
    const res = await htmlGet("/dashboard/members", await memberCookie(), withSpaAssets(makeDbEnv(db)));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("window.__BOOT__=");
  });

  test("non-admin POST invite → 403, zero mutations", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    await createUser(db, { login: "mallory", role: "member" });
    const res = await membersPost("invite", await memberCookie(), "login=hubot", makeDbEnv(db));
    expect(res.status).toBe(403);
    expect(userCount(db)).toBe(2);
    expect(await getUserByLogin(db, "hubot")).toBeNull();
  });

  test("non-admin POST remove → 403, zero mutations (target row intact)", async () => {
    const db = createDashboardTestD1();
    const admin = await createUser(db, { login: "octocat", role: "admin" });
    await createUser(db, { login: "mallory", role: "member" });
    const res = await membersPost("remove", await memberCookie(), `userId=${admin.id}`, makeDbEnv(db));
    expect(res.status).toBe(403);
    expect(userCount(db)).toBe(2);
    expect((await getUserByLogin(db, "octocat"))?.id).toBe(admin.id);
  });

  test("admin invite → 200, member row created with invitedBy (input trimmed)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const res = await membersPost("invite", await adminCookie(), "login=%20%20hubot%20%20", makeDbEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    const row = await getUserByLogin(db, "hubot");
    expect(row?.role).toBe("member");
    expect(row?.invited_by).toBe("octocat");
    expect(userCount(db)).toBe(2);
  });

  test("T1 pin (Minor 2): invite resolves case variants — existing login → idempotent no-op, NO second row", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "OctoCat", role: "admin" });
    // Sequential path: the NOCASE pre-read catches the case variant and
    // answers the idempotent no-op. (The CONCURRENT window is closed by the
    // migration 0016 NOCASE unique index — pinned by the W-1 race test.)
    const res = await membersPost("invite", await adminCookie(), "login=octocat", makeDbEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(userCount(db)).toBe(1);
  });

  test("invite empty / whitespace login → 400, zero rows", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    for (const value of ["", "%20%20%20"]) {
      const res = await membersPost("invite", await adminCookie(), `login=${value}`, makeDbEnv(db));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Enter a GitHub login");
    }
    expect(userCount(db)).toBe(1);
  });

  test("invite invalid GitHub login syntax → 400, zero rows (qc1/qc2 F-003)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    // Spaces, symbols, >39 chars, non-ASCII — all can never match a real
    // GitHub login, so none may persist as a member row.
    const invalid = [
      "has%20space",
      "under_score",
      "dot.name",
      "a".repeat(40),
      "emoji%F0%9F%99%82",
    ];
    for (const value of invalid) {
      const res = await membersPost("invite", await adminCookie(), `login=${value}`, makeDbEnv(db));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("not a valid GitHub login");
    }
    expect(userCount(db)).toBe(1);
  });

  test("invite accepts the 39-char login boundary (F-003 regex upper bound)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const long = "a".repeat(39);
    const res = await membersPost("invite", await adminCookie(), `login=${long}`, makeDbEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect((await getUserByLogin(db, long))?.role).toBe("member");
  });

  test("self-remove → 400, row intact (the only admin is always the actor, so this is also the last-admin case)", async () => {
    const db = createDashboardTestD1();
    const admin = await createUser(db, { login: "octocat", role: "admin" });
    const res = await membersPost("remove", await adminCookie(), `userId=${admin.id}`, makeDbEnv(db));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("You cannot remove yourself.");
    expect(await countAdmins(db)).toBe(1);
    expect(userCount(db)).toBe(1);
  });

  test("removing another admin succeeds while 2 admins exist; the remaining last admin cannot then be removed", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const ada = await createUser(db, { login: "ada", role: "admin" });
    const ok = await membersPost("remove", await adminCookie(), `userId=${ada.id}`, makeDbEnv(db));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("ok");
    expect(await countAdmins(db)).toBe(1);
    // Now octocat IS the last admin — removal must refuse, row intact.
    const octocat = await getUserByLogin(db, "octocat");
    const refused = await membersPost("remove", await adminCookie(), `userId=${octocat?.id}`, makeDbEnv(db));
    expect(refused.status).toBe(400);
    expect(await countAdmins(db)).toBe(1);
    expect(userCount(db)).toBe(1);
  });

  test("remove unknown / blank userId → 400, rows intact", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    await createUser(db, { login: "mallory", role: "member" });
    for (const value of ["missing-id", ""]) {
      const res = await membersPost("remove", await adminCookie(), `userId=${value}`, makeDbEnv(db));
      expect(res.status).toBe(400);
    }
    expect(userCount(db)).toBe(2);
  });

  test("remove member → 200, row gone; the removed member's old cookie then 403s everywhere", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const mallory = await createUser(db, { login: "mallory", role: "member" });
    const staleCookie = await memberCookie(); // minted BEFORE the removal
    const res = await membersPost("remove", await adminCookie(), `userId=${mallory.id}`, makeDbEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(await getUserByLogin(db, "mallory")).toBeNull();
    // Done criterion: a removed member cannot reach any /dashboard/** route
    // with the still-valid session cookie. Plan 30 W-001: production always
    // binds ASSETS, so the shell path is denied by spa-dispatch's membership
    // gate — bind ASSETS to model production, not the legacy fall-through.
    const shell = await worker.fetch(
      dashboardRequest("/dashboard", staleCookie),
      withSpaAssets(makeDbEnv(db)),
    );
    expect(shell.status).toBe(403);
  });

  test("non-admin POST role → 403, zero mutations (plan 34 T1)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const mallory = await createUser(db, { login: "mallory", role: "member" });
    const res = await membersPost("role", await memberCookie(), `userId=${mallory.id}&role=admin`, makeDbEnv(db));
    expect(res.status).toBe(403);
    expect((await getUserByLogin(db, "mallory"))?.role).toBe("member");
    expect(userCount(db)).toBe(2);
  });

  test("admin role change member → admin → 200, row updated (plan 34 T1)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const mallory = await createUser(db, { login: "mallory", role: "member" });
    const res = await membersPost("role", await adminCookie(), `userId=${mallory.id}&role=admin`, makeDbEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect((await getUserByLogin(db, "mallory"))?.role).toBe("admin");
    expect(await countAdmins(db)).toBe(2);
  });

  test("admin role change admin → member succeeds while 2 admins exist; the remaining last admin cannot then be demoted (plan 34 T1)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const ada = await createUser(db, { login: "ada", role: "admin" });
    const ok = await membersPost("role", await adminCookie(), `userId=${ada.id}&role=member`, makeDbEnv(db));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("ok");
    expect(await countAdmins(db)).toBe(1);
    // Now octocat IS the last admin — demotion must refuse, row intact.
    // The actor is the only admin, so the self-demotion refusal fires
    // (the "last admin" pre-check is unreachable at the route level: when
    // countAdmins === 1 the actor IS the target — same shape as remove).
    // The last-admin ENFORCEMENT itself is pinned by the store-level test
    // and the concurrent race test below.
    const octocat = await getUserByLogin(db, "octocat");
    const refused = await membersPost("role", await adminCookie(), `userId=${octocat?.id}&role=member`, makeDbEnv(db));
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("You cannot change your own role.");
    expect((await getUserByLogin(db, "octocat"))?.role).toBe("admin");
    expect(await countAdmins(db)).toBe(1);
  });

  test("self-demotion → 400, row intact (the only admin is always the actor, so this is also the last-admin case) (plan 34 T1)", async () => {
    const db = createDashboardTestD1();
    const admin = await createUser(db, { login: "octocat", role: "admin" });
    const res = await membersPost("role", await adminCookie(), `userId=${admin.id}&role=member`, makeDbEnv(db));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("You cannot change your own role.");
    expect((await getUserByLogin(db, "octocat"))?.role).toBe("admin");
    expect(await countAdmins(db)).toBe(1);
  });

  test("role change unknown / blank userId → 400, rows intact (plan 34 T1)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    await createUser(db, { login: "mallory", role: "member" });
    for (const value of ["missing-id", ""]) {
      const res = await membersPost("role", await adminCookie(), `userId=${value}&role=admin`, makeDbEnv(db));
      expect(res.status).toBe(400);
    }
    expect(userCount(db)).toBe(2);
  });

  test("role change with a role outside the 0003 CHECK domain → 400, rows intact (plan 34 T1)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const mallory = await createUser(db, { login: "mallory", role: "member" });
    for (const role of ["owner", "", "ADMIN"]) {
      const res = await membersPost("role", await adminCookie(), `userId=${mallory.id}&role=${role}`, makeDbEnv(db));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Role must be admin or member.");
    }
    expect((await getUserByLogin(db, "mallory"))?.role).toBe("member");
    expect(userCount(db)).toBe(2);
  });

  test("invite with role=admin → 200, admin row created with invitedBy (plan 34 T1)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const res = await membersPost("invite", await adminCookie(), "login=ada&role=admin", makeDbEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    const row = await getUserByLogin(db, "ada");
    expect(row?.role).toBe("admin");
    expect(row?.invited_by).toBe("octocat");
    expect(await countAdmins(db)).toBe(2);
  });

  test("invite with a role outside the 0003 CHECK domain → 400, zero rows (plan 34 T1)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    for (const role of ["owner", "ADMIN"]) {
      const res = await membersPost("invite", await adminCookie(), `login=ada&role=${role}`, makeDbEnv(db));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Role must be admin or member.");
    }
    expect(userCount(db)).toBe(1);
    expect(await getUserByLogin(db, "ada")).toBeNull();
  });

  test("concurrent demotions of the last two admins: exactly one lands, the loser 400s (TOCTOU closed, plan 34 T1)", async () => {
    const db = createDashboardTestD1();
    const octocat = await createUser(db, { login: "octocat", role: "admin" });
    const ada = await createUser(db, { login: "ada", role: "admin" });
    const adaCookie = async () =>
      `${SESSION_COOKIE}=${await createSessionValue("ada", null, SESSION_SECRET)}`;
    // Two different admin actors demote each other concurrently. Both
    // pre-checks can pass (2 admins), but the single conditional UPDATE
    // serializes the last-admin check with the write — exactly one lands.
    // The loser is refused either way: 403 when its actor was already
    // demoted before requireAdmin re-read the row, or 400 when the
    // pre-check / conditional UPDATE catches the race.
    const [a, b] = await Promise.all([
      membersPost("role", await adminCookie(), `userId=${ada.id}&role=member`, makeDbEnv(db)),
      membersPost("role", await adaCookie(), `userId=${octocat.id}&role=member`, makeDbEnv(db)),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses[0]).toBe(200); // exactly one demotion lands
    expect(statuses[1]).toBeGreaterThanOrEqual(400); // the loser is refused
    expect(await countAdmins(db)).toBe(1);
  });

  test("concurrent case-variant invites: exactly one row, the loser is refused (W-1, migration 0016)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    // Two admins invite the same GitHub identity in different cases at the
    // same time. The NOCASE pre-read closes the sequential path; the 0016
    // NOCASE unique index closes the concurrent window — exactly one row
    // can land. The loser is either the sequential idempotent no-op (200 —
    // on this single-connection harness its NOCASE pre-read serializes
    // after the winner's commit) or the concurrent race refusal (409 — its
    // insert hit the 0016 index; the DuplicateLoginError → 409 mapping is
    // pinned by the store-level test above). Never a 5xx, never two rows.
    const [a, b] = await Promise.all([
      membersPost("invite", await adminCookie(), "login=Alice", makeDbEnv(db)),
      membersPost("invite", await adminCookie(), "login=alice", makeDbEnv(db)),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses[0]).toBe(200); // exactly one invite lands
    expect(statuses[1]).toBeGreaterThanOrEqual(200); // the loser is refused (200 no-op or 409 race)
    expect(statuses[1]).toBeLessThan(500); // never a 5xx
    expect(userCount(db)).toBe(2); // octocat + exactly one of Alice/alice
    const invited = (await listUsers(db)).filter((m) => m.github_login.toLowerCase() === "alice");
    expect(invited).toHaveLength(1);
  });

  test("demoted admin's old cookie → 403 on the members API (role change invalidates admin access immediately, QC S-001)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const ada = await createUser(db, { login: "ada", role: "admin" });
    const staleAdminCookie = `${SESSION_COOKIE}=${await createSessionValue("ada", null, SESSION_SECRET)}`; // minted BEFORE the demotion
    const res = await membersPost("role", await adminCookie(), `userId=${ada.id}&role=member`, makeDbEnv(db));
    expect(res.status).toBe(200);
    expect((await getUserByLogin(db, "ada"))?.role).toBe("member");
    // The demoted admin's still-valid session cookie must not reach the
    // members API — requireAdmin re-reads the row and fails closed (403),
    // mirroring the remove-path cookie invalidation pin (:3088-3105).
    const api = await worker.fetch(
      dashboardRequest("/dashboard/api/members", staleAdminCookie),
      withSpaAssets(makeDbEnv(db)),
    );
    expect(api.status).toBe(403);
  });

  test("T1 pin (Minor 1): ADMIN_LOGINS docs name the real var mechanism, not the nonexistent `wrangler vars put`", async () => {
    const example = await Bun.file(new URL("../../.env.example", import.meta.url)).text();
    expect(example).toContain("ADMIN_LOGINS");
    expect(example).not.toContain("wrangler vars put");
    const envTs = await Bun.file(new URL("../../src/worker/env.ts", import.meta.url)).text();
    expect(envTs).toContain("ADMIN_LOGINS");
    expect(envTs).not.toContain("wrangler vars put");
  });
});
// --- plan 22 T2: Review Health insights summary API --------------------------
// GET /dashboard/api/insights/summary — the JSON read face for the insights
// aggregation (src/dashboard/insights-store.ts). The guard is the SAME
// mount-level membership gate as every other /dashboard route (AL-22-1: zero
// new auth code); these tests pin that regression plus the query-param
// contract (window parse + clamp echo, repo filter) against a fixture D1.

type InsightsFixtureFinding = {
  id: string;
  severity: string;
  category: string | null;
  title: string;
  fingerprint: string | null;
};

/** Raw-insert one review + its findings (explicit reviewed_at / verdict). */
function seedInsightsReview(
  db: DashboardTestDb,
  opts: {
    id: string;
    owner: string;
    repo: string;
    pr_number: number;
    reviewedAt: string;
    verdict: string;
    findings: InsightsFixtureFinding[];
  },
): void {
  db.raw
    .query(
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, summary_md, envelope)
       VALUES (?, 123, ?, ?, ?, 'sha', ?, ?, 's', '{}')`,
    )
    .run(opts.id, opts.owner, opts.repo, opts.pr_number, opts.reviewedAt, opts.verdict);
  const insertFinding = db.raw.query(
    `INSERT INTO findings (id, review_id, severity, category, title, body, fingerprint)
     VALUES (?, ?, ?, ?, ?, 'b', ?)`,
  );
  for (const f of opts.findings) {
    insertFinding.run(f.id, opts.id, f.severity, f.category, f.title, f.fingerprint);
  }
}

/**
 * A member-seeded, insights-fixture D1 env:
 *   - r-a acme/widgets PR 1, 25d ago, verdict "comment": must-fix/logic fp-x,
 *     nit/NULL-category fp-y
 *   - r-b acme/widgets PR 2, 15d ago, verdict "approve": must-fix/logic fp-x
 *     (shares fp-x with r-a → recurrence, count 2)
 *   - r-c globex/gadgets PR 3, 5d ago, verdict "request changes":
 *     should-fix/security fp-z (single occurrence → never recurs)
 *   - r-d acme/widgets PR 4, 60d ago, verdict "approve", no findings —
 *     inside a 90-day window, outside the default 30
 * The interleaved sentinel `review-1` (createDashboardTestD1 seeds it between
 * 0002 and 0003) is deleted so every aggregation counts ONLY these rows.
 */
function insightsFixtureEnv(): Env {
  const db = createDashboardTestD1();
  const insertUser = db.raw.prepare(
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, ?, ?, NULL)",
  );
  for (const [login, role] of DEFAULT_SEEDED_MEMBERS) {
    insertUser.run(crypto.randomUUID(), login, role, new Date().toISOString());
  }
  db.raw.query("DELETE FROM reviews WHERE id = 'review-1'").run();
  seedInsightsReview(db, {
    id: "r-a",
    owner: "acme",
    repo: "widgets",
    pr_number: 1,
    reviewedAt: reviewedAt(25),
    verdict: "comment",
    findings: [
      { id: "f-a1", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: "fp-x" },
      { id: "f-a2", severity: "nit", category: null, title: "Trailing space", fingerprint: "fp-y" },
    ],
  });
  seedInsightsReview(db, {
    id: "r-b",
    owner: "acme",
    repo: "widgets",
    pr_number: 2,
    reviewedAt: reviewedAt(15),
    verdict: "approve",
    findings: [
      { id: "f-b1", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: "fp-x" },
    ],
  });
  seedInsightsReview(db, {
    id: "r-c",
    owner: "globex",
    repo: "gadgets",
    pr_number: 3,
    reviewedAt: reviewedAt(5),
    verdict: "request changes",
    findings: [
      { id: "f-c1", severity: "should-fix", category: "security", title: "Injection", fingerprint: "fp-z" },
    ],
  });
  seedInsightsReview(db, {
    id: "r-d",
    owner: "acme",
    repo: "widgets",
    pr_number: 4,
    reviewedAt: reviewedAt(60),
    verdict: "approve",
    findings: [],
  });
  return makeDbEnv(db);
}

function insightsUrl(query: string): string {
  return `/dashboard/api/insights/summary${query === "" ? "" : `?${query}`}`;
}

describe("/dashboard/api/insights/summary (plan 22 Task 2)", () => {
  const octocatCookie = async () => `${SESSION_COOKIE}=${await createSessionValue("octocat", null, SESSION_SECRET)}`;
  const malloryCookie = async () => `${SESSION_COOKIE}=${await createSessionValue("mallory", null, SESSION_SECRET)}`;

  async function insightsGet(query: string, cookie: string, env?: Env): Promise<Response> {
    return await worker.fetch(dashboardRequest(insightsUrl(query), cookie), env ?? insightsFixtureEnv());
  }

  test("guard three states: no session 302, removed member 403, non-admin member 200", async () => {
    // Session-less → the shared OAuth redirect; the route never runs.
    const anon = await worker.fetch(dashboardRequest(insightsUrl("")), insightsFixtureEnv());
    expect(anon.status).toBe(302);
    expect(anon.headers.get("Location")).toBe("/dashboard/login");

    // Removed member (valid cookie, no user row) → 403 removed-page.
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const mallory = await createUser(db, { login: "mallory", role: "member" });
    await deleteUser(db, mallory.id);
    const removed = await worker.fetch(
      dashboardRequest(insightsUrl(""), await malloryCookie()),
      makeDbEnv(db),
    );
    expect(removed.status).toBe(403);
    expect(await removed.text()).toContain("Your dashboard access was removed");

    // Non-admin member (mallory is role "member") → 200 JSON.
    const member = await worker.fetch(dashboardRequest(insightsUrl(""), await malloryCookie()), insightsFixtureEnv());
    expect(member.status).toBe(200);
    expect(((await member.json()) as { reviews_total: number }).reviews_total).toBe(3);
  });

  test("default params: full JSON shape, 30-day window, no repo key", async () => {
    const res = await insightsGet("", await octocatCookie());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window_days: number;
      repo?: string;
      reviews_total: number;
      findings_by_severity: Array<{ severity: string; count: number }>;
      findings_by_category: Array<{ category: string | null; count: number }>;
      verdict_distribution: Array<{ verdict: string; count: number }>;
      weekly_trend: Array<{ week_start: string; reviews: number; findings: number }>;
      recurring_top: Array<{ fingerprint: string; title_sample: string; count: number; repos: string[] }>;
    };
    // Exact key set: store return + the two echo params (snake_case API).
    expect(Object.keys(body).sort()).toEqual(
      [
        "window_days",
        "reviews_total",
        "findings_by_severity",
        "findings_by_category",
        "verdict_distribution",
        "weekly_trend",
        "recurring_top",
      ].sort(),
    );
    expect(body.repo).toBeUndefined();
    expect(body.window_days).toBe(30);
    expect(body.reviews_total).toBe(3); // r-d (60d) is outside the default window
    expect(body.findings_by_severity).toEqual([
      { severity: "must-fix", count: 2 },
      { severity: "nit", count: 1 },
      { severity: "should-fix", count: 1 },
    ]);
    expect(body.findings_by_category).toEqual([
      { category: "logic", count: 2 },
      { category: null, count: 1 },
      { category: "security", count: 1 },
    ]);
    expect(body.verdict_distribution).toEqual([
      { verdict: "approve", count: 1 },
      { verdict: "comment", count: 1 },
      { verdict: "request changes", count: 1 },
    ]);
    // The three in-window reviews are 10 days apart → always three distinct
    // Monday-anchored weeks; buckets ascend oldest → newest.
    const weekA = mondayOf(reviewedAt(25));
    const weekB = mondayOf(reviewedAt(15));
    const weekC = mondayOf(reviewedAt(5));
    expect(new Set([weekA, weekB, weekC]).size).toBe(3);
    expect(body.weekly_trend).toEqual([
      { week_start: weekA, reviews: 1, findings: 2 },
      { week_start: weekB, reviews: 1, findings: 1 },
      { week_start: weekC, reviews: 1, findings: 1 },
    ]);
    expect(body.recurring_top).toEqual([
      { fingerprint: "fp-x", title_sample: "Null deref risk", count: 2, repos: ["acme/widgets"] },
    ]);
  });

  test("window parse: non-integer, negative, and empty → 400; 0 is a legal day count", async () => {
    const cookie = await octocatCookie();
    for (const window of ["abc", "30.5", "1e2", "-5", "+5", ""]) {
      const res = await insightsGet(`window=${window}`, cookie);
      expect(res.status, `window=${window}`).toBe(400);
      expect(((await res.json()) as { error?: string }).error, `window=${window}`).toContain("window");
    }
    // AL-22-1: only negative is malformed — zero is a valid integer window.
    const zero = await insightsGet("window=0", cookie);
    expect(zero.status).toBe(200);
    const zeroBody = (await zero.json()) as { window_days: number; reviews_total: number };
    expect(zeroBody.window_days).toBe(0);
    expect(zeroBody.reviews_total).toBe(0);
  });

  test("window=400 clamps to 90: non-4xx, effective window echoed, r-d enters the window", async () => {
    const res = await insightsGet("window=400", await octocatCookie());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window_days: number;
      reviews_total: number;
      weekly_trend: unknown[];
    };
    // The response echoes the EFFECTIVE window (the store's single clamp
    // point at 90), not the raw request value.
    expect(body.window_days).toBe(90);
    expect(body.reviews_total).toBe(4); // r-d (60d) now fits the 90-day window
    expect(body.weekly_trend).toHaveLength(4);
  });

  test("repo filter: valid owner/repo echoed and forwarded; each aggregation restricted", async () => {
    const res = await insightsGet("repo=globex/gadgets", await octocatCookie());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repo: string;
      reviews_total: number;
      findings_by_severity: Array<{ severity: string; count: number }>;
      recurring_top: unknown[];
    };
    expect(body.repo).toBe("globex/gadgets");
    expect(body.reviews_total).toBe(1);
    expect(body.findings_by_severity).toEqual([{ severity: "should-fix", count: 1 }]);
    expect(body.recurring_top).toEqual([]); // fp-z appears once → no recurrence
  });

  test("repo parse: malformed owner/repo → 400 (no slash, extra slash, whitespace, empty parts)", async () => {
    const cookie = await octocatCookie();
    for (const repo of ["oops", "owner/repo/extra", "owner%20x/repo", "/repo", "owner/"]) {
      const res = await insightsGet(`repo=${repo}`, cookie);
      expect(res.status, `repo=${repo}`).toBe(400);
      expect(((await res.json()) as { error?: string }).error, `repo=${repo}`).toContain("repo");
    }
  });

  test("window + repo combine: both echoed, aggregation filtered with a custom window", async () => {
    const res = await insightsGet("window=20&repo=acme/widgets", await octocatCookie());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window_days: number;
      repo: string;
      reviews_total: number;
      weekly_trend: unknown[];
    };
    expect(body.window_days).toBe(20);
    expect(body.repo).toBe("acme/widgets");
    // 20-day window: r-a (25d) drops out — only r-b (15d) remains for acme.
    expect(body.reviews_total).toBe(1);
    expect(body.weekly_trend).toHaveLength(1);
  });
});

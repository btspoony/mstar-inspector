import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../../src/worker/index";
import { APP_VERSION } from "../../src/version";
import { exchangeCodeForToken, fetchGitHubUser } from "../../src/dashboard/oauth";
import type { Env } from "../../src/worker/env";
import {
  countUsers,
  createUser,
  deleteUser,
  deleteWorkspaceMember,
  DuplicateLoginError,
  getUserByLogin,
  isLoginRemoved,
  listUsers,
  parseLoginList,
  signInDashboardUser,
  updateWorkspaceMemberRole,
  type DashboardD1,
  type DashboardD1BatchResult,
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
  createHoldValue,
  createManifestStateValue,
  exchangeManifestCode,
  readHoldValue,
} from "../../src/dashboard/manifest";
import {
  errorPage,
  forbiddenPage,
  manifestConfirmPage,
  manifestErrorPage,
  manifestOnboardingPage,
  manifestStartPage,
  removedPage,
} from "../../src/dashboard/views";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { execMigrationScript } from "../store/helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { normalizePrivateKey } from "../../src/dashboard/private-key";
import { normalizePrivateKey as pipelineNormalizePrivateKey } from "../../src/pipeline/comment";
import { LOCALE_COOKIE, t } from "../../src/i18n";
import { SPA_BOOT_MARKER, htmlGet, withSpaAssets } from "../helpers/spa";
import { SPA_POST_FORM_HEADER, SPA_POST_FORM_VALUE } from "../../src/spa/post-form-headers";
import { replaceWorkspaceRef } from "../../src/spa/routes";
import { buildWorkspaceSwitcherModel } from "../../src/spa/shell";
import { gh, OAUTH_CLIENT_SECRET, fakePem, pemBanner } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const CLIENT_ID = "oauth-client-id";
const CLIENT_SECRET = OAUTH_CLIENT_SECRET;
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const FAKE_PEM = fakePem(Array.from({ length: 26 }, () => "A".repeat(64)).join("\n"), "RSA PRIVATE KEY");
const FAKE_WEBHOOK_SECRET = ["test", "manifest", "webhook", "secret"].join("-");
const CONVERSION = {
  id: 123456,
  name: "mstar-inspector-octocat",
  slug: "mstar-inspector-octocat",
  pem: FAKE_PEM,
  webhook_secret: FAKE_WEBHOOK_SECRET,
};
const START_APP_ID = "7f0a4d2e-1c3b-4a5f-9e8d-6c2b1a0f9e7d";
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseManifestField(body: string): Record<string, unknown> {
  const field = /name="manifest" value="([^"]*)"/.exec(body)?.[1] ?? "";
  return JSON.parse(
    field
      .replaceAll("&#39;", "'")
      .replaceAll("&quot;", '"')
      .replaceAll("&gt;", ">")
      .replaceAll("&lt;", "<")
      .replaceAll("&amp;", "&"),
  ) as Record<string, unknown>;
}

function hookSegmentsOf(manifest: Record<string, unknown>): { workspaceId: string; appId: string } {
  const url = (manifest.hook_attributes as { url: string }).url;
  const [workspaceId = "", appId = ""] = url.slice("https://worker.local/webhook/".length).split("/");
  return { workspaceId, appId };
}

function appIdOf(manifest: Record<string, unknown>): string {
  return hookSegmentsOf(manifest).appId;
}

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: {
      get: async () => null,
      put: async () => {},
    } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: CLIENT_ID,
    GITHUB_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    ...overrides,
  };
}

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
  const hasWorkspaces = db.raw
    .query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'workspace_members'")
    .get() as { n: number };
  const insertMembership = hasWorkspaces.n
    ? db.raw.prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('default', ?, ?, ?)",
      )
    : null;
  for (const [login, role] of DEFAULT_SEEDED_MEMBERS) {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    insert.run(id, login, role, createdAt);
    const workspaceRole = role === "admin" ? "owner" : login === "octocat-with-a-long-login" ? "owner" : "member";
    insertMembership?.run(id, workspaceRole, createdAt);
  }
  return db;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { ...baseEnv(overrides), DB: seededDashboardD1() } as unknown as Env;
}

function dashboardRequest(path: string, cookie?: string): Request {
  return new Request(`https://worker.local${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

function htmlDashboardRequest(path: string, cookie?: string): Request {
  return new Request(`https://worker.local${path}`, {
    headers: { Accept: "text/html", ...(cookie ? { Cookie: cookie } : {}) },
  });
}
function tamperSignature(value: string): string {
  const dot = value.lastIndexOf(".");
  return `${value.slice(0, dot + 1)}${"A".repeat(value.length - dot - 1)}`;
}
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
    const past = Date.now() - 8 * 24 * 60 * 60 * 1000;
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
      return new Response(JSON.stringify({ access_token: gh("o", "token"), scope: "read:user" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const token = await exchangeCodeForToken("code", CLIENT_ID, CLIENT_SECRET, "https://cb");
    expect(seenUrl).toBe("https://github.com/login/oauth/access_token");
    expect(seenAccept).toBe("application/json");
    expect(token).toBe(gh("o", "token"));
  });

  test("form-urlencoded (non-JSON) response returns null without throwing", async () => {
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) =>
      new Response("access_token=" + gh("o", "token") + "&scope=read%3Auser", {
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
      return new Response(JSON.stringify({ access_token: gh("o", "token") }), { status: 200 });
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

  test("unsafe code shapes → null BEFORE any fetch — no URL-breaking character survives the gate (F11)", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const hostile = [
      "../../admin",
      "x@evil.example",
      "a/b",
      "a?next=b",
      "a#frag",
      "a b",
      "a\nb",
      "コード",
      "",
      "a".repeat(257),
    ];
    for (const code of hostile) {
      expect(await exchangeCodeForToken(code, CLIENT_ID, CLIENT_SECRET, "https://cb")).toBeNull();
    }
    expect(fetchCalls).toBe(0);
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
    let seenUrl = "";
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenSignal = init?.signal;
      seenAuth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
      return new Response(JSON.stringify({ login: "octocat", name: null }), { status: 200 });
    }) as typeof fetch;
    const user = await fetchGitHubUser(gh("o", "token"));
    expect(user).toEqual({ login: "octocat", name: null });
    expect(seenUrl).toBe("https://api.github.com/user");
    expect(seenAuth).toBe("Bearer " + gh("o", "token"));
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
    expect(await fetchGitHubUser(gh("o", "token"))).toBeNull();
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
    expect(await fetchGitHubUser(gh("o", "token"))).toBeNull();
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.stage).toBe("user_fetch");
    expect(entry.reason).toBe("unexpected_payload");
  });

  test("network failure (fetch rejects) returns null and logs fetch_failed", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const warns = spyOnWarn();
    expect(await fetchGitHubUser(gh("o", "token"))).toBeNull();
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.stage).toBe("user_fetch");
    expect(entry.reason).toBe("fetch_failed");
    expect(entry.error_type).toBe("TypeError");
  });

  test("a hostile access token (CRLF header injection) fails closed null (F12)", async () => {
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      new Request(String(url), init);
      return new Response(JSON.stringify({ login: "pwn" }), { status: 200 });
    }) as typeof fetch;
    const warns = spyOnWarn();
    expect(await fetchGitHubUser("tok\r\nX-Evil: 1")).toBeNull();
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.stage).toBe("user_fetch");
    expect(entry.reason).toBe("fetch_failed");
    expect(entry.error_type).toBe("TypeError");
  });
});

describe("/dashboard routes", () => {
  test("GET /dashboard without a session → 302 to login", async () => {
    const res = await worker.fetch(dashboardRequest("/dashboard"), withSpaAssets(makeEnv()));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("GET /dashboard with a valid session cookie → the sole workspace's Apps shell", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      dashboardRequest("/dashboard", `${SESSION_COOKIE}=${session}`),
      withSpaAssets(makeEnv()),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/repos");

    const shell = await worker.fetch(
      htmlDashboardRequest("/dashboard/default/apps", `${SESSION_COOKIE}=${session}`),
      withSpaAssets(makeEnv()),
    );
    expect(shell.status).toBe(200);
    const body = await shell.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).toContain('"login":"octocat"');
    expect(body).toContain('"memberships":[{"id":"default","slug":"default","name":"Default","role":"owner","plan":"Unlimited"}]');
    expect(body).toContain(
      '{"locale":"en","login":"octocat","name":"octocat","deploymentMode":"self-hosted","isOperator":false,"workspaceRef":"default","canCreateApp":true',
    );
    expect(body).not.toContain("Model keys");
    expect(body).not.toContain("Not in this iteration (B3).");
    expect(body).not.toContain('action="/dashboard/manifest/start"');
  });

  test("the SPA home document title is the SPA index title", async () => {
    const indexHtml = readFileSync(join(import.meta.dir, "../../src/spa/index.html"), "utf8");
    expect(indexHtml).toContain("<title>Morning Star Inspector</title>");
    expect(indexHtml).not.toContain("Dashboard —");
  });

  test("the boot carries the WORKSPACE role, never users.role (F-001)", async () => {
    const admin = await worker.fetch(
      htmlDashboardRequest("/dashboard/default/apps", `${SESSION_COOKIE}=${await createSessionValue("octocat", null, SESSION_SECRET)}`),
      withSpaAssets(makeEnv()),
    );
    expect(admin.status).toBe(200);
    const adminBody = await admin.text();
    expect(adminBody).toContain('"login":"octocat"');
    expect(adminBody).toContain('"role":"owner"');
    expect(adminBody).not.toContain('"role":"admin"');
    const member = await worker.fetch(
      htmlDashboardRequest("/dashboard/default/apps", `${SESSION_COOKIE}=${await createSessionValue("mallory", null, SESSION_SECRET)}`),
      withSpaAssets(makeEnv()),
    );
    expect(member.status).toBe(200);
    const memberBody = await member.text();
    expect(memberBody).toContain('"login":"mallory"');
    expect(memberBody).toContain('"memberships":[{"id":"default","slug":"default","name":"Default","role":"member","plan":"Unlimited"}]');
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

  test("GET /dashboard/login with a live session → 302 to the signed-in landing", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      dashboardRequest("/dashboard/login", `${SESSION_COOKIE}=${session}`),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/repos");
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

  test("callback with a valid state but an unsafe-shaped code → 400, zero upstream fetch, no session (F11 entry gate)", async () => {
    const state = await createStateValue(SESSION_SECRET);
    const origFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const warns = spyOnWarn();
      const res = await worker.fetch(
        dashboardRequest(
          `/dashboard/oauth/callback?code=${encodeURIComponent("../../admin")}&state=${state}`,
          `${OAUTH_STATE_COOKIE}=${state}`,
        ),
        makeEnv(),
      );
      expect(res.status).toBe(400);
      expect(fetchCalls).toBe(0);
      for (const cookie of res.headers.getSetCookie()) {
        expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(false);
      }
      const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
      expect(entry.event).toBe("dashboard_oauth");
      expect(entry.stage).toBe("callback");
      expect(entry.reason).toBe("unsafe_code_shape");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("GET /dashboard/logout → 302 to login; session, manifest hold, and manifest state cookies expired", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      dashboardRequest("/dashboard/logout", `${SESSION_COOKIE}=${session}`),
      makeEnv(),
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

  test("dashboard routes fail closed when OAuth secrets are unset", async () => {
    const env = makeEnv({
      GITHUB_OAUTH_CLIENT_ID: undefined,
      GITHUB_OAUTH_CLIENT_SECRET: undefined,
      DASHBOARD_SESSION_SECRET: undefined,
    });
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

describe("/dashboard/locale", () => {
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
    expect(res.headers.get("Location")).toBe("/dashboard/insights");
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toContain(`${LOCALE_COOKIE}=zh_CN`);
    expect(setCookie[0]).toContain("HttpOnly");
    expect(setCookie[0]).toContain("Secure");
    expect(setCookie[0]).toContain("SameSite=Lax");
    expect(setCookie[0]).toContain("Path=/");
  });

  test("POST from the platform console Referer → 302 back + exact widened Set-Cookie (Path=/)", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/locale", {
        method: "POST",
        headers: {
          Cookie: await sessionCookie(),
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://worker.local/_internal_admin/users",
        },
        body: "locale=zh_CN",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/_internal_admin/users");
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toBe(
      `${LOCALE_COOKIE}=zh_CN; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`,
    );
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
    expect(setCookie[0]).toContain("Path=/");
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
    createHoldValue(CONVERSION, login, SESSION_SECRET, START_APP_ID, "default", nowMs);

  test("round trip carries id/name/login/slug/pem/webhook_secret", async () => {
    const value = await freshHold();
    const payload = await readHoldValue(value, SESSION_SECRET);
    expect(payload).toEqual({
      ...CONVERSION,
      login: "octocat",
      appId: START_APP_ID,
      workspaceId: "default",
      exp: expect.any(Number),
    });
  });

  test("serialized value stays under the 4096B cookie budget with an RSA-2048-size PEM", async () => {
    expect(FAKE_PEM.length).toBeGreaterThan(1500);
    const value = await freshHold();
    expect(value.length).toBeLessThan(4096);
  });

  test("wrong secret fails closed", async () => {
    const value = await freshHold();
    expect(await readHoldValue(value, "another-secret")).toBeNull();
  });

  test("tampered ciphertext fails closed (GCM tag)", async () => {
    const value = await freshHold();
    const at = 24;
    const tampered = `${value.slice(0, at)}${value[at] === "A" ? "B" : "A"}${value.slice(at + 1)}`;
    expect(await readHoldValue(tampered, SESSION_SECRET)).toBeNull();
  });

  test("expired hold fails closed (server-side exp beside Max-Age)", async () => {
    const past = Date.now() - 10 * 60 * 1000;
    const value = await freshHold("octocat", past);
    expect(await readHoldValue(value, SESSION_SECRET)).toBeNull();
  });

  test("missing, garbage, and truncated values fail closed", async () => {
    expect(await readHoldValue(undefined, SESSION_SECRET)).toBeNull();
    expect(await readHoldValue("!!!", SESSION_SECRET)).toBeNull();
    expect(await readHoldValue("AAAA", SESSION_SECRET)).toBeNull();
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

  test("unsafe code shapes → null BEFORE any fetch — no URL-breaking character survives the gate (F13)", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const hostile = [
      "../conversions",
      "x@evil.example",
      "a/b",
      "a?next=b",
      "a#frag",
      "a b",
      "%2e%2e",
      "a\nb",
      "",
      "a".repeat(257),
    ];
    for (const code of hostile) {
      expect(await exchangeManifestCode(code)).toBeNull();
    }
    expect(fetchCalls).toBe(0);
  });

  test("a shape-valid dot-only code stays on the fixed api.github.com host (F13: path normalization cannot cross authorities)", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url: unknown) => {
      seenUrl = String(url);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await exchangeManifestCode("..");
    expect(seenUrl.startsWith("https://api.github.com/app-manifests/")).toBe(true);
    expect(seenUrl.endsWith("/conversions")).toBe(true);
  });
});

describe("/dashboard manifest routes", () => {
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
    const manifest = parseManifestField(body);
    return {
      res,
      body,
      session,
      state,
      stateCookie,
      manifest,
      startAppId: appIdOf(manifest),
    };
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
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("Secure");
    expect(stateCookie).toContain("SameSite=Lax");
    expect(stateCookie).toContain("Path=/");
    expect(stateCookie).toContain("Max-Age=600");
    expect(stateCookie).not.toContain("Domain");
    expect(state.length).toBeGreaterThan(0);
    expect(MANIFEST_STATE_COOKIE).not.toBe(OAUTH_STATE_COOKIE);
    expect(body).toContain('method="post"');
    expect(body).toContain(`action="https://github.com/settings/apps/new?state=${state}"`);
    expect(manifest.name).toBe("mstar-inspector-octocat");
    expect(manifest.url).toBe("https://worker.local");
    expect(manifest.hook_attributes).toEqual({
      url: `https://worker.local/webhook/default/${appIdOf(manifest)}`,
    });
    expect(hookSegmentsOf(manifest).workspaceId).toBe("default");
    expect(appIdOf(manifest)).toMatch(UUID_SHAPE);
    expect(appIdOf(manifest)).not.toContain("octocat");
    expect(manifest.redirect_url).toBe("https://worker.local/dashboard/manifest/callback");
    expect(manifest.public).toBe(false);
    expect(manifest.default_events).toEqual(["pull_request", "issue_comment"]);
    expect(manifest.default_permissions).toEqual({
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      issues: "write",
      checks: "write",
    });
  });
  test("Accept-Language zh renders the start page in zh_CN", async () => {
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
    expect(body).not.toContain("Continue on GitHub");
  });

  test("long login: manifest name is capped at 34 chars and the start page shows the truncated name", async () => {
    const { body, manifest } = await startManifest("octocat-with-a-long-login");
    const name = manifest.name as string;
    expect(name.length).toBeLessThanOrEqual(34);
    expect(name.startsWith("mstar-inspector-")).toBe(true);
    expect(body).toContain(`<strong>${name}</strong>`);
    expect(appIdOf(manifest)).toMatch(UUID_SHAPE);
    expect(manifest.hook_attributes).toEqual({
      url: `https://worker.local/webhook/default/${appIdOf(manifest)}`,
    });
    expect(hookSegmentsOf(manifest).workspaceId).toBe("default");
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
    const state = await createManifestStateValue(SESSION_SECRET, START_APP_ID, "default");
    const warns = spyOnWarn();
    const res = await worker.fetch(callbackRequest(session, state, `state=${state}`), makeEnv());
    expect(res.status).toBe(400);
    expect(guard.calls()).toBe(0);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.event).toBe("dashboard_manifest");
    expect(entry.stage).toBe("callback");
    expect(entry.reason).toBe("missing_code");
  });

  test("callback with a valid state but an unsafe-shaped code → 400, zero conversion fetch (F13 entry gate)", async () => {
    const guard = stubFetchMustNotBeCalled();
    const { session, state } = await startManifest();
    const warns = spyOnWarn();
    const res = await worker.fetch(
      callbackRequest(session, state, `code=${encodeURIComponent("../conversions")}&state=${state}`),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(guard.calls()).toBe(0);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.event).toBe("dashboard_manifest");
    expect(entry.stage).toBe("callback");
    expect(entry.reason).toBe("unsafe_code_shape");
  });

  test("callback success → conversion exchanged, App auto-committed, 302 to onboarding, hold burned, no secrets", async () => {
    const env = makeEnv({ DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });
    const { session, state, startAppId } = await startManifest();
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
    expect(calls).toEqual(["https://api.github.com/app-manifests/manifest-code/conversions"]);
    expect(seenHeaders.Accept).toBe("application/vnd.github+json");
    expect(seenHeaders["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(seenHeaders.Authorization).toBeUndefined();
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/dashboard/default/apps/${CONVERSION.id}/onboarding`);
    const cookies = res.headers.getSetCookie();
    expect(
      cookies.some((c) => c.startsWith(`${MANIFEST_STATE_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
    expect(
      cookies.some((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=`) && !c.includes("Max-Age=0"))).toBe(false);
    const rows = dbOf(env).raw.query(
      "SELECT id, github_slug, github_app_id, created_by FROM review_bots",
    ).all() as Array<{
      id: string;
      github_slug: string | null;
      github_app_id: number;
      created_by: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(startAppId);
    expect(rows[0]!.github_slug).toBe(CONVERSION.slug);
    expect(rows[0]!.github_app_id).toBe(CONVERSION.id);
    expect(rows[0]!.created_by).toBe("octocat");
    const landing = await worker.fetch(
      dashboardRequest(
        `/dashboard/default/apps/${CONVERSION.id}/onboarding`,
        `${SESSION_COOKIE}=${session}`,
      ),
      env,
    );
    expect(landing.status).toBe(200);
    const body = await landing.text();
    expect(body).toContain(`<span class="id">${CONVERSION.id}</span>`);
    expect(body).toContain(CONVERSION.name);
    expect(body).toContain(`Slug: ${CONVERSION.slug}`);
    expect(body).toContain(`https://worker.local/webhook/default/${startAppId}`);
    expect(body).toContain('href="/dashboard/default/repos"');
    expect(body).not.toContain(`href="/dashboard/default/repos/${CONVERSION.id}"`);
    expect(body).toContain(">Open Settings</a>");
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_PEM);
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
    expect(body).not.toContain("overwrite");
    expect(body).not.toContain("APP_ID");
    expect(body).not.toContain('class="danger"');
  });

  test("callback auto-commit already-connected (github_app_id taken) → 409 error page, hold burned, zero new rows", async () => {
    const env = makeEnv({ DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });
    await envDb(env).createApp({
      id: crypto.randomUUID(),
      githubSlug: "mstar-inspector-earlier",
      githubAppId: CONVERSION.id,
      name: "earlier",
      privateKeyEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      webhookSecretEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      createdBy: "someone-else",
      workspaceId: "default",
      maxApps: null,
    });
    const { session, state } = await startManifest();
    globalThis.fetch = (async () => new Response(JSON.stringify(CONVERSION), { status: 201 })) as unknown as typeof fetch;
    const warns = spyOnWarn();
    const res = await worker.fetch(
      callbackRequest(session, state, `code=manifest-code&state=${state}`),
      env,
    );
    expect(res.status).toBe(409);
    expect(
      res.headers.getSetCookie().some((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
    expect(appRowCount(env)).toBe(1);
    const body = await res.text();
    expect(body).toContain("already connected");
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
    const entry = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    expect(entry.stage).toBe("commit");
    expect(entry.reason).toBe("github_app_id_conflict");
  });

  test("callback retryable 500 (missing encryption key) → resumable page, hold cookie parked, confirm gate reachable", async () => {
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
    expect(payload?.slug).toBe(CONVERSION.slug);
    expect(payload?.pem).toBe(CONVERSION.pem);
    expect(payload?.webhook_secret).toBe(CONVERSION.webhook_secret);
    expect(body).toContain('href="/dashboard/manifest/confirm"');
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

  test("callback retryable 500 (unbound D1) → resumable page, hold cookie parked, confirm gate reachable (QC F-005)", async () => {
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
    expect(payload?.slug).toBe(CONVERSION.slug);
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

  test("unbound D1: the creation gate does not 403 the callback into burning the hold (I-000090)", async () => {
    const env = baseEnv({ DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });
    const { session, state } = await startManifest();
    globalThis.fetch = (async () => new Response(JSON.stringify(CONVERSION), { status: 201 })) as unknown as typeof fetch;
    const res = await worker.fetch(
      callbackRequest(session, state, `code=manifest-code&state=${state}`),
      env,
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain(t("en", "common.error.forbiddenTitle"));
    expect(body).toContain("Dashboard storage is not configured");
    expect(body).toContain('href="/dashboard/manifest/confirm"');
    const holdValue = (res.headers.getSetCookie().find((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=`)) ?? "")
      .split(";")[0]!
      .slice(MANIFEST_HOLD_COOKIE.length + 1);
    expect(holdValue.length).toBeGreaterThan(0);
    expect((await readHoldValue(holdValue, SESSION_SECRET))?.id).toBe(CONVERSION.id);
    const resumed = await worker.fetch(
      dashboardRequest(
        "/dashboard/manifest/confirm",
        `${SESSION_COOKIE}=${session}; ${MANIFEST_HOLD_COOKIE}=${holdValue}`,
      ),
      env,
    );
    expect(resumed.status).toBe(200);
    expect(await resumed.text()).toContain('action="/dashboard/manifest/commit"');
    expect(
      resumed.headers.getSetCookie().some((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=;`) && c.includes("Max-Age=0")),
      "confirm must not expire the hold on an unbound store",
    ).toBe(false);
  });

  test("callback retryable 500 (review_bots missing) → hold parked, confirm gate reachable", async () => {
    const db = seededDashboardD1(3);
    applyMigrationFile(db.raw, "0026_workspaces.sql");
    applyMigrationFile(db.raw, "0040_runtime_config.sql");
    applyMigrationFile(db.raw, "0049_workspace_check_min_score.sql");
    db.raw
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         SELECT 'default', id, 'owner', '2026-01-01T00:00:00.000Z' FROM users`,
      )
      .run();
    const env = {
      ...baseEnv({ DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      DB: db,
    } as unknown as Env;
    const { session, state } = await startManifest();
    globalThis.fetch = (async () => new Response(JSON.stringify(CONVERSION), { status: 201 })) as unknown as typeof fetch;
    const res = await worker.fetch(
      callbackRequest(session, state, `code=manifest-code&state=${state}`),
      env,
    );
    expect(res.status).toBe(500);
    const failedBody = await res.text();
    expect(failedBody).toContain("the dashboard database rejected the write");
    expect(failedBody).not.toContain("default score floor cannot be read");
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
    createHoldValue(CONVERSION, "octocat", SESSION_SECRET, START_APP_ID, "default");

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
    expect(body).toContain(`Slug <strong>${CONVERSION.slug}</strong>`);
    expect(body).toContain(`https://worker.local/webhook/default/${START_APP_ID}`);
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_PEM);
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
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
    expect(await rejected.text()).toContain('href="/dashboard/manifest/confirm"');
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

  test("Accept-Language zh renders the confirm page in zh_CN", async () => {
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
  });
});

describe("dashboard private-key normalization (private-key.ts)", () => {
  test("PKCS#1 wraps to PKCS#8, byte-identical to the pipeline implementation", () => {
    const wrapped = normalizePrivateKey(FAKE_PEM);
    expect(wrapped).toBe(pipelineNormalizePrivateKey(FAKE_PEM));
    expect(wrapped.startsWith(pemBanner("BEGIN", "PRIVATE KEY") + "\n")).toBe(true);
    expect(wrapped).not.toContain("RSA PRIVATE KEY");
  });

  test("PKCS#8 passes through unchanged; OpenSSH is a hard error", () => {
    const pkcs8 = fakePem("AAAA");
    expect(normalizePrivateKey(pkcs8)).toBe(pkcs8);
    expect(() =>
      normalizePrivateKey(pemBanner("BEGIN", "OPENSSH PRIVATE KEY") + "\nAAAA\n" + pemBanner("END", "OPENSSH PRIVATE KEY")),
    ).toThrow();
  });

  test("AC-B5-nocf: CLOUDFLARE_* is gone from the dashboard deps (env.ts + .env.example); the encryption key remains", async () => {
    const example = await Bun.file(new URL("../../.env.example", import.meta.url)).text();
    expect(example).not.toContain("CLOUDFLARE_");
    expect(example).toContain("DASHBOARD_ENCRYPTION_KEY");
    const envTs = await Bun.file(new URL("../../src/worker/env.ts", import.meta.url)).text();
    expect(envTs).not.toContain("CLOUDFLARE_");
    const manifestTs = await Bun.file(new URL("../../src/dashboard/manifest.ts", import.meta.url)).text();
    expect(manifestTs).not.toContain("api.cloudflare.com");
    expect(manifestTs).not.toContain("secrets-bulk");
  });
});

describe("/dashboard manifest commit (manifest → D1, zero CF API)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function stubFetchRecording(): { urls: string[] } {
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      throw new Error(`no upstream may be called on this path (${String(url)})`);
    }) as unknown as typeof fetch;
    return { urls };
  }

  function stubGitHubConversionOnly(conversion: Record<string, unknown> = CONVERSION): { urls: string[] } {
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      if (String(url) === "https://api.github.com/app-manifests/manifest-code/conversions") {
        return new Response(JSON.stringify(conversion), { status: 201 });
      }
      throw new Error(`unexpected upstream: ${String(url)}`);
    }) as unknown as typeof fetch;
    return { urls };
  }

  const freshHold = () =>
    createHoldValue(CONVERSION, "octocat", SESSION_SECRET, START_APP_ID, "default");

  function commitEnv(overrides: Partial<Env> = {}): Env {
    return makeEnv({ DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, ...overrides });
  }

  function degradedFloorEnv(cause: "read-failed" | "malformed"): Env {
    const env = commitEnv();
    const db = dbOf(env);
    return {
      ...env,
      DB: {
        ...db,
        prepare(query: string): DashboardD1Statement {
          if (!query.includes("check_min_score AS value")) return db.prepare(query);
          if (cause === "read-failed") throw new Error("D1_ERROR: no such column: deleted_at");
          const malformed: DashboardD1Statement = {
            bind: () => malformed,
            first: async <T = Record<string, unknown>>() => ({}) as T,
            all: <T = Record<string, unknown>>() => db.prepare(query).all<T>(),
            run: <T = Record<string, unknown>>() => db.prepare(query).run<T>(),
          };
          return malformed;
        },
      },
    } as unknown as Env;
  }

  const bannerCopy = (
    key:
      | "manifest.error.workspaceFloorUnreadable"
      | "manifest.error.workspaceFloorMalformed"
      | "manifest.error.workspaceFloorReadFailed",
  ) => t("en", key).replaceAll("'", "&#39;");

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
      START_APP_ID,
      "default",
      Date.now() - (MANIFEST_HOLD_MAX_AGE_SEC + 100) * 1000,
    );
    for (const holdValue of [tampered, expired]) {
      const res = await doCommit({ holdValue });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/dashboard");
      expectHoldExpired(res);
    }
    expect(rec.urls).toHaveLength(0);
  });

  test("hold.login ≠ session.login → 403, zero writes, hold burned", async () => {
    const rec = stubFetchRecording();
    const warns = spyOnWarn();
    const res = await doCommit({ holdValue: await freshHold(), sessionLogin: "octocat-with-a-long-login" });
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
    expectHoldKept(res);
    expect(rec.urls).toHaveLength(0);
    const body = await res.text();
    expect(body).toContain("DASHBOARD_ENCRYPTION_KEY");
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
  });

  test("migrations not applied (no review_bots table) → 500 fail-closed, hold KEPT", async () => {
    const rec = stubFetchRecording();
    const preApps = seededDashboardD1(3);
    applyMigrationFile(preApps.raw, "0026_workspaces.sql");
    applyMigrationFile(preApps.raw, "0040_runtime_config.sql");
    preApps.raw
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         SELECT 'default', id, 'owner', '2026-01-01T00:00:00.000Z' FROM users`,
      )
      .run();
    const res = await doCommit({
      env: {
        ...baseEnv({ DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
        DB: preApps,
      } as unknown as Env,
      holdValue: await freshHold(),
    });
    expect(res.status).toBe(500);
    expectHoldKept(res);
    expect(rec.urls).toHaveLength(0);
  });

  test("e2e start→callback AUTO-COMMIT: encrypted review_bots row, PEM verbatim (L1), AAD rowKey = row PK, onboarding shows slug/webhook URL/id, ZERO api.cloudflare.com calls, no secrets in HTML", async () => {
    const rec = stubGitHubConversionOnly();
    const env = commitEnv();
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
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
    const startAppId = appIdOf(parseManifestField(await start.text()));
    const callback = await worker.fetch(
      dashboardRequest(
        `/dashboard/manifest/callback?code=manifest-code&state=${state}`,
        `${SESSION_COOKIE}=${session}; ${MANIFEST_STATE_COOKIE}=${state}`,
      ),
      env,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe(`/dashboard/default/apps/${CONVERSION.id}/onboarding`);
    for (const url of rec.urls) expect(url).not.toContain("api.cloudflare.com");
    expect(rec.urls).toEqual([
      "https://api.github.com/app-manifests/manifest-code/conversions",
    ]);
    expectHoldExpired(callback);
    const db = dbOf(env);
    const rows = db.raw.query("SELECT * FROM review_bots").all() as Array<{
      id: string;
      github_slug: string | null;
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
    expect(row.id).toBe(startAppId);
    expect(row.github_slug).toBe(CONVERSION.slug);
    expect(row.github_app_id).toBe(CONVERSION.id);
    expect(row.name).toBe(CONVERSION.name);
    expect(row.created_by).toBe("octocat");
    expect(row.status).toBe("active");
    expect(row.deleted_at).toBeNull();
    expect(row.private_key_enc.startsWith("v1.primary.")).toBe(true);
    expect(row.webhook_secret_enc.startsWith("v1.primary.")).toBe(true);
    const box = createSecretbox(TEST_ENCRYPTION_KEY);
    expect(
      await box.decryptSecret(row.private_key_enc, `github_apps.private_key_enc:${row.id}`),
    ).toBe(CONVERSION.pem);
    expect(
      await box.decryptSecret(row.webhook_secret_enc, `github_apps.webhook_secret_enc:${row.id}`),
    ).toBe(FAKE_WEBHOOK_SECRET);
    expect(row.private_key_enc.startsWith("v1.")).toBe(true);
    const decryptedPem = await box.decryptSecret(
      row.private_key_enc,
      `github_apps.private_key_enc:${row.id}`,
    );
    expect(decryptedPem.startsWith(pemBanner("BEGIN", "RSA PRIVATE KEY"))).toBe(true);
    expect(decryptedPem).not.toBe(normalizePrivateKey(FAKE_PEM));
    const landing = await worker.fetch(
      dashboardRequest(`/dashboard/default/apps/${CONVERSION.id}/onboarding`, `${SESSION_COOKIE}=${session}`),
      env,
    );
    expect(landing.status).toBe(200);
    const html = await landing.text();
    expect(html).toContain(`Slug: ${CONVERSION.slug}`);
    expect(html).toContain(`https://worker.local/webhook/default/${startAppId}`);
    expect(html).toContain(`<span class="id">${CONVERSION.id}</span>`);
    expect(html).not.toContain("BEGIN");
    expect(html).not.toContain(FAKE_PEM);
    expect(html).not.toContain(FAKE_WEBHOOK_SECRET);
  });

  test("a successful commit lands on the workspace onboarding URL", async () => {
    const env = commitEnv();
    const res = await doCommit({ env, holdValue: await freshHold() });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/dashboard/default/apps/${CONVERSION.id}/onboarding`,
    );
    expectHoldExpired(res);
    expect(appRowCount(env)).toBe(1);
  });

  async function seedApps(env: Env, count: number): Promise<void> {
    for (let at = 0; at < count; at += 1) {
      await envDb(env).createApp({
        id: crypto.randomUUID(),
        githubSlug: `seeded-${at}`,
        githubAppId: 900_000 + at,
        name: `seeded-${at}`,
        privateKeyEnc: "v1.primary.aXZpdi5h.cHJldGV4dA==",
        webhookSecretEnc: "v1.primary.aXZpdi5i.cHJldGV4dA==",
        createdBy: "octocat",
        workspaceId: "default",
        maxApps: null,
      });
    }
  }

  const appCapCopy = (limit: number) => t("en", "manifest.error.appCapReached", { limit }).replaceAll("'", "&#39;");

  test("saas: a free workspace's second App is refused before any row is written", async () => {
    const env = commitEnv({ DEPLOYMENT_MODE: "saas" });
    await seedApps(env, 1);
    expect(appRowCount(env)).toBe(1);

    const refused = await doCommit({ env, holdValue: await freshHold() });

    expect(refused.status).toBe(409);
    expect(appRowCount(env)).toBe(1);
    expect(relatedRowCount(env, "bot_workspaces")).toBe(1);
    expect(relatedRowCount(env, "review_targets")).toBe(0);
    expect(await refused.text()).toContain(appCapCopy(1));
    expectHoldExpired(refused);
  });

  test("saas: two concurrent capped commits create exactly one App and one refusal", async () => {
    const env = commitEnv({ DEPLOYMENT_MODE: "saas" });
    expect(appRowCount(env)).toBe(0);
    const [a, b] = await Promise.all([
      doCommit({
        env,
        holdValue: await createHoldValue(CONVERSION, "octocat", SESSION_SECRET, crypto.randomUUID(), "default"),
      }),
      doCommit({
        env,
        holdValue: await createHoldValue(CONVERSION, "octocat", SESSION_SECRET, crypto.randomUUID(), "default"),
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([302, 409]);
    expect(appRowCount(env)).toBe(1);
    expect(relatedRowCount(env, "bot_workspaces")).toBe(1);
    expect(relatedRowCount(env, "review_targets")).toBe(0);
    const refused = a.status === 409 ? a : b;
    expect(await refused.text()).toContain(appCapCopy(1));
    expectHoldExpired(refused);
  });

  function staleCountEnv(env: Env): Env {
    const db = dbOf(env);
    return {
      ...env,
      DB: {
        ...db,
        prepare(query: string): DashboardD1Statement {
          const stmt = db.prepare(query);
          if (!query.includes("COUNT(*) AS n")) return stmt;
          const zero: DashboardD1Statement = {
            bind: () => zero,
            first: async <T = Record<string, unknown>>() => ({ n: 0 }) as T,
            all: async <T = Record<string, unknown>>() => ({ results: [] as T[] }),
            run: () => stmt.run(),
          };
          return zero;
        },
      },
    } as unknown as Env;
  }

  test("saas: a same-hold resubmit racing for the last slot is refused, never a mapping fault", async () => {
    const env = commitEnv({ DEPLOYMENT_MODE: "saas" });
    const holdValue = await freshHold();
    const [a, b] = await Promise.all([
      doCommit({ env: staleCountEnv(env), holdValue }),
      doCommit({ env: staleCountEnv(env), holdValue }),
    ]);

    expect([a.status, b.status].sort()).toEqual([302, 409]);
    expect(appRowCount(env)).toBe(1);
    expect(relatedRowCount(env, "bot_workspaces")).toBe(1);
    const refused = a.status === 409 ? a : b;
    expect(await refused.text()).toContain(appCapCopy(1));
    expectHoldExpired(refused);
  });

  test("saas: the insert's own count refuses when the fast-path read saw zero", async () => {
    const env = commitEnv({ DEPLOYMENT_MODE: "saas" });
    await seedApps(env, 1);
    const staleCount = staleCountEnv(env);

    const refused = await doCommit({ env: staleCount, holdValue: await freshHold() });

    expect(refused.status).toBe(409);
    expect(appRowCount(env)).toBe(1);
    expect(relatedRowCount(env, "bot_workspaces")).toBe(1);
    expect(await refused.text()).toContain(appCapCopy(1));
    expectHoldExpired(refused);
  });

  test("saas: a pro workspace's tenth App succeeds and the eleventh is refused", async () => {
    const env = commitEnv({ DEPLOYMENT_MODE: "saas" });
    dbOf(env)
      .raw.prepare(
        `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
         VALUES ('default', 'pro', 'active', datetime('now'), datetime('now'))`,
      )
      .run();
    await seedApps(env, 9);

    const accepted = await doCommit({ env, holdValue: await freshHold() });
    expect(accepted.status).toBe(302);
    expect(appRowCount(env)).toBe(10);

    const refused = await doCommit({ env, holdValue: await freshHold() });
    expect(refused.status).toBe(409);
    expect(appRowCount(env)).toBe(10);
    expect(await refused.text()).toContain(appCapCopy(10));
  });

  test("self-hosted reads no App cap: an eleventh App still connects", async () => {
    const env = commitEnv();
    await seedApps(env, 11);

    const accepted = await doCommit({ env, holdValue: await freshHold() });

    expect(accepted.status).toBe(302);
    expect(appRowCount(env)).toBe(12);
  });

  test("a soft-deleted App frees its slot", async () => {
    const env = commitEnv({ DEPLOYMENT_MODE: "saas" });
    await seedApps(env, 1);
    const seeded = dbOf(env)
      .raw.query("SELECT id FROM review_bots ORDER BY created_at, rowid LIMIT 1")
      .get() as { id: string };
    dbOf(env).raw.prepare("UPDATE review_bots SET deleted_at = datetime('now') WHERE id = ?").run(seeded.id);

    const accepted = await doCommit({ env, holdValue: await freshHold() });

    expect(accepted.status).toBe(302);
    expect(appRowCount(env)).toBe(2);
  });

  test("an unreadable workspace default fails the commit closed, then retries once the stored floor is repaired", async () => {
    const env = commitEnv();
    const db = dbOf(env);
    db.raw.run("PRAGMA ignore_check_constraints = ON");
    db.raw.prepare("UPDATE workspaces SET check_min_score = 'abc' WHERE id = 'default'").run();
    db.raw.run("PRAGMA ignore_check_constraints = OFF");

    const holdValue = await createHoldValue(CONVERSION, "octocat", SESSION_SECRET, START_APP_ID, "default");

    const refused = await doCommit({ env, holdValue });
    expect(refused.status).toBe(500);
    expect(appRowCount(env)).toBe(0);
    const refusedBody = await refused.text();
    expect(refusedBody).toContain(bannerCopy("manifest.error.workspaceFloorUnreadable"));
    expect(refusedBody).not.toContain(bannerCopy("manifest.error.workspaceFloorReadFailed"));
    expect(refusedBody).not.toContain("The App could not be stored");
    expect(refusedBody).toContain('href="/dashboard/default/settings"');
    const holdCookie =
      refused.headers.getSetCookie().find((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=`)) ?? "";
    expect(holdCookie).not.toContain("Max-Age=0");

    db.raw.prepare("UPDATE workspaces SET check_min_score = 90 WHERE id = 'default'").run();
    const committed = await doCommit({ env, holdValue });
    expect(committed.status).toBe(302);
    expect(appRowCount(env)).toBe(1);
    expect(relatedRowCount(env, "review_targets")).toBe(0);
  });

  test("an unreadable workspace default fails the callback auto-commit closed on the same floor page", async () => {
    stubGitHubConversionOnly();
    const env = commitEnv();
    const db = dbOf(env);
    db.raw.run("PRAGMA ignore_check_constraints = ON");
    db.raw.prepare("UPDATE workspaces SET check_min_score = 'abc' WHERE id = 'default'").run();
    db.raw.run("PRAGMA ignore_check_constraints = OFF");
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const state = await createManifestStateValue(SESSION_SECRET, START_APP_ID, "default");

    const refused = await worker.fetch(
      dashboardRequest(
        `/dashboard/manifest/callback?code=manifest-code&state=${state}`,
        `${SESSION_COOKIE}=${session}; ${MANIFEST_STATE_COOKIE}=${state}`,
      ),
      env,
    );
    expect(refused.status).toBe(500);
    expect(appRowCount(env)).toBe(0);
    const refusedBody = await refused.text();
    expect(refusedBody).toContain(bannerCopy("manifest.error.workspaceFloorUnreadable"));
    expect(refusedBody).not.toContain(bannerCopy("manifest.error.workspaceFloorReadFailed"));
    expect(refusedBody).not.toContain("The App could not be stored");
    expect(refusedBody).toContain('href="/dashboard/default/settings"');
    expect(refusedBody).toContain(">workspace settings</a>.");
    const holdCookie =
      refused.headers.getSetCookie().find((c) => c.startsWith(`${MANIFEST_HOLD_COOKIE}=`)) ?? "";
    expect(holdCookie).toBeTruthy();
    expect(holdCookie).not.toContain("Max-Age=0");
  });

  test("a missing non-floor column is a read failure: retryable, names no migration and no setting to repair", async () => {
    stubGitHubConversionOnly();
    const env = degradedFloorEnv("read-failed");
    const holdValue = await freshHold();

    const refused = await doCommit({ env, holdValue });
    expect(refused.status).toBe(500);
    expect(appRowCount(env)).toBe(0);
    const refusedBody = await refused.text();
    expect(refusedBody).toContain(bannerCopy("manifest.error.workspaceFloorReadFailed"));
    expect(refusedBody).not.toContain(bannerCopy("manifest.error.workspaceFloorUnreadable"));
    expect(refusedBody).not.toContain("0049_workspace_check_min_score.sql");
    expect(refusedBody).not.toContain('href="/dashboard/default/settings"');
    expectHoldKept(refused);

    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const state = await createManifestStateValue(SESSION_SECRET, START_APP_ID, "default");
    const callback = await worker.fetch(
      dashboardRequest(
        `/dashboard/manifest/callback?code=manifest-code&state=${state}`,
        `${SESSION_COOKIE}=${session}; ${MANIFEST_STATE_COOKIE}=${state}`,
      ),
      env,
    );
    expect(callback.status).toBe(500);
    expect(appRowCount(env)).toBe(0);
    const callbackBody = await callback.text();
    expect(callbackBody).toContain(bannerCopy("manifest.error.workspaceFloorReadFailed"));
    expect(callbackBody).not.toContain("0049_workspace_check_min_score.sql");
    expect(callbackBody).not.toContain('href="/dashboard/default/settings"');
  });

  test("a malformed floor result row names the migration and links no setting to repair", async () => {
    const env = degradedFloorEnv("malformed");
    const holdValue = await freshHold();
    const refused = await doCommit({ env, holdValue });
    expect(refused.status).toBe(500);
    expect(appRowCount(env)).toBe(0);
    const refusedBody = await refused.text();
    expect(refusedBody).toContain(bannerCopy("manifest.error.workspaceFloorMalformed"));
    expect(refusedBody).toContain("0049_workspace_check_min_score.sql");
    expect(refusedBody).not.toContain(bannerCopy("manifest.error.workspaceFloorUnreadable"));
    expect(refusedBody).not.toContain(bannerCopy("manifest.error.workspaceFloorReadFailed"));
    expect(refusedBody).not.toContain('href="/dashboard/default/settings"');
    expectHoldKept(refused);
  });

  test("POST /manifest/commit stays an idempotent-recovery path: after a retryable callback 500, the SAME hold resubmits → 302 onboarding + one row", async () => {
    const brokeEnv = makeEnv();
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const state = await createManifestStateValue(SESSION_SECRET, START_APP_ID, "default");
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
    const env = commitEnv();
    const committed = await doCommit({
      env: { ...env, DB: dbOf(brokeEnv) } as unknown as Env,
      holdValue,
    });
    expect(committed.status).toBe(302);
    expect(committed.headers.get("Location")).toBe(`/dashboard/default/apps/${CONVERSION.id}/onboarding`);
    expectHoldExpired(committed);
    const rows = dbOf(brokeEnv).raw.query("SELECT id FROM review_bots WHERE github_app_id = ?").all(CONVERSION.id) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(START_APP_ID);
    const replay = await doCommit({ env: { ...env, DB: dbOf(brokeEnv) } as unknown as Env, holdValue });
    expect(replay.status).toBe(409);
    expect(appRowCount({ ...env, DB: dbOf(brokeEnv) } as unknown as Env)).toBe(1);
  });

  test("two starts mint distinct app ids and each commit lands on the id its manifest registered", async () => {
    const env = commitEnv();
    const db = dbOf(env);
    const startFlow = async () => {
      const session = await createSessionValue("octocat", null, SESSION_SECRET);
      const res = await worker.fetch(
        new Request("https://worker.local/dashboard/manifest/start", {
          method: "POST",
          headers: { Cookie: `${SESSION_COOKIE}=${session}` },
        }),
        env,
      );
      const cookie =
        res.headers.getSetCookie().find((c) => c.startsWith(`${MANIFEST_STATE_COOKIE}=`)) ?? "";
      return {
        session,
        state: (cookie.split(";")[0] ?? "").slice(MANIFEST_STATE_COOKIE.length + 1),
        startAppId: appIdOf(parseManifestField(await res.text())),
      };
    };
    const first = await startFlow();
    const second = await startFlow();
    expect(first.startAppId).not.toBe(second.startAppId);
    expect(first.startAppId).toMatch(UUID_SHAPE);
    const startUrl = `https://worker.local/webhook/default/${first.startAppId}`;
    stubGitHubConversionOnly();
    const callback = await worker.fetch(
      dashboardRequest(
        `/dashboard/manifest/callback?code=manifest-code&state=${first.state}`,
        `${SESSION_COOKIE}=${first.session}; ${MANIFEST_STATE_COOKIE}=${first.state}`,
      ),
      env,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe(`/dashboard/default/apps/${CONVERSION.id}/onboarding`);
    const rows = db.raw.query(
      "SELECT id, github_slug, github_app_id FROM review_bots WHERE github_app_id = ?",
    ).all(CONVERSION.id) as Array<{
      id: string;
      github_slug: string | null;
      github_app_id: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.startAppId);
    expect(`https://worker.local/webhook/default/${rows[0]!.id}`).toBe(startUrl);
    expect(rows[0]!.github_slug).toBe(CONVERSION.slug);
    const landing = await worker.fetch(
      dashboardRequest(
        `/dashboard/default/apps/${CONVERSION.id}/onboarding`,
        `${SESSION_COOKIE}=${first.session}`,
      ),
      env,
    );
    expect(landing.status).toBe(200);
    const html = await landing.text();
    expect(html).toContain(`Slug: ${CONVERSION.slug}`);
    expect(html).toContain(startUrl);
    expect(html).toContain('href="/dashboard/default/repos"');
    expect(html).not.toContain(`href="/dashboard/default/repos/${CONVERSION.id}"`);
    stubGitHubConversionOnly({ ...CONVERSION, id: CONVERSION.id + 1, name: `${CONVERSION.name}-2` });
    const secondCallback = await worker.fetch(
      dashboardRequest(
        `/dashboard/manifest/callback?code=manifest-code&state=${second.state}`,
        `${SESSION_COOKIE}=${second.session}; ${MANIFEST_STATE_COOKIE}=${second.state}`,
      ),
      env,
    );
    expect(secondCallback.status).toBe(302);
    const all = db.raw.query(
      "SELECT id, github_app_id FROM review_bots ORDER BY github_app_id",
    ).all() as Array<{ id: string; github_app_id: number }>;
    expect(all.map((r) => [r.github_app_id, r.id])).toEqual([
      [CONVERSION.id, first.startAppId],
      [CONVERSION.id + 1, second.startAppId],
    ]);
  });

  test("an unrelated App's stale github_slug cache never blocks this commit (the cache is not an identity)", async () => {
    const env = commitEnv();
    await envDb(env).createApp({
      id: crypto.randomUUID(),
      githubSlug: CONVERSION.slug,
      githubAppId: 999,
      name: "earlier",
      privateKeyEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      webhookSecretEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      createdBy: "someone-else",
      workspaceId: "default",
      maxApps: null,
    });
    const res = await doCommit({ env, holdValue: await freshHold() });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/dashboard/default/apps/${CONVERSION.id}/onboarding`);
    expect(appRowCount(env)).toBe(2);
  });

  test("github_app_id already connected → 409, zero new rows, hold burned (non-retryable)", async () => {
    const rec = stubFetchRecording();
    const env = commitEnv();
    await envDb(env).createApp({
      id: crypto.randomUUID(),
      githubSlug: "mstar-inspector-earlier",
      githubAppId: CONVERSION.id,
      name: "earlier",
      privateKeyEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      webhookSecretEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      createdBy: "someone-else",
      workspaceId: "default",
      maxApps: null,
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

  test("Accept-Language zh renders the onboarding page after a successful commit", async () => {
    stubFetchRecording();
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const env = commitEnv();
    const res = await doCommit({
      env,
      holdValue: await freshHold(),
      extraHeaders: { "Accept-Language": "zh-CN,zh;q=0.9" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/dashboard/default/apps/${CONVERSION.id}/onboarding`);
    const landing = await worker.fetch(
      new Request(`https://worker.local/dashboard/default/apps/${CONVERSION.id}/onboarding`, {
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
  });

  test("Accept-Language zh renders the retryable commit error in zh_CN", async () => {
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
  });
});

describe("/dashboard placeholder lock + legacy home retirement", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("BYOK / Review placeholder POSTs → 405, zero fetch, no stale B0 copy", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return new Response("{}");
    }) as unknown as typeof fetch;
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const env = makeEnv();
    for (const path of ["/dashboard/model-keys", "/dashboard/review"]) {
      const res = await worker.fetch(
        new Request(`https://worker.local${path}`, {
          method: "POST",
          headers: { Cookie: `${SESSION_COOKIE}=${session}` },
        }),
        env,
      );
      expect(res.status).toBe(405);
      expect(await res.text()).not.toContain("B0");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("SSR views honor the stored theme (F-13)", () => {
  const readViews = () => readFileSync(join(import.meta.dir, "../../src/dashboard/views.ts"), "utf8");

  function renderedStyle(): string {
    const html = errorPage("boom");
    return html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  }

  function blockAfter(source: string, openToken: string): string {
    const at = source.indexOf(openToken);
    expect(at, openToken).toBeGreaterThanOrEqual(0);
    const open = source.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) return source.slice(open + 1, i);
      }
    }
    throw new Error(`unbalanced block: ${openToken}`);
  }

  test("STYLE carries a stored-light branch with the semantic names of the light theme", () => {
    const light = blockAfter(renderedStyle(), ':root[data-theme="light"] {');
    expect(light).toContain("color-scheme: light");
    for (const declaration of [
      "--surface-page: #ffffff",
      "--surface-raised: #f3f5f8",
      "--text-primary: #0f141a",
      "--text-secondary: #2f3742",
      "--border-default: #10192824",
      "--tone-danger-fg: #b91c1c",
      "--tone-warn-fg: #b45309",
    ]) {
      expect(light, declaration).toContain(declaration);
    }
  });

  test("the OS-light fallback is deleted — unset stays dark in every browser (deterministic default)", () => {
    const views = readViews();
    expect(views).not.toContain("@media (prefers-color-scheme: light)");
    expect(views).not.toContain(':root:not([data-theme="dark"])');
  });

  test("the onboarding CTA never puts a target id in the workspace-ref slot", () => {
    const user: { login: string; name?: string } = { login: "octocat" };
    const app = { id: 1234, name: "fixture", slug: null, webhookUrl: "https://worker.local/webhook/x" };
    const targetId = "2a0e6d1c-7f3a-4c86-9a1f-0e5e3f2a9b7d";

    const legacy = manifestOnboardingPage(user, app, "en", null, targetId);
    expect(legacy).toContain('href="/dashboard"');
    expect(legacy).not.toContain(`href="/dashboard/${targetId}"`);

    const scoped = manifestOnboardingPage(user, app, "en", "acme", targetId);
    expect(scoped).toContain(`href="/dashboard/acme/repos/${targetId}"`);

    expect(manifestOnboardingPage(user, app, "en", null, null)).toContain('href="/dashboard"');
  });

  test("explicit stored-dark branch is a no-op and dark stays the :root default", () => {
    const style = renderedStyle();
    const dark = blockAfter(style, ':root[data-theme="dark"] {');
    expect(dark.trim()).toBe("");
    const root = blockAfter(style, ":root {");
    expect(root).toContain("color-scheme: dark");
    expect(root).toContain("--surface-page: #0a0c10");
  });

  test("every SSR face inlines the pre-paint theme bootstrap before STYLE", () => {
    const user = { login: "octocat", name: "Octo Cat" };
    const app = {
      id: 1234,
      name: "mstar-inspector-octocat",
      slug: "mstar-inspector-octocat",
      webhookUrl: "https://worker.local/webhook/mstar-inspector-octocat",
    };
    const faces: [string, string][] = [
      ["start", manifestStartPage(user, app.name, "{}", "https://github.com/settings/apps/new")],
      ["confirm", manifestConfirmPage(user, app)],
      ["onboarding", manifestOnboardingPage(user, app)],
      ["manifest-error", manifestErrorPage("boom")],
      ["manifest-error-resumable", manifestErrorPage("boom", true)],
      ["removed", removedPage("octocat")],
      ["forbidden", forbiddenPage("octocat")],
      ["error", errorPage("boom")],
    ];
    for (const [face, html] of faces) {
      const scriptAt = html.indexOf("mstar.dashboard.theme");
      const styleAt = html.indexOf("<style>");
      expect(scriptAt, face).toBeGreaterThan(0);
      expect(styleAt, face).toBeGreaterThan(0);
      expect(scriptAt, face).toBeLessThan(styleAt);
      for (const fragment of [
        'localStorage.getItem("mstar.dashboard.theme")',
        'if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;',
        "catch {}",
      ]) {
        expect(html, `${face}: ${fragment}`).toContain(fragment);
      }
    }
  });
});

describe("existing routes unaffected", () => {
  test("GET /healthz still returns 200 ok (plus the version field)", async () => {
    const res = await worker.fetch(new Request("https://worker.local/healthz"), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(`v${APP_VERSION}`);
  });

  test("bare POST /webhook is 404 — the legacy face is retired and the dashboard mount does not intercept it", async () => {
    const db = createDashboardTestD1();
    const sent: unknown[] = [];
    const env = makeDbEnv(db, {
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
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
    const rows = db.raw.query("SELECT COUNT(*) AS n FROM webhook_deliveries").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});


function applyMigrationFile(db: Database, name: string): void {
  execMigrationScript(db, readFileSync(join(import.meta.dir, "../../migrations", name), "utf8"));
}

const DASHBOARD_MIGRATION_SEQUENCE = [
  "0001_reviews.sql",
  "0002_mstar_review_v1.sql",
  "0003_dashboard_users.sql",
  "0004_github_apps.sql",
  "0005_reviews_app_id.sql",
  "0016_users_login_nocase_unique.sql",
  "0023_removed_logins.sql",
  "0026_workspaces.sql",
  "0040_runtime_config.sql",
  "0028_workspace_invites.sql",
  "0031_plans_usage.sql",
  "0032_unlimited_plan.sql",
  "0033_platform_admin.sql",
  "0036_app_identity.sql",
  "0008_github_apps_ops.sql",
  "0018_app_sandbox_images.sql",
  "0019_github_apps_metadata.sql",
  "0022_app_trigger_mode.sql",
  "0037_github_metadata_attempt.sql",
  "0038_webhook_path_drop.sql",
  "0045_review_gate_and_owner_allowlist.sql",
  "0049_workspace_check_min_score.sql",
  "0011_webhook_deliveries.sql",
  "0043_webhook_delivery_repository.sql",
  "0039_pull_requests.sql",
  "0020_finding_lifecycle.sql",
  "0021_review_checks.sql",
  "0007_reviews_app_id_index.sql",
  "0006_app_provider_config.sql",
  "0009_app_model_roles.sql",
  "0012_custom_providers_and_key_updated_at.sql",
  "0015_provider_verification.sql",
  "0017_app_model_chains.sql",
  "0024_provider_multi_key.sql",
  "0025_provider_model_evidence.sql",
  "0055_app_installations_removed_at.sql",
  "0047_review_level_per_app.sql",
  "0048_comment_trigger_claims.sql",
  "0056_review_bots_rename.sql",
  "0057_review_targets.sql",
  "0058_review_bot_scope.sql",
  "0061_plan_shared_bot_allowed.sql",
  "0063_quota_profiles.sql",
] as const;

function createDashboardTestD1(
  through: number = DASHBOARD_MIGRATION_SEQUENCE.length,
): DashboardD1 & { raw: Database } {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON;");
  for (const [index, name] of DASHBOARD_MIGRATION_SEQUENCE.entries()) {
    if (index >= through) break;
    if (index === 2) {
      db.run(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md)
         VALUES ('review-1', 123, 'acme', 'widgets', 42, '0123456789abcdef0123456789abcdef01234567', 'comment', 'No blocking issues.')`,
      );
    }
    applyMigrationFile(db, name);
  }
  let batchQueue: Promise<void> = Promise.resolve();
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
    async batch(statements: DashboardD1Statement[]): Promise<DashboardD1BatchResult[]> {
      const run = batchQueue.then(async () => {
        db.run("BEGIN");
        try {
          const results: DashboardD1BatchResult[] = [];
          for (const stmt of statements) results.push(await stmt.run());
          db.run("COMMIT");
          return results;
        } catch (error) {
          db.run("ROLLBACK");
          throw error;
        }
      });
      batchQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

function userCount(db: DashboardD1 & { raw: Database }): number {
  return (db.raw.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

function removedRows(
  db: DashboardD1 & { raw: Database },
): Array<{ github_login: string; removed_at: string; removed_by: string | null }> {
  return db.raw
    .query("SELECT github_login, removed_at, removed_by FROM removed_logins ORDER BY github_login")
    .all() as Array<{ github_login: string; removed_at: string; removed_by: string | null }>;
}

type DashboardTestDb = DashboardD1 & { raw: Database };

function bootstrapRaceD1(inner: DashboardTestDb, interleave: () => Promise<void>): DashboardTestDb {
  let fired = false;
  const thenInterleave = async <T>(value: T): Promise<T> => {
    if (!fired) {
      fired = true;
      await interleave();
    }
    return value;
  };
  const race = (stmt: DashboardD1Statement): DashboardD1Statement => ({
    bind(...values: unknown[]) {
      const bound = stmt.bind(...values);
      return {
        bind: (...more: unknown[]) => bound.bind(...more),
        first: async <T = Record<string, unknown>>() => thenInterleave(await bound.first<T>()),
        all: <T = Record<string, unknown>>() => bound.all<T>(),
        run: <T = Record<string, unknown>>() => bound.run<T>(),
      };
    },
    first: async <T = Record<string, unknown>>() => thenInterleave(await stmt.first<T>()),
    all: <T = Record<string, unknown>>() => stmt.all<T>(),
    run: <T = Record<string, unknown>>() => stmt.run<T>(),
  });
  return {
    raw: inner.raw,
    prepare(query: string): DashboardD1Statement {
      const stmt = inner.prepare(query);
      return query.includes("FROM removed_logins") ? race(stmt) : stmt;
    },
    batch: (statements: DashboardD1Statement[]) => inner.batch(statements),
  };
}

function dbOf(env: Env): DashboardTestDb {
  return (env as Env & { DB: DashboardTestDb }).DB;
}

function appRowCount(env: Env): number {
  return (dbOf(env).raw.query("SELECT COUNT(*) AS n FROM review_bots").get() as { n: number }).n;
}

function relatedRowCount(env: Env, table: "bot_workspaces" | "review_targets"): number {
  return (dbOf(env).raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function envDb(env: Env) {
  return createReviewBotsStore(dbOf(env));
}

function makeDbEnv(db: DashboardD1, overrides: Partial<Env> = {}): Env {
  return { ...baseEnv(overrides), DB: db } as Env;
}

describe("GET /dashboard/<ref>/apps/:appId/onboarding (AC4b)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function seedApp(env: Env, overrides: Partial<{ githubSlug: string | null; githubAppId: number; name: string; createdBy: string; deletedAt: string | null }> = {}) {
    return envDb(env).createApp({
      id: crypto.randomUUID(),
      githubSlug: overrides.githubSlug === undefined ? CONVERSION.slug : overrides.githubSlug,
      githubAppId: overrides.githubAppId ?? CONVERSION.id,
      name: overrides.name ?? CONVERSION.name,
      privateKeyEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      webhookSecretEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      createdBy: overrides.createdBy ?? "octocat",
      workspaceId: "default",
      maxApps: null,
    }).then(async (row) => {
      if (!overrides.deletedAt) return row;
      await dbOf(env).raw
        .prepare(`UPDATE review_bots SET deleted_at = ? WHERE id = ?`)
        .run(overrides.deletedAt, row.id);
      return row;
    });
  }

  function onboardingRequest(appId: number, login = "octocat"): Promise<Request> {
    return createSessionValue(login, null, SESSION_SECRET).then((session) =>
      dashboardRequest(`/dashboard/default/apps/${appId}/onboarding`, `${SESSION_COOKIE}=${session}`),
    );
  }

  test("no session → 302 to login", async () => {
    const res = await worker.fetch(
      dashboardRequest(`/dashboard/default/apps/${CONVERSION.id}/onboarding`),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  test("unknown App id → 404 (settings-family unknown-app shape)", async () => {
    const res = await worker.fetch(await onboardingRequest(9_999_999), makeEnv());
    expect(res.status).toBe(404);
  });

  test("soft-deleted App → 404", async () => {
    const env = makeEnv();
    await seedApp(env, { deletedAt: new Date().toISOString() });
    const res = await worker.fetch(await onboardingRequest(CONVERSION.id), env);
    expect(res.status).toBe(404);
  });

  test("plain workspace member → 403 forbidden page", async () => {
    const env = makeEnv();
    await seedApp(env, { createdBy: "someone-else" });
    const res = await worker.fetch(await onboardingRequest(CONVERSION.id, "mallory"), env);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain(CONVERSION.name);
    expect(body).not.toContain(FAKE_PEM);
  });

  test("owner → 200 with name / id / GitHub slug / webhook URL + Settings CTA, no secrets", async () => {
    const env = makeEnv();
    const app = await seedApp(env, { createdBy: "octocat-with-a-long-login" });
    const res = await worker.fetch(await onboardingRequest(CONVERSION.id, "octocat-with-a-long-login"), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`Slug: ${CONVERSION.slug}`);
    expect(body).toContain(`<span class="id">${CONVERSION.id}</span>`);
    expect(body).toContain(`https://worker.local/webhook/default/${app.id}`);
    expect(body).toContain('href="/dashboard/default/repos"');
    expect(body).not.toContain(`href="/dashboard/default/repos/${CONVERSION.id}"`);
    expect(body).toContain(">Open Settings</a>");
    expect(body).toContain("Next: open Settings and configure a provider");
    expect(body).not.toContain("BEGIN");
    expect(body).not.toContain(FAKE_PEM);
    expect(body).not.toContain(FAKE_WEBHOOK_SECRET);
  });

  test("before the first metadata sync the page labels the numeric App id as the App ID", async () => {
    const env = makeEnv();
    await seedApp(env, { githubSlug: null });
    const res = await worker.fetch(await onboardingRequest(CONVERSION.id), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`App ID: ${CONVERSION.id}`);
    expect(body).not.toContain(`Slug: ${CONVERSION.id}`);
  });

  test("admin views any App's onboarding page", async () => {
    const env = makeEnv();
    await seedApp(env, { createdBy: "someone-else" });
    const res = await worker.fetch(await onboardingRequest(CONVERSION.id), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('href="/dashboard/default/repos"');
    expect(body).not.toContain(`href="/dashboard/default/repos/${CONVERSION.id}"`);
  });

  test("Accept-Language zh renders the onboarding page in zh_CN", async () => {
    const env = makeEnv();
    await seedApp(env);
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const zh = await worker.fetch(
      new Request(`https://worker.local/dashboard/default/apps/${CONVERSION.id}/onboarding`, {
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
  });
});

describe("migrations/0003_dashboard_users.sql", () => {
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
    expect(byName["id"]?.pk).toBe(1);
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

describe("migrations/0023_removed_logins.sql", () => {
  test("keys removals by github_login — removed_at required, removed_by nullable", () => {
    const db = createDashboardTestD1();
    const cols = db.raw.query("PRAGMA table_info(removed_logins)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const byName: Record<string, { notnull: number }> = Object.fromEntries(
      cols.map((c) => [c.name, { notnull: c.notnull }]),
    );
    expect(Object.keys(byName).sort()).toEqual(["github_login", "removed_at", "removed_by"]);
    expect(byName["github_login"]?.notnull).toBe(1);
    expect(byName["removed_at"]?.notnull).toBe(1);
    expect(byName["removed_by"]?.notnull).toBe(0);
  });

  test("login comparison is NOCASE, like users.github_login (migration 0016)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "OctoCat", role: "member" });
    const row = await getUserByLogin(db, "octocat");
    expect(await deleteUser(db, row!.id, "ada")).toBe(true);
    expect(await isLoginRemoved(db, "octocat")).toBe(true);
    expect(await isLoginRemoved(db, "OCTOCAT")).toBe(true);
    expect(removedRows(db).map((r) => r.github_login)).toEqual(["OctoCat"]);
    db.raw.run("DELETE FROM removed_logins");
    db.raw.run("INSERT INTO removed_logins (github_login, removed_at) VALUES ('octocat', 't1')");
    expect(() =>
      db.raw.run("INSERT INTO removed_logins (github_login, removed_at) VALUES ('OCTOCAT', 't2')"),
    ).toThrow(/UNIQUE constraint failed/);
    db.raw
      .prepare(
        `INSERT INTO removed_logins (github_login, removed_at, removed_by) VALUES (?, ?, ?)
         ON CONFLICT (github_login) DO UPDATE
           SET removed_at = excluded.removed_at, removed_by = excluded.removed_by`,
      )
      .run("OCTOCAT", "t3", "ada");
    expect(removedRows(db)).toEqual([
      { github_login: "octocat", removed_at: "t3", removed_by: "ada" },
    ]);
  });
});

describe("dashboard users store (users.ts)", () => {
  function membershipRoles(db: DashboardD1 & { raw: Database }): Record<string, string> {
    const rows = db.raw
      .query(
        `SELECT u.github_login AS login, wm.role AS role
         FROM workspace_members wm JOIN users u ON u.id = wm.user_id
         ORDER BY u.github_login`,
      )
      .all() as Array<{ login: string; role: string }>;
    return Object.fromEntries(rows.map((row) => [row.login, row.role]));
  }

  function seedBackfilledUser(
    db: DashboardD1 & { raw: Database },
    login: string,
    role: "admin" | "member",
  ): string {
    const id = crypto.randomUUID();
    db.raw
      .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, ?, ?, NULL)")
      .run(id, login, role, new Date().toISOString());
    db.raw
      .prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('default', ?, ?, ?)")
      .run(id, role === "admin" ? "owner" : "member", new Date().toISOString());
    return id;
  }

  test("createUser writes the users row and NO membership (admission is invite-accept or creation)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    await createUser(db, { login: "hubot", role: "member" });
    expect(membershipRoles(db)).toEqual({});
  });

  test("createUser with no workspace row still succeeds (no tenant read at all)", async () => {
    const db = createDashboardTestD1();
    db.raw.run("DELETE FROM workspaces");
    const user = await createUser(db, { login: "hubot", role: "member" });
    expect((await getUserByLogin(db, "hubot"))?.id).toBe(user.id);
    expect(membershipRoles(db)).toEqual({});
  });

  test("deleteWorkspaceMember drops the membership only: the users row and any invites survive", async () => {
    const db = createDashboardTestD1();
    const admin = seedBackfilledUser(db, "octocat", "admin");
    const hubot = seedBackfilledUser(db, "hubot", "member");
    db.raw
      .prepare(
        `INSERT INTO workspace_invites (id, workspace_id, github_login, role, status, invited_by, created_at, expires_at)
         VALUES (?, 'default', 'newcomer', 'member', 'pending', ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        hubot,
        new Date().toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
      );
    expect(await deleteWorkspaceMember(db, "default", hubot)).toBe(true);
    expect((await getUserByLogin(db, "hubot"))?.id).toBe(hubot);
    expect(membershipRoles(db)).toEqual({ octocat: "owner" });
    expect(await isLoginRemoved(db, "hubot")).toBe(false);
    expect(removedRows(db)).toEqual([]);
    expect(
      db.raw.prepare("SELECT COUNT(*) AS n FROM workspace_invites WHERE invited_by = ?").get(hubot),
    ).toEqual({ n: 1 });
    expect((await getUserByLogin(db, "octocat"))?.id).toBe(admin);
  });

  test("the sole-owner refusal leaves the membership row and writes no tombstone", async () => {
    const db = createDashboardTestD1();
    const soleOwner = seedBackfilledUser(db, "octocat", "admin");
    expect(await deleteWorkspaceMember(db, "default", soleOwner)).toBe(false);
    expect(await getUserByLogin(db, "octocat")).not.toBeNull();
    expect(membershipRoles(db)).toEqual({ octocat: "owner" });
    expect(removedRows(db)).toEqual([]);
  });

  test("updateWorkspaceMemberRole writes workspace_members only, never users.role", async () => {
    const db = createDashboardTestD1();
    seedBackfilledUser(db, "octocat", "admin");
    const hubot = seedBackfilledUser(db, "hubot", "member");
    expect(await updateWorkspaceMemberRole(db, "default", hubot, "admin")).toBe(true);
    expect(membershipRoles(db)).toEqual({ hubot: "admin", octocat: "owner" });
    expect((await getUserByLogin(db, "hubot"))?.role).toBe("member");
    expect(await updateWorkspaceMemberRole(db, "default", hubot, "member")).toBe(true);
    expect(membershipRoles(db)).toEqual({ hubot: "member", octocat: "owner" });
  });

  test("a refused demotion of the sole owner changes no role", async () => {
    const db = createDashboardTestD1();
    const owner = seedBackfilledUser(db, "octocat", "admin");
    expect(await updateWorkspaceMemberRole(db, "default", owner, "member")).toBe(false);
    expect(membershipRoles(db)).toEqual({ octocat: "owner" });
  });

  test("an accepted invite lets the member read the workspace App list", async () => {
    const env = makeEnv();
    const db = dbOf(env);
    await envDb(env).createApp({
      id: crypto.randomUUID(),
      githubSlug: CONVERSION.slug,
      githubAppId: CONVERSION.id,
      name: CONVERSION.name,
      privateKeyEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      webhookSecretEnc: "v1.primary.aXZpdi.cHJldGV4dA==",
      createdBy: "octocat",
      workspaceId: "default",
      maxApps: null,
    });
    const invitee = await createUser(db, { login: "invitee", role: "member" });
    expect(membershipRoles(db)).not.toHaveProperty("invitee");
    await db
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('default', ?, 'member', ?)",
      )
      .bind(invitee.id, new Date().toISOString())
      .run();
    const cookie = `${SESSION_COOKIE}=${await createSessionValue("invitee", null, SESSION_SECRET)}`;

    const res = await worker.fetch(dashboardRequest("/dashboard/default/api/apps", cookie), env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { apps: Array<{ github_app_id: number }> };
    expect(body.apps.map((app) => app.github_app_id)).toEqual([CONVERSION.id]);
  });

  test("createUser + getUserByLogin round trip (bootstrapped admin shape)", async () => {
    const db = createDashboardTestD1();
    const created = await createUser(db, { login: "octocat", role: "admin" });
    expect(created.github_login).toBe("octocat");
    expect(created.role).toBe("admin");
    expect(created.invited_by).toBeNull();
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
    await expect(createUser(db, { login: "alice", role: "member" })).rejects.toThrow(DuplicateLoginError);
    expect(userCount(db)).toBe(1);
  });

  test("listUsers / deleteUser / countUsers", async () => {
    const db = createDashboardTestD1();
    const admin = await createUser(db, { login: "octocat", role: "admin" });
    const member = await createUser(db, { login: "hubot", role: "member" });
    expect(await countUsers(db)).toBe(2);
    const logins = (await listUsers(db)).map((u) => u.github_login).sort();
    expect(logins).toEqual(["hubot", "octocat"]);
    expect(await deleteUser(db, member.id)).toBe(true);
    expect(await deleteUser(db, member.id)).toBe(false);
    expect(await deleteUser(db, "missing-id")).toBe(false);
    expect(await countUsers(db)).toBe(1);
    expect((await getUserByLogin(db, admin.github_login))?.id).toBe(admin.id);
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

  test("parseLoginList trims entries, drops empties, treats unset/blank as empty", () => {
    expect(parseLoginList(undefined)).toEqual([]);
    expect(parseLoginList("")).toEqual([]);
    expect(parseLoginList("   ")).toEqual([]);
    expect(parseLoginList(" octocat , Hubot ,, ada ")).toEqual(["octocat", "Hubot", "ada"]);
  });
});

describe("signInDashboardUser precedence (login is member)", () => {
  test("empty users table + any login → the row is created, role is member, no membership", async () => {
    const db = createDashboardTestD1();
    const decision = await signInDashboardUser(db, "octocat");
    expect(decision.outcome).toBe("allow");
    if (decision.outcome === "allow") {
      expect(decision.created).toBe(true);
      expect(decision.user.role).toBe("member");
      expect(decision.user.invited_by).toBeNull();
    }
    expect(userCount(db)).toBe(1);
    const membership = db.raw.query("SELECT * FROM workspace_members").all();
    expect(membership).toEqual([]);
  });

  test("a populated users table does not gate an unknown login (no allowlist)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const decision = await signInDashboardUser(db, "mallory");
    expect(decision.outcome).toBe("allow");
    if (decision.outcome === "allow") expect(decision.created).toBe(true);
    expect(userCount(db)).toBe(2);
  });

  test("an existing row wins: allow, zero writes, no promotion", async () => {
    const db = createDashboardTestD1();
    const existing = await createUser(db, { login: "octocat", role: "member" });
    expect(await signInDashboardUser(db, "octocat")).toEqual({
      outcome: "allow",
      user: existing,
      created: false,
    });
    expect(userCount(db)).toBe(1);
  });

  test("row lookup is case-insensitive", async () => {
    const db = createDashboardTestD1();
    const existing = await createUser(db, { login: "octocat", role: "member" });
    expect(await signInDashboardUser(db, "OCTOCAT")).toEqual({
      outcome: "allow",
      user: existing,
      created: false,
    });
  });

  test("a recorded removal still denies — case-insensitively, with zero writes", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const removed = await createUser(db, { login: "hubot", role: "member" });
    await deleteUser(db, removed.id, "octocat");
    expect(await signInDashboardUser(db, "hubot")).toEqual({ outcome: "deny" });
    expect(await signInDashboardUser(db, "HUBOT")).toEqual({ outcome: "deny" });
    expect(await getUserByLogin(db, "hubot")).toBeNull();
    expect(userCount(db)).toBe(1);
  });

  test("a deliberate re-admission (createUser) clears the removal record and lets the login back in", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const removed = await createUser(db, { login: "hubot", role: "member" });
    expect(await deleteUser(db, removed.id, "octocat")).toBe(true);
    expect(await signInDashboardUser(db, "hubot")).toEqual({ outcome: "deny" });
    const reinvited = await createUser(db, { login: "hubot", role: "member", invitedBy: "octocat" });
    expect(removedRows(db)).toEqual([]);
    expect(await signInDashboardUser(db, "hubot")).toEqual({
      outcome: "allow",
      user: reinvited,
      created: false,
    });
  });

  test("a live row outranks a stale tombstone", async () => {
    const db = createDashboardTestD1();
    const existing = await createUser(db, { login: "octocat", role: "member" });
    db.raw
      .prepare("INSERT INTO removed_logins (github_login, removed_at, removed_by) VALUES (?, ?, NULL)")
      .run("octocat", new Date().toISOString());
    expect(await signInDashboardUser(db, "octocat")).toEqual({
      outcome: "allow",
      user: existing,
      created: false,
    });
  });

  test("SEC-01: a sign-in paused after its reads cannot resurrect a login removed in between", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "root-admin", role: "admin" });
    const racy = bootstrapRaceD1(db, async () => {
      const created = await createUser(db, { login: "octocat", role: "member" });
      expect(await deleteUser(db, created.id, "root-admin")).toBe(true);
    });
    expect(await signInDashboardUser(racy, "octocat")).toEqual({ outcome: "deny" });
    expect(await getUserByLogin(db, "octocat")).toBeNull();
    expect(await isLoginRemoved(db, "octocat")).toBe(true);
    expect(removedRows(db).map((r) => r.github_login)).toEqual(["octocat"]);
    expect(userCount(db)).toBe(1);
  });

  test("SEC-01: the write-boundary refusal is case-insensitive (OCTOCAT login, octocat removal)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "root-admin", role: "admin" });
    const racy = bootstrapRaceD1(db, async () => {
      const created = await createUser(db, { login: "octocat", role: "member" });
      expect(await deleteUser(db, created.id, "root-admin")).toBe(true);
    });
    expect(await signInDashboardUser(racy, "OCTOCAT")).toEqual({ outcome: "deny" });
    expect(await getUserByLogin(db, "OCTOCAT")).toBeNull();
    expect(await isLoginRemoved(db, "octocat")).toBe(true);
    expect(userCount(db)).toBe(1);
  });
});

describe("/dashboard/oauth/callback sign-in", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function stubGitHubIdentity(login: string): void {
    globalThis.fetch = (async (url: unknown) => {
      const target = String(url);
      if (target === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: gh("o", "test-token") }), {
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

  test("empty users table + any login → 302, session cookie, a member row, no membership (AC1)", async () => {
    const db = createDashboardTestD1();
    db.raw.run("DELETE FROM users");
    stubGitHubIdentity("deployer");
    const res = await oauthCallback("deployer", makeDbEnv(db));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    expect((await getUserByLogin(db, "deployer"))?.role).toBe("member");
    expect(db.raw.query("SELECT * FROM workspace_members").all()).toEqual([]);
  });

  test("a populated table does not gate an unknown login (no allowlist to miss)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    stubGitHubIdentity("mallory");
    const res = await oauthCallback("mallory", makeDbEnv(db));
    expect(res.status).toBe(302);
    expect((await getUserByLogin(db, "mallory"))?.role).toBe("member");
    expect(userCount(db)).toBe(2);
  });

  test("SEC-01: a removal landing inside the callback's read→insert window → 403, ZERO Set-Cookie, no resurrected row", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "root-admin", role: "admin" });
    stubGitHubIdentity("octocat");
    const racy = bootstrapRaceD1(db, async () => {
      const created = await createUser(db, { login: "octocat", role: "member" });
      expect(await deleteUser(db, created.id, "root-admin")).toBe(true);
    });
    const res = await oauthCallback("octocat", makeDbEnv(racy));
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(await getUserByLogin(db, "octocat")).toBeNull();
    expect(await isLoginRemoved(db, "octocat")).toBe(true);
    expect(userCount(db)).toBe(1);
  });

  test("a recorded removal → 403 deny page with ZERO Set-Cookie and zero writes", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const removed = await createUser(db, { login: "mallory", role: "member" });
    await deleteUser(db, removed.id, "octocat");
    stubGitHubIdentity("mallory");
    const res = await oauthCallback("mallory", makeDbEnv(db));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Access removed");
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(userCount(db)).toBe(1);
  });

  test("a login with no workspace lands on the shell, not a workspace page it cannot open", async () => {
    const db = createDashboardTestD1();
    stubGitHubIdentity("octocat");
    const res = await oauthCallback("octocat", makeDbEnv(db));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
  });

  test("a workspace MEMBER lands on that workspace's Apps page", async () => {
    const db = createDashboardTestD1();
    const user = await createUser(db, { login: "octocat", role: "member" });
    db.raw
      .prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('default', ?, 'owner', ?)")
      .run(user.id, new Date().toISOString());
    stubGitHubIdentity("octocat");
    const res = await oauthCallback("octocat", makeDbEnv(db));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/repos");
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
    const res = await oauthCallback("octocat", makeDbEnv(db));
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    const value = cookie.split(";")[0]?.slice(SESSION_COOKIE.length + 1) ?? "";
    const payload = await readSessionValue(value, SESSION_SECRET);
    expect(payload?.login).toBe("octocat");
    expect(Object.keys(payload ?? {}).sort()).toEqual(["exp", "iat", "login"]);
  });

  test("missing D1 binding on the post-identity path → 500 fail-closed, no session cookie", async () => {
    stubGitHubIdentity("octocat");
    const res = await oauthCallback("octocat", baseEnv());
    expect(res.status).toBe(500);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
  });
});

describe("per-request allowlist guard (spec § AuthZ + lock L5)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  async function removedMemberEnv(): Promise<Env> {
    const db = createDashboardTestD1();
    await createUser(db, { login: "octocat", role: "admin" });
    const mallory = await createUser(db, { login: "mallory", role: "member" });
    await deleteUser(db, mallory.id);
    return makeDbEnv(db);
  }

  const mallorySession = () => createSessionValue("mallory", null, SESSION_SECRET);

  test("removed member with a valid cookie → 403 + expired session on API/fetch, 302 + expired session on HTML navigation (shell, manifest start/confirm/commit, catch-all)", async () => {
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls++;
      throw new Error("no network may run behind the guard");
    }) as unknown as typeof fetch;
    const env = withSpaAssets(await removedMemberEnv());
    const cookie = `${SESSION_COOKIE}=${await mallorySession()}`;
    for (const accept of [undefined, "application/json"]) {
      const headers: Record<string, string> = { Cookie: cookie };
      if (accept) headers.Accept = accept;
      const shell = await worker.fetch(new Request("https://worker.local/dashboard", { headers }), env);
      expect(shell.status, accept ?? "no Accept").toBe(403);
      const body = await shell.text();
      expect(body).toContain("Your dashboard access was removed. Ask an admin to re-invite mallory.");
      expect(body).not.toContain("Signed in as");
      expect(body).not.toContain('action="/dashboard/manifest/start"');
      const setCookie = shell.headers.getSetCookie();
      expect(setCookie, accept ?? "no Accept").toHaveLength(1);
      expect(setCookie[0]).toContain(`${SESSION_COOKIE}=;`);
      expect(setCookie[0]).toContain("Max-Age=0");
    }
    const htmlShell = await worker.fetch(
      new Request("https://worker.local/dashboard", {
        headers: { Cookie: cookie, Accept: "text/html" },
      }),
      env,
    );
    expect(htmlShell.status).toBe(302);
    expect(htmlShell.headers.get("Location")).toBe("/dashboard/login");
    expect(htmlShell.headers.getSetCookie()).toHaveLength(1);
    const start = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/start", {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      env,
    );
    expect(start.status).toBe(403);
    expect(start.headers.getSetCookie()).toHaveLength(1);
    const confirm = await worker.fetch(dashboardRequest("/dashboard/manifest/confirm", cookie), env);
    expect(confirm.status).toBe(403);
    expect(confirm.headers.getSetCookie()).toHaveLength(1);
    const commit = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/commit", {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      env,
    );
    expect(commit.status).toBe(403);
    expect(commit.headers.getSetCookie()).toHaveLength(1);
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

  test("removed member HTML navigation on a non-enumerated route → expire + 302 login (guard)", async () => {
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
    const env = await removedMemberEnv();
    const login = await worker.fetch(dashboardRequest("/dashboard/login"), env);
    expect(login.status).toBe(302);
    expect(new URL(login.headers.get("Location") ?? "").host).toBe("github.com");
    const callback = await worker.fetch(
      dashboardRequest("/dashboard/oauth/callback?code=x&state=y"),
      env,
    );
    expect(callback.status).toBe(400);
  });

  test("member requests pass the guard and reach the routes unchanged (SPA shell + B1 manifest)", async () => {
    const env = makeEnv();
    const cookie = `${SESSION_COOKIE}=${await createSessionValue("octocat", null, SESSION_SECRET)}`;
    const shell = await worker.fetch(
      htmlDashboardRequest("/dashboard/default/apps", cookie),
      withSpaAssets(env),
    );
    expect(shell.status).toBe(200);
    const shellBody = await shell.text();
    expect(shellBody).toContain("window.__BOOT__=");
    expect(shellBody).toContain('"login":"octocat"');
    expect(shellBody).toContain('"role":"owner"');
    const start = await worker.fetch(
      new Request("https://worker.local/dashboard/manifest/start", {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      env,
    );
    expect(start.status).toBe(200);
    const out = await worker.fetch(dashboardRequest("/dashboard/logout", cookie), env);
    expect(out.status).toBe(302);
    expect(out.headers.get("Location")).toBe("/dashboard/login");
    expect(out.headers.getSetCookie()).toHaveLength(3);
  });

  test("membership lookup is case-insensitive: session login case variant of a member row passes", async () => {
    const session = await createSessionValue("OctoCat", null, SESSION_SECRET);
    const res = await worker.fetch(
      htmlDashboardRequest("/dashboard/default/apps", `${SESSION_COOKIE}=${session}`),
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
      baseEnv(),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("dashboard storage is not configured");
  });

  test("removed-member denial logs a structured not_a_member warning (login only, no secrets)", async () => {
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


describe("members page (workspace-scoped shell)", () => {
  const adminCookie = async () =>
    `${SESSION_COOKIE}=${await createSessionValue("octocat", null, SESSION_SECRET)}`;

  test("the workspace members page is the SPA shell for an HTML navigation", async () => {
    const env = withSpaAssets(makeEnv());
    const res = await htmlGet("/dashboard/default/members", await adminCookie(), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).not.toContain(SPA_BOOT_MARKER);
  });

  test("no session on the workspace members page 302s into the OAuth flow", async () => {
    const env = withSpaAssets(makeEnv());
    const get = await htmlGet("/dashboard/default/members", "", env);
    expect(get.status).toBe(302);
    expect(get.headers.get("Location")).toBe("/dashboard/login");
  });

  test("the retired root members page is not a route (no legacy copy)", async () => {
    const res = await worker.fetch(
      dashboardRequest("/dashboard/members", await adminCookie()),
      withSpaAssets(makeEnv()),
    );
    expect(res.status).toBe(404);
  });

});


describe("POST /dashboard/api/workspaces — workspace creation", () => {
  const WORKSPACE_ID = /^ws_[a-z2-7]{22}$/;

  const FREE_SLOT_REFUSAL =
    "This workspace was not created. You already belong to a free workspace, and you can belong to only one at a time. Delete that workspace if you own it. If you do not, an owner or admin of that workspace must remove you. Then create this one.";

  async function createWorkspaceRequest(
    db: DashboardD1 & { raw: Database },
    login: string,
    form: Record<string, string>,
    mode: "saas" | "self-hosted" = "self-hosted",
  ): Promise<Response> {
    const session = await createSessionValue(login, null, SESSION_SECRET);
    return worker.fetch(
      new Request("https://worker.local/dashboard/api/workspaces", {
        method: "POST",
        headers: {
          Cookie: `${SESSION_COOKIE}=${session}`,
          "Content-Type": "application/x-www-form-urlencoded",
          [SPA_POST_FORM_HEADER]: SPA_POST_FORM_VALUE,
        },
        body: new URLSearchParams(form),
      }),
      makeDbEnv(db, { DEPLOYMENT_MODE: mode }),
    );
  }

  type WorkspaceRow = { id: string; slug: string; name: string; created_by: string };
  type MemberRow = { workspace_id: string; user_id: string; role: string };
  type CountRow = { n: number };

  function workspaceCount(db: DashboardD1 & { raw: Database }): number {
    return (db.raw.query("SELECT COUNT(*) AS n FROM workspaces").get() as CountRow).n;
  }

  function memberRowCount(db: DashboardD1 & { raw: Database }): number {
    return (db.raw.query("SELECT COUNT(*) AS n FROM workspace_members").get() as CountRow).n;
  }

  function subscriptionRowCount(db: DashboardD1 & { raw: Database }): number {
    return (db.raw.query("SELECT COUNT(*) AS n FROM workspace_subscriptions").get() as CountRow).n;
  }

  test("creates the workspace, its owner membership and its free subscription, returning the ref", async () => {
    const db = createDashboardTestD1();
    db.raw.run("DELETE FROM users");
    const user = await createUser(db, { login: "deployer", role: "member" });

    const res = await createWorkspaceRequest(db, "deployer", { name: "  Acme  " });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; slug: string; name: string; role: string };
    expect(body.id).toMatch(WORKSPACE_ID);
    expect(body.slug).toBe(body.id);
    expect(body.name).toBe("Acme");
    expect(body.role).toBe("owner");

    const rows = db.raw
      .query("SELECT id, slug, name, created_by FROM workspaces WHERE id = ?")
      .all(body.id) as WorkspaceRow[];
    expect(rows).toEqual([{ id: body.id, slug: body.id, name: "Acme", created_by: user.id }]);
    const members = db.raw
      .query("SELECT workspace_id, user_id, role FROM workspace_members WHERE workspace_id = ?")
      .all(body.id) as MemberRow[];
    expect(members).toEqual([{ workspace_id: body.id, user_id: user.id, role: "owner" }]);
    const subscriptions = db.raw
      .query("SELECT workspace_id, plan_id, status FROM workspace_subscriptions WHERE workspace_id = ?")
      .all(body.id);
    expect(subscriptions).toEqual([{ workspace_id: body.id, plan_id: "free", status: "active" }]);
    const defaults = db.raw
      .query("SELECT * FROM workspace_members WHERE workspace_id = 'default'")
      .all();
    expect(defaults).toEqual([]);
  });

  test("an empty or whitespace-only name is 400 and writes nothing", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "deployer", role: "member" });
    const before = workspaceCount(db);
    for (const name of ["", "   "]) {
      const res = await createWorkspaceRequest(db, "deployer", { name });
      expect(res.status, JSON.stringify(name)).toBe(400);
    }
    expect(workspaceCount(db)).toBe(before);
  });

  test("a name over 80 characters is 400 and writes nothing", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "deployer", role: "member" });
    const before = workspaceCount(db);
    const res = await createWorkspaceRequest(db, "deployer", { name: "a".repeat(81) });
    expect(res.status).toBe(400);
    expect(workspaceCount(db)).toBe(before);
  });

  test("an 80-character name is accepted (the boundary)", async () => {
    const db = createDashboardTestD1();
    await createUser(db, { login: "deployer", role: "member" });
    const name = "a".repeat(80);
    const res = await createWorkspaceRequest(db, "deployer", { name });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { name: string }).name).toBe(name);
  });

  test("a second free workspace for the same login is refused with the exact 409 body and writes nothing", async () => {
    const db = createDashboardTestD1();
    db.raw.run("DELETE FROM users");
    await createUser(db, { login: "deployer", role: "member" });

    const first = await createWorkspaceRequest(db, "deployer", { name: "First" }, "saas");
    expect(first.status).toBe(201);
    const workspacesBefore = workspaceCount(db);
    const membersBefore = memberRowCount(db);
    const subscriptionsBefore = subscriptionRowCount(db);
    expect(subscriptionsBefore).toBe(1);

    for (const name of ["Second", "Retry"]) {
      const res = await createWorkspaceRequest(db, "deployer", { name }, "saas");
      expect(res.status, name).toBe(409);
      expect(await res.text(), name).toBe(FREE_SLOT_REFUSAL);
      expect(workspaceCount(db), name).toBe(workspacesBefore);
      expect(memberRowCount(db), name).toBe(membersBefore);
      expect(subscriptionRowCount(db), name).toBe(subscriptionsBefore);
    }
  });

  test("self-hosted allows a second workspace: nothing resolves to free there", async () => {
    const db = createDashboardTestD1();
    db.raw.run("DELETE FROM users");
    await createUser(db, { login: "deployer", role: "member" });

    expect((await createWorkspaceRequest(db, "deployer", { name: "First" })).status).toBe(201);
    expect((await createWorkspaceRequest(db, "deployer", { name: "Second" })).status).toBe(201);
    expect(subscriptionRowCount(db)).toBe(2);
    expect(
      db.raw.query("SELECT plan_id FROM workspace_subscriptions ORDER BY created_at").all(),
    ).toEqual([{ plan_id: "free" }, { plan_id: "free" }]);
  });

  test("owning a pro workspace does not consume the free slot", async () => {
    const db = createDashboardTestD1();
    db.raw.run("DELETE FROM users");
    const user = await createUser(db, { login: "deployer", role: "member" });
    const now = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES ('ws_pro', 'ws_pro', 'Pro', ?, ?, NULL)",
      )
      .run(user.id, now);
    db.raw
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws_pro', ?, 'owner', ?)",
      )
      .run(user.id, now);
    db.raw
      .prepare(
        "INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at) VALUES ('ws_pro', 'pro', 'active', ?, ?)",
      )
      .run(now, now);

    const res = await createWorkspaceRequest(db, "deployer", { name: "Free one" }, "saas");
    expect(res.status).toBe(201);
    const plans = db.raw
      .query("SELECT plan_id FROM workspace_subscriptions ORDER BY plan_id")
      .all();
    expect(plans).toEqual([{ plan_id: "free" }, { plan_id: "pro" }]);
  });

  test("a soft-deleted workspace frees the slot: the next creation succeeds", async () => {
    const db = createDashboardTestD1();
    db.raw.run("DELETE FROM users");
    await createUser(db, { login: "deployer", role: "member" });
    const first = await createWorkspaceRequest(db, "deployer", { name: "Workspace 1" }, "saas");
    expect(first.status).toBe(201);
    const retired = (await first.json()) as { id: string };

    const refused = await createWorkspaceRequest(db, "deployer", { name: "Workspace 2" }, "saas");
    expect(refused.status).toBe(409);

    db.raw
      .prepare("UPDATE workspaces SET deleted_at = ? WHERE id = ?")
      .run(new Date().toISOString(), retired.id);

    const res = await createWorkspaceRequest(db, "deployer", { name: "Replacement" }, "saas");
    expect(res.status).toBe(201);
  });

  test("anonymous → 302 to login, zero writes", async () => {
    const db = createDashboardTestD1();
    const before = workspaceCount(db);
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name: "Acme" }),
      }),
      makeDbEnv(db),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    expect(workspaceCount(db)).toBe(before);
  });
});

describe("workspace switch leaves the session untouched (workspace URL identifiers, 2026-10 — I-000059)", () => {
  function twoWorkspaceDb() {
    const db = seededDashboardD1();
    const now = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES ('ws_beta', 'beta', 'Beta', NULL, ?, NULL)",
      )
      .run(now);
    const user = db.raw
      .query("SELECT id FROM users WHERE github_login = 'octocat'")
      .get() as { id: string };
    db.raw
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws_beta', ?, 'owner', ?)",
      )
      .run(user.id, now);
    return db;
  }

  test("navigating between workspaces presents the same cookie bytes and sets none", async () => {
    const env = withSpaAssets(makeDbEnv(twoWorkspaceDb()));
    const value = await createSessionValue("octocat", null, SESSION_SECRET);
    const jar = `${SESSION_COOKIE}=${value}`;

    const before = "/dashboard/default/apps";
    const after = replaceWorkspaceRef(before, "ws_beta");
    expect(after).toBe("/dashboard/ws_beta/apps");

    for (const [ref, path] of [
      ["default", before],
      ["ws_beta", after as string],
    ] as const) {
      const res = await htmlGet(path, jar, env);
      expect(res.status, ref).toBe(200);
      expect(res.headers.getSetCookie(), ref).toEqual([]);
      const body = await res.text();
      expect(body, ref).toContain(`"workspaceRef":"${ref}"`);
      expect(body, ref).toContain('"slug":"beta"');
      expect(body, ref).toContain('"slug":"default"');
      for (const [name, header] of res.headers) {
        expect(header, `${ref} ${name}`).not.toContain("ws_beta");
        expect(header, `${ref} ${name}`).not.toContain("beta");
      }
    }

    const payload = JSON.parse((await verifyValue(value, SESSION_SECRET)) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "login"]);
    expect(payload.login).toBe("octocat");
  });

  test("the only workspace is the control's one row: a pick changes no bytes and sets no cookie", async () => {
    const env = withSpaAssets(makeDbEnv(seededDashboardD1()));
    const value = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await htmlGet("/dashboard/default/apps", `${SESSION_COOKIE}=${value}`, env);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);

    const body = await res.text();
    expect(body).toContain('"workspaceRef":"default"');
    const boot = JSON.parse(
      /window\.__BOOT__=(\{.*?\});<\/script>/s.exec(body)?.[1] ?? "{}",
    ) as Parameters<typeof buildWorkspaceSwitcherModel>[0];
    expect(boot.memberships).toHaveLength(1);
    const model = buildWorkspaceSwitcherModel(boot, "/dashboard/default/apps");
    expect(model?.currentRef).toBe("default");
    expect(model?.options).toEqual([{ ref: "default", name: "Default" }]);
    expect(model?.target).toBe("replace");
  });
});

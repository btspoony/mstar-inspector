/**
 * `server_flags` and its consumers (plan 116 Task 2, spec operator-admin-surface
 * §3.1).
 *
 * Pinned at the CONSUMER, not at the accessor alone: an absent row means
 * ENABLED (the behaviour the platform shipped with), and a stored `0` changes
 * what the named consumer does — signup refused, review not enqueued, creation
 * refused. The console's write path is pinned too: one PATCH = one flag row +
 * exactly one platform audit row.
 */
import { afterEach, describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { isFlagEnabled, type ServerFlagKey } from "../../src/admin/flags";
import { OAUTH_STATE_COOKIE, SESSION_COOKIE, createStateValue } from "../../src/dashboard/session";

const SESSION_SECRET = ["test", "flag", "accessor", "secret", "32-bytes!"].join("-");
const OPERATOR = "Support-Bot";
const OPERATOR_KEY = OPERATOR.toLowerCase();
const MEMBER = "regular-member";

/** Raw fixture writes (the accessor and every consumer read real SQL). */
function insertUser(db: TestD1, login: string): void {
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(crypto.randomUUID(), login, new Date().toISOString());
}

function setFlagRow(db: TestD1, key: ServerFlagKey, enabled: 0 | 1): void {
  db.raw
    .prepare("INSERT INTO server_flags (key, enabled, updated_at, updated_by) VALUES (?, ?, ?, 'fixture')")
    .run(key, enabled, new Date().toISOString());
}

function envFor(db: TestD1, overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DEPLOYMENT_MODE: "self-hosted",
    PLATFORM_OPERATORS: OPERATOR_KEY,
    DB: db,
    ...overrides,
  } as unknown as Env;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

/** GitHub identity stub: token exchange then `/user` for the given login. */
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

/** Run the real OAuth callback for `login`. */
async function oauthCallback(login: string, env: Env): Promise<Response> {
  stubGitHubIdentity(login);
  const state = await createStateValue(SESSION_SECRET);
  return worker.fetch(
    new Request(`https://worker.local/dashboard/oauth/callback?code=x&state=${state}`, {
      headers: { Cookie: `${OAUTH_STATE_COOKIE}=${state}` },
    }),
    env,
  );
}

function userCount(db: TestD1, login: string): number {
  // bun:sqlite returns an untyped row; the SELECT above fixes its shape.
  const row = db.raw
    .prepare("SELECT COUNT(*) AS n FROM users WHERE github_login = ? COLLATE NOCASE")
    .get(login) as { n: number } | null;
  return row?.n ?? 0;
}

/** Does the response mint a live session cookie? */
function mintedSession(res: Response): boolean {
  return res.headers
    .getSetCookie()
    .some((value) => value.startsWith(`${SESSION_COOKIE}=`) && !value.includes("Max-Age=0"));
}

describe("isFlagEnabled", () => {
  test("an absent row reads as enabled — fail-open to current behaviour", async () => {
    const db = createMigratedTestD1();
    for (const key of ["review_global", "signup_open", "workspace_creation_open"] as const) {
      expect(await isFlagEnabled(db, key)).toBe(true);
    }
  });

  test("a stored row is the effective value", async () => {
    const db = createMigratedTestD1();
    setFlagRow(db, "signup_open", 0);
    setFlagRow(db, "review_global", 1);
    expect(await isFlagEnabled(db, "signup_open")).toBe(false);
    expect(await isFlagEnabled(db, "review_global")).toBe(true);
  });
});

describe("signup_open at the OAuth first-sign-in branch", () => {
  test("an absent row still creates a `users` row for an unknown login", async () => {
    const db = createMigratedTestD1();
    const res = await oauthCallback("newcomer", envFor(db));
    expect(res.status).toBe(302);
    expect(mintedSession(res)).toBe(true);
    expect(userCount(db, "newcomer")).toBe(1);
  });

  test("closed refuses an unknown login with zero writes and no session", async () => {
    const db = createMigratedTestD1();
    setFlagRow(db, "signup_open", 0);
    const res = await oauthCallback("newcomer", envFor(db));
    expect(res.status).toBe(403);
    expect(mintedSession(res)).toBe(false);
    expect(userCount(db, "newcomer")).toBe(0);
  });

  test("closed leaves an existing login untouched", async () => {
    const db = createMigratedTestD1();
    insertUser(db, MEMBER);
    setFlagRow(db, "signup_open", 0);
    const res = await oauthCallback(MEMBER, envFor(db));
    expect(res.status).toBe(302);
    expect(mintedSession(res)).toBe(true);
  });
});

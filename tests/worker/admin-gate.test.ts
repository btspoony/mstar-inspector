/**
 * `/_internal_admin` — the namespace, its gate, and its registration.
 *
 * One matrix over (deployment mode × caller). The namespace must be
 * indistinguishable from an unknown path for everyone except a platform
 * operator on a `saas` deployment: same 404 body, no redirect, no `403`. The
 * allowlisted login is the SAME caller in both mode columns, so the
 * `self-hosted` column proves the refusal is registration-time rather than a
 * runtime flag inside a handler.
 */
import { describe, expect, test } from "bun:test";
import type { Fetcher } from "@cloudflare/workers-types";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "admin", "gate", "secret", "32-bytes!"].join("-");
/** The allowlisted login. The allowlist names it lowercase (NOCASE compare). */
const OPERATOR = "Support-Bot";
const OPERATOR_KEY = OPERATOR.toLowerCase();
/** A signed-in account that is NOT on the allowlist. */
const MEMBER = "regular-member";

const ADMIN_HTML = `<!doctype html><html><head><!--SPA_BOOT--></head><body>admin console</body></html>`;

/**
 * The deployed `dist/spa` bucket, restricted to the admin document. Any other
 * path is a miss, so a test that reaches the document through a route other
 * than the gated admin one fails instead of finding it.
 */
function adminAssets(): Fetcher {
  return {
    fetch: async (input: Request | URL | string) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (pathname !== "/admin.html") return new Response("missing", { status: 404 });
      return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  } as unknown as Fetcher;
}

function seededDb(): TestD1 {
  const db = createMigratedTestD1();
  const insert = db.raw.prepare(
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)",
  );
  insert.run(crypto.randomUUID(), OPERATOR, new Date().toISOString());
  insert.run(crypto.randomUUID(), MEMBER, new Date().toISOString());
  return db;
}

function envFor(mode: string): Env {
  return {
    DEPLOYMENT_MODE: mode,
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    PLATFORM_OPERATORS: OPERATOR_KEY,
    DB: seededDb(),
    ASSETS: adminAssets(),
  } as unknown as Env;
}

/** A GET as `login`, or anonymous when `login` is null. */
async function get(path: string, login: string | null, env: Env): Promise<Response> {
  const headers: Record<string, string> = { Accept: "text/html" };
  if (login !== null) {
    headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  }
  return worker.fetch(new Request(`https://worker.local${path}`, { headers }), env);
}

describe("/_internal_admin on saas", () => {
  test("an operator reads the namespace API", async () => {
    const res = await get("/_internal_admin/api/me", OPERATOR, envFor("saas"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: OPERATOR });
  });

  test("a signed-in non-operator gets the unknown-path 404, not a 403", async () => {
    const env = envFor("saas");
    const res = await get("/_internal_admin/api/me", MEMBER, env);
    const unknown = await get("/not-a-route", null, env);
    expect(res.status).toBe(unknown.status);
    expect(await res.text()).toBe(await unknown.text());
  });

  test("an unauthenticated request gets 404, never a login redirect", async () => {
    const env = envFor("saas");
    const res = await get("/_internal_admin/api/me", null, env);
    const unknown = await get("/not-a-route", null, env);
    expect(res.status).toBe(unknown.status);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toBe(await unknown.text());
  });

  test("a forged session cookie is a 404", async () => {
    const env = envFor("saas");
    const res = await worker.fetch(
      new Request("https://worker.local/_internal_admin/api/me", {
        headers: { Cookie: `${SESSION_COOKIE}=not-a-signed-value` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  test("an allowlisted login with no users row is a 404", async () => {
    const env = envFor("saas");
    // Same signature, but this login was never created — the allowlist alone
    // must not authorize.
    const res = await get("/_internal_admin/api/me", "never-signed-in", env);
    expect(res.status).toBe(404);
  });
});

describe("/_internal_admin on self-hosted", () => {
  test("the route does not exist, even for an allowlisted login", async () => {
    const env = envFor("self-hosted");
    const unknown = await get("/not-a-route", null, env);
    const unknownText = await unknown.text();
    for (const path of ["/_internal_admin/api/me", "/_internal_admin/flags"]) {
      const res = await get(path, OPERATOR, env);
      expect(res.status).toBe(unknown.status);
      expect(await res.text()).toBe(unknownText);
    }
  });
});

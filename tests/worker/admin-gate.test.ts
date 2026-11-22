import { describe, expect, test } from "bun:test";
import type { Fetcher } from "@cloudflare/workers-types";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "admin", "gate", "secret", "32-bytes!"].join("-");
const OPERATOR = "Support-Bot";
const OPERATOR_KEY = OPERATOR.toLowerCase();
const MEMBER = "regular-member";

const ADMIN_HTML = `<!doctype html><html lang="en"><head><!--SPA_BOOT--><title>Morning Star — Platform operations</title></head><body>admin console</body></html>`;

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

async function get(path: string, login: string | null, env: Env): Promise<Response> {
  const headers: Record<string, string> = { Accept: "text/html" };
  if (login !== null) {
    headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  }
  return worker.fetch(new Request(`https://worker.local${path}`, { headers }), env);
}

describe("/_internal_admin on saas", () => {
  test("an operator reads the namespace API", async () => {
    const res = await get("/_internal_admin/api/users", OPERATOR, envFor("saas"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ login: string }> };
    expect(body.users.map((user) => user.login)).toContain(OPERATOR);
  });

  test("there is no identity read: /api/me is the unknown-path 404", async () => {
    const env = envFor("saas");
    const res = await get("/_internal_admin/api/me", OPERATOR, env);
    const unknown = await get("/not-a-route", null, env);
    expect(res.status).toBe(unknown.status);
    expect(await res.text()).toBe(await unknown.text());
  });

  test("a signed-in non-operator gets the unknown-path 404, not a 403", async () => {
    const env = envFor("saas");
    const res = await get("/_internal_admin/api/users", MEMBER, env);
    const unknown = await get("/not-a-route", null, env);
    expect(res.status).toBe(unknown.status);
    expect(await res.text()).toBe(await unknown.text());
  });

  test("an unauthenticated request gets 404, never a login redirect", async () => {
    const env = envFor("saas");
    const res = await get("/_internal_admin/api/users", null, env);
    const unknown = await get("/not-a-route", null, env);
    expect(res.status).toBe(unknown.status);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toBe(await unknown.text());
  });

  test("a forged session cookie is a 404", async () => {
    const env = envFor("saas");
    const res = await worker.fetch(
      new Request("https://worker.local/_internal_admin/api/users", {
        headers: { Cookie: `${SESSION_COOKIE}=not-a-signed-value` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  test("an allowlisted login with no users row is a 404", async () => {
    const env = envFor("saas");
    const res = await get("/_internal_admin/api/users", "never-signed-in", env);
    expect(res.status).toBe(404);
  });
});

describe("the admin document", () => {
  function bootOf(html: string): Record<string, unknown> {
    const json = /window\.__BOOT__=(\{.*?\});<\/script>/s.exec(html)?.[1];
    if (json === undefined) throw new Error("no boot in the admin document");
    return JSON.parse(json) as Record<string, unknown>;
  }

  test("an operator gets the console document, booted with their login only", async () => {
    const env = envFor("saas");
    const res = await get("/_internal_admin/flags", OPERATOR, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await get("/_internal_admin", OPERATOR, env)).status).toBe(200);
    const boot = bootOf(await res.text());
    expect(boot.login).toBe(OPERATOR);
    for (const key of ["memberships", "pendingInvites", "workspaceRef", "workspaceBoot"]) {
      expect(boot).not.toHaveProperty(key);
    }
  });

  test("a non-operator and an anonymous caller never see it", async () => {
    const env = envFor("saas");
    const unknown = await get("/not-a-route", null, env);
    const unknownText = await unknown.text();
    for (const login of [MEMBER, null]) {
      const res = await get("/_internal_admin/flags", login, env);
      expect(res.status).toBe(unknown.status);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toBe(unknownText);
    }
  });

  test("/admin.html is not served outside the gated admin route", async () => {
    for (const mode of ["saas", "self-hosted"]) {
      const env = envFor(mode);
      const res = await get("/admin.html", OPERATOR, env);
      const unknown = await get("/not-a-route", null, env);
      expect(res.status).toBe(unknown.status);
      expect(await res.text()).toBe(await unknown.text());
    }
  });
});

describe("/_internal_admin on self-hosted", () => {
  test("the route does not exist, even for an allowlisted login", async () => {
    const env = envFor("self-hosted");
    const unknown = await get("/not-a-route", null, env);
    const unknownText = await unknown.text();
    for (const path of ["/_internal_admin/api/users", "/_internal_admin/flags"]) {
      const res = await get(path, OPERATOR, env);
      expect(res.status).toBe(unknown.status);
      expect(await res.text()).toBe(unknownText);
    }
  });
});

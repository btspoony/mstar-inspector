/**
 * Plan 29 T3: enumerated SPA dispatch + HTML/JSON negotiation.
 */
import { describe, expect, test } from "bun:test";
import type { Fetcher } from "@cloudflare/workers-types";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createSessionValue, SESSION_COOKIE } from "../../src/dashboard/session";
import { LOCALE_COOKIE } from "../../src/i18n";
import { SPA_BOOT_MARKER } from "../../src/spa/boot";
import { SPA_INDEX_HTML, htmlGetRequest } from "../helpers/spa";

const SESSION_SECRET = "test-dashboard-session-secret-32-bytes!";
type AssetCall = { method: string; pathname: string };

/**
 * Users-store D1 double for the W-001 shell membership gate: returns a row
 * for any login (the tests here only distinguish session-present from
 * session-absent; the removed-member denial is pinned in dashboard.test.ts).
 */
function memberDbStub(): Env["DB"] {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => ({
          id: "u-test",
          github_login: "octocat",
          role: "admin",
          created_at: new Date().toISOString(),
          invited_by: null,
        }),
      }),
    }),
  } as unknown as Env["DB"];
}

/**
 * Users-store D1 double for the removed-member shell gate (plan 33 T3):
 * `first()` returns no row, so any session login is treated as removed.
 */
function removedMemberDbStub(): Env["DB"] {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
      }),
    }),
  } as unknown as Env["DB"];
}

function stubAssets(
  files: Record<string, string>,
  calls: AssetCall[],
): Fetcher {
  return {
    fetch: async (input: Request | URL | string) => {
      const request = input instanceof Request ? input : new Request(String(input));
      const pathname = new URL(request.url).pathname;
      calls.push({ method: request.method, pathname });
      const body = files[pathname];
      if (body === undefined) return new Response("missing", { status: 404 });
      return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  } as unknown as Fetcher;
}

function makeEnv(overrides: Partial<Env> = {}): { env: Env; calls: AssetCall[] } {
  const calls: AssetCall[] = [];
  const env: Env = {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: {
      get: async () => null,
      put: async () => {},
    } as unknown as Env["IDEMPOTENCY_KV"],
    ASSETS: stubAssets({ "/index.html": SPA_INDEX_HTML, "/assets/app.js": "js" }, calls),
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    ...overrides,
  };
  return { env, calls };
}


describe("SPA dispatch (plan 29 T3)", () => {
  test("SPA page GET with Accept: text/html fetches /index.html", async () => {
    const { env, calls } = makeEnv({ DB: memberDbStub() });
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      htmlGetRequest("/dashboard/insights", { Cookie: `${SESSION_COOKIE}=${session}` }),
      env,
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: "GET", pathname: "/index.html" }]);
    const body = await res.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).not.toContain(SPA_BOOT_MARKER);
  });

  test("each enumerated page GET hits ASSETS (with a session)", async () => {
    const pages = [
      "/dashboard",
      "/dashboard/apps",
      "/dashboard/insights",
      "/dashboard/members",
      "/dashboard/login",
      "/dashboard/apps/acme/settings",
    ];
    for (const path of pages) {
      const { env, calls } = makeEnv({ DB: memberDbStub() });
      const session = await createSessionValue("octocat", null, SESSION_SECRET);
      const res = await worker.fetch(
        htmlGetRequest(path, { Cookie: `${SESSION_COOKIE}=${session}` }),
        env,
      );
      expect(res.status, path).toBe(200);
      expect(calls, path).toEqual([{ method: "GET", pathname: "/index.html" }]);
    }
  });

  test("POST to an SPA path does not call ASSETS (legacy)", async () => {
    const { env, calls } = makeEnv();
    await worker.fetch(
      new Request("https://worker.local/dashboard/insights", {
        method: "POST",
        headers: { Accept: "text/html" },
      }),
      env,
    );
    expect(calls).toEqual([]);
  });

  test("non-page GET does not call ASSETS for index.html", async () => {
    const { env, calls } = makeEnv();
    await worker.fetch(htmlGetRequest("/dashboard/manifest/callback"), env);
    expect(calls.filter((c) => c.pathname === "/index.html")).toEqual([]);
  });

  test("GET /dashboard HTML navigation is served by SPA dispatch", async () => {
    const { env, calls } = makeEnv({ DB: memberDbStub() });
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      htmlGetRequest("/dashboard", { Cookie: `${SESSION_COOKIE}=${session}` }),
      env,
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: "GET", pathname: "/index.html" }]);
    expect(await res.text()).toContain("window.__BOOT__=");
    // Plan 30 QC S-001: the boot-injected document carries identity (login/
    // role) — explicitly uncacheable.
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("GET /dashboard is the SPA workbench for every Accept variant (plan 30 T4)", async () => {
    for (const accept of [undefined, "*/*", "application/json", "text/html"]) {
      const { env, calls } = makeEnv({ DB: memberDbStub() });
      const session = await createSessionValue("octocat", null, SESSION_SECRET);
      const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${session}` };
      if (accept) headers.Accept = accept;
      const res = await worker.fetch(new Request("https://worker.local/dashboard", { headers }), env);
      expect(res.status, accept ?? "no Accept").toBe(200);
      expect(calls, accept ?? "no Accept").toEqual([{ method: "GET", pathname: "/index.html" }]);
      expect(await res.text(), accept ?? "no Accept").toContain("window.__BOOT__=");
    }
  });

  test("Accept: application/json stays on legacy", async () => {
    const { env, calls } = makeEnv();
    await worker.fetch(
      new Request("https://worker.local/dashboard/insights", {
        headers: { Accept: "application/json" },
      }),
      env,
    );
    expect(calls).toEqual([]);
  });

  test("default Accept */* stays on legacy (existing tests)", async () => {
    const { env, calls } = makeEnv();
    await worker.fetch(new Request("https://worker.local/dashboard/insights"), env);
    expect(calls).toEqual([]);
  });

  test("GET /assets/* is served from ASSETS", async () => {
    const { env, calls } = makeEnv();
    const res = await worker.fetch(new Request("https://worker.local/assets/app.js"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("js");
    expect(calls).toEqual([{ method: "GET", pathname: "/assets/app.js" }]);
  });

  test("GET /index.html injects window.__BOOT__", async () => {
    const { env, calls } = makeEnv();
    const res = await worker.fetch(new Request("https://worker.local/index.html"), env);
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: "GET", pathname: "/index.html" }]);
    const body = await res.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).not.toContain(SPA_BOOT_MARKER);
  });

  test("theme bootstrap precedes the injected boot and the bundle in the served shell (plan 41 T1)", async () => {
    // serveSpaIndex fetches ASSETS /index.html verbatim and injects the boot
    // at <!--SPA_BOOT--> — the prod document is the real shell source plus
    // the injection, so serve the actual src/spa/index.html here to pin the
    // no-flash ordering (theme applied before window.__BOOT__ and the module
    // bundle can paint).
    const shell = await Bun.file(new URL("../../src/spa/index.html", import.meta.url)).text();
    const calls: AssetCall[] = [];
    const { env } = makeEnv({ ASSETS: stubAssets({ "/index.html": shell }, calls) });
    const res = await worker.fetch(htmlGetRequest("/dashboard/login"), env);
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: "GET", pathname: "/index.html" }]);
    const body = await res.text();
    const bootstrapAt = body.indexOf('localStorage.getItem("mstar.dashboard.theme")');
    const bootAt = body.indexOf("window.__BOOT__=");
    expect(bootstrapAt).toBeGreaterThan(-1);
    expect(bootAt).toBeGreaterThan(-1);
    expect(bootstrapAt).toBeLessThan(bootAt);
    expect(bootstrapAt).toBeLessThan(body.indexOf("./main.tsx"));
    // Whitelist: only the exact stored values may set data-theme — anything
    // else (corrupted/unreadable) must behave as unset.
    expect(body).toContain('if (t === "light" || t === "dark")');
    expect(body).not.toContain(SPA_BOOT_MARKER);
  });

  test("webhook POST is untouched", async () => {
    const { env, calls } = makeEnv();
    await worker.fetch(
      new Request("https://worker.local/webhook/acme", { method: "POST", body: "{}" }),
      env,
    );
    expect(calls).toEqual([]);
  });

  test("boot script carries locale from the mstar_locale cookie", async () => {
    // The login page is exempt from the no-session redirect (plan 33 T3),
    // so it is the session-less shell surface that still carries the boot.
    const { env } = makeEnv();
    const res = await worker.fetch(
      htmlGetRequest("/dashboard/login", { Cookie: `${LOCALE_COOKIE}=zh_CN` }),
      env,
    );
    const body = await res.text();
    expect(body).toContain('"locale":"zh_CN"');
  });

  test("login HTML GET with Accept-Language zh injects locale zh_CN in boot (plan 29 T7)", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      htmlGetRequest("/dashboard/login", { "Accept-Language": "zh-CN,zh;q=0.9" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"locale":"zh_CN"');
    expect(body).toContain("window.__BOOT__=");
  });

  test("boot script carries login from the session cookie", async () => {
    // Plan 30 W-001: a session-bearing shell request re-reads membership
    // through D1 — bind the users store so the boot's login/name resolve
    // past the gate (role comes from the same single lookup).
    const { env } = makeEnv({ DB: memberDbStub() });
    const session = await createSessionValue("octocat", "The Octocat", SESSION_SECRET);
    const res = await worker.fetch(
      htmlGetRequest("/dashboard/login", { Cookie: `${SESSION_COOKIE}=${session}` }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"login":"octocat"');
    expect(body).toContain('"name":"The Octocat"');
    expect(body).toContain('"role":"admin"');
  });

  test("session on the shell path fails closed when D1 is unbound (500, plan 30 W-001)", async () => {
    // Mirrors the guard: a session whose membership cannot be verified (no
    // users-store binding) must never receive the shell — 500, not a leak.
    const { env } = makeEnv({ DB: undefined });
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      htmlGetRequest("/dashboard", { Cookie: `${SESSION_COOKIE}=${session}` }),
      env,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("dashboard storage is not configured");
  });

  // --- plan 33 T3: auth redirect 全覆盖 (spec §1.3) ---

  test("unauthenticated deep link HTML GET → 302 login, no ASSETS call", async () => {
    const deepLinks = [
      "/dashboard/apps",
      "/dashboard/insights",
      "/dashboard/members",
      "/dashboard/apps/acme/settings",
    ];
    for (const path of deepLinks) {
      const { env, calls } = makeEnv();
      const res = await worker.fetch(htmlGetRequest(path), env);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("Location"), path).toBe("/dashboard/login");
      expect(calls, path).toEqual([]);
    }
  });

  test("unauthenticated /dashboard 302s to login for every Accept variant", async () => {
    for (const accept of [undefined, "*/*", "application/json", "text/html"]) {
      const { env, calls } = makeEnv();
      const headers: Record<string, string> = {};
      if (accept) headers.Accept = accept;
      const res = await worker.fetch(new Request("https://worker.local/dashboard", { headers }), env);
      expect(res.status, accept ?? "no Accept").toBe(302);
      expect(res.headers.get("Location"), accept ?? "no Accept").toBe("/dashboard/login");
      expect(calls, accept ?? "no Accept").toEqual([]);
    }
  });

  test("login page HTML GET without a session → 200 shell, no self-loop", async () => {
    const { env, calls } = makeEnv();
    const res = await worker.fetch(htmlGetRequest("/dashboard/login"), env);
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: "GET", pathname: "/index.html" }]);
    const body = await res.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).toContain('"login":null');
  });

  test("removed member HTML navigation → session cookie expired + 302 login", async () => {
    const { env, calls } = makeEnv({ DB: removedMemberDbStub() });
    const session = await createSessionValue("mallory", null, SESSION_SECRET);
    const res = await worker.fetch(
      htmlGetRequest("/dashboard", { Cookie: `${SESSION_COOKIE}=${session}` }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toContain(`${SESSION_COOKIE}=;`);
    expect(setCookie[0]).toContain("Max-Age=0");
    expect(calls).toEqual([]);
  });

  test("removed member API/fetch → session cookie expired + 403 removedPage", async () => {
    const { env, calls } = makeEnv({ DB: removedMemberDbStub() });
    const session = await createSessionValue("mallory", null, SESSION_SECRET);
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard", {
        headers: { Cookie: `${SESSION_COOKIE}=${session}`, Accept: "application/json" },
      }),
      env,
    );
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain("Your dashboard access was removed");
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toContain(`${SESSION_COOKIE}=;`);
    expect(setCookie[0]).toContain("Max-Age=0");
    expect(calls).toEqual([]);
  });

  test("removed member on the login page → null-boot shell + expired session, no self-loop", async () => {
    const { env, calls } = makeEnv({ DB: removedMemberDbStub() });
    const session = await createSessionValue("mallory", null, SESSION_SECRET);
    const res = await worker.fetch(
      htmlGetRequest("/dashboard/login", { Cookie: `${SESSION_COOKIE}=${session}` }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).toContain('"login":null');
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toContain(`${SESSION_COOKIE}=;`);
    expect(setCookie[0]).toContain("Max-Age=0");
    expect(calls).toEqual([{ method: "GET", pathname: "/index.html" }]);
  });
});

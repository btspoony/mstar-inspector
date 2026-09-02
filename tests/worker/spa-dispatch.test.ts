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
    const { env, calls } = makeEnv();
    const res = await worker.fetch(htmlGetRequest("/dashboard/insights"), env);
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: "GET", pathname: "/index.html" }]);
    const body = await res.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).not.toContain(SPA_BOOT_MARKER);
  });

  test("each enumerated page GET hits ASSETS", async () => {
    const pages = [
      "/dashboard/insights",
      "/dashboard/members",
      "/dashboard/apps",
      "/dashboard/login",
      "/dashboard/apps/acme/settings",
    ];
    for (const path of pages) {
      const { env, calls } = makeEnv();
      const res = await worker.fetch(htmlGetRequest(path), env);
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

  test("GET /dashboard (legacy home) is not an SPA page", async () => {
    const { env, calls } = makeEnv();
    await worker.fetch(htmlGetRequest("/dashboard"), env);
    expect(calls).toEqual([]);
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

  test("webhook POST is untouched", async () => {
    const { env, calls } = makeEnv();
    await worker.fetch(
      new Request("https://worker.local/webhook/acme", { method: "POST", body: "{}" }),
      env,
    );
    expect(calls).toEqual([]);
  });

  test("boot script carries locale from the mstar_locale cookie", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      htmlGetRequest("/dashboard/apps", { Cookie: `${LOCALE_COOKIE}=zh_CN` }),
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
    const { env } = makeEnv();
    const session = await createSessionValue("octocat", "The Octocat", SESSION_SECRET);
    const res = await worker.fetch(
      htmlGetRequest("/dashboard/login", { Cookie: `${SESSION_COOKIE}=${session}` }),
      env,
    );
    const body = await res.text();
    expect(body).toContain('"login":"octocat"');
    expect(body).toContain('"name":"The Octocat"');
  });
});

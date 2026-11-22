import { describe, expect, test } from "bun:test";
import type { Fetcher } from "@cloudflare/workers-types";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createSessionValue, SESSION_COOKIE } from "../../src/dashboard/session";
import { LOCALE_COOKIE } from "../../src/i18n";
import { SPA_BOOT_MARKER } from "../../src/spa/boot";
import { SPA_INDEX_HTML, htmlGetRequest } from "../helpers/spa";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
type AssetCall = { method: string; pathname: string };

function memberDbStub(): Env["DB"] {
  return {
    prepare: () => ({
      all: async () => ({ results: [] }),
      first: async () => null,
      bind: () => ({
        first: async () => ({
          id: "u-test",
          github_login: "octocat",
          role: "admin",
          created_at: new Date().toISOString(),
          invited_by: null,
        }),
        all: async () => ({ results: [] }),
      }),
    }),
  } as unknown as Env["DB"];
}

function removedMemberDbStub(): Env["DB"] {
  return {
    prepare: () => ({
      all: async () => ({ results: [] }),
      first: async () => null,
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [] }),
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
    ASSETS: stubAssets({ "/index.html": SPA_INDEX_HTML, "/app-assets/app.js": "js" }, calls),
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    ...overrides,
  };
  return { env, calls };
}


function concurrentBootReads() {
  const arrived = new Set<string>();
  let release: (() => void) | null = null;
  const bothInFlight = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrive = async (kind: string): Promise<void> => {
    arrived.add(kind);
    if (arrived.size === 5) release?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bothInFlight,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`boot reads did not overlap: ${[...arrived]}`)), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const respond = (query: string) => {
    if (query.includes("workspace_invites i JOIN workspaces w")) return { all: async () => { await arrive("invites"); return { results: [] }; } };
    if (query.includes("w.name AS name")) return { all: async () => { await arrive("memberships"); return { results: [] }; } };
    if (query.includes("wm.role AS role")) return { all: async () => { await arrive("workspace"); return { results: [] }; } };
    if (query.includes("FROM server_flags")) return { first: async () => { await arrive("flag"); return null; } };
    if (query.includes("SELECT * FROM users WHERE github_login")) {
      return { first: async () => ({ id: "u-test", github_login: "octocat", role: "admin", created_at: new Date().toISOString(), invited_by: null }) };
    }
    return { all: async () => ({ results: [] }), first: async () => null };
  };
  const db = {
    prepare: (query: string) => ({
      ...respond(query),
      bind: () => ({ ...respond(query), run: async () => ({ meta: { changes: 0 } }) }),
    }),
  } as unknown as Env["DB"];
  return { db, arrive };
}

describe("SPA dispatch", () => {
  test("SPA page GET with Accept: text/html fetches /index.html", async () => {
    const { env, calls } = makeEnv({ DB: memberDbStub() });
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      htmlGetRequest("/dashboard/acme/members", { Cookie: `${SESSION_COOKIE}=${session}` }),
      env,
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: "GET", pathname: "/index.html" }]);
    const body = await res.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).not.toContain(SPA_BOOT_MARKER);
  });

  test("each enumerated page GET hits ASSETS (with a session)", async () => {
    const pages: string[] = [
      "/dashboard",
      "/dashboard/acme/apps",
      "/dashboard/acme/apps/12345",
      "/dashboard/acme/repos",
      "/dashboard/acme/repos/12345",
      "/dashboard/acme/members",
      "/dashboard/login",
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
      new Request("https://worker.local/dashboard/acme/members", {
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
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("GET /dashboard is the SPA workbench for every Accept variant", async () => {
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
      new Request("https://worker.local/dashboard/acme/members", {
        headers: { Accept: "application/json" },
      }),
      env,
    );
    expect(calls).toEqual([]);
  });

  test("default Accept */* stays on legacy (existing tests)", async () => {
    const { env, calls } = makeEnv();
    await worker.fetch(new Request("https://worker.local/dashboard/apps"), env);
    expect(calls).toEqual([]);
  });

  test("GET /app-assets/* is served from ASSETS", async () => {
    const { env, calls } = makeEnv();
    const res = await worker.fetch(new Request("https://worker.local/app-assets/app.js"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("js");
    expect(calls).toEqual([{ method: "GET", pathname: "/app-assets/app.js" }]);
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

  test("theme bootstrap precedes the injected boot and the bundle in the served shell", async () => {
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
    const { env } = makeEnv();
    const res = await worker.fetch(
      htmlGetRequest("/dashboard/login", { Cookie: `${LOCALE_COOKIE}=zh_CN` }),
      env,
    );
    const body = await res.text();
    expect(body).toContain('"locale":"zh_CN"');
  });

  test("login HTML GET with Accept-Language zh injects locale zh_CN in boot", async () => {
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
    expect(body).not.toContain('"role":"admin"');
  });

  test("session on the shell path fails closed when D1 is unbound (500, W-001)", async () => {
    const { env } = makeEnv({ DB: undefined });
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      htmlGetRequest("/dashboard", { Cookie: `${SESSION_COOKIE}=${session}` }),
      env,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("dashboard storage is not configured");
  });


  test("unauthenticated deep link HTML GET → 302 login, no ASSETS call", async () => {
    const deepLinks = [
      "/dashboard/acme/apps",
      "/dashboard/acme/members",
      "/dashboard/acme/apps/12345",
      "/dashboard/acme/repos/12345",
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
  test("a zh_CN shell declares its own language and title on the document", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      htmlGetRequest("/dashboard/login", { Cookie: `${LOCALE_COOKIE}=zh_CN` }),
      env,
    );
    const body = await res.text();
    expect(body.match(/<html[^>]*>/)?.[0]).toBe('<html lang="zh-CN">');
    expect(body).toContain("<title>登录 — Morning Star Inspector</title>");
    expect(body).not.toContain('lang="en"');
  });

  test("an en shell keeps lang=en and names the page it serves", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      htmlGetRequest("/dashboard/login", { Cookie: `${LOCALE_COOKIE}=en` }),
      env,
    );
    const body = await res.text();
    expect(body.match(/<html[^>]*>/)?.[0]).toBe('<html lang="en">');
    expect(body).toContain("<title>Sign in — Morning Star Inspector</title>");
  });

  test("access, discovery, eligibility, and the HTML asset load overlap after authentication", async () => {
    const { db, arrive } = concurrentBootReads();
    const { env, calls } = makeEnv({ DB: db });
    const assets = env.ASSETS!;
    env.ASSETS = {
      async fetch(url: URL) {
        await arrive("asset");
        return assets.fetch(url);
      },
    } as unknown as Fetcher;
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      htmlGetRequest("/dashboard/acme/apps", { Cookie: `${SESSION_COOKIE}=${session}` }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("window.__BOOT__=");
    expect(calls).toEqual([{ method: "GET", pathname: "/index.html" }]);
  });
});

describe("the retired targets family redirects once", () => {
  const redirects: Array<[string, string]> = [
    ["/dashboard/acme/targets", "/dashboard/acme/repos"],
    ["/dashboard/acme/targets/12345", "/dashboard/acme/repos/12345"],
    ["/dashboard/acme/targets/all", "/dashboard/acme/repos/all"],
  ];

  for (const [from, to] of redirects) {
    test(`${from} → 302 ${to}`, async () => {
      const { env, calls } = makeEnv({ DB: memberDbStub() });
      const session = await createSessionValue("octocat", null, SESSION_SECRET);
      const res = await worker.fetch(
        htmlGetRequest(from, { Cookie: `${SESSION_COOKIE}=${session}` }),
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(to);
      expect(calls).toEqual([]);
    });
  }

  test("the redirect needs no session (the destination enforces access)", async () => {
    const { env, calls } = makeEnv();
    const res = await worker.fetch(htmlGetRequest("/dashboard/acme/targets"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/acme/repos");
    expect(calls).toEqual([]);
  });
});

describe("the retired settings-tab addresses redirect once", () => {
  const redirects: Array<[string, string]> = [
    ["/dashboard/acme/apps/12345/settings", "/dashboard/acme/apps/12345?tab=settings"],
    ["/dashboard/acme/apps/12345/bot", "/dashboard/acme/apps/12345?tab=settings"],
  ];

  for (const [from, to] of redirects) {
    test(`${from} → 302 ${to}`, async () => {
      const { env, calls } = makeEnv({ DB: memberDbStub() });
      const session = await createSessionValue("octocat", null, SESSION_SECRET);
      const res = await worker.fetch(
        htmlGetRequest(from, { Cookie: `${SESSION_COOKIE}=${session}` }),
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(to);
      expect(calls).toEqual([]);
    });
  }

  test("the redirect needs no session (the destination enforces access)", async () => {
    const { env, calls } = makeEnv();
    const res = await worker.fetch(htmlGetRequest("/dashboard/acme/apps/12345/settings"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/acme/apps/12345?tab=settings");
    expect(calls).toEqual([]);
  });

  test("every other app-scoped address keeps serving its own page", async () => {
    for (const path of [
      "/dashboard/acme/apps/12345",
      "/dashboard/acme/apps/12345?tab=settings",
      "/dashboard/acme/apps/12345?tab=insights",
      "/dashboard/acme/repos/12345",
    ]) {
      const { env, calls } = makeEnv({ DB: memberDbStub() });
      const session = await createSessionValue("octocat", null, SESSION_SECRET);
      const res = await worker.fetch(htmlGetRequest(path, { Cookie: `${SESSION_COOKIE}=${session}` }), env);
      expect(res.status, path).toBe(200);
      expect(calls, path).toEqual([{ method: "GET", pathname: "/index.html" }]);
    }
  });
});

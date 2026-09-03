/**
 * Plan 29 T3: trailing-slash 301 matrix (pure + Worker mount).
 */
import { describe, expect, test } from "bun:test";
import { normalizeDashboardTrailingSlash } from "../../src/worker/redirects";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";

function env(): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: {
      get: async () => null,
      put: async () => {},
    } as unknown as Env["IDEMPOTENCY_KV"],
  };
}

describe("normalizeDashboardTrailingSlash (plan 29 T3)", () => {
  test("GET /dashboard/ → /dashboard", () => {
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/")).toBe("/dashboard");
  });

  test("preserves the query string in one hop", () => {
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/", "?tab=apps")).toBe("/dashboard?tab=apps");
  });

  test("normalizes nested /dashboard* trailing slashes", () => {
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/apps/")).toBe("/dashboard");
    expect(normalizeDashboardTrailingSlash("HEAD", "/dashboard/insights/")).toBe("/dashboard/insights");
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/apps/acme/settings/")).toBe(
      "/dashboard/apps/acme/settings",
    );
  });

  test("GET/HEAD without a trailing slash pass through", () => {
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard")).toBeNull();
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/insights")).toBeNull();
  });

  test("POST is never redirected (pinned POST family)", () => {
    expect(normalizeDashboardTrailingSlash("POST", "/dashboard/")).toBeNull();
    expect(normalizeDashboardTrailingSlash("POST", "/dashboard/apps/acme/settings/")).toBeNull();
  });

  test("paths outside /dashboard* pass through", () => {
    expect(normalizeDashboardTrailingSlash("GET", "/healthz/")).toBeNull();
    expect(normalizeDashboardTrailingSlash("GET", "/webhook/acme/")).toBeNull();
  });

  test("GET /dashboard/apps and /dashboard/apps/ alias to /dashboard in one hop (plan 30 T4)", () => {
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/apps")).toBe("/dashboard");
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/apps/")).toBe("/dashboard");
    expect(normalizeDashboardTrailingSlash("HEAD", "/dashboard/apps")).toBe("/dashboard");
    expect(normalizeDashboardTrailingSlash("HEAD", "/dashboard/apps/")).toBe("/dashboard");
  });

  test("alias preserves the query string", () => {
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/apps", "?q=1")).toBe("/dashboard?q=1");
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/apps/", "?q=1")).toBe("/dashboard?q=1");
  });

  test("alias is exact: /dashboard/apps/:slug/* is never caught", () => {
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/apps/acme/settings")).toBeNull();
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/apps/acme/disable")).toBeNull();
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/apps/acme")).toBeNull();
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/apps-extra")).toBeNull();
  });

  test("POST is never aliased (pinned POST family)", () => {
    expect(normalizeDashboardTrailingSlash("POST", "/dashboard/apps")).toBeNull();
    expect(normalizeDashboardTrailingSlash("POST", "/dashboard/apps/")).toBeNull();
  });

  test("trailing slash on every SPA_PAGES path strips in one hop", () => {
    const spaTrailing = [
      "/dashboard/insights/",
      "/dashboard/members/",
      "/dashboard/login/",
      "/dashboard/apps/acme/settings/",
    ];
    for (const path of spaTrailing) {
      expect(normalizeDashboardTrailingSlash("GET", path), path).toBe(path.slice(0, -1));
      expect(normalizeDashboardTrailingSlash("HEAD", path), `HEAD ${path}`).toBe(path.slice(0, -1));
    }
  });

  test("webhook, unslashed API, and POST never 301", () => {
    expect(normalizeDashboardTrailingSlash("GET", "/webhook/acme/")).toBeNull();
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/api/apps")).toBeNull();
    expect(normalizeDashboardTrailingSlash("POST", "/dashboard/insights/")).toBeNull();
    expect(normalizeDashboardTrailingSlash("POST", "/dashboard/login/")).toBeNull();
  });

  test("GET /dashboard/api/apps/ is a /dashboard* GET so it 301s (current spec)", () => {
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/api/apps/")).toBe("/dashboard/api/apps");
  });
});

describe("trailing-slash middleware mount (plan 29 T3)", () => {
  test("GET /dashboard/ returns 301 Location /dashboard", async () => {
    const res = await worker.fetch(new Request("https://worker.local/dashboard/?q=1"), env());
    expect(res.status).toBe(301);
    const location = new URL(res.headers.get("Location") ?? "", "https://worker.local");
    expect(location.pathname).toBe("/dashboard");
    expect(location.search).toBe("?q=1");
  });

  test("HEAD /dashboard/ returns 301 Location /dashboard", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/?q=1", { method: "HEAD" }),
      env(),
    );
    expect(res.status).toBe(301);
    const location = new URL(res.headers.get("Location") ?? "", "https://worker.local");
    expect(location.pathname).toBe("/dashboard");
    expect(location.search).toBe("?q=1");
  });

  test("POST /dashboard/ is not a 301", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/", { method: "POST" }),
      env(),
    );
    expect(res.status).not.toBe(301);
  });

  test("GET trailing slash on every SPA_PAGES path returns 301 Location without the slash", async () => {
    const spaTrailing = [
      "/dashboard/insights/",
      "/dashboard/members/",
      "/dashboard/login/",
      "/dashboard/apps/acme/settings/",
    ];
    for (const path of spaTrailing) {
      const res = await worker.fetch(new Request(`https://worker.local${path}?q=1`), env());
      expect(res.status, path).toBe(301);
      const location = new URL(res.headers.get("Location") ?? "", "https://worker.local");
      expect(location.pathname, path).toBe(path.slice(0, -1));
      expect(location.search, path).toBe("?q=1");
    }
  });

  test("GET /webhook/acme/ is not a 301", async () => {
    const res = await worker.fetch(new Request("https://worker.local/webhook/acme/"), env());
    expect(res.status).not.toBe(301);
  });

  test("POST /dashboard/apps/ is not a 301", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/apps/", { method: "POST" }),
      env(),
    );
    expect(res.status).not.toBe(301);
  });

  test("GET /dashboard/apps returns 301 Location /dashboard (alias)", async () => {
    const res = await worker.fetch(new Request("https://worker.local/dashboard/apps?q=1"), env());
    expect(res.status).toBe(301);
    const location = new URL(res.headers.get("Location") ?? "", "https://worker.local");
    expect(location.pathname).toBe("/dashboard");
    expect(location.search).toBe("?q=1");
  });

  test("GET /dashboard/apps/ returns 301 Location /dashboard in one hop (alias)", async () => {
    const res = await worker.fetch(new Request("https://worker.local/dashboard/apps/?q=1"), env());
    expect(res.status).toBe(301);
    const location = new URL(res.headers.get("Location") ?? "", "https://worker.local");
    expect(location.pathname).toBe("/dashboard");
    expect(location.search).toBe("?q=1");
  });

  test("HEAD /dashboard/apps returns 301 Location /dashboard (alias)", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/apps", { method: "HEAD" }),
      env(),
    );
    expect(res.status).toBe(301);
    const location = new URL(res.headers.get("Location") ?? "", "https://worker.local");
    expect(location.pathname).toBe("/dashboard");
  });

  test("GET /dashboard/apps/acme/settings is not aliased (exact match only)", async () => {
    const res = await worker.fetch(new Request("https://worker.local/dashboard/apps/acme/settings"), env());
    expect(res.status).not.toBe(301);
  });

  test("POST /dashboard/apps is not a 301 (pinned POST family)", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/apps", { method: "POST" }),
      env(),
    );
    expect(res.status).not.toBe(301);
  });

  test("GET /dashboard/api/apps (no slash) is not a 301", async () => {
    const res = await worker.fetch(new Request("https://worker.local/dashboard/api/apps"), env());
    expect(res.status).not.toBe(301);
  });

  test("GET /dashboard/api/apps/ is a /dashboard* GET so it 301s (current spec)", async () => {
    const res = await worker.fetch(new Request("https://worker.local/dashboard/api/apps/"), env());
    expect(res.status).toBe(301);
    const location = new URL(res.headers.get("Location") ?? "", "https://worker.local");
    expect(location.pathname).toBe("/dashboard/api/apps");
  });
});

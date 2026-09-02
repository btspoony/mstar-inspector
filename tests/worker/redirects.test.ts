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
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/apps/")).toBe("/dashboard/apps");
    expect(normalizeDashboardTrailingSlash("HEAD", "/dashboard/insights/")).toBe("/dashboard/insights");
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/apps/acme/settings/")).toBe(
      "/dashboard/apps/acme/settings",
    );
  });

  test("GET/HEAD without a trailing slash pass through", () => {
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard")).toBeNull();
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/apps")).toBeNull();
  });

  test("POST is never redirected (pinned POST family)", () => {
    expect(normalizeDashboardTrailingSlash("POST", "/dashboard/")).toBeNull();
    expect(normalizeDashboardTrailingSlash("POST", "/dashboard/apps/acme/settings/")).toBeNull();
  });

  test("paths outside /dashboard* pass through", () => {
    expect(normalizeDashboardTrailingSlash("GET", "/healthz/")).toBeNull();
    expect(normalizeDashboardTrailingSlash("GET", "/webhook/acme/")).toBeNull();
  });

  test("does not 301 /dashboard/apps as a path alias (plan 30)", () => {
    expect(normalizeDashboardTrailingSlash("GET", "/dashboard/apps")).toBeNull();
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
});

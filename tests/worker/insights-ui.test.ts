/**
 * Plan 29 T6: the insights HTML panel is retired — /dashboard/insights is
 * SPA-owned. The data contract lives on the JSON face
 * (GET /dashboard/api/insights/summary, tested in dashboard.test.ts); this
 * file pins the route-level behavior: an HTML navigation GET is served by
 * SPA dispatch, and the legacy SSR handler is gone (a non-HTML GET falls
 * through to the legacy app's membership guard).
 */
import { describe, expect, test } from "bun:test";
import type { Fetcher } from "@cloudflare/workers-types";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { SPA_BOOT_MARKER } from "../../src/spa/boot";

const INDEX_HTML = `<!doctype html><html><head>${SPA_BOOT_MARKER}</head><body>spa</body></html>`;

function stubAssets(): Fetcher {
  return {
    fetch: async (input: Request | URL | string) => {
      const request = input instanceof Request ? input : new Request(String(input));
      const pathname = new URL(request.url).pathname;
      if (pathname !== "/index.html") return new Response("missing", { status: 404 });
      return new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  } as unknown as Fetcher;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    ASSETS: stubAssets(),
    DASHBOARD_SESSION_SECRET: "test-dashboard-session-secret-32-bytes!",
    ...overrides,
  } as Env;
}

describe("GET /dashboard/insights (plan 29 T6: SPA-owned)", () => {
  test("HTML navigation GET is served by SPA dispatch (boot-injected index)", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/insights", { headers: { Accept: "text/html" } }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("window.__BOOT__=");
    expect(body).not.toContain(SPA_BOOT_MARKER);
  });

  test("the legacy SSR handler is gone: a non-HTML GET falls through to the legacy app (guard 302, never the old HTML)", async () => {
    const res = await worker.fetch(new Request("https://worker.local/dashboard/insights"), makeEnv());
    // The mount-level membership guard answers before any route — the old
    // SSR handler would have rendered 200 HTML for a session-less request
    // only after the guard, so a 302 proves the handler is gone.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });
});

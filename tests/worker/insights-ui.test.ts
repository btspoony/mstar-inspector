/**
 * The global insights page is retired — /dashboard/insights is no longer a
 * SPA page and no longer dispatches to the SPA shell. The data face moves
 * per-App in the follow-up work; the legacy SSR handler is already gone.
 * This file pins the route-level absence: neither an HTML navigation GET nor
 * any other GET reaches the SPA boot document on this path.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createSessionValue, SESSION_COOKIE } from "../../src/dashboard/session";
import { SPA_BOOT_MARKER, withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");

/** Users-store D1 double: any session login resolves to a member row. */
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

function makeEnv(overrides: Partial<Env> = {}): Env {
  return withSpaAssets({
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    ...overrides,
  } as Env);
}

describe("GET /dashboard/insights (retired)", () => {
  test("an authenticated HTML navigation GET no longer serves the SPA shell", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/insights", {
        headers: { Accept: "text/html", Cookie: `${SESSION_COOKIE}=${session}` },
      }),
      makeEnv({ DB: memberDbStub() }),
    );
    // The route is gone from SPA_PAGES, so SPA dispatch never serves the
    // boot-injected index on this path — the legacy app answers instead.
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("window.__BOOT__=");
    expect(body).not.toContain(SPA_BOOT_MARKER);
  });

  test("a non-HTML GET falls through to the legacy app (guard 302, never the old HTML)", async () => {
    const res = await worker.fetch(new Request("https://worker.local/dashboard/insights"), makeEnv());
    // The mount-level membership guard answers before any route — the old
    // SSR handler would have rendered 200 HTML for a session-less request
    // only after the guard, so a 302 proves the handler is gone.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });
});

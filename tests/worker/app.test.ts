import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";

/**
 * Worker entry smoke tests. The legacy bare `POST /webhook` face is retired
 * (plan 24 Task 1) — its end-to-end coverage (valid signature / 401 / 500 /
 * kill-switch / 413) now lives in tests/worker/webhook-routing.test.ts
 * against the per-App `POST /webhook/:appSlug` route, which shares the same
 * pre-order. This file keeps the non-webhook entry surface.
 */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: {
      get: async () => null,
      put: async () => {},
    } as unknown as Env["IDEMPOTENCY_KV"],
    REVIEW_ENABLED: "true",
    ...overrides,
  };
}

describe("worker fetch entry", () => {
  test("GET /healthz returns 200 ok", async () => {
    const res = await worker.fetch(new Request("https://worker.local/healthz"), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

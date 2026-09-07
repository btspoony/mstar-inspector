import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { APP_VERSION } from "../../src/version";
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
  test("GET /healthz returns 200 ok with the version field (plan 51)", async () => {
    const res = await worker.fetch(new Request("https://worker.local/healthz"), makeEnv());
    expect(res.status).toBe(200);
    // Field-set assertion (plan 51): `ok:true` contract unchanged, `version`
    // is additive and rides the generated single source with the tag-shaped
    // `v` prefix — future additive fields do not break this pin.
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(`v${APP_VERSION}`);
  });
});

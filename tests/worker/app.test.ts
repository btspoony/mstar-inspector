import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { APP_VERSION } from "../../src/version";
import type { Env } from "../../src/worker/env";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: {
      get: async () => null,
      put: async () => {},
    } as unknown as Env["IDEMPOTENCY_KV"],
    ...overrides,
  };
}

describe("worker fetch entry", () => {
  test("GET /healthz returns 200 ok with the version field", async () => {
    const res = await worker.fetch(new Request("https://worker.local/healthz"), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(`v${APP_VERSION}`);
  });
});

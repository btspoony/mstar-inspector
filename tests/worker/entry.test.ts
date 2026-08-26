/**
 * Production Worker entry (deploy) tests (plan 06 T3 fix, review Important 2).
 *
 * The entry module (src/worker/entry.ts) is what wrangler.jsonc `main` points
 * at: it must export BOTH the fetch/queue handler (re-exported from ./index)
 * AND the Sandbox Durable Object class so the containers binding resolves
 * (`class_name: "Sandbox"` in wrangler.jsonc). The entry statically imports
 * the workerd-only @cloudflare/sandbox SDK, so the SDK is mocked here (same
 * technique as tests/pipeline/sandbox.test.ts) and the entry is imported
 * dynamically after the mock is registered.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("@cloudflare/sandbox", () => ({
  getSandbox: mock(() => ({})),
  Sandbox: class Sandbox {},
}));

const { default: worker, Sandbox } = await import("../../src/worker/entry");
import type { Env } from "../../src/worker/env";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ID: "123",
    PRIVATE_KEY: "private-key",
    WEBHOOK_SECRET: "s3cret-webhook-secret",
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: {
      get: async () => null,
      put: async () => {},
    } as unknown as Env["IDEMPOTENCY_KV"],
    ...overrides,
  };
}

describe("worker entry (deploy)", () => {
  test("exports the Sandbox DO class for the containers binding", () => {
    expect(typeof Sandbox).toBe("function");
  });

  test("re-exports the fetch handler (healthz)", async () => {
    const res = await worker.fetch(new Request("https://worker.local/healthz"), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

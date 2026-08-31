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
import type { D1Database, ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { createFailureStore } from "../../src/store/failure-store";
import { createMigratedTestD1 } from "../store/helpers";
import { defaultSweepLog } from "../../src/worker/sweep";

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

/**
 * Cron scheduled wiring (plan 19 T1, AL-6): the deploy entry must expose the
 * `scheduled` face (re-exported from ./index) that runs the trailing-24h
 * failure sweep over the bound D1 — read-only, and NEVER throwing out of the
 * handler (a throwing cron handler just retries into alert noise).
 */
describe("worker entry scheduled wiring (plan 19 T1)", () => {
  const NOOP_CONTROLLER = {} as ScheduledController;
  const NOOP_CTX = {} as ExecutionContext;

  test("exports a scheduled handler", () => {
    expect(typeof worker.scheduled).toBe("function");
  });

  test("scheduled runs the sweep over the bound DB and POSTs the alert to ALERT_WEBHOOK_URL on breach", async () => {
    const db = createMigratedTestD1();
    const store = createFailureStore(db);
    for (let i = 0; i < 6; i++) {
      await store.record({
        installation_id: 1,
        owner: "acme",
        repo: "widgets",
        pr_number: 1,
        head_sha: "",
        stage: "runner",
        error: `boom-${i}`,
      });
    }
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("ok");
    }) as typeof fetch;
    try {
      await worker.scheduled(
        NOOP_CONTROLLER,
        makeEnv({ DB: db as unknown as D1Database, ALERT_WEBHOOK_URL: "https://ops.example/hook" }),
        NOOP_CTX,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ops.example/hook");
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({
      event: "ops_sweep_alert",
      failures_24h: 6,
      dlq_check: "skipped",
    });
  });

  test("scheduled without a DB binding fails closed — warn log, no webhook, no throw", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("ok");
    }) as unknown as typeof fetch;
    // TEST-01: capture the handler's warn events through the sweep log sink.
    const warnCalls: Array<{ fields: Record<string, unknown>; msg?: string }> = [];
    const originalWarn = defaultSweepLog.warn;
    defaultSweepLog.warn = (fields, msg) => void warnCalls.push({ fields: fields as Record<string, unknown>, msg });
    try {
      await worker.scheduled(NOOP_CONTROLLER, makeEnv({ ALERT_WEBHOOK_URL: "https://ops.example/hook" }), NOOP_CTX);
    } finally {
      globalThis.fetch = originalFetch;
      defaultSweepLog.warn = originalWarn;
    }
    expect(fetchCalls).toBe(0);
    // The DB-unbound case fires the `ops_sweep_db_unbound` event with the
    // binding-missing detail (TEST-01).
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]!.fields.event).toBe("ops_sweep_db_unbound");
    expect(warnCalls[0]!.fields.detail).toContain("DB binding missing");
  });

  test("scheduled never throws when the sweep itself fails", async () => {
    const brokenDb = {
      prepare(): never {
        throw new Error("d1 down");
      },
      batch: async () => [],
    };
    // TEST-01: the throwing-sweep case fires the `ops_sweep_failed` event.
    const warnCalls: Array<{ fields: Record<string, unknown>; msg?: string }> = [];
    const originalWarn = defaultSweepLog.warn;
    defaultSweepLog.warn = (fields, msg) => void warnCalls.push({ fields: fields as Record<string, unknown>, msg });
    try {
      await expect(
        worker.scheduled(NOOP_CONTROLLER, makeEnv({ DB: brokenDb as unknown as D1Database }), NOOP_CTX),
      ).resolves.toBeUndefined();
    } finally {
      defaultSweepLog.warn = originalWarn;
    }
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]!.fields.event).toBe("ops_sweep_failed");
    expect(warnCalls[0]!.fields.detail).toContain("d1 down");
  });
});

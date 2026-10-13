/**
 * Production Worker entry (deploy) tests (review Important 2 fix).
 *
 * The entry module (src/worker/entry.ts) is what wrangler.jsonc `main` points
 * at: it must export BOTH the fetch/queue handler (re-exported from ./index)
 * AND the SandboxV1 Durable Object class so the containers binding resolves
 * (`class_name: "SandboxV1"` in wrangler.jsonc). The entry statically imports
 * the workerd-only `cloudflare:workers` builtin (via the sandbox adapter), so
 * the builtin is mocked here (same technique as
 * tests/pipeline/sandbox.test.ts) and the entry is imported dynamically after
 * the mock is registered.
 */

import { describe, expect, test } from "bun:test";
import type { D1Database, ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import "../helpers/cloudflare-workers-mock";
import { createFailureStore } from "../../src/store/failure-store";
import { createMigratedTestD1 } from "../store/helpers";
import { defaultSweepLog } from "../../src/worker/sweep";

const { default: worker, Sandbox, SandboxV1 } = await import("../../src/worker/entry");
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

describe("worker entry (deploy)", () => {
  test("exports the SandboxV1 DO class for the containers binding", () => {
    expect(typeof SandboxV1).toBe("function");
  });

  test("exports BOTH DO classes the config declares — SandboxV1 plus the compatibility Sandbox (fresh-deploy migration replay)", () => {
    // The retained legacy `v1` migration names `new_sqlite_classes: ["Sandbox"]`;
    // a fresh worker replays every unapplied migration, so the compatibility
    // class MUST stay exported or the first deploy fails. Pinning the pair so a
    // rename cannot silently drop it again.
    expect(typeof Sandbox).toBe("function");
    expect(Sandbox).not.toBe(SandboxV1);
  });

  test("the smoke entry re-exports the SAME DO class pair (its config carries the same v1 migration)", async () => {
    // wrangler.smoke.jsonc's `main` is src/pipeline/smoke-entry.ts and it
    // carries the same `v1` `new_sqlite_classes: ["Sandbox"]` tag, so dropping
    // either re-export there re-arms the fresh-worker rejection on the smoke
    // worker. Identity-pinned: same module graph, same class objects.
    const smoke = await import("../../src/pipeline/smoke-entry");
    expect(smoke.Sandbox).toBe(Sandbox);
    expect(smoke.SandboxV1).toBe(SandboxV1);
  });

  test("re-exports the fetch handler (healthz)", async () => {
    const res = await worker.fetch(new Request("https://worker.local/healthz"), makeEnv());
    expect(res.status).toBe(200);
    // Field-set assertion: `ok:true` contract unchanged, `version`
    // additive from the generated single source with the `v` prefix.
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(`v${APP_VERSION}`);
  });
});

/**
 * Cron scheduled wiring (AL-6): the deploy entry must expose the
 * `scheduled` face (re-exported from ./index) that runs the trailing-24h
 * failure sweep over the bound D1 — read-only, and NEVER throwing out of the
 * handler (a throwing cron handler just retries into alert noise).
 */
describe("worker entry scheduled wiring", () => {
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
    // The retention step runs first and degrades to its own warn (PR #10) —
    // the failure-sweep D1 error then propagates to the handler's catch.
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
    expect(warnCalls).toHaveLength(2);
    expect(warnCalls[0]!.fields.event).toBe("retention_swept_failed");
    expect(warnCalls[1]!.fields.event).toBe("ops_sweep_failed");
    expect(warnCalls[1]!.fields.detail).toContain("d1 down");
  });
});

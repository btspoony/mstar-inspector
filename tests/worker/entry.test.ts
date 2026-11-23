
import { describe, expect, test } from "bun:test";
import type { D1Database, ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import "../helpers/cloudflare-workers-mock";
import { createFailureStore, QUEUE_MAX_ATTEMPTS } from "../../src/store/failure-store";
import { createMigratedTestD1, seedBot, seedTarget } from "../store/helpers";
import { defaultSweepLog } from "../../src/worker/sweep";

const { default: worker, Sandbox, SandboxV1 } = await import("../../src/worker/entry");
import { APP_VERSION } from "../../src/version";
import type { Env } from "../../src/worker/env";

const SWEEP_FAILURE_THRESHOLD = QUEUE_MAX_ATTEMPTS + 1;

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
    expect(typeof Sandbox).toBe("function");
    expect(Sandbox).not.toBe(SandboxV1);
  });

  test("the smoke entry re-exports the SAME DO class pair (its config carries the same v1 migration)", async () => {
    const smoke = await import("../../src/pipeline/smoke-entry");
    expect(smoke.Sandbox).toBe(Sandbox);
    expect(smoke.SandboxV1).toBe(SandboxV1);
  });

  test("re-exports the fetch handler (healthz)", async () => {
    const res = await worker.fetch(new Request("https://worker.local/healthz"), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(`v${APP_VERSION}`);
  });
});

describe("worker entry scheduled wiring", () => {
  const NOOP_CONTROLLER = {} as ScheduledController;
  const NOOP_CTX = {} as ExecutionContext;

  test("exports a scheduled handler", () => {
    expect(typeof worker.scheduled).toBe("function");
  });

  test("scheduled runs the sweep over the bound DB and POSTs the alert to ALERT_WEBHOOK_URL on breach", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-entry", 9401);
    seedTarget(db, "bot-entry", { id: "target-entry" });
    const store = createFailureStore(db);
    for (let i = 0; i < SWEEP_FAILURE_THRESHOLD + 1; i++) {
      await store.record({
        target_id: "target-entry",
        installation_id: 1,
        owner: "acme",
        repo: "widgets",
        pr_number: 1,
        head_sha: "",
        code: "review.internal.unclassified",
      trackId: "t",
      message: "the review did not complete",
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
      failures_24h: SWEEP_FAILURE_THRESHOLD + 1,
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
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]!.fields.event).toBe("ops_sweep_db_unbound");
    expect(warnCalls[0]!.fields.detail).toContain("DB binding missing");
  });

  test("scheduled never throws when the sweep itself fails", async () => {
    const brokenDb = {
      prepare(sql: string): never | { bind: () => { all: () => Promise<{ results: never[] }> } } {
        if (sql.includes("review_runtime_settings WHERE key IN")) {
          return { bind: () => ({ all: async () => ({ results: [] }) }) };
        }
        throw new Error("d1 down");
      },
      batch: async () => [],
    };
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
    const events = warnCalls.map((call) => call.fields.event);
    for (const laneEvent of [
      "comment_claim_outbox_failed",
      "invite_lapse_swept_failed",
      "ops_sweep_failed",
      "pull_request_retention_swept_failed",
      "retention_swept_failed",
      "review_comment_claim_settings_degraded",
    ] as const) {
      expect(events).toContain(laneEvent);
    }
    const sweepFailure = warnCalls.find((call) => call.fields.event === "ops_sweep_failed");
    expect(sweepFailure?.fields.detail).toContain("d1 down");
  });
});

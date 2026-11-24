import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import "../helpers/cloudflare-workers-mock";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const { runReviewQueueBatch } = await import("../../src/worker/index");

const logLines: string[] = [];
const warnLines: string[] = [];
const realLog = console.log;
const realWarn = console.warn;
console.log = (...args: unknown[]) => {
  logLines.push(args.map(String).join(" "));
};
console.warn = (...args: unknown[]) => {
  warnLines.push(args.map(String).join(" "));
};

afterAll(() => {
  console.log = realLog;
  console.warn = realWarn;
  mock.restore();
});

const KEY = "review.route.workflow";

let consumerLoads = 0;
const settlements: string[] = [];

async function fakeConsumer(): Promise<never> {
  consumerLoads += 1;
  return {
    createReviewConsumer: () => async (): Promise<{ errors: number }> => ({ errors: 0 }),
    createWorkflowInstance: async () => {},
    settleHaltedBatch: async (_batch: unknown, _env: unknown, state: string) => {
      settlements.push(state);
    },
  } as never;
}

const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const BATCH = { queue: "review", messages: [] } as unknown as MessageBatch<never>;

function store(db: TestD1, value: string): void {
  db.raw
    .prepare(`INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, ?, ?)`)
    .run(KEY, value, new Date().toISOString());
}

function reset(): void {
  consumerLoads = 0;
  settlements.length = 0;
  logLines.length = 0;
  warnLines.length = 0;
}

describe("the review route's deployment gate", () => {
  test("an absent row refuses the batch and names the gate", async () => {
    reset();
    const db = createMigratedTestD1();

    await runReviewQueueBatch(BATCH, { DB: db } as never, CTX, fakeConsumer);

    expect(settlements).toEqual(["blocked-deployment-gate"]);
    expect(logLines).toHaveLength(1);
    const line = JSON.parse(logLines[0]!) as Record<string, unknown>;
    expect(line.event).toBe("review_route_gate_closed");
    expect(line.answer).toBe("blocked-deployment-gate");
    expect(line.review_route_workflow).toBe("off");
    expect(line.gate_saved).toBe(false);
    expect(line.gate_degraded).toBe(false);
    expect(line.gate_reason).toBeNull();
    expect(String(line.msg)).toContain(KEY);
  });

  test("a stored `on` admits the batch", async () => {
    reset();
    const db = createMigratedTestD1();
    store(db, "on");

    await runReviewQueueBatch(
      BATCH,
      { DB: db, REVIEW_WORKFLOW: { create: async () => ({}) } } as never,
      CTX,
      fakeConsumer,
    );

    expect(consumerLoads).toBe(1);
    expect(settlements).toHaveLength(0);
    expect(logLines).toHaveLength(0);
    expect(warnLines).toHaveLength(0);
  });

  test("a readable but untrusted row is closed — it settles as blocked, not as a fault", async () => {
    // The row WAS read; the value is simply not on/off. The gate's documented
    // answer is the safe default `off`, which the batch settles visibly. Only a
    // read that could not happen is unknowable.
    for (const raw of ["on ", " on", "on\t", "\non", "ON", "1", "true", "maybe"]) {
      reset();
      const db = createMigratedTestD1();
      store(db, raw);

      await runReviewQueueBatch(BATCH, { DB: db } as never, CTX, fakeConsumer);

      expect(settlements, raw).toEqual(["blocked-deployment-gate"]);
      expect(logLines, raw).toHaveLength(1);
      expect(warnLines, raw).toHaveLength(0);
      const line = JSON.parse(logLines[0]!) as Record<string, unknown>;
      expect(line.event, raw).toBe("review_route_gate_closed");
      expect(line.answer, raw).toBe("blocked-deployment-gate");
      expect(line.gate_degraded, raw).toBe(true);
      expect(line.gate_reason, raw).toBe("untrusted");
      expect(line.gate_rejected, raw).toBe(JSON.stringify(raw));
    }
  });

  test("a failing read refuses too — never permission, and nothing is settled", async () => {
    reset();
    const failing = {
      prepare() {
        throw new Error("settings unavailable");
      },
    };

    await expect(runReviewQueueBatch(BATCH, { DB: failing } as never, CTX, fakeConsumer)).rejects.toThrow(
      "unreadable",
    );

    expect(settlements).toHaveLength(0);
    expect(logLines).toHaveLength(0);
    const line = JSON.parse(warnLines[0]!) as Record<string, unknown>;
    expect(line.answer).toBe("unreadable-state");
    expect(line.gate_reason).toBe("read-failed");
  });
});

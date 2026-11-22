/**
 * The review route's deployment gate (spec § Deployment gate). One system
 * setting decides whether a queue delivery may create a Workflow instance, so
 * merging this code is safe and enabling the route is a deliberate operator
 * act: absent is OFF, a stored `on` is the ONLY admission, and an unreadable
 * row refuses rather than admits.
 *
 * The consumer arrives through `runReviewQueueBatch`'s loader parameter, so this
 * suite needs no `mock.module` — a process-wide stub cannot be undone in Bun
 * and would leak into later files.
 */
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

/** Counts how often the gate let the handler reach the consumer. */
let consumerLoads = 0;

/** The fake consumer module: a no-op consumer, so the batch costs nothing. */
async function fakeConsumer(): Promise<never> {
  consumerLoads += 1;
  return {
    createReviewConsumer: () => async (): Promise<{ errors: number }> => ({ errors: 0 }),
    createWorkflowInstance: async () => {},
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
  logLines.length = 0;
  warnLines.length = 0;
}

describe("the review route's deployment gate", () => {
  test("an absent row refuses the batch and names the gate", async () => {
    reset();
    const db = createMigratedTestD1();

    await runReviewQueueBatch(BATCH, { DB: db } as never, CTX, fakeConsumer);

    expect(consumerLoads).toBe(0);
    expect(logLines).toHaveLength(1);
    const line = JSON.parse(logLines[0]!) as Record<string, unknown>;
    expect(line.event).toBe("review_route_gate_closed");
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
    expect(logLines).toHaveLength(0);
    expect(warnLines).toHaveLength(0);
  });

  test("an unreadable row refuses, and says why", async () => {
    reset();
    const db = createMigratedTestD1();
    store(db, "maybe");

    await runReviewQueueBatch(BATCH, { DB: db } as never, CTX, fakeConsumer);

    expect(consumerLoads).toBe(0);
    // Unreadable evidence is a fault, so the line rides warn; the refusal is
    // the same as an absent row.
    expect(logLines).toHaveLength(0);
    expect(warnLines).toHaveLength(1);
    const line = JSON.parse(warnLines[0]!) as Record<string, unknown>;
    expect(line.event).toBe("review_route_gate_closed");
    expect(line.gate_degraded).toBe(true);
    expect(line.gate_reason).toBe("untrusted");
  });

  test("a failing read refuses too — never permission", async () => {
    reset();
    const failing = {
      prepare() {
        throw new Error("settings unavailable");
      },
    };

    await runReviewQueueBatch(BATCH, { DB: failing } as never, CTX, fakeConsumer);

    expect(consumerLoads).toBe(0);
    const line = JSON.parse(warnLines[0]!) as Record<string, unknown>;
    expect(line.gate_reason).toBe("read-failed");
  });
});

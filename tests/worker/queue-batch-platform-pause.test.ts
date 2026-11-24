import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import "../helpers/cloudflare-workers-mock";
import {
  SHA,
  TEST_APP_ID,
  createSeededTestD1,
} from "../helpers/consumer-fixtures";
import { makePayload, failureRows } from "../helpers/consumer-harness";
import type { TestD1 } from "../store/helpers";
import { FAILURE_SUMMARIES } from "../../src/contracts/failure-codes";
import {
  TERMINAL_FAILURE_TEXT,
  attachCheckAtAcceptance,
  createChecksAdapter,
  type CheckRunPayload,
  type ChecksOctokit,
} from "../../src/pipeline/checks";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import { reviewRunState } from "../../src/dashboard/runtime-config-store";

// Static import cannot work here: `src/worker/index` loads the workerd shim at
// module scope, so the shim above must be registered first (same seam as
// tests/worker/queue-route-gate.test.ts).
const { runReviewQueueBatch } = await import("../../src/worker/index");

const lines: string[] = [];
const realLog = console.log;
const realWarn = console.warn;
console.log = (...args: unknown[]) => {
  lines.push(args.map(String).join(" "));
};
console.warn = (...args: unknown[]) => {
  lines.push(args.map(String).join(" "));
};

afterAll(() => {
  console.log = realLog;
  console.warn = realWarn;
  mock.restore();
});

const CTX = { waitUntil: () => {}, passUntil: () => {} } as unknown as ExecutionContext;

function linesOf(event: string): Array<Record<string, unknown>> {
  return lines
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .filter((line) => line.event === event);
}

function openRouteGate(db: TestD1): void {
  db.raw
    .prepare(`INSERT INTO review_runtime_settings (key, value, updated_at) VALUES ('review.route.workflow', 'on', ?)`)
    .run(new Date().toISOString());
}

function storeSwitch(db: TestD1, enabled: 0 | 1): void {
  db.raw
    .prepare(`INSERT INTO server_flags (key, enabled, updated_at, updated_by) VALUES ('review_global', ?, ?, 'tester')`)
    .run(enabled, new Date().toISOString());
}

function batchOf(payload: ReviewJobPayload) {
  const acks: number[] = [];
  const retries: number[] = [];
  return {
    acks,
    retries,
    batch: {
      queue: "review-queue",
      messages: [
        {
          id: "m1",
          timestamp: new Date(),
          attempts: 1,
          body: payload,
          ack: () => acks.push(1),
          retry: () => retries.push(1),
        },
      ],
    } as unknown as MessageBatch<ReviewJobPayload>,
  };
}

function kvDouble() {
  const puts: Array<{ key: string; value: string }> = [];
  const kv = {
    get: async () => null,
    put: async (key: string, value: string) => {
      puts.push({ key, value });
    },
    delete: async () => {},
  };
  return { kv: kv as never, puts };
}

function scriptedChecks(): ChecksOctokit {
  let nextId = 8100;
  const run = (params: { name: string; head_sha: string; external_id: string }): CheckRunPayload => ({
    id: (nextId += 1),
    name: params.name,
    head_sha: params.head_sha,
    external_id: params.external_id,
    status: "queued",
    conclusion: null,
    app: { id: 424242 },
  });
  return {
    rest: {
      checks: {
        create: async (params) => ({ data: run(params) }),
        update: async () => ({ data: run({ name: "", head_sha: SHA, external_id: "" }) }),
        get: async () => ({ data: run({ name: "", head_sha: SHA, external_id: "" }) }),
        listForRef: async () => ({ data: { total_count: 0, check_runs: [] } }),
      },
    },
  };
}

/** The Check run the delivery path already attached before the queue saw it. */
async function attachRun(db: TestD1, payload: ReviewJobPayload, deliveryId: string): Promise<void> {
  const adapter = createChecksAdapter({ db: db as never, nowMs: () => Date.now(), getOctokit: async () => scriptedChecks() });
  const attached = await attachCheckAtAcceptance(
    { db: db as never, adapter, nowMs: () => Date.now() },
    {
      scope: {
        appId: payload.botRef.appId,
        installationId: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        prNumber: payload.pr_number,
      },
      githubAppId: 424242,
      headSha: SHA,
      triggeredBy: payload.triggered_by,
      action: payload.action,
      deliveryId,
    },
  );
  if (attached.kind !== "attached") throw new Error(`fixture: expected attached, got ${attached.kind}`);
  payload.attachDeliveryId = attached.deliveryId;
}

function checkRow(db: TestD1): Record<string, unknown> {
  return db.raw.query("SELECT * FROM review_checks WHERE head_sha = ?").get(SHA) as Record<string, unknown>;
}

describe("the platform switch ends a queued batch visibly", () => {
  test("switch off: paused Check, exactly one failure row, one ack, no Workflow instance", async () => {
    lines.length = 0;
    const db = await createSeededTestD1();
    openRouteGate(db);
    storeSwitch(db, 0);
    const payload = makePayload();
    await attachRun(db, payload, "pause-delivery-1");
    const { batch, acks, retries } = batchOf(payload);
    const { kv, puts } = kvDouble();
    const creates: unknown[] = [];

    await runReviewQueueBatch(
      batch,
      {
        DB: db as never,
        IDEMPOTENCY_KV: kv,
        REVIEW_WORKFLOW: { create: async (options: unknown) => creates.push(options) },
      } as never,
      CTX,
    );

    expect(creates).toHaveLength(0);
    expect(retries).toHaveLength(0);
    expect(acks).toHaveLength(1);
    expect(puts.map((put) => put.value)).toEqual(["paused"]);

    const row = checkRow(db);
    expect(row.desired).toBe("neutral");
    expect(row.desired_summary).toBe(TERMINAL_FAILURE_TEXT.paused);
    expect(row.terminal_failure_status).toBe("paused");
    expect(row.terminal_ms).toBeNull();

    const failures = failureRows(db);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error_code).toBe("review.paused.platform");
    expect(failures[0]!.message).toBe(FAILURE_SUMMARIES["review.paused.platform"]);
    expect(String(failures[0]!.error)).toContain("platform_paused");
    expect(failures[0]!.head_sha).toBe(SHA);

    const pauseLines = linesOf("review_paused");
    expect(pauseLines).toHaveLength(1);
    expect(pauseLines[0]!.batch_size).toBe(1);
  });

  test("switch off twice for the same delivery appends no second row", async () => {
    const db = await createSeededTestD1();
    openRouteGate(db);
    storeSwitch(db, 0);
    const payload = makePayload();
    await attachRun(db, payload, "pause-delivery-2");

    for (let round = 0; round < 2; round += 1) {
      const { batch } = batchOf(payload);
      const { kv } = kvDouble();
      await runReviewQueueBatch(
        batch,
        { DB: db as never, IDEMPOTENCY_KV: kv, REVIEW_WORKFLOW: { create: async () => ({}) } } as never,
        CTX,
      );
    }

    expect(failureRows(db)).toHaveLength(1);
  });

  test("switch read fault: fail-closed, nothing settled, nothing acked, batch redelivered", async () => {
    lines.length = 0;
    const db = await createSeededTestD1();
    openRouteGate(db);
    const payload = makePayload();
    await attachRun(db, payload, "pause-delivery-3");
    const { batch, acks } = batchOf(payload);
    const { kv } = kvDouble();
    const faulting = {
      prepare: (sql: string) => {
        if (sql.includes("server_flags")) throw new Error("flags unavailable");
        return db.prepare(sql);
      },
      batch: (statements: never[]) => db.batch(statements),
    };

    await expect(
      runReviewQueueBatch(
        batch,
        { DB: faulting as never, IDEMPOTENCY_KV: kv, REVIEW_WORKFLOW: { create: async () => ({}) } } as never,
        CTX,
      ),
    ).rejects.toThrow("unreadable");

    const closed = linesOf("review_route_gate_closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]!.platform_unreadable).toBe(true);
    expect(closed[0]!.answer).toBe("unreadable-state");
    expect(failureRows(db)).toHaveLength(0);
    expect(acks).toHaveLength(0);
    expect(checkRow(db).desired).toBe("in_progress");
    expect(checkRow(db).terminal_failure_status).toBeNull();
  });

  test("both gates closed: the batch settles as blocked, never the silent ack", async () => {
    lines.length = 0;
    const db = await createSeededTestD1();
    // No gate row (absent = off) AND the platform switch off.
    storeSwitch(db, 0);
    const payload = makePayload();
    await attachRun(db, payload, "pause-delivery-5");
    const { batch, acks, retries } = batchOf(payload);
    const { kv, puts } = kvDouble();

    await runReviewQueueBatch(
      batch,
      { DB: db as never, IDEMPOTENCY_KV: kv, REVIEW_WORKFLOW: { create: async () => ({}) } } as never,
      CTX,
    );

    expect(acks).toHaveLength(1);
    expect(retries).toHaveLength(0);
    expect(puts.map((put) => put.value)).toEqual(["paused"]);
    expect(checkRow(db).terminal_failure_status).toBe("paused");
    const failures = failureRows(db);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error_code).toBe("review.blocked.deployment_gate");
    expect(failures[0]!.message).toBe(FAILURE_SUMMARIES["review.blocked.deployment_gate"]);
    expect(String(failures[0]!.error)).toContain("deployment_gate_closed");
    expect(failures[0]!.stage).toBe("pipeline");
    // The card and the queue agree: ONE derivation answers both.
    expect((await reviewRunState(db as never)).state).toBe("blocked-deployment-gate");
  });

  test("a failed failure-row insert leaves the delivery unacked so it is redelivered", async () => {
    lines.length = 0;
    const db = await createSeededTestD1();
    openRouteGate(db);
    storeSwitch(db, 0);
    const payload = makePayload();
    await attachRun(db, payload, "pause-delivery-6");
    const { batch, acks } = batchOf(payload);
    const { kv } = kvDouble();
    const refuseInsert = {
      prepare: (sql: string) => {
        if (sql.includes("INSERT INTO review_failures")) throw new Error("failure store unavailable");
        return db.prepare(sql);
      },
      batch: (statements: never[]) => db.batch(statements),
    };

    await expect(
      runReviewQueueBatch(
        batch,
        { DB: refuseInsert as never, IDEMPOTENCY_KV: kv, REVIEW_WORKFLOW: { create: async () => ({}) } } as never,
        CTX,
      ),
    ).rejects.toThrow("failure store unavailable");

    expect(acks).toHaveLength(0);
    // The row was attempted BEFORE the Check settlement, so the Check is still open.
    expect(checkRow(db).desired).toBe("in_progress");
    expect(checkRow(db).terminal_failure_status).toBeNull();
  });

  test("the per-App pause path keeps its own settlement, with no platform code", async () => {
    const db = await createSeededTestD1();
    openRouteGate(db);
    storeSwitch(db, 1);
    db.raw.prepare("UPDATE review_bots SET review_enabled = 0 WHERE id = ?").run(TEST_APP_ID);
    const payload = makePayload();
    await attachRun(db, payload, "pause-delivery-4");
    const { batch, acks } = batchOf(payload);
    const { kv } = kvDouble();

    await runReviewQueueBatch(
      batch,
      { DB: db as never, IDEMPOTENCY_KV: kv, REVIEW_WORKFLOW: { create: async () => ({}) } } as never,
      CTX,
    );

    expect(acks).toHaveLength(1);
    expect(failureRows(db).filter((row) => row.error_code === "review.paused.platform")).toHaveLength(0);
    expect(checkRow(db).terminal_failure_status).toBe("paused");
  });
});

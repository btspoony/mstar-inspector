import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import "../helpers/cloudflare-workers-mock";
import {
  SHA,
  TEST_APP_ID,
  createSeededTestD1,
} from "../helpers/consumer-fixtures";
import { makePayload, failureRows } from "../helpers/consumer-harness";
import { seedBot, seedTarget, type TestD1 } from "../store/helpers";
import { FAILURE_SUMMARIES } from "../../src/contracts/failure-codes";
import {
  TERMINAL_FAILURE_TEXT,
  attachCheckAtAcceptance,
  createChecksAdapter,
  type CheckRunPayload,
  type ChecksOctokit,
} from "../../src/pipeline/checks";
import { QUEUE_MAX_ATTEMPTS } from "../../src/store/failure-store";
import { requestMaintenanceReplay } from "../../src/admin/maintenance-replay";
import { runSweep } from "../../src/worker/sweep";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import { reviewRunState, setMaintenanceMode } from "../../src/dashboard/runtime-config-store";
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

const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

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

function batchOf(payload: ReviewJobPayload, attempts = 1) {
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
          attempts,
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

/** A queued mention claim, as the webhook lane writes it before the queue send. */
function seedClaim(db: TestD1, payload: ReviewJobPayload): void {
  db.raw
    .prepare(
      `INSERT INTO comment_trigger_claims
         (installation_id, owner, repo, pr_number, comment_id, state, payload_json, attempts, created_ms, queued_ms)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, 1, 1)`,
    )
    .run(
      payload.installation_id,
      payload.owner,
      payload.repo,
      payload.pr_number,
      payload.comment_id!,
      JSON.stringify(payload),
    );
}

function mentionPayload(commentId: number): ReviewJobPayload {
  return makePayload({ head_sha: null, action: "created", triggered_by: "issue_comment", comment_id: commentId });
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

  test("a readable but untrusted gate settles as blocked, with the gate's own code", async () => {
    lines.length = 0;
    const db = await createSeededTestD1();
    // The row exists but holds a value the gate refuses (not on/off).
    db.raw
      .prepare(`INSERT INTO review_runtime_settings (key, value, updated_at) VALUES ('review.route.workflow', 'ON', ?)`)
      .run(new Date().toISOString());
    storeSwitch(db, 1);
    const payload = makePayload();
    await attachRun(db, payload, "pause-delivery-7");
    const { batch, acks } = batchOf(payload);
    const { kv } = kvDouble();

    await runReviewQueueBatch(
      batch,
      { DB: db as never, IDEMPOTENCY_KV: kv, REVIEW_WORKFLOW: { create: async () => ({}) } } as never,
      CTX,
    );

    expect(acks).toHaveLength(1);
    expect(checkRow(db).terminal_failure_status).toBe("paused");
    const failures = failureRows(db);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error_code).toBe("review.blocked.deployment_gate");
    expect((await reviewRunState(db as never)).state).toBe("blocked-deployment-gate");
  });

  test("a gate whose READ fails throws with nothing settled", async () => {
    lines.length = 0;
    const db = await createSeededTestD1();
    storeSwitch(db, 1);
    const payload = makePayload();
    await attachRun(db, payload, "pause-delivery-8");
    const { batch, acks } = batchOf(payload);
    const { kv } = kvDouble();
    // The gate's own point read fails; every other statement works.
    const gateFault = {
      prepare: (sql: string) => {
        const statement = db.prepare(sql) as unknown as Record<string, unknown> & {
          bind: (...args: unknown[]) => unknown;
        };
        return new Proxy(statement, {
          get(target, property, receiver) {
            if (property !== "bind") return Reflect.get(target, property, receiver);
            return (...args: unknown[]) => {
              if (args[0] === "review.route.workflow") throw new Error("gate unavailable");
              return target.bind(...args);
            };
          },
        });
      },
      batch: (statements: never[]) => db.batch(statements),
    };

    await expect(
      runReviewQueueBatch(
        batch,
        { DB: gateFault as never, IDEMPOTENCY_KV: kv, REVIEW_WORKFLOW: { create: async () => ({}) } } as never,
        CTX,
      ),
    ).rejects.toThrow("the review route gate is unreadable (read-failed)");

    expect(acks).toHaveLength(0);
    expect(failureRows(db)).toHaveLength(0);
    expect(checkRow(db).desired).toBe("in_progress");
    expect(checkRow(db).terminal_failure_status).toBeNull();
    const closed = linesOf("review_route_gate_closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]!.answer).toBe("unreadable-state");
    expect(closed[0]!.gate_reason).toBe("read-failed");
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
    db.raw.prepare("UPDATE github_apps SET review_enabled = 0 WHERE id = ?").run(TEST_APP_ID);
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

  test("platform off + maintenance on: the batch defers, it does not halt-settle", async () => {
    lines.length = 0;
    const db = await createSeededTestD1();
    openRouteGate(db);
    storeSwitch(db, 0);
    await setMaintenanceMode(
      db,
      { enabled: true, reason: "repository backfill", actor: "tester" },
      "2026-11-24T09:00:00.000Z",
    );
    const payload = makePayload();
    await attachRun(db, payload, "pause-delivery-9");
    const { batch, acks, retries } = batchOf(payload);
    const { kv, puts } = kvDouble();

    await runReviewQueueBatch(
      batch,
      { DB: db as never, IDEMPOTENCY_KV: kv, REVIEW_WORKFLOW: { create: async () => ({}) } } as never,
      CTX,
    );

    expect(retries).toHaveLength(1);
    expect(acks).toHaveLength(0);
    expect(puts).toHaveLength(0);
    expect(failureRows(db)).toHaveLength(0);
    expect(checkRow(db).terminal_failure_status).toBeNull();
    expect(linesOf("maintenance_defer")).toHaveLength(1);
  });

  test("a halt-settled bot mention closes its comment claim — nothing left for the sweep to resend", async () => {
    const db = await createSeededTestD1();
    openRouteGate(db);
    storeSwitch(db, 0);
    const payload = mentionPayload(9501);
    seedClaim(db, payload);
    const { batch, acks } = batchOf(payload);
    const { kv } = kvDouble();

    await runReviewQueueBatch(batch, { DB: db as never, IDEMPOTENCY_KV: kv } as never, CTX);

    expect(acks).toHaveLength(1);
    const failures = failureRows(db);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error_code).toBe("review.paused.platform");
    const claim = db.raw
      .query("SELECT state, consumed_ms, payload_json FROM comment_trigger_claims")
      .get() as { state: string; consumed_ms: number | null; payload_json: string | null };
    expect(claim.state).toBe("consumed");
    expect(claim.consumed_ms).not.toBeNull();
    expect(claim.payload_json).toBeNull();
  });

  test("two halted mentions of one PR keep a row each, and replaying a delivery shares its row", async () => {
    const db = await createSeededTestD1();
    openRouteGate(db);
    storeSwitch(db, 0);
    const first = mentionPayload(9511);
    const second = mentionPayload(9512);
    seedClaim(db, first);
    seedClaim(db, second);
    const { kv } = kvDouble();
    const env = { DB: db as never, IDEMPOTENCY_KV: kv } as never;

    await runReviewQueueBatch(batchOf(first).batch, env, CTX);
    await runReviewQueueBatch(batchOf(second).batch, env, CTX);
    expect(failureRows(db)).toHaveLength(2);

    await runReviewQueueBatch(batchOf(first).batch, env, CTX);

    const failures = failureRows(db);
    expect(failures).toHaveLength(2);
    expect(failures.map((row) => row.error_code)).toEqual(["review.paused.platform", "review.paused.platform"]);
    expect(new Set(failures.map((row) => row.id)).size).toBe(2);
  });

  test("the webhook copy and the outbox resend of one mention share its halt row", async () => {
    const db = await createSeededTestD1();
    openRouteGate(db);
    storeSwitch(db, 0);
    // The claim's payload_json is saved BEFORE the webhook attaches a delivery
    // id, so the outbox resend omits it and the webhook copy carries it — one
    // mention, two deliveryKey identities.
    const outboxCopy = mentionPayload(9521);
    const webhookCopy = { ...outboxCopy, attachDeliveryId: "attach-9521" };
    seedClaim(db, outboxCopy);
    const { kv } = kvDouble();
    const env = { DB: db as never, IDEMPOTENCY_KV: kv } as never;

    await runReviewQueueBatch(batchOf(webhookCopy).batch, env, CTX);
    await runReviewQueueBatch(batchOf(outboxCopy).batch, env, CTX);

    const failures = failureRows(db);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error_code).toBe("review.paused.platform");
  });

  test("a halted batch that spends its last maintenance deferral keeps the halt shape and joins the outbox", async () => {
    const db = await createSeededTestD1();
    openRouteGate(db);
    storeSwitch(db, 0);
    await setMaintenanceMode(
      db,
      { enabled: true, reason: "repository backfill", actor: "tester" },
      "2026-11-24T09:00:00.000Z",
    );
    const payload = makePayload();
    await attachRun(db, payload, "pause-delivery-10");
    const { batch, acks, retries } = batchOf(payload, QUEUE_MAX_ATTEMPTS);
    const { kv, puts } = kvDouble();

    await runReviewQueueBatch(batch, { DB: db as never, IDEMPOTENCY_KV: kv } as never, CTX);

    expect(retries).toHaveLength(0);
    expect(acks).toHaveLength(1);
    // The halted settlement's claim: a resume may re-enqueue this head.
    expect(puts).toHaveLength(1);
    expect(puts[0]!.value).toBe("paused");
    const failures = failureRows(db);
    expect(failures).toHaveLength(1);
    // The row keeps the HALT shape — code, cause and summary — so the operator
    // card and the row agree, while `maintenance_deferred` + the requested
    // stamp put it in the sweep's replay outbox (and ONLY there: the admin
    // route answers it `repeat`, and `reviews_not_running` while the switch
    // stays off).
    expect(failures[0]!.error_code).toBe("review.paused.platform");
    expect(failures[0]!.stage).toBe("maintenance_deferred");
    expect(failures[0]!.message).toBe(FAILURE_SUMMARIES["review.paused.platform"]);
    expect(failures[0]!.maintenance_replay_requested_at).not.toBeNull();
    expect(failures[0]!.maintenance_replay_sent_at).toBeNull();
    expect(String(failures[0]!.error)).toContain("platform_paused");
    expect(String(failures[0]!.error)).toContain("maintenance window");
    // The Check is settled paused like the halted path settles it — the
    // deferral may not leave an attached run hanging.
    expect(checkRow(db).terminal_failure_status).toBe("paused");

    // The admin replay refuses the halt-caused row while the halt holds: a
    // send would be acked without running. Maintenance is lifted first so the
    // refusal names the halt, not the window.
    await setMaintenanceMode(
      db,
      { enabled: false, reason: null, actor: "tester" },
      "2026-11-24T10:00:00.000Z",
    );
    const res = await requestMaintenanceReplay(
      db as never,
      { send: async () => {} } as never,
      { failureId: String(failures[0]!.id), actor: "tester", now: new Date().toISOString() },
    );
    // Already stamped: the route answers `repeat` from the row's own state
    // before any gate — the stamp is what kept it out of the operator lane.
    expect(res).toEqual({ kind: "repeat", state: "requested" });
    expect(failureRows(db)[0]!.maintenance_replay_sent_at).toBeNull();

    // Once the halt clears, the sweep lane is the one sender: it re-issues
    // the delivery and stamps the row sent.
    db.raw.prepare("UPDATE server_flags SET enabled = 1 WHERE key = 'review_global'").run();
    const sent: ReviewJobPayload[] = [];
    await runSweep(db as never, {
      log: { warn: () => {} },
      queue: { send: async (p: ReviewJobPayload) => void sent.push(p) } as never,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: "maintenance_replay", pr_number: payload.pr_number });
    const after = db.raw
      .prepare("SELECT maintenance_replay_sent_at AS sent FROM review_failures WHERE id = ?")
      .get(failures[0]!.id as string) as { sent: string | null };
    expect(after.sent).not.toBeNull();
  });

  test("one comment id naming two Apps' targets still keeps a row each", async () => {
    const db = await createSeededTestD1();
    openRouteGate(db);
    storeSwitch(db, 0);
    // Two Apps may serve one repository (one target each): the same mention
    // then arrives as two deliveries that differ only in targetId, and each
    // needs its own durable row.
    seedBot(db, "bot-other-app", 9101);
    const otherTarget = seedTarget(db, "bot-other-app", { repoOwner: "acme", repoName: "widgets" });
    const first = mentionPayload(9531);
    const second = { ...first, targetId: otherTarget };
    seedClaim(db, first);
    const { kv } = kvDouble();
    const env = { DB: db as never, IDEMPOTENCY_KV: kv } as never;

    await runReviewQueueBatch(batchOf(first).batch, env, CTX);
    await runReviewQueueBatch(batchOf(second).batch, env, CTX);

    const failures = failureRows(db);
    expect(failures).toHaveLength(2);
    expect(new Set(failures.map((row) => row.id)).size).toBe(2);
  });
});

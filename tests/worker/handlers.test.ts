import { describe, expect, mock, test, type Mock } from "bun:test";
import type { D1Database, KVNamespace, Queue } from "@cloudflare/workers-types";
import { idemKey, IDEMPOTENCY_SECONDS } from "../../src/contracts/idem";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import { claimIdempotency, handleReviewJob, idempotencyHit, type HandlerDeps, type HandlerLog } from "../../src/worker/handlers";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const COMMENT_ID = 987654321;

function prPayload(overrides: Partial<ReviewJobPayload> = {}): ReviewJobPayload {
  return {
    installation_id: 12345,
    owner: "acme",
    repo: "inspector",
    pr_number: 42,
    head_sha: HEAD_SHA,
    action: "opened",
    triggered_by: "pull_request",
    botRef: { appId: "11111111-2222-3333-4444-555555555555" },
    targetId: "66666666-7777-8888-9999-aaaaaaaaaaaa",
    ...overrides,
  };
}

function mentionPayload(overrides: Partial<ReviewJobPayload> = {}): ReviewJobPayload {
  return {
    installation_id: 12345,
    owner: "acme",
    repo: "inspector",
    pr_number: 42,
    head_sha: null,
    comment_id: COMMENT_ID,
    action: "created",
    triggered_by: "issue_comment",
    botRef: { appId: "11111111-2222-3333-4444-555555555555" },
    targetId: "66666666-7777-8888-9999-aaaaaaaaaaaa",
    ...overrides,
  };
}

function makeKvStub() {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  const get = mock(async (key: string) => store.get(key)?.value ?? null);
  const put = mock(async (key: string, value: string, options?: { expirationTtl?: number }) => {
    store.set(key, { value, expirationTtl: options?.expirationTtl });
  });
  const kv = {
    get,
    put,
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    delete: async () => {},
  } as unknown as KVNamespace & { get: Mock<(key: string) => Promise<string | null>>; put: Mock<(key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>> };
  return { kv, store };
}

function makeQueueStub() {
  const sent: ReviewJobPayload[] = [];
  const send = mock(async (message: ReviewJobPayload) => {
    sent.push(message);
  });
  const queue = {
    send,
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
    sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
  } as unknown as Queue<ReviewJobPayload> & { send: Mock<(message: ReviewJobPayload) => Promise<void>> };
  return { queue, sent };
}

function makeLog(): { info: Mock<(fields: unknown, msg?: string) => void>; warn: Mock<(fields: unknown, msg?: string) => void> } & HandlerLog {
  return {
    info: mock((_fields: unknown, _msg?: string) => {}),
    warn: mock((_fields: unknown, _msg?: string) => {}),
  } as { info: Mock<(fields: unknown, msg?: string) => void>; warn: Mock<(fields: unknown, msg?: string) => void> } & HandlerLog;
}

function handlerEnv(
  kv: KVNamespace,
  queue: Queue<ReviewJobPayload>,
  db: D1Database = createMigratedTestD1() as unknown as D1Database,
): HandlerDeps["env"] {
  return { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue, DB: db };
}

type ClaimRow = { state: string; attempts: number; payload_json: string; queued_ms: number; consumed_ms: number | null };

function claimRows(db: D1Database): ClaimRow[] {
  return (db as unknown as TestD1).raw
    .query("SELECT state, attempts, payload_json, queued_ms, consumed_ms FROM comment_trigger_claims ORDER BY comment_id")
    .all() as ClaimRow[];
}

function insertClaim(db: D1Database, state: "queued" | "consumed" | "expired", commentId = COMMENT_ID): void {
  (db as unknown as TestD1).raw
    .prepare(
      `INSERT INTO comment_trigger_claims
         (installation_id, owner, repo, pr_number, comment_id, state, payload_json, attempts, created_ms, queued_ms)
       VALUES (12345, 'acme', 'inspector', 42, ?, ?, ?, 0, 1, 1)`,
    )
    .run(commentId, state, JSON.stringify(mentionPayload({ comment_id: commentId })));
}

describe("handleReviewJob — enqueue once", () => {
  test("first delivery with a non-null head_sha enqueues exactly once and writes the KV key", async () => {
    const { kv, store } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();

    const outcome = await handleReviewJob(prPayload(), { env: handlerEnv(kv, queue), log });

    expect(outcome).toEqual({ kind: "enqueued" });
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(sent[0]).toEqual(prPayload());
    const key = idemKey({ installation_id: 12345, owner: "acme", repo: "inspector", pr_number: 42, head_sha: HEAD_SHA });
    expect(store.get(key)?.value).toBe("1");
    expect(store.get(key)?.expirationTtl).toBe(IDEMPOTENCY_SECONDS);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]?.[0]).toMatchObject({
      event: "pull_request",
      action: "opened",
      installation_id: 12345,
      owner: "acme",
      repo: "inspector",
      pr_number: 42,
      head_sha: HEAD_SHA,
    });
  });

  test("a pre-enqueue step may patch the payload — the attach identity rides the message", async () => {
    const { kv } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();

    const outcome = await handleReviewJob(prPayload(), {
      env: handlerEnv(kv, queue),
      log,
      beforeEnqueue: async (payload) => ({ ...payload, attachDeliveryId: "delivery-uuid" }),
    });

    expect(outcome).toEqual({ kind: "enqueued" });
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(sent[0]!.attachDeliveryId).toBe("delivery-uuid");
  });
  test("second delivery with the same non-null head_sha is skipped (put-if-absent) and not enqueued", async () => {
    const { kv } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();

    await handleReviewJob(prPayload(), { env: handlerEnv(kv, queue), log });
    log.info.mockClear();
    const outcome = await handleReviewJob(prPayload(), { env: handlerEnv(kv, queue), log });

    expect(outcome).toEqual({ kind: "skipped", reason: "idempotency hit" });
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(log.info.mock.calls[0]?.[1]).toContain("idempotency hit");
  });

  test("a different head_sha on the same PR is a different key and enqueues", async () => {
    const { kv } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();

    await handleReviewJob(prPayload(), { env: handlerEnv(kv, queue), log });
    const outcome = await handleReviewJob(
      prPayload({ head_sha: "ffffffffffffffffffffffffffffffffffffffff" }),
      { env: handlerEnv(kv, queue), log },
    );

    expect(outcome).toEqual({ kind: "enqueued" });
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(sent[1]?.head_sha).toBe("ffffffffffffffffffffffffffffffffffffffff");
  });
});

describe("handleReviewJob — a key that proves no review happened", () => {
  test("dropped / failed / paused / degraded / superseded values re-enqueue the commit and refresh the claim", async () => {
    const key = idemKey({ installation_id: 12345, owner: "acme", repo: "inspector", pr_number: 42, head_sha: HEAD_SHA });
    for (const value of ["dropped", "failed", "paused", "degraded", "superseded"] as const) {
      const { kv, store } = makeKvStub();
      store.set(key, { value });
      const { queue, sent } = makeQueueStub();
      const log = makeLog();

      const outcome = await handleReviewJob(prPayload(), { env: handlerEnv(kv, queue), log });

      expect(outcome).toEqual({ kind: "enqueued" });
      expect(sent).toHaveLength(1);
      expect(store.get(key)?.value).toBe("1");
    }
  });
});

describe("handleReviewJob — a key that still covers the commit", () => {
  test("a done value skips the redelivery", async () => {
    const key = idemKey({ installation_id: 12345, owner: "acme", repo: "inspector", pr_number: 42, head_sha: HEAD_SHA });
    const value = "done";
    const { kv, store } = makeKvStub();
    store.set(key, { value });
    const { queue, sent } = makeQueueStub();
    const log = makeLog();

    const outcome = await handleReviewJob(prPayload(), { env: handlerEnv(kv, queue), log });

    expect(outcome).toEqual({ kind: "skipped", reason: "idempotency hit" });
    expect(sent).toHaveLength(0);
    expect(store.get(key)?.value).toBe(value);
  });
});

describe("handleReviewJob — durable comment-trigger claim (no head_sha)", () => {
  test("a job without a comment id enqueues, touches no KV key and writes no claim row", async () => {
    const { kv, store } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();
    const db = createMigratedTestD1() as unknown as D1Database;

    const outcome = await handleReviewJob(mentionPayload({ comment_id: undefined }), {
      env: handlerEnv(kv, queue, db),
      log,
    });

    expect(outcome).toEqual({ kind: "enqueued" });
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    expect(claimRows(db)).toHaveLength(0);
    expect(log.info.mock.calls[0]?.[0]).toMatchObject({
      event: "issue_comment",
      action: "created",
      head_sha: null,
    });
  });

  test("the same comment id enqueues once — KV fast path, then the D1 claim alone", async () => {
    const { kv, store } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();
    const db = createMigratedTestD1() as unknown as D1Database;
    const env = handlerEnv(kv, queue, db);

    await handleReviewJob(mentionPayload(), { env, log });
    expect(claimRows(db)).toHaveLength(1);
    log.info.mockClear();

    const fastPath = await handleReviewJob(mentionPayload(), { env, log });
    expect(fastPath).toEqual({ kind: "skipped", reason: "idempotency hit" });
    expect(log.info.mock.calls[0]?.[1]).toContain("idempotency hit");

    store.clear();
    log.info.mockClear();
    const outcome = await handleReviewJob(mentionPayload(), { env, log });

    expect(outcome).toEqual({ kind: "skipped", reason: "duplicate comment trigger" });
    expect(log.info.mock.calls[0]?.[1]).toContain("duplicate comment trigger");
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);

    const [row] = claimRows(db);
    expect(row).toMatchObject({ state: "queued", attempts: 0, consumed_ms: null });
    expect(JSON.parse(row!.payload_json)).toMatchObject({
      comment_id: COMMENT_ID,
      triggered_by: "issue_comment",
      botRef: { appId: "11111111-2222-3333-4444-555555555555" },
      targetId: "66666666-7777-8888-9999-aaaaaaaaaaaa",
    });
  });

  test("a claim row that another delivery already owns refuses the enqueue with no send", async () => {
    for (const state of ["queued", "consumed", "expired"] as const) {
      const { kv } = makeKvStub();
      const { queue, sent } = makeQueueStub();
      const log = makeLog();
      const db = createMigratedTestD1() as unknown as D1Database;
      insertClaim(db, state);

      const outcome = await handleReviewJob(mentionPayload(), { env: handlerEnv(kv, queue, db), log });

      expect(outcome, state).toEqual({ kind: "skipped", reason: "duplicate comment trigger" });
      expect(queue.send, state).not.toHaveBeenCalled();
      expect(sent, state).toHaveLength(0);
      expect(claimRows(db), state).toHaveLength(1);
    }
  });

  test("a non-conflict claim refusal propagates instead of being logged as a duplicate", async () => {
    const { kv } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();
    const db = createMigratedTestD1() as unknown as D1Database;
    (db as unknown as TestD1).raw.run(`
      CREATE TABLE comment_trigger_claims_v2 (
        installation_id INTEGER NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL, comment_id INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'consumed', 'expired')),
        payload_json TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        created_ms INTEGER NOT NULL, queued_ms INTEGER NOT NULL, consumed_ms INTEGER,
        origin TEXT NOT NULL,
        PRIMARY KEY (installation_id, owner, repo, pr_number, comment_id)
      );
      DROP TABLE comment_trigger_claims;
      ALTER TABLE comment_trigger_claims_v2 RENAME TO comment_trigger_claims;
    `);

    await expect(handleReviewJob(mentionPayload(), { env: handlerEnv(kv, queue, db), log })).rejects.toThrow(
      /NOT NULL/,
    );

    expect(queue.send).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(log.info).not.toHaveBeenCalled();
  });

  test("a failed send releases the claim so GitHub's retry enqueues again", async () => {
    const { kv } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();
    const db = createMigratedTestD1() as unknown as D1Database;
    const env = handlerEnv(kv, queue, db);
    queue.send.mockRejectedValueOnce(new Error("queue down"));

    await expect(handleReviewJob(mentionPayload(), { env, log })).rejects.toThrow("queue down");

    expect(claimRows(db)).toHaveLength(0);
    expect(sent).toHaveLength(0);

    const outcome = await handleReviewJob(mentionPayload(), { env, log });

    expect(outcome).toEqual({ kind: "enqueued" });
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
    expect(claimRows(db)).toHaveLength(1);
  });

  test("a different comment id on the same PR enqueues again", async () => {
    const { kv } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();
    const db = createMigratedTestD1() as unknown as D1Database;
    const env = handlerEnv(kv, queue, db);

    await handleReviewJob(mentionPayload(), { env, log });
    const outcome = await handleReviewJob(mentionPayload({ comment_id: COMMENT_ID + 1 }), { env, log });

    expect(outcome).toEqual({ kind: "enqueued" });
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(sent[1]?.comment_id).toBe(COMMENT_ID + 1);
    expect(claimRows(db)).toHaveLength(2);
  });
});

describe("handleReviewJob — send failure must not claim the KV key (C1)", () => {
  test("a failed send leaves no KV key and the retry enqueues again", async () => {
    const { kv, store } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();
    queue.send.mockRejectedValueOnce(new Error("queue down"));

    await expect(
      handleReviewJob(prPayload(), { env: handlerEnv(kv, queue), log }),
    ).rejects.toThrow("queue down");

    expect(store.size).toBe(0);
    expect(kv.put).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [warnFields, warnMsg] = log.warn.mock.calls[0] ?? [];
    expect(warnFields).toMatchObject({
      event: "pull_request",
      action: "opened",
      installation_id: 12345,
      owner: "acme",
      repo: "inspector",
      pr_number: 42,
      head_sha: HEAD_SHA,
    });
    expect(warnMsg).toContain("queue send failed");
    expect(warnMsg).toContain("queue down");

    const outcome = await handleReviewJob(prPayload(), { env: handlerEnv(kv, queue), log });

    expect(outcome).toEqual({ kind: "enqueued" });
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
    expect(store.size).toBe(1);
  });
});

describe("handleReviewJob — empty head_sha (product lock, I1)", () => {
  test('head_sha "" enqueues, never touches KV, and does not throw', async () => {
    const { kv, store } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();

    const outcome = await handleReviewJob(prPayload({ head_sha: "" }), {
      env: handlerEnv(kv, queue),
      log,
    });

    expect(outcome).toEqual({ kind: "enqueued" });
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(sent[0]?.head_sha).toBe("");
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  test('repeated head_sha "" deliveries always enqueue (never KV-skipped)', async () => {
    const { kv } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();

    await handleReviewJob(prPayload({ head_sha: "" }), { env: handlerEnv(kv, queue), log });
    const outcome = await handleReviewJob(prPayload({ head_sha: "" }), {
      env: handlerEnv(kv, queue),
      log,
    });

    expect(outcome).toEqual({ kind: "enqueued" });
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(2);
  });
});

describe("payload hygiene — no secrets", () => {
  test("every enqueued payload key is in the ReviewJobPayload contract (no token/secret fields)", async () => {
    const { kv } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();

    await handleReviewJob(prPayload(), { env: handlerEnv(kv, queue), log });
    await handleReviewJob(mentionPayload(), { env: handlerEnv(kv, queue), log });

    const allowed: Record<string, true> = {
      installation_id: true,
      owner: true,
      repo: true,
      pr_number: true,
      head_sha: true,
      comment_id: true,
      action: true,
      triggered_by: true,
      botRef: true,
      targetId: true,
    };
    for (const payload of sent) {
      for (const key of Object.keys(payload)) {
        expect(allowed[key], `unexpected payload key: ${key}`).toBe(true);
      }
    }
  });
});

describe("idempotencyHit", () => {
  test("returns true when the key already exists and never writes", async () => {
    const { kv, store } = makeKvStub();
    store.set("idem:1:a/b:2:sha", { value: "1" });
    const log = makeLog();

    const result = await idempotencyHit(kv, "idem:1:a/b:2:sha", {} as never, log);

    expect(result).toBe(true);
    expect(kv.put).not.toHaveBeenCalled();
  });

  test("returns false when the key is absent", async () => {
    const { kv } = makeKvStub();
    const log = makeLog();

    const result = await idempotencyHit(kv, "idem:1:a/b:2:sha", {} as never, log);

    expect(result).toBe(false);
    expect(kv.put).not.toHaveBeenCalled();
  });

  test("KV get failure returns false (conservative pass) and logs a warning", async () => {
    const { kv } = makeKvStub();
    kv.get.mockRejectedValueOnce(new Error("kv down"));
    const log = makeLog();

    const result = await idempotencyHit(kv, "idem:1:a/b:2:sha", {} as never, log);

    expect(result).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[1]).toContain("D1 fallback");
  });
});

describe("claimIdempotency", () => {
  test("writes the key with TTL", async () => {
    const { kv, store } = makeKvStub();
    const log = makeLog();

    await claimIdempotency(kv, "idem:1:a/b:2:sha", {} as never, log);

    expect(store.get("idem:1:a/b:2:sha")?.value).toBe("1");
    expect(store.get("idem:1:a/b:2:sha")?.expirationTtl).toBe(IDEMPOTENCY_SECONDS);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("KV put failure logs a warning and does not throw", async () => {
    const { kv } = makeKvStub();
    kv.put.mockRejectedValueOnce(new Error("kv write failed"));
    const log = makeLog();

    await claimIdempotency(kv, "idem:1:a/b:2:sha", {} as never, log);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[1]).toContain("D1 fallback");
  });
});

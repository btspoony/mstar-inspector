/**
 * Handler tests — idempotency pre-check + queue enqueue (plan 04 Task 2).
 * Mock env: in-memory KV stub + queue send recorder. No real bindings.
 *
 * Product lock (compass S4 / plan Clarify 4): a null `head_sha` must never
 * become a KV key and must always enqueue — `/review` commands are never
 * KV-skipped.
 */
import { describe, expect, mock, test, type Mock } from "bun:test";
import type { KVNamespace, Queue } from "@cloudflare/workers-types";
import { idemKey, IDEMPOTENCY_SECONDS } from "../../src/contracts/idem";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import { claimIdempotency, handleReviewJob, idempotencyHit, type HandlerLog } from "../../src/worker/handlers";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function prPayload(overrides: Partial<ReviewJobPayload> = {}): ReviewJobPayload {
  return {
    installation_id: 12345,
    owner: "acme",
    repo: "inspector",
    pr_number: 42,
    head_sha: HEAD_SHA,
    action: "opened",
    triggered_by: "pull_request",
    ...overrides,
  };
}

function reviewCommandPayload(overrides: Partial<ReviewJobPayload> = {}): ReviewJobPayload {
  return {
    installation_id: 12345,
    owner: "acme",
    repo: "inspector",
    pr_number: 42,
    head_sha: null,
    action: "created",
    triggered_by: "review_command",
    ...overrides,
  };
}

/** In-memory KV stub: get/put with TTL bookkeeping, optional failure injection. */
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

describe("handleReviewJob — enqueue once", () => {
  test("first delivery with a non-null head_sha enqueues exactly once and writes the KV key", async () => {
    const { kv, store } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();

    const outcome = await handleReviewJob(prPayload(), { env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue }, log });

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

  test("second delivery with the same non-null head_sha is skipped (put-if-absent) and not enqueued", async () => {
    const { kv } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();

    await handleReviewJob(prPayload(), { env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue }, log });
    log.info.mockClear();
    const outcome = await handleReviewJob(prPayload(), { env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue }, log });

    expect(outcome).toEqual({ kind: "skipped", reason: "idempotency hit" });
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(log.info.mock.calls[0]?.[1]).toContain("idempotency hit");
  });

  test("a different head_sha on the same PR is a different key and enqueues", async () => {
    const { kv } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();

    await handleReviewJob(prPayload(), { env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue }, log });
    const outcome = await handleReviewJob(
      prPayload({ head_sha: "ffffffffffffffffffffffffffffffffffffffff" }),
      { env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue }, log },
    );

    expect(outcome).toEqual({ kind: "enqueued" });
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(sent[1]?.head_sha).toBe("ffffffffffffffffffffffffffffffffffffffff");
  });
});

describe("handleReviewJob — null head_sha (product lock)", () => {
  test("null head_sha enqueues and never writes a KV key", async () => {
    const { kv, store } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();

    const outcome = await handleReviewJob(reviewCommandPayload(), {
      env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue },
      log,
    });

    expect(outcome).toEqual({ kind: "enqueued" });
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(sent[0]).toEqual(reviewCommandPayload());
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    expect(log.info.mock.calls[0]?.[0]).toMatchObject({
      event: "issue_comment",
      action: "created",
      head_sha: null,
    });
  });

  test("repeated /review commands always enqueue (never KV-skipped)", async () => {
    const { kv } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();

    await handleReviewJob(reviewCommandPayload(), { env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue }, log });
    const outcome = await handleReviewJob(reviewCommandPayload(), {
      env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue },
      log,
    });

    expect(outcome).toEqual({ kind: "enqueued" });
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(2);
  });
});

describe("handleReviewJob — send failure must not claim the KV key (C1)", () => {
  test("a failed send leaves no KV key and the retry enqueues again", async () => {
    const { kv, store } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();
    queue.send.mockRejectedValueOnce(new Error("queue down"));

    await expect(
      handleReviewJob(prPayload(), { env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue }, log }),
    ).rejects.toThrow("queue down");

    // No key was claimed — the retry must not be KV-skipped.
    expect(store.size).toBe(0);
    expect(kv.put).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);

    // The failure path logs the seven-field structured event (QC F-002) so
    // the operator can map the 500 to the specific event.
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

    const outcome = await handleReviewJob(prPayload(), { env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue }, log });

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
      env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue },
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

    await handleReviewJob(prPayload({ head_sha: "" }), { env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue }, log });
    const outcome = await handleReviewJob(prPayload({ head_sha: "" }), {
      env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue },
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

    await handleReviewJob(prPayload(), { env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue }, log });
    await handleReviewJob(reviewCommandPayload(), { env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue }, log });

    const allowed: Record<string, true> = {
      installation_id: true,
      owner: true,
      repo: true,
      pr_number: true,
      head_sha: true,
      action: true,
      triggered_by: true,
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

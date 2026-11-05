/**
 * Handler tests — idempotency pre-check, durable comment claim, queue enqueue.
 * Mock env: in-memory KV stub + queue send recorder + a migrated D1 double
 * carrying the REAL `comment_trigger_claims` DDL (migration 0048).
 *
 * Product lock (compass S4 / plan T1): a null `head_sha` must never become a
 * KV key. A bot-mention job claims its `comment_id` in D1 BEFORE the send, so
 * one comment id triggers at most one review even when the KV fast path misses
 * (TTL lapse, concurrency); a job with no comment id enqueues unclaimed.
 */
import { describe, expect, mock, test, type Mock } from "bun:test";
import type { D1Database, KVNamespace, Queue } from "@cloudflare/workers-types";
import { idemKey, IDEMPOTENCY_SECONDS } from "../../src/contracts/idem";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import { claimIdempotency, handleReviewJob, idempotencyHit, type HandlerDeps, type HandlerLog } from "../../src/worker/handlers";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
/** The `issue_comment` id a mention job claims its idempotency on. */
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
    // Required single shape — a reference, never a credential.
    appRef: { appId: "11111111-2222-3333-4444-555555555555" },
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
    // The comment trigger's identity — the only claim a no-sha job can make.
    comment_id: COMMENT_ID,
    action: "created",
    triggered_by: "issue_comment",
    appRef: { appId: "11111111-2222-3333-4444-555555555555" },
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

/**
 * Handler deps with all three required bindings; `db` is injectable. The
 * default DB is a migrated double: the REAL `comment_trigger_claims` DDL, so
 * the claim insert behaves exactly as it does in production.
 */
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

/** Seed a claim row in the given state — the "another delivery already owns it" case. */
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
    // `dropped` = the guard gave the job up for good; `failed` = the final
    // delivery is heading to the DLQ; `paused` = the App is paused; `degraded`
    // = the run ended in a degraded notice; `superseded` = a newer commit
    // overtook this sha when it was acked, so THIS sha was never reviewed.
    // None is "already enqueued", so the redelivery must enqueue again rather
    // than be KV-skipped — a force-push back to the sha (A → B → A) depends on
    // it, since the skip that wrote the claim no longer fires (the ledger's
    // head is that sha again).
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
    // `done` = this consumer already posted the review, so a redelivery is
    // pure duplicate cost. `superseded` is deliberately NOT here — see above.
    const key = idemKey({ installation_id: 12345, owner: "acme", repo: "inspector", pr_number: 42, head_sha: HEAD_SHA });
    const value = "done";
    const { kv, store } = makeKvStub();
    store.set(key, { value });
    const { queue, sent } = makeQueueStub();
    const log = makeLog();

    const outcome = await handleReviewJob(prPayload(), { env: handlerEnv(kv, queue), log });

    expect(outcome).toEqual({ kind: "skipped", reason: "idempotency hit" });
    expect(sent).toHaveLength(0);
    // A skip never rewrites the claim.
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

    // 1) KV fast path: the 24h comment claim is present, so the second
    // delivery never reaches the insert.
    const fastPath = await handleReviewJob(mentionPayload(), { env, log });
    expect(fastPath).toEqual({ kind: "skipped", reason: "idempotency hit" });
    expect(log.info.mock.calls[0]?.[1]).toContain("idempotency hit");

    // 2) Durable claim: drop the KV entry (TTL lapse / another isolate / a
    // concurrent delivery) and the row alone must still refuse it.
    store.clear();
    log.info.mockClear();
    const outcome = await handleReviewJob(mentionPayload(), { env, log });

    expect(outcome).toEqual({ kind: "skipped", reason: "duplicate comment trigger" });
    expect(log.info.mock.calls[0]?.[1]).toContain("duplicate comment trigger");
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);

    const [row] = claimRows(db);
    expect(row).toMatchObject({ state: "queued", attempts: 0, consumed_ms: null });
    // The stored payload is the outbox record the sweep re-sends.
    expect(JSON.parse(row!.payload_json)).toMatchObject({
      comment_id: COMMENT_ID,
      triggered_by: "issue_comment",
      appRef: { appId: "11111111-2222-3333-4444-555555555555" },
    });
  });

  test("a claim row that another delivery already owns refuses the enqueue with no send", async () => {
    // The concurrency case: D1 serializes the PRIMARY KEY insert, so whichever
    // delivery loses sees `changes === 0` whatever state the winner left.
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
      // The winner's row is never rewritten by the losing delivery.
      expect(claimRows(db), state).toHaveLength(1);
    }
  });

  test("a non-conflict claim refusal propagates instead of being logged as a duplicate", async () => {
    const { kv } = makeKvStub();
    const { queue, sent } = makeQueueStub();
    const log = makeLog();
    const db = createMigratedTestD1() as unknown as D1Database;
    // The scenario `INSERT OR IGNORE` hid: a later migration adds a NOT NULL
    // column the worker cannot fill. Only a duplicate key is suppressed now, so
    // this refusal reaches the handler's uncaught-D1 path (500 → GitHub retry)
    // instead of a silent drop with a misleading "duplicate" log.
    (db as unknown as TestD1).raw.exec(`
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

    // Nothing is left behind: no claim row, no KV key, no message.
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
      // The comment trigger's identity (issue_comment jobs only).
      comment_id: true,
      action: true,
      triggered_by: true,
      // The App attribution reference — an id, never a secret.
      appRef: true,
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

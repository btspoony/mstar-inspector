import { beforeEach, describe, expect, test } from "bun:test";

import "../helpers/cloudflare-workers-mock";

import type { ReviewJobPayload } from "../../src/contracts/review-job";
import { createSeededTestD1, TEST_OWNER, TEST_REPO } from "../helpers/consumer-fixtures";
import { createConsumerHarness, failureRows, makePayload } from "../helpers/consumer-harness";
import { acquireInflight } from "../../src/store/inflight-store";
import {
  guardDropDedupeKeyOf,
  listOwedSuccessors,
  markSuccessorDelivered,
  recordGuardDropIntent,
  successorGeneration,
} from "../../src/store/review-route-store";
import { reconcileReviewRoute } from "../../src/pipeline/route-reconcile";
import type { AttemptRef } from "../../src/pipeline/review-attempt-execution";
import type { TestD1 } from "../store/helpers";
const routeKv = { get: async () => null, put: async () => {}, delete: async () => {} };

const { createReviewConsumer } = await import("../../src/pipeline/consumer");

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

const PR = { installation_id: 123, owner: TEST_OWNER, repo: TEST_REPO, pr_number: 42, workspace_id: "default" };

async function seedLiveHolder(db: TestD1, headSha: string): Promise<void> {
  const acquired = await acquireInflight(db as never, PR, {
    systemCap: 32,
    workspaceCap: 16,
    attemptId: "holder-attempt",
    ttlSeconds: 1_320,
    headSha,
    now: new Date().toISOString(),
  });
  expect(acquired).toEqual({ ok: true });
}

describe("claim 8 — a dropped retry is owed, never ack-and-forget", () => {
  test("the terminal guard drop records the retry the reconciler owes", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload({ head_sha: "1111111111111111111111111111111111111111" });
    await seedLiveHolder(db, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    h.queueState.attempts = 6;
    const started: AttemptRef[] = [];
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      {
        ...h.overrides,
        startAttempt: async (_deps, ref) => {
          started.push(ref);
        },
      },
    );

    await consumer(h.makeBatch(payload));

    expect(started).toHaveLength(0);
    expect(h.messageAckCalls).toHaveLength(1);
    expect(failureRows(db)).toHaveLength(1);

    const owed = await listOwedSuccessors(db as never, 10);
    expect(owed).toHaveLength(1);
    expect(owed[0]!.payload.head_sha).toBe(payload.head_sha);

    const sent: ReviewJobPayload[] = [];
    await reconcileReviewRoute(
      {
        DB: db as never,
        IDEMPOTENCY_KV: routeKv as never,
        REVIEW_QUEUE: { send: async (message: ReviewJobPayload) => void sent.push(message) } as never,
      },
      Date.now(),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.head_sha).toBe(payload.head_sha);
    await reconcileReviewRoute(
      {
        DB: db as never,
        IDEMPOTENCY_KV: routeKv as never,
        REVIEW_QUEUE: { send: async (message: ReviewJobPayload) => void sent.push(message) } as never,
      },
      Date.now() + 1_000,
    );
    expect(sent).toHaveLength(1);
  });

  test("a lost comment-triggered delivery is handed back with its claim, so the owed retry can run", async () => {
    const db = await createSeededTestD1();
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
         VALUES ('review.concurrency.system', '1', datetime('now'), 'tester')`,
      )
      .run();
    await acquireInflight(
      db as never,
      { ...PR, pr_number: 7, workspace_id: "other" },
      {
        systemCap: 1,
        workspaceCap: 16,
        attemptId: "other-pr",
        ttlSeconds: 1_320,
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        now: new Date().toISOString(),
      },
    );
    const payload = makePayload({
      head_sha: null,
      action: "created",
      triggered_by: "issue_comment",
      comment_id: 9400,
    });
    db.raw
      .prepare(
        `INSERT INTO comment_trigger_claims
           (installation_id, owner, repo, pr_number, comment_id, state, payload_json, attempts, created_ms, queued_ms)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, 1, 1)`,
      )
      .run(payload.installation_id, payload.owner, payload.repo, payload.pr_number, 9400, JSON.stringify(payload));
    h.queueState.attempts = 6;
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      startAttempt: async () => {},
    });

    await consumer(h.makeBatch(payload));

    const claim = db.raw.query("SELECT state, payload_json FROM comment_trigger_claims").get() as {
      state: string;
      payload_json: string | null;
    };
    expect(claim.state).toBe("queued");
    expect(JSON.parse(claim.payload_json!)).toEqual(payload);
    expect(await listOwedSuccessors(db as never, 10)).toHaveLength(1);

    const sent: ReviewJobPayload[] = [];
    await reconcileReviewRoute(
      {
        DB: db as never,
        IDEMPOTENCY_KV: routeKv as never,
        REVIEW_QUEUE: { send: async (message: ReviewJobPayload) => void sent.push(message) } as never,
      },
      Date.now(),
    );
    expect(sent).toHaveLength(1);
    const started: AttemptRef[] = [];
    db.raw.prepare("DELETE FROM review_inflight").run();
    const retryConsumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      startAttempt: async (_deps, ref) => {
        started.push(ref);
      },
    });
    await retryConsumer(h.makeBatch(sent[0]!));
    expect(started).toHaveLength(1);
    expect((db.raw.query("SELECT state FROM comment_trigger_claims").get() as { state: string }).state).toBe(
      "consumed",
    );
  });

  test("a drop whose obligation cannot be written refuses to ack", async () => {
    const db = await createSeededTestD1();
    await seedLiveHolder(db, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    h.queueState.attempts = 6;
    const failing = {
      prepare(query: string) {
        if (!/INSERT INTO\s+review_successors/.test(query)) return db.prepare(query);
        const reject = Promise.withResolvers<never>();
        reject.reject(new Error("D1 unavailable"));
        return {
          bind() {
            return this;
          },
          first: async () => null,
          all: async () => ({ results: [] }),
          run: () => reject.promise,
        };
      },
    };
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: failing as never }),
      h.testLog,
      { ...h.overrides, startAttempt: async () => {} },
    );

    await expect(
      consumer(h.makeBatch(makePayload({ head_sha: "1111111111111111111111111111111111111111" }))),
    ).rejects.toThrow(/D1 unavailable/);

    expect(h.messageAckCalls).toHaveLength(0);
    expect(failureRows(db)).toHaveLength(0);
    expect(await listOwedSuccessors(db as never, 10)).toHaveLength(0);
  });

  test("a later drop of the same delivery re-arms its delivered row", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload({ head_sha: "1111111111111111111111111111111111111111" });
    await seedLiveHolder(db, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    h.queueState.attempts = 6;
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      startAttempt: async () => {},
    });

    await consumer(h.makeBatch(payload));
    const sent: ReviewJobPayload[] = [];
    const env = {
      DB: db as never,
      IDEMPOTENCY_KV: routeKv as never,
      REVIEW_QUEUE: { send: async (message: ReviewJobPayload) => void sent.push(message) } as never,
    };
    await reconcileReviewRoute(env, Date.now());
    expect(sent).toHaveLength(1);
    expect(await listOwedSuccessors(db as never, 10)).toHaveLength(0);

    await consumer(h.makeBatch(payload));
    expect(await listOwedSuccessors(db as never, 10)).toHaveLength(1);
    await reconcileReviewRoute(env, Date.now() + 1_000);
    expect(sent).toHaveLength(2);
  });

  test("a re-arm during a send is not buried by that send's delivered mark", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload({ head_sha: "1111111111111111111111111111111111111111" });
    const dedupeKey = guardDropDedupeKeyOf(payload);
    const first = await recordGuardDropIntent(db as never, { dedupeKey, payload, nowMs: 1 });
    expect(first.generation).toBe(1);

    const sent: ReviewJobPayload[] = [];
    const env = {
      DB: db as never,
      IDEMPOTENCY_KV: routeKv as never,
      REVIEW_QUEUE: {
        send: async (message: ReviewJobPayload) => {
          sent.push(message);
          await recordGuardDropIntent(db as never, { dedupeKey, payload: message, nowMs: 2 });
        },
      } as never,
    };
    await reconcileReviewRoute(env, Date.now());

    expect(await successorGeneration(db as never, dedupeKey)).toBe(2);
    const owed = await listOwedSuccessors(db as never, 10);
    expect(owed).toHaveLength(1);
    expect(owed[0]!.generation).toBe(2);
    expect(await markSuccessorDelivered(db as never, dedupeKey, 1, Date.now())).toBe(false);

    await reconcileReviewRoute(env, Date.now() + 1_000);
    expect(sent).toHaveLength(2);
    expect(await successorGeneration(db as never, dedupeKey)).toBe(3);
    expect(await listOwedSuccessors(db as never, 10)).toHaveLength(1);
  });
});

describe("claim 8 — an unknown paid state holds the PR and its capacity", () => {
  test("an expired lease whose paid exec is unaccounted for is not replaced", async () => {
    const db = await createSeededTestD1();
    const expired = await acquireInflight(db as never, PR, {
      systemCap: 32,
      workspaceCap: 16,
      attemptId: "paid-unknown",
      ttlSeconds: 60,
      headSha: "2222222222222222222222222222222222222222",
      now: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect(expired).toEqual({ ok: true });
    db.raw
      .prepare(
        `INSERT INTO review_launches (attempt_id, state, claimed_at_ms, launched_at_ms)
         VALUES (?, 'launched', ?, ?)`,
      )
      .run("paid-unknown", Date.now() - 3_500_000, Date.now() - 3_400_000);

    const started: AttemptRef[] = [];
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      {
        ...h.overrides,
        startAttempt: async (_deps, ref) => {
          started.push(ref);
        },
      },
    );

    await consumer(h.makeBatch(makePayload({ head_sha: "3333333333333333333333333333333333333333" })));
    expect(started).toHaveLength(0);
    expect(h.messageRetryCalls).toHaveLength(1);
    const holder = db.raw.prepare("SELECT attempt_id FROM review_inflight").get() as { attempt_id: string };
    expect(holder.attempt_id).toBe("paid-unknown");
  });

  test("the unknown attempt's capacity is counted, so another PR is refused too", async () => {
    const db = await createSeededTestD1();
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
         VALUES ('review.concurrency.system', '1', datetime('now'), 'tester')`,
      )
      .run();
    const expired = await acquireInflight(db as never, PR, {
      systemCap: 1,
      workspaceCap: 16,
      attemptId: "paid-unknown",
      ttlSeconds: 60,
      headSha: "2222222222222222222222222222222222222222",
      now: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect(expired).toEqual({ ok: true });
    db.raw
      .prepare(
        `INSERT INTO review_launches (attempt_id, state, claimed_at_ms, launched_at_ms)
         VALUES (?, 'launched', ?, ?)`,
      )
      .run("paid-unknown", Date.now() - 3_500_000, Date.now() - 3_400_000);

    const started: AttemptRef[] = [];
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      {
        ...h.overrides,
        startAttempt: async (_deps, ref) => {
          started.push(ref);
        },
      },
    );

    await consumer(h.makeBatch(makePayload({ head_sha: "4444444444444444444444444444444444444444", pr_number: 99 })));
    expect(started).toHaveLength(0);
    expect(h.messageRetryCalls).toHaveLength(1);
    const rows = db.raw.query("SELECT attempt_id FROM review_inflight").all() as Array<{ attempt_id: string }>;
    expect(rows.map((row) => row.attempt_id)).toEqual(["paid-unknown"]);
  });
});

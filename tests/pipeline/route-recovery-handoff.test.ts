import { beforeEach, describe, expect, test } from "bun:test";

import "../helpers/cloudflare-workers-mock";

import type { ReviewJobPayload } from "../../src/contracts/review-job";
import { createSeededTestD1 } from "../helpers/consumer-fixtures";
import type { TestD1 } from "../store/helpers";
import { createConsumerHarness, failureRows, makePayload } from "../helpers/consumer-harness";
import {
  deliveryKeyOf,
  markAttemptHandoff,
  readAttemptHandoff,
  reserveAttemptHandoff,
} from "../../src/store/review-route-store";
import { reconcileReviewRoute } from "../../src/pipeline/route-reconcile";
import type { AttemptRef } from "../../src/pipeline/review-attempt-execution";
const routeKv = { get: async () => null, put: async () => {}, delete: async () => {} };

const { createReviewConsumer, createWorkflowInstance } = await import("../../src/pipeline/consumer");

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

function commentPayload(commentId: number): ReviewJobPayload {
  return makePayload({ head_sha: null, action: "created", triggered_by: "issue_comment", comment_id: commentId });
}

function seedCommentClaim(
  db: TestD1,
  payload: ReviewJobPayload,
  commentId: number,
  state: "queued" | "consumed",
  keepPayload: boolean,
): void {
  db.raw
    .prepare(
      `INSERT INTO comment_trigger_claims
         (installation_id, owner, repo, pr_number, comment_id, state, payload_json, attempts, created_ms, queued_ms, consumed_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?)`,
    )
    .run(
      payload.installation_id,
      payload.owner,
      payload.repo,
      payload.pr_number,
      commentId,
      state,
      keepPayload ? JSON.stringify(payload) : null,
      state === "consumed" ? 1 : null,
    );
}

function claimRow(db: TestD1) {
  return db.raw.query("SELECT state, consumed_ms, payload_json FROM comment_trigger_claims").get() as {
    state: string;
    consumed_ms: number | null;
    payload_json: string | null;
  };
}

function recordingStarter() {
  const started: AttemptRef[] = [];
  return {
    started,
    startAttempt: async (_deps: unknown, ref: AttemptRef) => {
      started.push(ref);
    },
  };
}

describe("claim 1 — a consumed claim never strands a recorded attempt", () => {
  test("a redelivery that finds an owed handoff reaches create instead of acking on the consumed claim", async () => {
    const db = await createSeededTestD1();
    const payload = commentPayload(9100);
    const key = deliveryKeyOf(payload);
    seedCommentClaim(db, payload, 9100, "consumed", false);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: key,
      attemptId: "attempt-recovered",
      payload,
      nowMs: 1_000,
      enqueuedMs: 0,
      deadlineMs: Date.now() + 600_000,
    });
    expect((await readAttemptHandoff(db as never, key))?.state).toBe("owed");

    const sent: ReviewJobPayload[] = [];
    await reconcileReviewRoute(
      {
        DB: db as never,
        IDEMPOTENCY_KV: routeKv as never,
        REVIEW_QUEUE: { send: async (message: ReviewJobPayload) => void sent.push(message) } as never,
      },
      1_000 + 5 * 60_000 + 1,
    );
    expect(sent).toHaveLength(1);

    const route = recordingStarter();
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      { ...h.overrides, startAttempt: route.startAttempt },
    );
    await consumer(h.makeBatch(sent[0]!));

    expect(route.started).toHaveLength(1);
    expect(route.started[0]!.attemptId).toBe("attempt-recovered");
    expect(h.messageAckCalls).toHaveLength(1);
    expect(h.sandbox.calls).toHaveLength(0);
    expect((await readAttemptHandoff(db as never, key))?.state).toBe("created");
  });

  test("an ambiguous handoff is replayed the same way, and a failed one too", async () => {
    for (const state of ["ambiguous", "failed"] as const) {
      h = createConsumerHarness();
      const db = await createSeededTestD1();
      const payload = commentPayload(9200 + (state === "ambiguous" ? 0 : 1));
      const key = deliveryKeyOf(payload);
      seedCommentClaim(db, payload, payload.comment_id!, "consumed", false);
      await reserveAttemptHandoff(db as never, {
        deliveryKey: key,
        attemptId: `attempt-${state}`,
        payload,
        nowMs: 1_000,
        enqueuedMs: 0,
        deadlineMs: Date.now() + 600_000,
      });
      await markAttemptHandoff(db as never, key, state, 1_000);

      const route = recordingStarter();
      const consumer = createReviewConsumer(
        await h.makeEnv({ DB: db as never }),
        h.testLog,
        { ...h.overrides, startAttempt: route.startAttempt },
      );
      await consumer(h.makeBatch(payload));

      expect(route.started.map((ref) => ref.attemptId)).toEqual([`attempt-${state}`]);
      expect((await readAttemptHandoff(db as never, key))?.state).toBe("created");
    }
  });

  test("a host killed after consuming the claim and before the handoff leaves a row the reconciler hands back", async () => {
    const db = await createSeededTestD1();
    const payload = commentPayload(9300);
    seedCommentClaim(db, payload, 9300, "queued", true);

    const reached = Promise.withResolvers<void>();
    const consumer = createReviewConsumer(
      await h.makeEnv({
        DB: {
          prepare(query: string) {
            const statement = db.prepare(query);
            if (!/INSERT INTO\s+review_attempt_handoffs/.test(query)) return statement;
            reached.resolve();
            const hang = Promise.withResolvers<never>();
            return {
              bind() {
                return this;
              },
              first: <T>() => statement.first<T>(),
              all: <T>() => statement.all<T>(),
              run: () => hang.promise,
            };
          },
        } as never,
      }),
      h.testLog,
      h.overrides,
    );
    const abandoned = consumer(h.makeBatch(payload));
    abandoned.catch(() => {});

    await reached.promise;

    expect(claimRow(db)).toMatchObject({ state: "consumed" });
    expect(JSON.parse(claimRow(db).payload_json!)).toEqual(payload);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_attempt_handoffs").get()).toEqual({ n: 0 });

    const sent: ReviewJobPayload[] = [];
    const env = {
      DB: db as never,
      IDEMPOTENCY_KV: routeKv as never,
      REVIEW_QUEUE: { send: async (message: ReviewJobPayload) => void sent.push(message) } as never,
    };
    const killedAt = Date.now();
    await reconcileReviewRoute(env, killedAt);
    expect(sent).toHaveLength(0);
    await reconcileReviewRoute(env, killedAt + 5 * 60_000 + 1);
    expect(sent).toHaveLength(1);
    await reconcileReviewRoute(env, killedAt + 10 * 60_000);
    expect(sent).toHaveLength(1);
    expect(claimRow(db).state).toBe("queued");

    db.raw.prepare("DELETE FROM review_inflight").run();
    const route = recordingStarter();
    const replay = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      { ...h.overrides, startAttempt: route.startAttempt },
    );
    await replay(h.makeBatch(sent[0]!));
    expect(route.started).toHaveLength(1);
    expect(claimRow(db)).toMatchObject({ state: "consumed", payload_json: null });
  });
});

describe("claim 5 — error classification carries proof", () => {
  test("a TypeError from create is unknown, not a definite non-acceptance", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      {
        ...h.overrides,
        startAttempt: (_deps, ref) =>
          createWorkflowInstance(
            {
              create: async () => {
                throw new TypeError("Illegal invocation");
              },
              get: async () => {
                throw new Error("instance not found");
              },
            } as never,
            ref,
          ),
      },
    );

    await consumer(h.makeBatch(payload));

    expect(h.messageAckCalls).toHaveLength(1);
    expect(h.messageRetryCalls).toHaveLength(0);
    expect(failureRows(db)).toHaveLength(0);
    expect((await readAttemptHandoff(db as never, deliveryKeyOf(payload)))?.state).toBe("ambiguous");
  });

  test("an 'already exists' message is not proof of THIS attempt's instance", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      {
        ...h.overrides,
        startAttempt: (_deps, ref) =>
          createWorkflowInstance(
            {
              create: async () => {
                throw new Error("A Workflow instance with that ID already exists");
              },
              get: async () => {
                throw new Error("instance not found");
              },
            } as never,
            ref,
          ),
      },
    );

    await consumer(h.makeBatch(payload));

    expect((await readAttemptHandoff(db as never, deliveryKeyOf(payload)))?.state).toBe("ambiguous");
    expect(h.messageAckCalls).toHaveLength(1);
    expect(h.messageRetryCalls).toHaveLength(0);
    expect(failureRows(db)).toHaveLength(0);
  });

  test("the instance is confirmed only by reading this attempt's own id back", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    let probed: string | undefined;
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      {
        ...h.overrides,
        startAttempt: (_deps, ref) =>
          createWorkflowInstance(
            {
              create: async () => {
                throw new Error("A Workflow instance with that ID already exists");
              },
              get: async (id: string) => {
                probed = id;
                return { status: async () => ({ status: "running" }) };
              },
            } as never,
            ref,
          ),
      },
    );

    await consumer(h.makeBatch(payload));

    const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(payload));
    expect(probed).toBe(handoff?.attemptId);
    expect(handoff?.state).toBe("created");
    expect(h.messageAckCalls).toHaveLength(1);
  });

  test("an absent Queue send stamp is recorded as absent, never invented", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const batch = h.makeBatch(payload);
    const message = batch.messages[0]!;
    const unstamped = message as unknown as { timestamp?: Date | null };
    unstamped.timestamp = null;

    const route = recordingStarter();
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      { ...h.overrides, startAttempt: route.startAttempt },
    );
    await consumer(batch);

    expect(route.started).toHaveLength(1);
    expect((await readAttemptHandoff(db as never, deliveryKeyOf(payload)))?.enqueuedMs).toBeNull();
  });
});

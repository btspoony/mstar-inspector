/**
 * Route recovery claims 1 and 5 — the consumer's side of the handoff.
 *
 * 1. A comment-triggered delivery whose claim was already consumed can still be
 *    recovered: a redelivery that finds an `owed`/`ambiguous` handoff must not
 *    be stopped by the consumed comment claim, and an interruption after
 *    consuming the claim but BEFORE writing the handoff must leave something
 *    the reconciler can find.
 * 5. Error classification carries proof: a `TypeError` is not evidence that a
 *    create did not land, and an "already exists" message is not evidence that
 *    the same instance exists — either find a fact that does, or treat it as
 *    unknown.
 *
 * Every case simulates the interruption (or the lying error) rather than the
 * happy path: the pre-fix code acks a stranded comment delivery, records a
 * TypeError as a definite failure, and confirms "already exists" from a string.
 */
import { beforeEach, describe, expect, test } from "bun:test";

// Load shim FIRST: the consumer module statically imports ./sandbox → the
// workerd builtin `cloudflare:workers`, which Bun's runner cannot resolve. A
// static import would be HOISTED above the shim, so the module graph under test
// is loaded dynamically on purpose (the same reason every suite here does).
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

const { createReviewConsumer, createWorkflowInstance } = await import("../../src/pipeline/consumer");

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

/** The payload of a comment-triggered delivery (no commit of its own). */
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
    // The original delivery consumed the comment claim and wrote the handoff,
    // then the host died before the instance was created.
    seedCommentClaim(db, payload, 9100, "consumed", false);
    await reserveAttemptHandoff(db as never, {
      deliveryKey: key,
      attemptId: "attempt-recovered",
      payload,
      nowMs: 1_000,
      deadlineMs: Date.now() + 600_000,
    });
    expect((await readAttemptHandoff(db as never, key))?.state).toBe("owed");

    // The recovery pass re-enqueues the recorded payload.
    const sent: ReviewJobPayload[] = [];
    await reconcileReviewRoute(
      {
        DB: db as never,
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

    // The same attempt is replayed: the consumed claim is not a second claim.
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

  test("an interruption after consuming the claim leaves a row the reconciler hands back", async () => {
    const db = await createSeededTestD1();
    const payload = commentPayload(9300);
    // The host died between consuming the claim and writing the handoff: the
    // claim row is the only record, and it still carries the payload.
    seedCommentClaim(db, payload, 9300, "consumed", true);

    const sent: ReviewJobPayload[] = [];
    const env = {
      DB: db as never,
      REVIEW_QUEUE: { send: async (message: ReviewJobPayload) => void sent.push(message) } as never,
    };
    // Too fresh: a live delivery may still be writing its handoff.
    await reconcileReviewRoute(env, 2_000);
    expect(sent).toHaveLength(0);

    await reconcileReviewRoute(env, 1_000 + 5 * 60_000 + 1);
    expect(sent).toHaveLength(1);
    expect(deliveryKeyOf(sent[0]!)).toBe(deliveryKeyOf(payload));
    // The hand-back is a state transition: a second pass sends nothing.
    await reconcileReviewRoute(env, 1_000 + 10 * 60_000);
    expect(sent).toHaveLength(1);
    expect(claimRow(db).state).toBe("queued");

    // The re-delivery runs the review and the claim becomes consumed again,
    // this time with the payload dropped (the handoff row owns recovery).
    const route = recordingStarter();
    const consumer = createReviewConsumer(
      await h.makeEnv({ DB: db as never }),
      h.testLog,
      { ...h.overrides, startAttempt: route.startAttempt },
    );
    await consumer(h.makeBatch(sent[0]!));
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
              // The catch surrounds an async call: a TypeError can be raised
              // while processing a reply the platform already accepted.
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

    // Acked, never retried: the instance MAY exist. Nothing claims the create
    // did not land — no failure row, no definite-failure settlement.
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
              // The message names no id, and this attempt's id is not there.
              get: async () => {
                throw new Error("instance not found");
              },
            } as never,
            ref,
          ),
      },
    );

    await consumer(h.makeBatch(payload));

    // Not recorded as created: the handoff stays recoverable instead of the
    // delivery being acked as if an instance owned the attempt.
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
    // The fact, not the message: the probe ran against the recorded attempt id
    // and its answer recorded the create as landed.
    expect(probed).toBe(handoff?.attemptId);
    expect(handoff?.state).toBe("created");
    expect(h.messageAckCalls).toHaveLength(1);
  });
});

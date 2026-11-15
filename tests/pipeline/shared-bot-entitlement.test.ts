/**
 * The shared-bot enqueue refusal: the webhook face's admission gate on a
 * delivery whose target's plan lost the capability.
 *
 * Pinned here, in the order the product fixes:
 *   - NO queue send, so no consumer starts and nothing is spent
 *     (`usage_events` stays empty);
 *   - NO KV idempotency key and NO `comment_trigger_claims` row, so the cron
 *     sweep has no outbox record to re-send — the refusal cannot come back;
 *   - the Check is still attached through the pre-enqueue hook, and the row it
 *     attached is settled `neutral` with THIS delivery's attach identity and
 *     the one skip reason;
 *   - ONE terminal `entitlement` failure row whose `error` is the identical
 *     sentence the Check carries;
 *   - a bot-mention delivery (no head SHA) settles nothing and records
 *     `head_sha: ""`.
 *
 * The fixture is the fully-migrated D1 double; the Check settlement is a spy
 * here because the store-only lifecycle it calls is pinned by
 * `tests/pipeline/checks.test.ts`.
 */
import { describe, expect, mock, test } from "bun:test";
import type { D1Database, KVNamespace, Queue } from "@cloudflare/workers-types";
import {
  SHARED_BOT_ENTITLEMENT_SKIP_REASON,
  SHARED_BOT_ENTITLEMENT_STAGE,
} from "../../src/contracts/failure-stages";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { SharedBotRefusal } from "../../src/dashboard/entitlement";
import { CHECK_SUMMARIES } from "../../src/pipeline/checks";
import { handleReviewJob, type HandlerDeps } from "../../src/worker/handlers";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const WS = "default";
const APP_ID = "11111111-2222-3333-4444-555555555555";
const GITHUB_APP_ID = 7101;
const TARGET_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const INSTALLATION_ID = 12345;
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** The verdict the route computes and hands to the handler. */
const REFUSAL: SharedBotRefusal = { kind: "shared-bot-not-included", planId: "free" };

type SettleInput = Parameters<NonNullable<HandlerDeps["settleSkipped"]>>[0];

/** The one failure read both cases make. */
const FAILURE_SQL = "SELECT * FROM review_failures ORDER BY rowid";

function payload(overrides: Partial<ReviewJobPayload> = {}): ReviewJobPayload {
  return {
    installation_id: INSTALLATION_ID,
    owner: "acme",
    repo: "widgets",
    pr_number: 7,
    head_sha: SHA,
    action: "opened",
    triggered_by: "pull_request",
    botRef: { appId: APP_ID },
    targetId: TARGET_ID,
    ...overrides,
  };
}

/** One bot and its target in the default workspace (the failure row's FK). */
function seedReviewConfig(db: TestD1): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
          status, deleted_at, created_at, updated_at)
       VALUES (?, ?, 'shared-bot-test', 'enc', 'enc', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(APP_ID, GITHUB_APP_ID);
  db.raw
    .prepare(
      `INSERT INTO review_targets (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'shared-bot-test', 'tester', datetime('now'), datetime('now'))`,
    )
    .run(TARGET_ID, WS, APP_ID);
}

function makeKv() {
  const get = mock(async () => null);
  const put = mock(async () => {});
  return {
    kv: { get, put } as unknown as KVNamespace & { get: typeof get; put: typeof put },
    get,
    put,
  };
}

function makeQueue() {
  const send = mock(async () => {});
  return { queue: { send } as unknown as Queue<ReviewJobPayload> & { send: typeof send }, send };
}

function countRows(db: TestD1, table: string): number {
  return (db.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

type FailureRow = {
  target_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  stage: string;
  error: string;
};

/** The deps the route assembles: the attach hook plus the settlement seam. */
function handlerDeps(
  db: TestD1,
  kv: KVNamespace,
  queue: Queue<ReviewJobPayload>,
  settleSkipped: HandlerDeps["settleSkipped"],
  attach: HandlerDeps["beforeEnqueue"],
): HandlerDeps {
  return {
    env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue, DB: db as unknown as D1Database },
    log: { info: () => {}, warn: () => {} },
    beforeEnqueue: attach,
    settleSkipped,
  };
}

describe("handleReviewJob — a shared-bot refusal", () => {
  test("skips terminally: no send, no claim, neutral Check, one entitlement failure", async () => {
    const db = createMigratedTestD1();
    seedReviewConfig(db);
    const { kv, get, put } = makeKv();
    const { queue, send } = makeQueue();
    const settleSkipped = mock(async (_input: SettleInput) => true);
    const attach = mock(async (p: ReviewJobPayload) => ({ ...p, attachDeliveryId: "delivery-uuid" }));

    const outcome = await handleReviewJob(
      payload(),
      handlerDeps(db, kv, queue, settleSkipped, attach),
      REFUSAL,
    );

    expect(outcome).toEqual({ kind: "skipped", reason: SHARED_BOT_ENTITLEMENT_SKIP_REASON });
    // No runner can start and nothing is metered.
    expect(send).toHaveBeenCalledTimes(0);
    expect(countRows(db, "usage_events")).toBe(0);
    // No idempotency claim and no comment outbox row for the sweep to re-send.
    expect(get).toHaveBeenCalledTimes(0);
    expect(put).toHaveBeenCalledTimes(0);
    expect(countRows(db, "comment_trigger_claims")).toBe(0);

    // The Check is attached exactly as an admitted delivery's would be, and
    // settled through the lifecycle seam with THIS delivery's identity.
    expect(attach).toHaveBeenCalledTimes(1);
    expect(settleSkipped).toHaveBeenCalledTimes(1);
    expect(settleSkipped.mock.calls[0]?.[0]).toEqual({
      scope: {
        appId: APP_ID,
        installationId: INSTALLATION_ID,
        owner: "acme",
        repo: "widgets",
        prNumber: 7,
      },
      headSha: SHA,
      triggeredBy: "pull_request",
      action: "opened",
      attachDeliveryId: "delivery-uuid",
      reason: SHARED_BOT_ENTITLEMENT_SKIP_REASON,
    });

    // ONE terminal failure row, carrying the sentence the Check carries.
    const rows = db.raw.query(FAILURE_SQL).all() as FailureRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_id: TARGET_ID,
      installation_id: INSTALLATION_ID,
      owner: "acme",
      repo: "widgets",
      pr_number: 7,
      head_sha: SHA,
      stage: SHARED_BOT_ENTITLEMENT_STAGE,
    });
    expect(rows[0]!.error).toBe(CHECK_SUMMARIES.skippedByDelivery(SHARED_BOT_ENTITLEMENT_SKIP_REASON));
    expect(rows[0]!.error).toContain(
      "the review target's plan does not include the shared bot",
    );
    db.raw.close();
  });

  test("a bot-mention delivery attaches and settles nothing, and records no head", async () => {
    const db = createMigratedTestD1();
    seedReviewConfig(db);
    const { kv } = makeKv();
    const { queue, send } = makeQueue();
    const settleSkipped = mock(async (_input: SettleInput) => true);
    const attach = mock(async (p: ReviewJobPayload) => ({ ...p, attachDeliveryId: "delivery-uuid" }));

    const outcome = await handleReviewJob(
      payload({ head_sha: null, comment_id: 987654321, action: "created", triggered_by: "issue_comment" }),
      handlerDeps(db, kv, queue, settleSkipped, attach),
      REFUSAL,
    );

    expect(outcome.kind).toBe("skipped");
    expect(send).toHaveBeenCalledTimes(0);
    expect(settleSkipped).toHaveBeenCalledTimes(0);
    // The claim BEFORE the send would be this delivery's outbox record; a
    // refusal writes none, so the sweep re-sends nothing.
    expect(countRows(db, "comment_trigger_claims")).toBe(0);
    const rows = db.raw.query(FAILURE_SQL).all() as FailureRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.head_sha).toBe("");
    expect(rows[0]!.stage).toBe(SHARED_BOT_ENTITLEMENT_STAGE);
    db.raw.close();
  });
});

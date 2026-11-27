import { describe, expect, mock, test } from "bun:test";
import type { D1Database, KVNamespace, Queue } from "@cloudflare/workers-types";
import {
  QUOTA_PLAN_SKIP_REASON,
  QUOTA_STAGE,
  SHARED_BOT_ENTITLEMENT_SKIP_REASON,
  SHARED_BOT_ENTITLEMENT_STAGE,
} from "../../src/contracts/failure-stages";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { SharedBotRefusal } from "../../src/dashboard/entitlement";
import { CHECK_SUMMARIES } from "../../src/pipeline/checks";
import { handleReviewJob, type DeliveryRefusal, type HandlerDeps } from "../../src/worker/handlers";
import { syncSplitPair, createMigratedTestD1, type TestD1 } from "../store/helpers";

const WS = "default";
const APP_ID = "11111111-2222-3333-4444-555555555555";
const GITHUB_APP_ID = 7101;
const TARGET_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const INSTALLATION_ID = 12345;
const SHA = "0123456789abcdef0123456789abcdef01234567";

const REFUSAL: SharedBotRefusal = { kind: "shared-bot-not-included", planId: "free" };

const QUOTA_REFUSAL: DeliveryRefusal = { kind: "quota-exhausted", limit: 2000, used: 1999, cost: 60 };

const FAILURE_SQL = "SELECT * FROM review_failures ORDER BY rowid";

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

function payload(overrides: Partial<ReviewJobPayload> = {}): ReviewJobPayload {
  return {
    installation_id: INSTALLATION_ID,
    owner: "acme",
    repo: "widgets",
    pr_number: 7,
    head_sha: SHA,
    action: "opened",
    triggered_by: "pull_request",
    botRef: { appId: APP_ID, botId: APP_ID },
    targetId: TARGET_ID,
    ...overrides,
  };
}

function seedReviewConfig(db: TestD1): void {
  db.raw.prepare(
      `INSERT INTO github_apps
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
          status, deleted_at, created_at, updated_at)
       VALUES (?, ?, 'shared-bot-test', 'enc', 'enc', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(APP_ID, GITHUB_APP_ID);
  // The split pair: the bot row and the default-workspace mapping the
  // same-id invariant of this release requires beside the App row.
  syncSplitPair(db);
  db.raw
    .prepare(
      `INSERT INTO review_targets (id, workspace_id, app_id, name, created_by, created_at, updated_at)
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

function handlerDeps(
  db: TestD1,
  kv: KVNamespace,
  queue: Queue<ReviewJobPayload>,
  attach: HandlerDeps["beforeEnqueue"],
): HandlerDeps {
  return {
    env: { IDEMPOTENCY_KV: kv, REVIEW_QUEUE: queue, DB: db as unknown as D1Database },
    log: { info: () => {}, warn: () => {} },
    beforeEnqueue: attach,
  };
}

describe("handleReviewJob — a shared-bot refusal", () => {
  test("skips terminally: no send, no claim, one entitlement failure, Check work left to the route", async () => {
    const db = createMigratedTestD1();
    seedReviewConfig(db);
    const { kv, get, put } = makeKv();
    const { queue, send } = makeQueue();
    const attach = mock(async (p: ReviewJobPayload) => ({ ...p, attachDeliveryId: "delivery-uuid" }));

    const outcome = await handleReviewJob(payload(), handlerDeps(db, kv, queue, attach), REFUSAL);

    expect(outcome).toEqual({ kind: "skipped", reason: SHARED_BOT_ENTITLEMENT_SKIP_REASON });
    expect(send).toHaveBeenCalledTimes(0);
    expect(countRows(db, "usage_events")).toBe(0);
    expect(get).toHaveBeenCalledTimes(0);
    expect(put).toHaveBeenCalledTimes(0);
    expect(countRows(db, "comment_trigger_claims")).toBe(0);

    expect(attach).toHaveBeenCalledTimes(1);
    expect(countRows(db, "review_checks")).toBe(0);

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

  test("a bot-mention delivery still runs the hook, and records no head", async () => {
    const db = createMigratedTestD1();
    seedReviewConfig(db);
    const { kv } = makeKv();
    const { queue, send } = makeQueue();
    const attach = mock(async (p: ReviewJobPayload) => ({ ...p, attachDeliveryId: "delivery-uuid" }));

    const outcome = await handleReviewJob(
      payload({ head_sha: null, comment_id: 987654321, action: "created", triggered_by: "issue_comment" }),
      handlerDeps(db, kv, queue, attach),
      REFUSAL,
    );

    expect(outcome.kind).toBe("skipped");
    expect(send).toHaveBeenCalledTimes(0);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(countRows(db, "comment_trigger_claims")).toBe(0);
    const rows = db.raw.query(FAILURE_SQL).all() as FailureRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.head_sha).toBe("");
    expect(rows[0]!.stage).toBe(SHARED_BOT_ENTITLEMENT_STAGE);
    db.raw.close();
  });
});

describe("handleReviewJob — a quota refusal", () => {
  test("skips terminally on the `quota` stage: no send, no claim, one failure row", async () => {
    const db = createMigratedTestD1();
    seedReviewConfig(db);
    const { kv, get, put } = makeKv();
    const { queue, send } = makeQueue();
    const attach = mock(async (p: ReviewJobPayload) => ({ ...p, attachDeliveryId: "delivery-uuid" }));

    const outcome = await handleReviewJob(payload(), handlerDeps(db, kv, queue, attach), QUOTA_REFUSAL);

    expect(outcome).toEqual({ kind: "skipped", reason: QUOTA_PLAN_SKIP_REASON });
    expect(send).toHaveBeenCalledTimes(0);
    expect(countRows(db, "usage_events")).toBe(0);
    expect(countRows(db, "comment_trigger_claims")).toBe(0);
    expect(get).toHaveBeenCalledTimes(0);
    expect(put).toHaveBeenCalledTimes(0);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(countRows(db, "review_checks")).toBe(0);

    const rows = db.raw.query(FAILURE_SQL).all() as FailureRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: QUOTA_STAGE, target_id: TARGET_ID, head_sha: SHA });
    expect(rows[0]!.error).toBe(CHECK_SUMMARIES.skippedByDelivery(QUOTA_PLAN_SKIP_REASON));
    expect(rows[0]!.error).not.toContain("2000");
    db.raw.close();
  });
});

import "../helpers/cloudflare-workers-mock";

import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createSeededTestD1 } from "../helpers/consumer-fixtures";
import { createConsumerHarness, loadConsumer, makePayload } from "../helpers/consumer-harness";
import { withFrozenClock } from "../helpers/clock";
import { deliveryKeyOf, readAttemptHandoff } from "../../src/store/review-route-store";
import {
  REVIEW_ATTEMPT_CAP_DEFAULT_MS,
  REVIEW_ATTEMPT_CAP_KEY,
  REVIEW_ATTEMPT_CAP_MAX_MS,
  REVIEW_ATTEMPT_CAP_MIN_MS,
  getReviewAttemptCapSetting,
} from "../../src/dashboard/runtime-config-store";
import { readReviewAttemptCapMs } from "../../src/review-budget";
import type { AttemptRef } from "../../src/pipeline/review-attempt-execution";
import type { TestD1 } from "../store/helpers";

const { createReviewConsumer, WorkflowCreateFailedError } = await loadConsumer();

const SESSION_SECRET = ["test", "attempt", "cap", "write", "session", "32-bytes!"].join("-");
const OPERATOR = "Cap-Operator";
const OPERATOR_KEY = OPERATOR.toLowerCase();
const RANGE = `${REVIEW_ATTEMPT_CAP_MIN_MS}..${REVIEW_ATTEMPT_CAP_MAX_MS}`;

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "saas",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    PLATFORM_OPERATORS: OPERATOR_KEY,
    DB: db,
  } as unknown as Env;
}

async function fixture(): Promise<TestD1> {
  const db = await createSeededTestD1();
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(crypto.randomUUID(), OPERATOR, new Date().toISOString());
  return db;
}

async function adminFetch(db: TestD1, path: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    Cookie: `${SESSION_COOKIE}=${await createSessionValue(OPERATOR, null, SESSION_SECRET)}`,
  };
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(
    new Request(`https://worker.local/_internal_admin/api${path}`, { ...init, headers }),
    envFor(db),
  );
}

function patchCap(db: TestD1, capMs: unknown): Promise<Response> {
  return adminFetch(db, "/runtime", { method: "PATCH", body: JSON.stringify({ attemptCap: { capMs } }) });
}

function capRows(db: TestD1): Array<{ key: string; value: string }> {
  return db.raw
    .query("SELECT key, value FROM review_runtime_settings WHERE key LIKE 'review.attempt%' ORDER BY key")
    .all() as Array<{ key: string; value: string }>;
}

function auditRows(db: TestD1): Array<{ detail_json: string }> {
  return db.raw
    .query("SELECT detail_json FROM platform_audit_events WHERE action = 'runtime.attempt_cap.set'")
    .all() as Array<{ detail_json: string }>;
}

describe("the attempt cap's operator read", () => {
  test("an absent row reports the documented default as a default, not as a saved value", async () => {
    const db = await fixture();
    const answer = await adminFetch(db, "/runtime");
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { attemptCap: unknown };
    expect(body.attemptCap).toEqual({
      capMs: REVIEW_ATTEMPT_CAP_DEFAULT_MS,
      saved: false,
      min: REVIEW_ATTEMPT_CAP_MIN_MS,
      max: REVIEW_ATTEMPT_CAP_MAX_MS,
      degraded: false,
    });
    expect(capRows(db)).toEqual([]);
    expect(await getReviewAttemptCapSetting(db as never)).toEqual({
      capMs: REVIEW_ATTEMPT_CAP_DEFAULT_MS,
      saved: false,
      degraded: false,
    });
  });

  test("a saved value is reported as saved", async () => {
    const db = await fixture();
    expect((await patchCap(db, REVIEW_ATTEMPT_CAP_MIN_MS)).status).toBe(200);
    const body = (await (await adminFetch(db, "/runtime")).json()) as { attemptCap: unknown };
    expect(body.attemptCap).toEqual({
      capMs: REVIEW_ATTEMPT_CAP_MIN_MS,
      saved: true,
      min: REVIEW_ATTEMPT_CAP_MIN_MS,
      max: REVIEW_ATTEMPT_CAP_MAX_MS,
      degraded: false,
    });
  });
});

describe("a saved cap is the value enforcement uses", () => {
  test("admission freezes the saved value into the attempt's deadline on both ends of the range", async () => {
    const db = await fixture();
    const h = createConsumerHarness();
    const seen: AttemptRef[] = [];
    const startAttempt = async (_deps: unknown, ref: AttemptRef): Promise<void> => {
      seen.push(ref);
      throw new WorkflowCreateFailedError(ref.attemptId, new Error("no instance"));
    };
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      startAttempt,
    });

    await withFrozenClock(async (clock) => {
      const admittedAt = clock.now;
      const ends = [REVIEW_ATTEMPT_CAP_MIN_MS, REVIEW_ATTEMPT_CAP_MAX_MS];
      for (const [index, capMs] of ends.entries()) {
        const answer = await patchCap(db, capMs);
        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual({ attemptCap: { capMs } });

        const payload = makePayload({ pr_number: 70 + index });
        await consumer(h.makeBatch(payload)).catch(() => {});
        expect(await readReviewAttemptCapMs(db as never, { warn: () => {} })).toBe(capMs);
        expect(seen.at(-1)?.deadlineMs).toBe(admittedAt + capMs);
        expect((await readAttemptHandoff(db as never, deliveryKeyOf(payload)))?.deadlineMs).toBe(
          admittedAt + capMs,
        );
      }
    });

    expect(capRows(db)).toEqual([{ key: REVIEW_ATTEMPT_CAP_KEY, value: String(REVIEW_ATTEMPT_CAP_MAX_MS) }]);
    expect(auditRows(db)).toHaveLength(2);
    const [first] = auditRows(db);
    expect(JSON.parse(first!.detail_json)).toEqual({
      before: null,
      after: REVIEW_ATTEMPT_CAP_MIN_MS,
    });
  });
});

describe("the attempt cap's write gate", () => {
  test("an out-of-range or non-integer value is refused with the accepted range named", async () => {
    const db = await fixture();
    for (const capMs of [
      REVIEW_ATTEMPT_CAP_MIN_MS - 1,
      REVIEW_ATTEMPT_CAP_MAX_MS + 1,
      REVIEW_ATTEMPT_CAP_MIN_MS + 0.5,
    ]) {
      const answer = await patchCap(db, capMs);
      expect(answer.status).toBe(400);
      const body = (await answer.json()) as { error: string };
      expect(body.error).toContain(RANGE);
    }
    expect(capRows(db)).toEqual([]);
    expect(auditRows(db)).toHaveLength(0);
  });

  test("a value already stored is untouched by a later refusal", async () => {
    const db = await fixture();
    expect((await patchCap(db, REVIEW_ATTEMPT_CAP_MIN_MS)).status).toBe(200);
    expect((await patchCap(db, REVIEW_ATTEMPT_CAP_MAX_MS + 1)).status).toBe(400);
    expect(capRows(db)).toEqual([
      { key: REVIEW_ATTEMPT_CAP_KEY, value: String(REVIEW_ATTEMPT_CAP_MIN_MS) },
    ]);
    expect(auditRows(db)).toHaveLength(1);
  });

  test("a value that is not a number is a shape refusal, never coerced", async () => {
    const db = await fixture();
    const answer = await patchCap(db, String(REVIEW_ATTEMPT_CAP_DEFAULT_MS));
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "body must be { attemptCap: { capMs } }" });
    expect(capRows(db)).toEqual([]);
  });
});

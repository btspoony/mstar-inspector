import "../helpers/cloudflare-workers-mock";

import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createSeededTestD1 } from "../helpers/consumer-fixtures";
import {
  LOST_REPLY_SETTLE_DEFAULT_MS,
  LOST_REPLY_SETTLE_KEY,
  LOST_REPLY_SETTLE_MAX_MS,
  LOST_REPLY_SETTLE_MIN_MS,
  getLostReplySettleMs,
} from "../../src/dashboard/runtime-config-store";
import type { TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "lost", "reply", "window", "session", "32b"].join("-");
const OPERATOR = "Window-Operator";

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "saas",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    PLATFORM_OPERATORS: OPERATOR.toLowerCase(),
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

function patch(db: TestD1, settleMs: unknown): Promise<Response> {
  return adminFetch(db, "/runtime", {
    method: "PATCH",
    body: JSON.stringify({ lostReplySettle: { settleMs } }),
  });
}

function auditRows(db: TestD1): Array<{ detail_json: string }> {
  return db.raw
    .query("SELECT detail_json FROM platform_audit_events WHERE action = 'runtime.lost_reply_settle.set'")
    .all() as Array<{ detail_json: string }>;
}

describe("the lost reply window's operator surface", () => {
  test("an absent row reports the documented default, and the window reads it", async () => {
    const db = await fixture();
    const body = (await (await adminFetch(db, "/runtime")).json()) as { lostReplySettle: unknown };
    expect(body.lostReplySettle).toEqual({
      settleMs: LOST_REPLY_SETTLE_DEFAULT_MS,
      min: LOST_REPLY_SETTLE_MIN_MS,
      max: LOST_REPLY_SETTLE_MAX_MS,
      degraded: false,
    });
    expect(await getLostReplySettleMs(db as never)).toEqual({
      settleMs: LOST_REPLY_SETTLE_DEFAULT_MS,
      degraded: false,
    });
  });

  test("a save is audited with before/after and is what the pass reads next", async () => {
    const db = await fixture();
    const saved = LOST_REPLY_SETTLE_MIN_MS;
    expect((await patch(db, saved)).status).toBe(200);
    expect(await getLostReplySettleMs(db as never)).toEqual({ settleMs: saved, degraded: false });
    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    // note: The BEFORE object names the absent row, never the effective default.
    expect(JSON.parse(rows[0]!.detail_json)).toEqual({ before: { settleMs: null }, after: { settleMs: saved } });
    expect((await patch(db, LOST_REPLY_SETTLE_MAX_MS)).status).toBe(200);
    expect(await getLostReplySettleMs(db as never)).toEqual({
      settleMs: LOST_REPLY_SETTLE_MAX_MS,
      degraded: false,
    });
  });

  test("a window shorter than the runner budget is refused and writes nothing", async () => {
    const db = await fixture();
    // note: A non-number never reaches the range check — the body shape guard
    // refuses it first, which is also a 400 with no write.
    for (const invalid of [LOST_REPLY_SETTLE_MIN_MS - 1, LOST_REPLY_SETTLE_MAX_MS + 1, 1.5]) {
      const response = await patch(db, invalid);
      expect(response.status, JSON.stringify(invalid)).toBe(400);
      expect((await response.json() as { error: string }).error).toContain(
        `${LOST_REPLY_SETTLE_MIN_MS}..${LOST_REPLY_SETTLE_MAX_MS}`,
      );
    }
    for (const invalid of ["900000", null]) {
      expect((await patch(db, invalid)).status, JSON.stringify(invalid)).toBe(400);
    }
    expect(auditRows(db)).toEqual([]);
    expect(
      db.raw.query("SELECT value FROM review_runtime_settings WHERE key = ?").get(LOST_REPLY_SETTLE_KEY),
    ).toBeNull();
  });

  test("an untrusted stored value answers the default, marked degraded", async () => {
    const db = await fixture();
    db.raw
      .prepare("INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, 'not-a-number', ?)")
      .run(LOST_REPLY_SETTLE_KEY, new Date().toISOString());
    expect(await getLostReplySettleMs(db as never)).toEqual({
      settleMs: LOST_REPLY_SETTLE_DEFAULT_MS,
      degraded: true,
      reason: "untrusted",
    });
  });
});

import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";
import { reviewRunState } from "../../src/dashboard/runtime-config-store";

const SESSION_SECRET = ["test", "reviews", "answer", "session", "32-bytes!"].join("-");
const OPERATOR = "Support-Bot";

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {}, metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }) },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "saas",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    PLATFORM_OPERATORS: OPERATOR.toLowerCase(),
    DB: db,
  } as unknown as Env;
}

function seed(db: TestD1, sql: string, ...params: Array<string | number | null>): void {
  db.raw.prepare(sql).run(...params);
}

function seedOperator(db: TestD1): void {
  seed(
    db,
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)",
    crypto.randomUUID(),
    OPERATOR,
    new Date().toISOString(),
  );
}

function setPlatformSwitch(db: TestD1, enabled: 0 | 1): void {
  seed(
    db,
    "INSERT INTO server_flags (key, enabled, updated_at, updated_by) VALUES ('review_global', ?, ?, 'fixture')",
    enabled,
    new Date().toISOString(),
  );
}

function setRouteGate(db: TestD1, value: string): void {
  seed(
    db,
    "INSERT INTO review_runtime_settings (key, value, updated_at) VALUES ('review.route.workflow', ?, ?)",
    value,
    new Date().toISOString(),
  );
}

async function readAnswer(db: TestD1): Promise<{
  answer: string;
  platform: { enabled: boolean; unreadable: boolean };
  pausedApps: number | null;
  appsHref: string | null;
}> {
  const res = await worker.fetch(
    new Request("https://worker.local/_internal_admin/api/runtime", {
      headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(OPERATOR, null, SESSION_SECRET)}` },
    }),
    envFor(db),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { reviewsRunning: never };
  return body.reviewsRunning;
}

function fixture(): TestD1 {
  const db = createMigratedTestD1();
  seedOperator(db);
  return db;
}

describe("GET /_internal_admin/api/runtime reviewsRunning", () => {
  test("platform on and the routing gate on answer running", async () => {
    const db = fixture();
    setRouteGate(db, "on");
    expect(await readAnswer(db)).toEqual({
      answer: "running",
      platform: { enabled: true, unreadable: false },
      pausedApps: 0,
      appsHref: null,
    });
  });

  test("both closed answers blocked-deployment-gate — the gate the queue acts on", async () => {
    const db = fixture();
    setPlatformSwitch(db, 0);
    expect(await readAnswer(db)).toEqual({
      answer: "blocked-deployment-gate",
      platform: { enabled: false, unreadable: false },
      pausedApps: 0,
      appsHref: null,
    });
  });

  test("an unreadable platform switch answers blocked-deployment-gate, never running", async () => {
    const db = fixture();
    setRouteGate(db, "on");
    const res = await worker.fetch(
      new Request("https://worker.local/_internal_admin/api/runtime", {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(OPERATOR, null, SESSION_SECRET)}` },
      }),
      {
        ...envFor(db),
        DB: {
          prepare: (sql: string) => {
            if (sql.includes("server_flags")) throw new Error("flags unavailable");
            return db.prepare(sql);
          },
          batch: (statements: never[]) => db.batch(statements),
        },
      } as unknown as Env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reviewsRunning: { answer: string; platform: unknown } };
    expect(body.reviewsRunning.answer).toBe("blocked-deployment-gate");
    expect(body.reviewsRunning.platform).toEqual({ enabled: false, unreadable: true });
  });

  test("the platform switch off answers paused-platform even with the gate on", async () => {
    const db = fixture();
    setRouteGate(db, "on");
    setPlatformSwitch(db, 0);
    expect(await readAnswer(db)).toEqual({
      answer: "paused-platform",
      platform: { enabled: false, unreadable: false },
      pausedApps: 0,
      appsHref: null,
    });
  });

  test("a routing gate that was never set answers blocked-deployment-gate", async () => {
    const db = fixture();
    expect(await readAnswer(db)).toEqual({
      answer: "blocked-deployment-gate",
      platform: { enabled: true, unreadable: false },
      pausedApps: 0,
      appsHref: null,
    });
  });

  test("a gate read that degrades answers blocked-deployment-gate, never running", async () => {
    const db = fixture();
    setRouteGate(db, "ON");
    const res = await worker.fetch(
      new Request("https://worker.local/_internal_admin/api/runtime", {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(OPERATOR, null, SESSION_SECRET)}` },
      }),
      envFor(db),
    );
    const body = (await res.json()) as {
      reviewsRunning: { answer: string };
      routeWorkflow: { mode: string; degraded: boolean; reason: string };
    };
    expect(body.reviewsRunning.answer).toBe("blocked-deployment-gate");
    expect(body.routeWorkflow).toMatchObject({ mode: "off", degraded: true, reason: "untrusted" });
  });

  test("the Apps link is workspace-scoped when the operator has a workspace", async () => {
    const db = fixture();
    setRouteGate(db, "on");
    seed(
      db,
      "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES ('ws-admin', 'admin-ws', 'Admin', NULL, ?, NULL)",
      new Date().toISOString(),
    );
    const operatorId = db.raw
      .prepare("SELECT id FROM users WHERE github_login = ?")
      .get(OPERATOR) as { id: string };
    seed(
      db,
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws-admin', ?, 'owner', ?)",
      operatorId.id,
      new Date().toISOString(),
    );
    expect((await readAnswer(db)).appsHref).toBe("/dashboard/ws-admin/apps");
  });

  test("the card and the queue read ONE state machine", async () => {
    // The payload answer is the shared derivation verbatim — the queue settles
    // by the same value, so the card can never name a cause the batch did not act on.
    const cases: Array<{ gate: string | null; flag: 0 | 1 | null }> = [
      { gate: "on", flag: 1 },
      { gate: "on", flag: 0 },
      { gate: null, flag: 1 },
      { gate: null, flag: 0 },
      { gate: "ON", flag: 1 },
    ];
    for (const entry of cases) {
      const db = fixture();
      if (entry.gate !== null) setRouteGate(db, entry.gate);
      if (entry.flag !== null) setPlatformSwitch(db, entry.flag);
      const label = JSON.stringify(entry);
      expect((await readAnswer(db)).answer, label).toBe((await reviewRunState(db)).state);
    }
  });

  test("the paused-App count reads the App pause of live Apps only", async () => {
    const db = fixture();
    setRouteGate(db, "on");
    seedBot(db, "bot-live-paused", 1);
    seedBot(db, "bot-live-running", 2);
    seedBot(db, "bot-deleted-paused", 3);
    seed(
      db,
      "UPDATE review_bots SET review_enabled = 0 WHERE id IN ('bot-live-paused', 'bot-deleted-paused')",
    );
    seed(db, "UPDATE review_bots SET deleted_at = datetime('now') WHERE id = 'bot-deleted-paused'");
    // A per-repository pause answers a different question and is not this count.
    const target = seedTarget(db, "bot-live-running");
    seed(db, "UPDATE review_targets SET review_enabled = 0 WHERE id = ?", target);

    expect(await readAnswer(db)).toEqual({
      answer: "running",
      platform: { enabled: true, unreadable: false },
      pausedApps: 1,
      appsHref: null,
    });
  });
});

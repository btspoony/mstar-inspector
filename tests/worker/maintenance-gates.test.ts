/**
 * The maintenance window's pipeline gates (D20) — the half the dashboard gate
 * does not cover. With the window on:
 *
 *   - the per-App webhook answers 503 BEFORE the signature is verified, so
 *     GitHub retries instead of the delivery landing on a ledger a running
 *     backfill may be repointing;
 *   - a cron invocation returns before any lane runs.
 *
 * With the window off (the absent-row default) every surface is unchanged. The
 * queue face lives in tests/pipeline/consumer-maintenance.test.ts (that suite
 * loads the real consumer; this directory replaces it process-wide).
 */
import { describe, expect, test } from "bun:test";
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { Webhooks } from "@octokit/webhooks";
import "../helpers/cloudflare-workers-mock";
import worker from "../../src/worker/index";
import { CHECK_RECOVERY_CRON } from "../../src/worker/index";
import { defaultSweepLog } from "../../src/worker/sweep";
import type { Env } from "../../src/worker/env";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { setMaintenanceMode } from "../../src/dashboard/runtime-config-store";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const SECRET = "test-webhook-secret";
const OPERATOR = "Support-Bot";
const SINCE = "2026-11-17T09:00:00.000Z";

function makeEnv(db: unknown): Env {
  return {
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as never,
    REVIEW_QUEUE: { send: async () => {} } as never,
    DB: db as never,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DEPLOYMENT_MODE: "self-hosted",
  };
}

async function seedApp(db: TestD1): Promise<string> {
  const id = "app-maintenance";
  const box = createSecretbox(TEST_KEY);
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(
      id,
      id,
      5100,
      id,
      await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`),
      await box.encryptSecret(SECRET, `github_apps.webhook_secret_enc:${id}`),
    );
  db.raw.prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, 'default')").run(id);
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
          review_trigger_mode, created_by, created_at, updated_at)
       VALUES (?, 'default', ?, ?, ?, ?, ?, 'every_push', 'tester', datetime('now'), datetime('now'))`,
    )
    .run(`target-${id}`, id, id, 5100, "btspoony", "mstar-inspector");
  return id;
}

const PR_PAYLOAD = {
  action: "opened",
  number: 131,
  installation: { id: 123 },
  pull_request: {
    number: 131,
    title: "Add a per-App PR surface",
    state: "open",
    merged: false,
    head: { sha: "abc123" },
    user: { login: "btspoony" },
  },
  repository: { id: 5100, name: "mstar-inspector", owner: { login: "btspoony" } },
};

/** Deliver a correctly SIGNED pull_request event, the way GitHub does. */
async function deliver(appId: string, env: Env): Promise<Response> {
  const body = JSON.stringify(PR_PAYLOAD);
  return worker.fetch(
    new Request(`https://worker.local/webhook/default/${appId}`, {
      method: "POST",
      headers: {
        "x-hub-signature-256": await new Webhooks({ secret: SECRET }).sign(body),
        "x-github-event": "pull_request",
      },
      body,
    }),
    env,
  );
}

async function close(db: TestD1): Promise<void> {
  await setMaintenanceMode(db, { enabled: true, reason: "repository backfill", actor: OPERATOR }, SINCE);
}

describe("the webhook maintenance gate", () => {
  test("a closed window answers 503 before the signature is checked", async () => {
    const db = createMigratedTestD1();
    const appId = await seedApp(db);
    await close(db);

    const env = makeEnv(db);
    const response = await deliver(appId, env);
    expect(response.status).toBe(503);
    // Short body, no window detail: the delivery was not admitted, so there is
    // nothing to explain and no operator reason to disclose to GitHub.
    expect(await response.text()).toBe("maintenance in progress");
    // Nothing was classified, recorded or enqueued.
    expect(db.raw.prepare("SELECT * FROM webhook_deliveries").all()).toHaveLength(0);
    expect(db.raw.prepare("SELECT * FROM pull_requests").all()).toHaveLength(0);
  });

  test("an UNSIGNED delivery is also refused while closed — the gate precedes verification", async () => {
    const db = createMigratedTestD1();
    const appId = await seedApp(db);
    await close(db);

    const response = await worker.fetch(
      new Request(`https://worker.local/webhook/default/${appId}`, {
        method: "POST",
        headers: { "x-github-event": "pull_request" },
        body: JSON.stringify(PR_PAYLOAD),
      }),
      makeEnv(db),
    );
    expect(response.status).toBe(503);
  });

  test("the absent-row default leaves the delivery path exactly as before", async () => {
    const db = createMigratedTestD1();
    const appId = await seedApp(db);

    const response = await deliver(appId, makeEnv(db));
    expect(response.status).toBe(200);
    // A verified job lands its delivery row: the gate added no cost or change.
    expect(db.raw.prepare("SELECT * FROM webhook_deliveries").all()).toHaveLength(1);
  });
});

describe("an unreadable window", () => {
  /** Every `platform.maintenance.*` read throws: the state is unknowable. */
  function brokenWindow(db: TestD1): TestD1 {
    return {
      ...db,
      prepare(query: string) {
        if (query.includes("review_runtime_settings WHERE key IN")) throw new Error("settings unavailable");
        return db.prepare(query);
      },
    } as TestD1;
  }

  test("the webhook answers 503 instead of admitting the delivery", async () => {
    const db = createMigratedTestD1();
    const appId = await seedApp(db);
    const response = await deliver(appId, makeEnv(brokenWindow(db)));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("maintenance in progress");
    expect(db.raw.prepare("SELECT * FROM webhook_deliveries").all()).toHaveLength(0);
  });

  test("the cron returns before any lane runs", async () => {
    const db = createMigratedTestD1();
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("ok");
    }) as unknown as typeof fetch;
    const warns: Array<Record<string, unknown>> = [];
    const originalWarn = defaultSweepLog.warn;
    defaultSweepLog.warn = (fields) => void warns.push(fields as Record<string, unknown>);
    try {
      await worker.scheduled(
        { cron: "*/15 * * * *" } as ScheduledController,
        makeEnv(brokenWindow(db)),
        {} as ExecutionContext,
      );
    } finally {
      globalThis.fetch = originalFetch;
      defaultSweepLog.warn = originalWarn;
    }
    expect(fetchCalls).toBe(0);
    expect(warns.map((call) => call.event)).toContain("maintenance_skip");
  });
});

describe("the cron maintenance gate", () => {
  const NOOP_CONTROLLER = { cron: "*/15 * * * *" } as ScheduledController;
  const NOOP_CTX = {} as ExecutionContext;

  test("a closed window returns before any lane runs", async () => {
    const db = createMigratedTestD1();
    await close(db);
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("ok");
    }) as unknown as typeof fetch;
    const warns: Array<Record<string, unknown>> = [];
    const originalWarn = defaultSweepLog.warn;
    defaultSweepLog.warn = (fields) => void warns.push(fields as Record<string, unknown>);
    try {
      await worker.scheduled(NOOP_CONTROLLER, makeEnv(db), NOOP_CTX);
    } finally {
      globalThis.fetch = originalFetch;
      defaultSweepLog.warn = originalWarn;
    }
    // No sweep, no alert: the only line is the skip itself.
    expect(fetchCalls).toBe(0);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ event: "maintenance_skip", detail: "cron=*/15 * * * *" });

    // A closed window also holds the Check lane expression back.
    const checkWarns: Array<Record<string, unknown>> = [];
    defaultSweepLog.warn = (fields) => void checkWarns.push(fields as Record<string, unknown>);
    try {
      await worker.scheduled({ cron: CHECK_RECOVERY_CRON } as ScheduledController, makeEnv(db), NOOP_CTX);
    } finally {
      defaultSweepLog.warn = originalWarn;
    }
    expect(checkWarns).toHaveLength(1);
    expect(checkWarns[0]).toMatchObject({ event: "maintenance_skip" });
  });

  test("the absent-row default still runs the sweep", async () => {
    const db = createMigratedTestD1();
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("ok");
    }) as unknown as typeof fetch;
    try {
      // A quiet sweep raises no alert, so zero POSTs is the healthy answer; the
      // run's own evidence is that it reached the store without a skip line.
      const warns: Array<Record<string, unknown>> = [];
      const originalWarn = defaultSweepLog.warn;
      defaultSweepLog.warn = (fields) => void warns.push(fields as Record<string, unknown>);
      try {
        await worker.scheduled(NOOP_CONTROLLER, makeEnv(db), NOOP_CTX);
      } finally {
        defaultSweepLog.warn = originalWarn;
      }
      expect(fetchCalls).toBe(0);
      expect(warns.map((call) => call.event)).not.toContain("maintenance_skip");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * webhook_deliveries tests (plan 20 Task 1, architect verdict AL-20-1) —
 * migration 0011 + the apps-store delivery face + the per-App webhook
 * face's best-effort recording.
 *
 * Contract under test:
 *   - 0011 applies over a seeded production-shaped DB (0001–0010) and
 *     creates webhook_deliveries + idx_webhook_deliveries_app_created
 *     (append-only; NO deliverable_hint column — AL-20-1).
 *   - The outcome vocabulary is producer-side (apps-store DELIVERY_OUTCOMES,
 *     0010 FAILURE_STAGES precedent): an off-vocabulary outcome throws
 *     BEFORE any row is written; the schema has no CHECK.
 *   - The per-App webhook face records ONE row per VERIFIED delivery,
 *     immediately after classifyWebhook returns (before the reject return):
 *     reject → rejected (status_code = the classifier's status), ignore →
 *     ignored, job + review_enabled=0 → paused, job → ok. Pre-classify
 *     failures (413 / kill-switch / db-guard / 404 / decrypt 500) record
 *     nothing; the legacy face records nothing (AL-20-1: legacy 不落行).
 *   - Recording is best-effort: a store failure logs a structured warn
 *     (event "delivery_record_failed") and the webhook response is
 *     unchanged.
 */

import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Webhooks } from "@octokit/webhooks";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { createAppsStore, DELIVERY_OUTCOMES } from "../../src/dashboard/apps-store";
import type { DeliveryOutcome } from "../../src/dashboard/apps-store";
import { createMigratedTestD1, createTestD1 } from "../store/helpers";
import type { ReviewJobPayload } from "../../src/contracts/review-job";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
/** base64 of exactly 32 bytes (the secretbox master-key requirement). */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const LEGACY_SECRET = "legacy-webhook-secret";

describe("migrations/0011_webhook_deliveries.sql", () => {
  /** Apply one migration file verbatim (filename order = wrangler order). */
  function applyMigrationFile(db: ReturnType<typeof createTestD1>, name: string): void {
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }

  /** Raw-insert one github_apps row (dummy envelopes — no decryption here). */
  function seedAppRow(db: ReturnType<typeof createTestD1>, id = "app-1"): void {
    const appNum = Number(id.replace(/\D/g, "")) || 1;
    db.raw
      .prepare(
        `INSERT INTO github_apps
           (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
      )
      .run(id, id, 1000 + appNum, `App ${id}`, "v1.primary.aXZpdi5jdA==", "v1.primary.aXZpdi5jdA==");
  }

  /** Raw-insert one delivery row (full column control). */
  function insertDelivery(
    db: ReturnType<typeof createTestD1>,
    overrides: Partial<Record<string, unknown>> = {},
  ): void {
    const row = {
      id: "delivery-1",
      app_id: "app-1",
      event_name: "pull_request",
      outcome: "ok",
      status_code: null,
      ...overrides,
    };
    db.raw
      .prepare(
        `INSERT INTO webhook_deliveries (id, app_id, event_name, outcome, status_code)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.app_id, row.event_name, row.outcome, row.status_code);
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0010 with live rows); existing tables untouched", () => {
    const db = createTestD1();
    // A live review predates the CREATE TABLE (wrangler order).
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md)
         VALUES ('review-1', 123, 'acme', 'widgets', 42, '0123456789abcdef0123456789abcdef01234567', 'comment', 'ok')`,
      )
      .run();
    for (const name of [
      "0003_dashboard_users.sql",
      "0004_github_apps.sql",
      "0005_reviews_app_id.sql",
      "0006_app_provider_config.sql",
      "0007_reviews_app_id_index.sql",
      "0008_github_apps_ops.sql",
      "0009_app_model_roles.sql",
      "0010_review_failures.sql",
    ]) {
      applyMigrationFile(db, name);
    }
    seedAppRow(db); // the FK parent exists before 0011

    // Append-only CREATE TABLE over the live rows — nothing existing changes.
    expect(() => applyMigrationFile(db, "0011_webhook_deliveries.sql")).not.toThrow();
    const reviewCount = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviewCount.n).toBe(1);
    const index = db.raw
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_webhook_deliveries_app_created'")
      .get();
    expect(index).toBeDefined();
    // AL-20-1: no deliverable_hint column.
    const cols = db.raw.query("PRAGMA table_info(webhook_deliveries)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain("deliverable_hint");
  });

  test("created_at defaults to datetime('now'); every NOT NULL column rejects NULL", () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    insertDelivery(db);
    const row = db.raw.query("SELECT * FROM webhook_deliveries").get() as { id: string; created_at: string };
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // A NULL in any one of the NOT NULL columns is refused while the rest
    // stay valid.
    const base = { app_id: "app-1", outcome: "ok" };
    for (const column of Object.keys(base)) {
      const values = { ...base, [column]: null } as typeof base;
      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO webhook_deliveries (id, app_id, outcome)
             VALUES ('d-null', ?, ?)`,
          )
          .run(values.app_id, values.outcome),
      ).toThrow(/NOT NULL constraint failed/);
    }
  });

  test("outcome has NO CHECK — the vocabulary is producer-side (0010 precedent); any outcome string is storable", () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    for (const outcome of ["ok", "paused", "ignored", "rejected", "not-an-outcome"]) {
      insertDelivery(db, { id: `delivery-${outcome}`, outcome });
    }
    const count = db.raw.query("SELECT COUNT(*) AS n FROM webhook_deliveries").get() as { n: number };
    expect(count.n).toBe(5);
  });

  test("app_id is NOT NULL FK to github_apps — an unknown app is refused", () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    expect(() => insertDelivery(db, { id: "delivery-fk", app_id: "no-such-app" })).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});

describe("apps-store delivery face (recordDelivery / deliverySummary / listRecentDeliveries)", () => {
  /** Raw-insert one github_apps row (dummy envelopes — no decryption here). */
  function seedAppRow(db: ReturnType<typeof createTestD1>, id = "app-1"): void {
    const appNum = Number(id.replace(/\D/g, "")) || 1;
    db.raw
      .prepare(
        `INSERT INTO github_apps
           (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
      )
      .run(id, id, 1000 + appNum, `App ${id}`, "v1.primary.aXZpdi5jdA==", "v1.primary.aXZpdi5jdA==");
  }

  test("recordDelivery persists a full row: UUID id, caller fields, datetime('now') created_at", async () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    const store = createAppsStore(db);

    await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "ok", statusCode: null });
    await store.recordDelivery({ appId: "app-1", eventName: null, outcome: "rejected", statusCode: 401 });

    const rows = db.raw.query("SELECT * FROM webhook_deliveries ORDER BY rowid").all() as Array<{
      id: string;
      app_id: string;
      event_name: string | null;
      outcome: string;
      status_code: number | null;
      created_at: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      app_id: "app-1",
      event_name: "pull_request",
      outcome: "ok",
      status_code: null,
    });
    expect(rows[1]).toMatchObject({ app_id: "app-1", event_name: null, outcome: "rejected", status_code: 401 });
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(rows[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("off-vocabulary outcome throws BEFORE any row is written (producer-side enforcement)", async () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    const store = createAppsStore(db);

    await expect(
      // Deliberately off-vocabulary: the runtime gate is the contract under
      // test, so the compiler's union is widened for this one call.
      store.recordDelivery({
        appId: "app-1",
        eventName: "pull_request",
        outcome: "not-an-outcome" as DeliveryOutcome,
        statusCode: null,
      }),
    ).rejects.toThrow(/not on the producer vocabulary/);
    const count = db.raw.query("SELECT COUNT(*) AS n FROM webhook_deliveries").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("DELIVERY_OUTCOMES is the frozen single source: exactly ok | paused | ignored | rejected", () => {
    expect(DELIVERY_OUTCOMES).toEqual(["ok", "paused", "ignored", "rejected"]);
    expect(Object.isFrozen(DELIVERY_OUTCOMES)).toBe(true);
  });

  test("deliverySummary returns the latest row + the 24h rejected count (ignored/paused/ok are healthy, not counted)", async () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    const store = createAppsStore(db);
    // Backdate every row but the newest so the order is observable
    // (datetime('now') has second resolution).
    await store.recordDelivery({ appId: "app-1", eventName: "ping", outcome: "ignored", statusCode: null });
    await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "ok", statusCode: null });
    await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "rejected", statusCode: 401 });
    await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "paused", statusCode: null });
    db.raw
      .prepare(
        `UPDATE webhook_deliveries SET created_at = datetime('now', '-25 hours')
         WHERE outcome IN ('ignored', 'ok', 'rejected')`,
      )
      .run();

    const summary = await store.deliverySummary("app-1");

    expect(summary.latest).toMatchObject({ outcome: "paused", status_code: null });
    expect(summary.rejected24h).toBe(0); // the rejected row is 25h old — outside the window
  });

  test("deliverySummary counts ONLY rejected rows inside the 24h window", async () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    const store = createAppsStore(db);
    await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "rejected", statusCode: 401 });
    await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "ok", statusCode: null });
    await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "rejected", statusCode: 500 });
    db.raw
      .prepare(
        `UPDATE webhook_deliveries SET created_at = datetime('now', '-25 hours')
         WHERE outcome = 'ok'`,
      )
      .run();

    const summary = await store.deliverySummary("app-1");

    expect(summary.rejected24h).toBe(2);
    expect(summary.latest).toMatchObject({ outcome: "rejected", status_code: 500 });
  });

  test("deliverySummary for an app with no rows: latest null, rejected24h 0", async () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    const summary = await createAppsStore(db).deliverySummary("app-1");
    expect(summary.latest).toBeNull();
    expect(summary.rejected24h).toBe(0);
  });

  test("listRecentDeliveries returns THIS App's rows, newest first, bounded by N", async () => {
    const db = createMigratedTestD1();
    seedAppRow(db, "app-1");
    seedAppRow(db, "app-2");
    const store = createAppsStore(db);
    for (let i = 1; i <= 7; i++) {
      await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "ok", statusCode: null });
    }
    await store.recordDelivery({ appId: "app-2", eventName: "ping", outcome: "ignored", statusCode: null });
    // Backdate the first six so the newest-first order is observable.
    db.raw
      .prepare(
        `UPDATE webhook_deliveries SET created_at = datetime('now', '-1 hour')
         WHERE id IN (SELECT id FROM webhook_deliveries ORDER BY rowid LIMIT 6)`,
      )
      .run();

    const recent = await store.listRecentDeliveries("app-1", 5);

    expect(recent).toHaveLength(5); // bounded by N
    expect(recent.every((r) => r.app_id === "app-1")).toBe(true); // sibling App never included
    expect(recent[0]!.created_at >= recent[4]!.created_at).toBe(true); // newest first
    expect(await store.listRecentDeliveries("no-such-app", 5)).toEqual([]);
  });
});

describe("per-App webhook face — best-effort delivery recording (plan 20)", () => {
  function createMigratedD1(withDeliveries = true): ReturnType<typeof createTestD1> {
    const db = createTestD1();
    // 0008 (plan 16): the github_apps ops columns (review_enabled /
    // last_webhook_at) the pause gate + touch read and write on every
    // delivery; 0011 (plan 20) is the delivery table under test — omitted
    // for the best-effort failure fixture.
    const names = ["0004_github_apps.sql", "0005_reviews_app_id.sql", "0008_github_apps_ops.sql"];
    if (withDeliveries) {
      names.push("0011_webhook_deliveries.sql");
    }
    for (const name of names) {
      db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }
    return db;
  }

  type SeedOptions = {
    slug: string;
    /** Plaintext webhook secret encrypted into the row (with the row-id AAD). */
    secret: string;
    githubAppId?: number;
  };

  /** Raw-insert an active, non-deleted github_apps row with real envelopes. */
  async function seedApp(
    db: ReturnType<typeof createTestD1>,
    opts: SeedOptions,
  ): Promise<{ id: string; slug: string }> {
    const id = crypto.randomUUID();
    const box = createSecretbox(TEST_KEY);
    const webhookSecretEnc = await box.encryptSecret(opts.secret, `github_apps.webhook_secret_enc:${id}`);
    const privateKeyEnc = await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`);
    const appCountRow = db.raw.query("SELECT COUNT(*) AS n FROM github_apps").get() as { n: number };
    const appCount = appCountRow.n;
    db.raw
      .prepare(
        `INSERT INTO github_apps
           (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
      )
      .run(id, opts.slug, opts.githubAppId ?? 1000 + appCount, opts.slug, privateKeyEnc, webhookSecretEnc);
    return { id, slug: opts.slug };
  }

  /** Queue stub capturing every enqueued payload. */
  function makeQueue() {
    const sent: ReviewJobPayload[] = [];
    const queue = {
      send: mock(async (message: ReviewJobPayload) => {
        sent.push(message);
      }),
    };
    return { queue, sent };
  }

  /** In-memory KV stub (idempotency pre-check + claim). */
  function makeKv() {
    const store = new Map<string, string>();
    return {
      kv: {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => {
          store.set(key, value);
        },
      },
      store,
    };
  }

  function makeEnv(db: ReturnType<typeof createTestD1>, overrides: Partial<Env> = {}): Env {
    const { kv } = makeKv();
    const { queue } = makeQueue();
    return {
      APP_ID: "999",
      PRIVATE_KEY: "legacy-pem",
      WEBHOOK_SECRET: LEGACY_SECRET,
      REVIEW_ENABLED: "true",
      IDEMPOTENCY_KV: kv as never,
      REVIEW_QUEUE: queue as never,
      DB: db as never,
      DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
      ...overrides,
    };
  }

  async function postWebhook(
    path: string,
    body: string,
    headers: Record<string, string>,
    env: Env,
  ): Promise<Response> {
    return worker.fetch(new Request(`https://worker.local${path}`, { method: "POST", headers, body }), env);
  }

  /** Sign a body the way GitHub does (the sha256=… header value). */
  async function signatureFor(secret: string, body: string): Promise<string> {
    return new Webhooks({ secret }).sign(body);
  }

  /** Full GitHub webhook headers for a signed delivery. */
  async function sigHeaders(secret: string, body: string, event = "pull_request"): Promise<Record<string, string>> {
    return { "x-hub-signature-256": await signatureFor(secret, body), "x-github-event": event };
  }

  /** Read every delivery row for one app, oldest first. */
  function deliveriesFor(
    db: ReturnType<typeof createTestD1>,
    appId: string,
  ): Array<{ event_name: string | null; outcome: string; status_code: number | null }> {
    return db.raw
      .query(
        `SELECT event_name, outcome, status_code FROM webhook_deliveries
         WHERE app_id = ? ORDER BY rowid`,
      )
      .all(appId) as Array<{ event_name: string | null; outcome: string; status_code: number | null }>;
  }

  const PR_PAYLOAD = {
    action: "opened",
    number: 42,
    installation: { id: 123 },
    pull_request: { number: 42, head: { sha: "abc123" } },
    repository: { name: "test-repo", owner: { login: "test-owner" } },
  };

  test("ok path: valid signature + whitelisted event + review_enabled=1 → 200 accepted + row outcome='ok'", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(deliveriesFor(db, appRow.id)).toEqual([
      { event_name: "pull_request", outcome: "ok", status_code: null },
    ]);
  });

  test("paused path: review_enabled=0 → 2xx ignored, zero enqueue + row outcome='paused'", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    await createAppsStore(db).setReviewEnabled(appRow.id, false);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(deliveriesFor(db, appRow.id)).toEqual([
      { event_name: "pull_request", outcome: "paused", status_code: null },
    ]);
  });

  test("ignored path: valid signature + non-whitelisted event → 2xx ignored + row outcome='ignored'", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/app-x", body, await sigHeaders("secret-x", body, "ping"), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(deliveriesFor(db, appRow.id)).toEqual([
      { event_name: "ping", outcome: "ignored", status_code: null },
    ]);
  });

  test("rejected path: bad signature → 401 + row outcome='rejected' with the classifier's status_code", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("wrong-secret", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
    expect(deliveriesFor(db, appRow.id)).toEqual([
      { event_name: "pull_request", outcome: "rejected", status_code: 401 },
    ]);
  });

  test("best-effort: a store failure logs a structured warn and the webhook response is unchanged", async () => {
    // No 0011 in this fixture — recordDelivery's INSERT hits "no such table".
    const db = createMigratedD1(false);
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const warn = mock((_msg: unknown) => {});
    const origWarn = console.warn;
    console.warn = warn;
    let res: Response;
    try {
      res = await postWebhook("/webhook/app-x", body, await sigHeaders("secret-x", body), env);
    } finally {
      console.warn = origWarn;
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1); // the enqueue is unaffected
    const line = warn.mock.calls.map((call) => String(call[0])).find((s) => s.includes("delivery_record_failed"));
    expect(line).toBeDefined();
    const fields = JSON.parse(line!) as { event: string };
    expect(fields.event).toBe("delivery_record_failed");
  });

  test("legacy face records NOTHING (AL-20-1: legacy 不落行)", async () => {
    const db = createMigratedD1();
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook",
      body,
      { "x-hub-signature-256": await signatureFor(LEGACY_SECRET, body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    const count = db.raw.query("SELECT COUNT(*) AS n FROM webhook_deliveries").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("pre-classify failures record NOTHING: kill-switch → 2xx ignored, unknown slug → 404", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const body = JSON.stringify(PR_PAYLOAD);

    // Kill-switch (REVIEW_ENABLED unset) returns before the slug lookup.
    const envKill = makeEnv(db, { REVIEW_QUEUE: queue as never, REVIEW_ENABLED: undefined });
    const resKill = await postWebhook("/webhook/app-x", body, await sigHeaders("secret-x", body), envKill);
    expect(resKill.status).toBe(200);
    expect(await resKill.text()).toBe("ignored");

    // Unknown slug → 404 before any signature work.
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const res404 = await postWebhook(
      "/webhook/no-such-app",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );
    expect(res404.status).toBe(404);

    expect(sent).toHaveLength(0);
    const count = db.raw.query("SELECT COUNT(*) AS n FROM webhook_deliveries").get() as { n: number };
    expect(count.n).toBe(0);
  });
});

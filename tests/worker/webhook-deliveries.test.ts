
import { describe, expect, mock, test } from "bun:test";
import { Webhooks } from "@octokit/webhooks";
import worker, { deliveryOutcomeFromWebhook } from "../../src/worker/index";
import { webhookRepositoryFullName } from "../../src/worker/webhooks";
import type { Env } from "../../src/worker/env";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { createReviewBotsStore, DELIVERY_OUTCOMES } from "../../src/dashboard/apps-store";
import { createTargetsStore } from "../../src/dashboard/targets-store";
import type { DeliveryOutcome } from "../../src/dashboard/apps-store";
import { createMigratedTestD1, createTestD1, type TestD1 } from "../store/helpers";
import {
  WEBHOOK_DELIVERIES_MIGRATIONS,
  WEBHOOK_DELIVERIES_TAIL,
  applyMigrations,
} from "../helpers/migration-shapes";
import type { ReviewJobPayload } from "../../src/contracts/review-job";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

describe("migrations/0011_webhook_deliveries.sql", () => {
  function shape(db: ReturnType<typeof createTestD1>): { parent: string; attribution: string } {
    const renamed = (db.raw
      .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'review_bots'")
      .get() as { present?: number } | null)?.present === 1;
    return renamed ? { parent: "review_bots", attribution: "bot_id" } : { parent: "github_apps", attribution: "app_id" };
  }

  function seedAppRow(db: ReturnType<typeof createTestD1>, id = "app-1"): void {
    const appNum = Number(id.replace(/\D/g, "")) || 1;
    const parent = shape(db).parent;
    const hasPath = (db.raw.query(`PRAGMA table_info(${parent})`).all() as Array<{ name: string }>).some(
      (column) => column.name === "webhook_path",
    );
    const pathColumn = hasPath ? "webhook_path, " : "";
    const pathValue = hasPath ? "?, " : "";
    const pathBind = hasPath ? [id] : [];
    db.raw
      .prepare(
        `INSERT INTO ${parent}
           (id, ${pathColumn}github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, deleted_at, created_at, updated_at)
         VALUES (?, ${pathValue}?, ?, ?, ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
      )
      .run(id, ...pathBind, id, 1000 + appNum, `App ${id}`, "v1.primary.aXZpdi5jdA==", "v1.primary.aXZpdi5jdA==");
  }

  function insertDelivery(
    db: ReturnType<typeof createTestD1>,
    overrides: Partial<Record<string, unknown>> = {},
  ): void {
    const row = {
      id: "delivery-1",
      bot_id: "app-1",
      event_name: "pull_request",
      outcome: "ok",
      status_code: null,
      ...overrides,
    };
    db.raw
      .prepare(
        `INSERT INTO webhook_deliveries (id, ${shape(db).attribution}, event_name, outcome, status_code)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.bot_id, row.event_name, row.outcome, row.status_code);
  }

  test("applies cleanly over a seeded production-shaped DB (0001–0010 with live rows); existing tables untouched", () => {
    const db = createTestD1();
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md)
         VALUES ('review-1', 123, 'acme', 'widgets', 42, '0123456789abcdef0123456789abcdef01234567', 'comment', 'ok')`,
      )
      .run();
    applyMigrations(db, [
      "0003_dashboard_users.sql",
      "0004_github_apps.sql",
      "0005_reviews_app_id.sql",
      "0006_app_provider_config.sql",
      "0007_reviews_app_id_index.sql",
      "0008_github_apps_ops.sql",
      "0009_app_model_roles.sql",
      "0010_review_failures.sql",
      "0036_app_identity.sql",
    ]);
    seedAppRow(db);

    expect(() => applyMigrations(db, ["0011_webhook_deliveries.sql"])).not.toThrow();
    const reviewCount = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviewCount.n).toBe(1);
    const index = db.raw
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_webhook_deliveries_app_created'")
      .get();
    expect(index).toBeDefined();
    const cols = db.raw.query("PRAGMA table_info(webhook_deliveries)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain("deliverable_hint");
  });

  test("created_at defaults to datetime('now'); every NOT NULL column rejects NULL", () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    insertDelivery(db);
    const row = db.raw.query("SELECT * FROM webhook_deliveries").get() as { id: string; created_at: string };
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const columns = db.raw.query("PRAGMA table_info(webhook_deliveries)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const valid: Record<string, string | number | null> = {
      id: "d-null",
      [shape(db).attribution]: "app-1",
      event_name: "pull_request",
      outcome: "ok",
      status_code: null,
      created_at: "2026-01-01 00:00:00",
      repository_full_name: "acme/widgets",
      reason: null,
    };
    expect(Object.keys(valid).sort()).toEqual(columns.map((column) => column.name).sort());
    for (const column of columns.filter((entry) => entry.notnull === 1)) {
      const values = { ...valid, [column.name]: null };
      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO webhook_deliveries (${columns.map((entry) => entry.name).join(", ")})
             VALUES (${columns.map(() => "?").join(", ")})`,
          )
          .run(...columns.map((entry) => values[entry.name]!)),
      ).toThrow(new RegExp(`NOT NULL constraint failed: webhook_deliveries\\.${column.name}`));
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

  test("bot_id is NOT NULL FK to review_bots — an unknown app is refused", () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    expect(() => insertDelivery(db, { id: "delivery-fk", bot_id: "no-such-app" })).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});

describe("migrations/0043_webhook_delivery_repository.sql", () => {
  function preSourceDb(): TestD1 {
    const db = createTestD1();
    applyMigrations(db, ["0004_github_apps.sql", "0036_app_identity.sql", "0011_webhook_deliveries.sql"]);
    return db;
  }

  test("applies over existing delivery rows: they survive with a NULL source, and a new insert can carry owner/name", () => {
    const db = preSourceDb();
    db.raw
      .prepare(
        `INSERT INTO github_apps
           (id, webhook_path, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, deleted_at, created_at, updated_at)
         VALUES ('app-1', 'app-1', 'app-1', 1001, 'App 1', 'v1.primary.aXZpdi5jdA==', 'v1.primary.aXZpdi5jdA==',
                 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO webhook_deliveries (id, app_id, event_name, outcome, status_code)
         VALUES ('delivery-old', 'app-1', 'pull_request', 'ok', NULL)`,
      )
      .run();

    expect(() => applyMigrations(db, ["0043_webhook_delivery_repository.sql"])).not.toThrow();
    expect(db.raw.query("SELECT id, repository_full_name FROM webhook_deliveries").all()).toEqual([
      { id: "delivery-old", repository_full_name: null },
    ]);

    db.raw
      .prepare(
        `INSERT INTO webhook_deliveries (id, app_id, event_name, outcome, status_code, repository_full_name)
         VALUES ('delivery-new', 'app-1', 'pull_request', 'ok', NULL, 'acme/widgets')`,
      )
      .run();
    expect(
      db.raw.query("SELECT repository_full_name FROM webhook_deliveries WHERE id = 'delivery-new'").get(),
    ).toEqual({ repository_full_name: "acme/widgets" });
  });
});

describe("webhookRepositoryFullName (delivery source repo, migration 0043)", () => {
  const parse = JSON.parse as (text: string) => unknown;

  test("full_name wins, owner/name is the fallback, and a document with no source is null — never throws", () => {
    expect(
      webhookRepositoryFullName(
        parse(JSON.stringify({ repository: { name: "widgets", owner: { login: "acme" }, full_name: "acme/widgets" } })),
      ),
    ).toBe("acme/widgets");
    expect(
      webhookRepositoryFullName(parse(JSON.stringify({ repository: { name: "widgets", owner: { login: "acme" } } }))),
    ).toBe("acme/widgets");
    expect(
      webhookRepositoryFullName(parse(JSON.stringify({ repository: { name: "", owner: { login: "acme" } } }))),
    ).toBeNull();
    expect(webhookRepositoryFullName(parse(JSON.stringify({ zen: "Keep it logically awesome." })))).toBeNull();
    expect(webhookRepositoryFullName(parse(JSON.stringify({ repository: null })))).toBeNull();
    expect(webhookRepositoryFullName(null)).toBeNull();
    expect(webhookRepositoryFullName(parse("null"))).toBeNull();
  });

  test("the preferred source is read on its own, without a valid owner/name pair", () => {
    expect(webhookRepositoryFullName(parse(JSON.stringify({ repository: { full_name: "acme/widgets" } })))).toBe(
      "acme/widgets",
    );
    expect(
      webhookRepositoryFullName(
        parse(JSON.stringify({ repository: { full_name: "acme/widgets", name: 42, owner: { login: "" } } })),
      ),
    ).toBe("acme/widgets");
    expect(
      webhookRepositoryFullName(
        parse(JSON.stringify({ repository: { full_name: "acme/widgets", name: "other", owner: { login: "elsewhere" } } })),
      ),
    ).toBe("acme/widgets");
    expect(
      webhookRepositoryFullName(
        parse(JSON.stringify({ repository: { full_name: "", name: "widgets", owner: { login: "acme" } } })),
      ),
    ).toBe("acme/widgets");
  });
});

describe("apps-store delivery face (recordDelivery / deliverySummary / listDeliveries)", () => {
  function seedAppRow(db: ReturnType<typeof createTestD1>, id = "app-1"): void {
    const appNum = Number(id.replace(/\D/g, "")) || 1;
    db.raw
      .prepare(
        `INSERT INTO review_bots
           (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
      )
      .run(id, id, 1000 + appNum, `App ${id}`, "v1.primary.aXZpdi5jdA==", "v1.primary.aXZpdi5jdA==");
  }

  test("recordDelivery persists a full row: UUID id, caller fields, datetime('now') created_at", async () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    const store = createReviewBotsStore(db);

    await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "ok", statusCode: null, repositoryFullName: null, reason: null });
    await store.recordDelivery({ appId: "app-1", eventName: null, outcome: "rejected", statusCode: 401, repositoryFullName: null, reason: null });

    const rows = db.raw.query("SELECT * FROM webhook_deliveries ORDER BY rowid").all() as Array<{
      id: string;
      bot_id: string;
      event_name: string | null;
      outcome: string;
      status_code: number | null;
      created_at: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      bot_id: "app-1",
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
    const store = createReviewBotsStore(db);

    await expect(
      store.recordDelivery({
        appId: "app-1",
        eventName: "pull_request",
        outcome: "not-an-outcome" as DeliveryOutcome,
        statusCode: null,
        repositoryFullName: null,
        reason: null,
      }),
    ).rejects.toThrow(/not on the producer vocabulary/);
    const count = db.raw.query("SELECT COUNT(*) AS n FROM webhook_deliveries").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("DELIVERY_OUTCOMES is the frozen single source: exactly ok | paused | ignored | rejected | skipped | refused", () => {
    expect(DELIVERY_OUTCOMES).toEqual(["ok", "paused", "ignored", "rejected", "skipped", "refused"]);
    expect(Object.isFrozen(DELIVERY_OUTCOMES)).toBe(true);
  });

  test("deliverySummary returns the latest row + the 24h rejected count (ignored/paused/ok are healthy, not counted)", async () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    const store = createReviewBotsStore(db);
    await store.recordDelivery({ appId: "app-1", eventName: "ping", outcome: "ignored", statusCode: null, repositoryFullName: null, reason: null });
    await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "ok", statusCode: null, repositoryFullName: null, reason: null });
    await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "rejected", statusCode: 401, repositoryFullName: null, reason: null });
    await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "paused", statusCode: null, repositoryFullName: null, reason: null });
    db.raw
      .prepare(
        `UPDATE webhook_deliveries SET created_at = datetime('now', '-25 hours')
         WHERE outcome IN ('ignored', 'ok', 'rejected')`,
      )
      .run();

    const summary = await store.deliverySummary("app-1");

    expect(summary.latest).toMatchObject({ outcome: "paused", status_code: null });
    expect(summary.rejected24h).toBe(0);
  });

  test("deliverySummary counts ONLY rejected rows inside the 24h window", async () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    const store = createReviewBotsStore(db);
    await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "rejected", statusCode: 401, repositoryFullName: null, reason: null });
    await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "ok", statusCode: null, repositoryFullName: null, reason: null });
    await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "rejected", statusCode: 500, repositoryFullName: null, reason: null });
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
    const summary = await createReviewBotsStore(db).deliverySummary("app-1");
    expect(summary.latest).toBeNull();
    expect(summary.rejected24h).toBe(0);
  });

  test("listDeliveries returns THIS App's rows, newest first inside its tier, bounded by the caller's window", async () => {
    const db = createMigratedTestD1();
    seedAppRow(db, "app-1");
    seedAppRow(db, "app-2");
    const store = createReviewBotsStore(db);
    for (let i = 1; i <= 7; i++) {
      await store.recordDelivery({ appId: "app-1", eventName: "pull_request", outcome: "ok", statusCode: null, repositoryFullName: null, reason: null });
    }
    await store.recordDelivery({ appId: "app-2", eventName: "ping", outcome: "ignored", statusCode: null, repositoryFullName: null, reason: null });
    db.raw
      .prepare(
        `UPDATE webhook_deliveries SET created_at = datetime('now', '-1 hour')
         WHERE id IN (SELECT id FROM webhook_deliveries ORDER BY rowid LIMIT 6)`,
      )
      .run();

    const page = await store.listDeliveries("app-1", {
      repo: null,
      sinceDays: null,
      eventName: null,
      limit: 5,
      offset: 0,
    });

    expect(page.rows).toHaveLength(5);
    expect(page.total).toBe(7);
    expect(page.rows.every((r) => r.bot_id === "app-1")).toBe(true);
    expect(page.rows[0]!.created_at >= page.rows[4]!.created_at).toBe(true);

    const empty = await store.listDeliveries("no-such-app", {
      repo: null,
      sinceDays: null,
      eventName: null,
      limit: 5,
      offset: 0,
    });
    expect(empty.rows).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.repos).toEqual([]);
    expect(empty.types).toEqual([]);
  });

  test("listDeliveries pages by OFFSET: the next window is disjoint and total stays the filtered size", async () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    const store = createReviewBotsStore(db);
    for (let i = 1; i <= 5; i++) {
      await store.recordDelivery({
        appId: "app-1",
        eventName: "pull_request",
        outcome: "ok",
        statusCode: null,
        repositoryFullName: null,
        reason: null,
      });
      db.raw.prepare("UPDATE webhook_deliveries SET created_at = datetime('now', ?) WHERE id = (SELECT id FROM webhook_deliveries ORDER BY rowid DESC LIMIT 1)").run(`-${10 - i} seconds`);
    }

    const filters = { repo: null, sinceDays: null, eventName: null, limit: 2, offset: 0 } as const;
    const first = await store.listDeliveries("app-1", { ...filters, offset: 0 });
    const second = await store.listDeliveries("app-1", { ...filters, offset: 2 });

    expect(first.rows).toHaveLength(2);
    expect(second.rows).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(second.total).toBe(5);
    const ids = new Set(first.rows.map((row) => row.id));
    expect(second.rows.every((row) => !ids.has(row.id))).toBe(true);
    expect((await store.listDeliveries("app-1", { ...filters, offset: 4 })).rows).toHaveLength(1);
    const past = await store.listDeliveries("app-1", { ...filters, offset: 6 });
    expect(past.rows).toEqual([]);
    expect(past.total).toBe(5);
  });

  test("listDeliveries filters narrow the page AND the total; the option sets stay unnarrowed", async () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    const store = createReviewBotsStore(db);
    const record = (eventName: string, repositoryFullName: string | null) =>
      store.recordDelivery({
        appId: "app-1",
        eventName,
        outcome: "ok",
        statusCode: null,
        repositoryFullName,
        reason: null,
      });
    await record("pull_request", "acme/web");
    await record("check_run", "acme/web");
    await record("pull_request", "acme/api");
    await record("pull_request", "acme/web");
    db.raw
      .prepare(
        `UPDATE webhook_deliveries SET created_at = datetime('now', '-30 days')
         WHERE id = (SELECT id FROM webhook_deliveries WHERE repository_full_name = 'acme/web' ORDER BY rowid DESC LIMIT 1)`,
      )
      .run();

    const base = { limit: 50, offset: 0 } as const;
    const all = await store.listDeliveries("app-1", { repo: null, sinceDays: null, eventName: null, ...base });
    const byRepo = await store.listDeliveries("app-1", { repo: "acme/web", sinceDays: null, eventName: null, ...base });
    const byType = await store.listDeliveries("app-1", { repo: null, sinceDays: null, eventName: "check_run", ...base });
    const byWindow = await store.listDeliveries("app-1", { repo: null, sinceDays: 7, eventName: null, ...base });

    expect(all.total).toBe(4);
    expect(byRepo.total).toBe(3);
    expect(byRepo.rows.every((row) => row.repository_full_name === "acme/web")).toBe(true);
    expect(byType.total).toBe(1);
    expect(byType.rows.every((row) => row.event_name === "check_run")).toBe(true);
    expect(byWindow.total).toBe(3);
    expect(byType.repos).toEqual(["acme/api", "acme/web"]);
    expect(byType.types).toEqual(["check_run", "pull_request"]);
    const missing = await store.listDeliveries("app-1", { repo: "nobody/nothing", sinceDays: null, eventName: null, ...base });
    expect(missing.rows).toEqual([]);
    expect(missing.total).toBe(0);
  });

  test("listDeliveries persists and returns the refusal reason; a non-reject row carries none", async () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    const store = createReviewBotsStore(db);
    await store.recordDelivery({
      appId: "app-1",
      eventName: "pull_request",
      outcome: "rejected",
      statusCode: 401,
      repositoryFullName: "acme/web",
      reason: "signature verification failed",
    });
    await store.recordDelivery({
      appId: "app-1",
      eventName: "pull_request",
      outcome: "ok",
      statusCode: null,
      repositoryFullName: "acme/web",
      reason: null,
    });

    const page = await store.listDeliveries("app-1", {
      repo: null,
      sinceDays: null,
      eventName: null,
      limit: 10,
      offset: 0,
    });
    const rejected = page.rows.find((row) => row.outcome === "rejected");
    const ok = page.rows.find((row) => row.outcome === "ok");
    expect(rejected?.reason).toBe("signature verification failed");
    expect(ok?.reason).toBeNull();
  });

  test("recordDelivery caps event_name at 64 chars and repository_full_name at 160 at persist time", async () => {
    const db = createMigratedTestD1();
    seedAppRow(db);
    const store = createReviewBotsStore(db);

    await store.recordDelivery({
      appId: "app-1",
      eventName: "x".repeat(200),
      outcome: "ok",
      statusCode: null,
      repositoryFullName: "y".repeat(2000),
      reason: null,
    });
    await store.recordDelivery({
      appId: "app-1",
      eventName: `${"x".repeat(63)}😀`,
      outcome: "ok",
      statusCode: null,
      repositoryFullName: `${"y".repeat(159)}😀`,
      reason: null,
    });
    await store.recordDelivery({ appId: "app-1", eventName: null, outcome: "ignored", statusCode: null, repositoryFullName: null, reason: null });

    const rows = db.raw
      .query("SELECT event_name, repository_full_name FROM webhook_deliveries ORDER BY rowid")
      .all() as Array<{ event_name: string | null; repository_full_name: string | null }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.event_name).toBe("x".repeat(64));
    expect(rows[0]!.repository_full_name).toBe("y".repeat(160));
    expect(rows[1]!.event_name).toBe("x".repeat(63));
    expect(rows[1]!.repository_full_name).toBe("y".repeat(159));
    expect(rows[2]!.event_name).toBeNull();
    expect(rows[2]!.repository_full_name).toBeNull();
  });
});

describe("per-App webhook face — best-effort delivery recording", () => {
  function createMigratedD1(withDeliveries = true): ReturnType<typeof createTestD1> {
    const db = createTestD1();
    applyMigrations(db, WEBHOOK_DELIVERIES_MIGRATIONS);
    if (withDeliveries) {
      applyMigrations(db, WEBHOOK_DELIVERIES_TAIL);
    } else {
      applyMigrations(db, WEBHOOK_DELIVERIES_TAIL);
      db.raw.run("DROP TABLE webhook_deliveries");
    }
    return db;
  }

  type SeedOptions = {
    slug: string;
    secret: string;
    githubAppId?: number;
  };

  async function seedApp(
    db: ReturnType<typeof createTestD1>,
    opts: SeedOptions,
  ): Promise<{ id: string; slug: string; targetId: string }> {
    const id = opts.slug;
    const box = createSecretbox(TEST_KEY);
    const webhookSecretEnc = await box.encryptSecret(opts.secret, `github_apps.webhook_secret_enc:${id}`);
    const privateKeyEnc = await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`);
    const appCountRow = db.raw.query(`SELECT COUNT(*) AS n FROM review_bots`).get() as { n: number };
    const appCount = appCountRow.n;
    db.raw
      .prepare(
        `INSERT INTO review_bots
           (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
      )
      .run(id, opts.slug, opts.githubAppId ?? 1000 + appCount, opts.slug, privateKeyEnc, webhookSecretEnc);
    db.raw
      .prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, 'default')")
      .run(id);
    const target = await createTargetsStore(db).create({
      workspaceId: "default",
      botId: id,
      repoId: 5000,
      repoOwner: "test-owner",
      repoName: "test-repo",
      createdBy: "tester",
    });
    if (target.outcome !== "created") throw new Error("the fixture target was not created");
    db.raw
      .prepare(
        `INSERT OR REPLACE INTO review_runtime_settings (key, value, updated_at)
         VALUES ('review.route.workflow', 'on', datetime('now'))`,
      )
      .run();
    return { id, slug: opts.slug, targetId: target.target.id };
  }

  function makeQueue() {
    const sent: ReviewJobPayload[] = [];
    const queue = {
      send: mock(async (message: ReviewJobPayload) => {
        sent.push(message);
      }),
    };
    return { queue, sent };
  }

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
      IDEMPOTENCY_KV: kv as never,
      REVIEW_QUEUE: queue as never,
      DB: db as never,
      DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
      DEPLOYMENT_MODE: "self-hosted",
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

  async function signatureFor(secret: string, body: string): Promise<string> {
    return new Webhooks({ secret }).sign(body);
  }

  async function sigHeaders(secret: string, body: string, event = "pull_request"): Promise<Record<string, string>> {
    return { "x-hub-signature-256": await signatureFor(secret, body), "x-github-event": event };
  }

  function deliveriesFor(
    db: ReturnType<typeof createTestD1>,
    appId: string,
  ): Array<{ event_name: string | null; outcome: string; status_code: number | null }> {
    return db.raw
      .query(
        `SELECT event_name, outcome, status_code FROM webhook_deliveries
         WHERE bot_id = ? ORDER BY rowid`,
      )
      .all(appId) as Array<{ event_name: string | null; outcome: string; status_code: number | null }>;
  }

  const PR_PAYLOAD = {
    action: "opened",
    number: 42,
    installation: { id: 123 },
    pull_request: { number: 42, state: "open", head: { sha: "abc123" }, user: { login: "alice" } },
    repository: { id: 5000, name: "test-repo", owner: { login: "test-owner" } },
  };

  test("ok path: valid signature + whitelisted event + review_enabled=1 → 200 accepted + row outcome='ok'", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(deliveriesFor(db, appRow.id)).toEqual([
      { event_name: "pull_request", outcome: "ok", status_code: null },
    ]);
  });

  test("a pull_request delivery persists the payload's source repository (repository.full_name)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const body = JSON.stringify({
      ...PR_PAYLOAD,
      repository: { name: "test-repo", owner: { login: "test-owner" }, full_name: "test-owner/test-repo" },
    });

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), makeEnv(db));

    expect(res.status).toBe(200);
    const rows = db.raw
      .query("SELECT repository_full_name FROM webhook_deliveries WHERE bot_id = ?")
      .all(appRow.id) as Array<{ repository_full_name: string | null }>;
    expect(rows).toEqual([{ repository_full_name: "test-owner/test-repo" }]);
  });

  test("an ignored delivery still records its source repository", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const body = JSON.stringify({
      zen: "Keep it logically awesome.",
      repository: { name: "test-repo", owner: { login: "test-owner" }, full_name: "test-owner/test-repo" },
    });

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      await sigHeaders("secret-x", body, "ping"),
      makeEnv(db),
    );

    expect(await res.text()).toBe("ignored");
    const rows = db.raw
      .query("SELECT repository_full_name FROM webhook_deliveries WHERE bot_id = ?")
      .all(appRow.id) as Array<{ repository_full_name: string | null }>;
    expect(rows).toEqual([{ repository_full_name: "test-owner/test-repo" }]);
  });

  test("a payload without a repository persists NULL — the unknown-source row still records", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const body = JSON.stringify({ zen: "Keep it logically awesome." });

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      await sigHeaders("secret-x", body, "ping"),
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const rows = db.raw
      .query("SELECT event_name, repository_full_name FROM webhook_deliveries WHERE bot_id = ?")
      .all(appRow.id) as Array<{ event_name: string | null; repository_full_name: string | null }>;
    expect(rows).toEqual([{ event_name: "ping", repository_full_name: null }]);
  });

  test("paused path: review_enabled=0 → 2xx ignored, zero enqueue + row outcome='paused'", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    await createReviewBotsStore(db).setReviewEnabled(appRow.id, false);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(deliveriesFor(db, appRow.id)).toEqual([
      { event_name: "pull_request", outcome: "paused", status_code: null },
    ]);
  });

  test("paused path: the target's business pause (the settings switch) → 2xx ignored, zero enqueue + row outcome='paused'", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    // The row's own pause answers only with inheritance off; a following target
    // answers the workspace default (covered separately).
    db.raw
      .prepare("UPDATE review_targets SET follow_workspace_defaults = 0 WHERE id = ?")
      .run(appRow.targetId);
    expect(await createTargetsStore(db).setReviewEnabled("default", appRow.targetId, false)).toBe(true);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(deliveriesFor(db, appRow.id)).toEqual([
      { event_name: "pull_request", outcome: "paused", status_code: null },
    ]);
    const bot = db.raw
      .query("SELECT review_enabled FROM review_bots WHERE id = ?")
      .get(appRow.id) as { review_enabled: number } | null;
    expect(bot?.review_enabled).toBe(1);
  });

  test("ignored path: valid signature + non-whitelisted event → 2xx ignored + row outcome='ignored'", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body, "ping"), env);

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
      "/webhook/default/app-x",
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
      res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);
    } finally {
      console.warn = origWarn;
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    const line = warn.mock.calls.map((call) => String(call[0])).find((s) => s.includes("delivery_record_failed"));
    expect(line).toBeDefined();
    const fields = JSON.parse(line!) as { event: string };
    expect(fields.event).toBe("delivery_record_failed");
  });

  function raceParentMutation(
    db: ReturnType<typeof createTestD1>,
    appId: string,
    mutation: "soft-delete" | "hard-delete",
  ): void {
    const originalPrepare = db.prepare.bind(db);
    let injected = false;
    const patched = ((query: string) => {
      const stmt = originalPrepare(query);
      if (!injected && query.includes("INSERT INTO webhook_deliveries")) {
        injected = true;
        const originalRun = stmt.run.bind(stmt);
        stmt.run = (async () => {
          if (mutation === "soft-delete") {
            db.raw
              .prepare(
                `UPDATE review_bots SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
              )
              .run(appId);
          } else {
            db.raw.prepare(`DELETE FROM review_bots WHERE id = ?`).run(appId);
          }
          return originalRun();
        }) as typeof stmt.run;
      }
      return stmt;
    }) as typeof db.prepare;
    db.prepare = patched;
  }

  test("best-effort: parent SOFT-deleted between classify and insert still records — FK NO ACTION holds (the soft-delete is an UPDATE, the parent row exists) and the response is unchanged", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    raceParentMutation(db, appRow.id, "soft-delete");
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(deliveriesFor(db, appRow.id)).toEqual([
      { event_name: "pull_request", outcome: "ok", status_code: null },
    ]);
    const app = db.raw
      .query("SELECT deleted_at FROM review_bots WHERE id = ?")
      .get(appRow.id) as { deleted_at: string | null };
    expect(app.deleted_at).not.toBeNull();
  });

  test("best-effort: parent HARD-deleted between classify and insert → FK insert throws → delivery_record_failed warn + response unchanged", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    raceParentMutation(db, appRow.id, "hard-delete");
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const warn = mock((_msg: unknown) => {});
    const origWarn = console.warn;
    console.warn = warn;
    let res: Response;
    try {
      res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);
    } finally {
      console.warn = origWarn;
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(deliveriesFor(db, appRow.id)).toEqual([]);
    const line = warn.mock.calls.map((call) => String(call[0])).find((s) => s.includes("delivery_record_failed"));
    expect(line).toBeDefined();
    const fields = JSON.parse(line!) as { event: string };
    expect(fields.event).toBe("delivery_record_failed");
  });

  test("best-effort: a store failure on a REJECTED record still returns the classifier's status (401), never a 500", async () => {
    const db = createMigratedD1(false);
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const warn = mock((_msg: unknown) => {});
    const origWarn = console.warn;
    console.warn = warn;
    let res: Response;
    try {
      res = await postWebhook(
        "/webhook/default/app-x",
        body,
        { "x-hub-signature-256": await signatureFor("wrong-secret", body), "x-github-event": "pull_request" },
        env,
      );
    } finally {
      console.warn = origWarn;
    }

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("signature verification failed");
    expect(sent).toHaveLength(0);
    const line = warn.mock.calls.map((call) => String(call[0])).find((s) => s.includes("delivery_record_failed"));
    expect(line).toBeDefined();
    const fields = JSON.parse(line!) as { event: string };
    expect(fields.event).toBe("delivery_record_failed");
  });

  test("pre-classify failures record NOTHING: unknown slug → 404", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const body = JSON.stringify(PR_PAYLOAD);

    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const res404 = await postWebhook(
      "/webhook/default/no-such-app",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );
    expect(res404.status).toBe(404);

    expect(sent).toHaveLength(0);
    const count = db.raw.query("SELECT COUNT(*) AS n FROM webhook_deliveries").get() as { n: number };
    expect(count.n).toBe(0);
  });
  test("route gate off: a verified job records outcome='refused' with the gate's reason and still answers 200", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    db.raw
      .prepare(
        `INSERT OR REPLACE INTO review_runtime_settings (key, value, updated_at)
         VALUES ('review.route.workflow', 'off', datetime('now'))`,
      )
      .run();
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(deliveriesFor(db, appRow.id)).toEqual([
      { event_name: "pull_request", outcome: "refused", status_code: null },
    ]);
    const reason = db.raw
      .query("SELECT reason FROM webhook_deliveries WHERE bot_id = ?")
      .all(appRow.id) as Array<{ reason: string | null }>;
    expect(reason).toHaveLength(1);
    expect(reason[0]!.reason).toContain("review.route.workflow");
  });

  test("route gate off: a ledger write fault still answers 200 and logs delivery_record_failed", async () => {
    const db = createMigratedD1(false);
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    db.raw
      .prepare(
        `INSERT OR REPLACE INTO review_runtime_settings (key, value, updated_at)
         VALUES ('review.route.workflow', 'off', datetime('now'))`,
      )
      .run();
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const warn = mock((_msg: unknown) => {});
    const origWarn = console.warn;
    console.warn = warn;
    let res: Response;
    try {
      res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);
    } finally {
      console.warn = origWarn;
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    const line = warn.mock.calls.map((call) => String(call[0])).find((s) => s.includes("delivery_record_failed"));
    expect(line).toBeDefined();
    const fields = JSON.parse(line!) as { event: string };
    expect(fields.event).toBe("delivery_record_failed");
  });

  test("route gate off: a paused App's delivery records 'paused' — the gate does not rewrite the visible reason", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    await createReviewBotsStore(db).setReviewEnabled(appRow.id, false);
    db.raw
      .prepare(
        `INSERT OR REPLACE INTO review_runtime_settings (key, value, updated_at)
         VALUES ('review.route.workflow', 'off', datetime('now'))`,
      )
      .run();
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(deliveriesFor(db, appRow.id)).toEqual([
      { event_name: "pull_request", outcome: "paused", status_code: null },
    ]);
    const reason = db.raw
      .query("SELECT reason FROM webhook_deliveries WHERE bot_id = ?")
      .all(appRow.id) as Array<{ reason: string | null }>;
    expect(reason).toEqual([{ reason: null }]);
  });

  test("route gate off after a successful delivery: the refused row wins the dashboard's ordered read", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    // Gate on: the first delivery enqueues and records 'ok'.
    const first = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);
    expect(await first.text()).toBe("accepted");

    db.raw
      .prepare(
        `INSERT OR REPLACE INTO review_runtime_settings (key, value, updated_at)
         VALUES ('review.route.workflow', 'off', datetime('now'))`,
      )
      .run();
    const second = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);
    expect(await second.text()).toBe("ignored");

    const summary = await createReviewBotsStore(db).deliverySummary(appRow.id);
    expect(summary.latest?.outcome).toBe("refused");
  });

});

describe("deliveryOutcomeFromWebhook (classifier outcome → delivery outcome, QC S-2)", () => {
  test("maps reject → rejected / ignore → ignored / job → paused when either review switch is off, else ok", () => {
    expect(deliveryOutcomeFromWebhook({ kind: "reject" }, 1, true)).toBe("rejected");
    expect(deliveryOutcomeFromWebhook({ kind: "reject" }, 0, false)).toBe("rejected");
    expect(deliveryOutcomeFromWebhook({ kind: "ignore" }, 1, true)).toBe("ignored");
    expect(deliveryOutcomeFromWebhook({ kind: "ignore" }, 0, false)).toBe("ignored");
    expect(deliveryOutcomeFromWebhook({ kind: "job" }, 0, true)).toBe("paused");
    expect(deliveryOutcomeFromWebhook({ kind: "job" }, 1, false)).toBe("paused");
    expect(deliveryOutcomeFromWebhook({ kind: "job" }, 1, true)).toBe("ok");
    expect(deliveryOutcomeFromWebhook({ kind: "job" }, 1, true, true)).toBe("skipped");
    expect(deliveryOutcomeFromWebhook({ kind: "job" }, 0, true, true)).toBe("paused");
    expect(deliveryOutcomeFromWebhook({ kind: "job" }, 1, false, true)).toBe("paused");
    expect(deliveryOutcomeFromWebhook({ kind: "reject" }, 1, true, true)).toBe("rejected");
    expect(deliveryOutcomeFromWebhook({ kind: "job" }, 1, true, false, true)).toBe("refused");
    expect(deliveryOutcomeFromWebhook({ kind: "job" }, 0, true, false, true)).toBe("paused");
    expect(deliveryOutcomeFromWebhook({ kind: "job" }, 1, false, false, true)).toBe("paused");
    expect(deliveryOutcomeFromWebhook({ kind: "ignore" }, 1, true, false, true)).toBe("ignored");
  });

  test.each([
    [0, true],
    [1, true],
    [0, false],
    [1, false],
  ])(
    "maps installation → ignored regardless of the switches (reviewEnabled=%i, reviewGlobal=%s)",
    (reviewEnabled, reviewGlobal) => {
      expect(deliveryOutcomeFromWebhook({ kind: "installation" }, reviewEnabled, reviewGlobal)).toBe("ignored");
    },
  );
});

/**
 * Plan 13 Task 1 tests: migrations 0004/0005 + the github_apps store layer
 * (spec dashboard-multi-app-platform § Data model, architect lock L2).
 *
 * Production-shaped sequence (the brief's STOP anchor): the bun:sqlite
 * double applies 0001/0002 (via tests/store/helpers), rows are SEEDED into
 * the existing reviews table, and ONLY THEN do 0004/0005 apply — the
 * append-only ALTER assumption is exercised against a DB that already holds
 * data, exactly like `wrangler d1 migrations apply` on production. If
 * reviews has diverged from 0001/0002 and the ALTERs fail here, Task 1
 * STOPs (no table rebuild improvisation).
 *
 * Schema contracts pinned by lock L2:
 *   - 0004 creates github_apps BEFORE app_installations (same-file FK);
 *     status CHECK ('active','disabled'); slug / github_app_id UNIQUE;
 *     NO ON DELETE clause anywhere (default NO ACTION — a hard DELETE of an
 *     app referenced by reviews must be refused; soft-delete is the only
 *     removal path).
 *   - 0005 is the metadata-only `ALTER TABLE reviews ADD COLUMN app_id TEXT
 *     REFERENCES github_apps(id)`; existing rows keep app_id NULL (legacy).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createTestD1 } from "../store/helpers";
import { createAppsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import type { D1Like } from "../../src/store/types";
import type { CreateAppInput, GithubAppRow } from "../../src/dashboard/apps-store";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

/**
 * Parameterized write on the raw bun:sqlite handle (params go straight to
 * run() — the raw statement face has no bind step). Statements throw
 * SYNCHRONOUSLY here, so failure assertions use expect(() => ...).toThrow.
 */
function rawRun(
  db: ReturnType<typeof createTestD1>,
  sql: string,
  ...params: (string | number | null)[]
): void {
  db.raw.prepare(sql).run(...params);
}

/** Apply one migration file verbatim (filename order = wrangler order). */
function applyMigration(db: ReturnType<typeof createTestD1>, name: string): void {
  db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
}

/** A DB shaped like production before plan 13: 0001/0002 + seeded rows. */function createSeededD1(): ReturnType<typeof createTestD1> {
  const db = createTestD1();
  // One M1-era row (raw_output, no envelope) and one v1 row (envelope).
  db.raw
    .prepare(
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md, raw_output)
       VALUES ('review-1', 123, 'acme', 'widgets', 42, '0123456789abcdef0123456789abcdef01234567', 'comment', 'ok', 'raw'),
              ('review-2', 123, 'acme', 'widgets', 43, 'ffffffffffffffffffffffffffffffffffffffff', 'approve', 'fine', NULL)`,
    )
    .run();
  db.raw
    .prepare(`UPDATE reviews SET envelope = '{"schema":"mstar.review/v1"}' WHERE id = 'review-2'`)
    .run();
  return db;
}
/** Seed DB + apply both plan-13 migrations in locked order 0004 → 0005. */
function createMigratedD1(): ReturnType<typeof createTestD1> {
  const db = createSeededD1();
  applyMigration(db, "0004_github_apps.sql");
  applyMigration(db, "0005_reviews_app_id.sql");
  return db;
}

function store(db: D1Like) {
  return createAppsStore(db);
}

const APP_INPUT: CreateAppInput = {
  // T1 review pin: the caller supplies the row PK so the secretbox AAD
  // (github_apps.<column>:<id>) is computable BEFORE insert.
  id: "018f4a2e-7c1d-4e5a-9b2f-3d6c8a1e4f70",
  slug: "mstar-inspector-octocat",
  githubAppId: 123456,
  name: "mstar-inspector-octocat",
  privateKeyEnc: "v1.primary.aXZpdi.Y3QmIHRhZw==",
  webhookSecretEnc: "v1.primary.aXZpdi.d2ViaG9vaw==",
  createdBy: "octocat",
};

async function seedApp(db: D1Like, overrides: Partial<CreateAppInput> = {}): Promise<GithubAppRow> {
  // Every seed mints its OWN caller-supplied id (the T1 pin shape) unless
  // the test explicitly pins one; APP_INPUT.id documents a fixed example.
  return store(db).createApp({ ...APP_INPUT, id: crypto.randomUUID(), ...overrides });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("migration 0004_github_apps.sql (on a seeded production-shaped DB)", () => {
  test("applies cleanly after 0001/0002 over existing review rows", () => {
    expect(() => createMigratedD1()).not.toThrow();
  });

  test("github_apps columns follow the spec data model", () => {
    const db = createMigratedD1();
    const cols = db.raw.query("PRAGMA table_info(github_apps)").all() as Array<{
      name: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    for (const name of [
      "id",
      "slug",
      "github_app_id",
      "name",
      "private_key_enc",
      "webhook_secret_enc",
      "created_by",
      "status",
      "deleted_at",
      "created_at",
      "updated_at",
    ]) {
      expect(byName.has(name)).toBe(true);
    }
    expect(byName.get("id")!.pk).toBe(1);
    expect(byName.get("slug")!.notnull).toBe(1);
    expect(byName.get("github_app_id")!.notnull).toBe(1);
    expect(byName.get("private_key_enc")!.notnull).toBe(1);
    expect(byName.get("webhook_secret_enc")!.notnull).toBe(1);
    expect(byName.get("status")!.notnull).toBe(1);
    expect(byName.get("status")!.dflt_value).toBe("'active'");
    expect(byName.get("deleted_at")!.notnull).toBe(0); // NULL = not deleted
    expect(byName.get("created_at")!.notnull).toBe(1);
    expect(byName.get("updated_at")!.notnull).toBe(1);
  });

  test("status CHECK allows only 'active' | 'disabled'", async () => {
    const db = createMigratedD1();
    await seedApp(db);
    await expect(
      db.prepare("UPDATE github_apps SET status = 'paused'").run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await db.prepare("UPDATE github_apps SET status = 'disabled'").run();
  });

  test("slug and github_app_id are UNIQUE", async () => {
    const db = createMigratedD1();
    await seedApp(db);
    await expect(seedApp(db, { githubAppId: 999999 })).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(seedApp(db, { slug: "other-slug" })).rejects.toThrow(/UNIQUE constraint failed/);
  });

  test("app_installations: FK to github_apps enforced, UNIQUE (app_id, installation_id)", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    // Unknown app_id → FK failure (github_apps created before app_installations).
    await expect(
      db
        .prepare(
          `INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at)
           VALUES ('inst-x', 'no-such-app', 1, 'octocat', '2026-01-01 00:00:00')`,
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await db
      .prepare(
        `INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at)
         VALUES ('inst-1', ?, 777, 'octocat', '2026-01-01 00:00:00')`,
      )
      .bind(app.id)
      .run();
    await expect(
      db
        .prepare(
          `INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at)
           VALUES ('inst-2', ?, 777, 'octocat', '2026-01-01 00:00:00')`,
        )
        .bind(app.id)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});

describe("migration 0005_reviews_app_id.sql (on a seeded production-shaped DB)", () => {
  test("existing reviews keep working: app_id NULL (legacy) after the ALTER", () => {
    const db = createMigratedD1();
    const rows = db.raw
      .query("SELECT id, app_id FROM reviews ORDER BY id")
      .all() as Array<{ id: string; app_id: string | null }>;
    expect(rows).toEqual([
      { id: "review-1", app_id: null },
      { id: "review-2", app_id: null },
    ]);
  });

  test("the legacy insert path (no app_id) still works after the ALTER", async () => {
    const db = createMigratedD1();
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict)
         VALUES ('review-3', 123, 'acme', 'widgets', 44, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'comment')`,
      )
      .run();
    const row = db.raw.query("SELECT app_id FROM reviews WHERE id = 'review-3'").get() as {
      app_id: string | null;
    };
    expect(row.app_id).toBeNull();
  });

  test("new rows may reference an app; unknown references are refused (FK)", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    rawRun(
      db,
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, app_id)
       VALUES ('review-4', 123, 'acme', 'widgets', 45, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'comment', ?)`,
      app.id,
    );
    const joined = db.raw
      .query(
        `SELECT r.id, a.slug FROM reviews r JOIN github_apps a ON a.id = r.app_id WHERE r.id = 'review-4'`,
      )
      .get() as { id: string; slug: string };
    expect(joined.slug).toBe(APP_INPUT.slug);
    expect(() =>
      rawRun(
        db,
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, app_id)
         VALUES ('review-5', 123, 'acme', 'widgets', 46, 'cccccccccccccccccccccccccccccccccccccccc', 'comment', 'no-such-app')`,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  test("NO ACTION: hard-deleting an app with review history is refused (soft-delete is the only path)", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    rawRun(
      db,
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, app_id)
       VALUES ('review-6', 123, 'acme', 'widgets', 47, 'dddddddddddddddddddddddddddddddddddddddd', 'comment', ?)`,
      app.id,
    );
    expect(() => rawRun(db, "DELETE FROM github_apps WHERE id = ?", app.id)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    // An app WITHOUT review history can still be hard-deleted (schema allows
    // it; the store/API surface never does — soft-delete is the product path).
    const orphan = await seedApp(db, { slug: "orphan", githubAppId: 42 });
    rawRun(db, "DELETE FROM github_apps WHERE id = ?", orphan.id);
  });
});

describe("apps-store (createAppsStore)", () => {
  test("createApp persists a full active row with the CALLER-SUPPLIED id and timestamps", async () => {
    const db = createMigratedD1();
    // Direct call (not seedApp) so the pinned APP_INPUT.id is the row PK.
    const app = await store(db).createApp(APP_INPUT);
    // T1 review pin: the row PK is exactly the caller's id — never a
    // store-generated default that would break the pre-computed AAD.
    expect(app.id).toBe(APP_INPUT.id);
    expect(UUID_RE.test(app.id)).toBe(true);
    expect(app.slug).toBe(APP_INPUT.slug);
    expect(app.github_app_id).toBe(APP_INPUT.githubAppId);
    expect(app.name).toBe(APP_INPUT.name);
    // The store treats encrypted payloads as opaque strings — no peeking.
    expect(app.private_key_enc).toBe(APP_INPUT.privateKeyEnc);
    expect(app.webhook_secret_enc).toBe(APP_INPUT.webhookSecretEnc);
    expect(app.created_by).toBe(APP_INPUT.createdBy);
    expect(app.status).toBe("active");
    expect(app.deleted_at).toBeNull();
    expect(app.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(app.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("T1 review pin: secretbox AAD rowKey equals the row PK across create+read-back (end-to-end)", async () => {
    const db = createMigratedD1();
    const id = crypto.randomUUID();
    const box = createSecretbox(Buffer.alloc(32, 9).toString("base64"));
    // Caller encrypts BEFORE insert, with the caller-supplied id in the AAD.
    const privateKeyEnc = await box.encryptSecret("pem-plaintext", `github_apps.private_key_enc:${id}`);
    const row = await store(db).createApp({
      ...APP_INPUT,
      id,
      slug: "aad-pin",
      githubAppId: 424242,
      privateKeyEnc,
      webhookSecretEnc: "v1.primary.aXZpdi.cGxhY2Vob2xkZXI=",
    });
    // Read back and decrypt with the AAD derived from the RETURNED row PK:
    // decryptSecret(row.private_key_enc, `github_apps.private_key_enc:${row.id}`)
    // must succeed — the row is NOT undecryptable.
    const readBack = await store(db).getAppById(row.id);
    expect(readBack?.id).toBe(id);
    expect(
      await box.decryptSecret(readBack!.private_key_enc, `github_apps.private_key_enc:${readBack!.id}`),
    ).toBe("pem-plaintext");
    // And the tamper anchor: any other rowKey fails the GCM tag.
    await expect(
      box.decryptSecret(readBack!.private_key_enc, "github_apps.private_key_enc:not-this-row"),
    ).rejects.toThrow(/AAD mismatch/);
  });

  test("getAppBySlug / getAppById round-trip; missing lookups return null", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    expect((await store(db).getAppBySlug(APP_INPUT.slug))?.id).toBe(app.id);
    expect(await store(db).getAppBySlug("no-such-slug")).toBeNull();
    expect((await store(db).getAppById(app.id))?.slug).toBe(APP_INPUT.slug);
    expect(await store(db).getAppById("no-such-id")).toBeNull();
  });

  test("getAppBySlug / getAppById still resolve soft-deleted rows (callers filter)", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    await store(db).softDeleteApp(app.id);
    const bySlug = await store(db).getAppBySlug(APP_INPUT.slug);
    expect(bySlug?.deleted_at).not.toBeNull();
    expect((await store(db).getAppById(app.id))?.deleted_at).not.toBeNull();
  });

  test("listApps returns non-deleted apps, newest first", async () => {
    const db = createMigratedD1();
    const older = await seedApp(db, { slug: "older", githubAppId: 1 });
    const newer = await seedApp(db, { slug: "newer", githubAppId: 2 });
    const deleted = await seedApp(db, { slug: "gone", githubAppId: 3 });
    // Distinct timestamps (datetime('now') has second resolution).
    rawRun(db, "UPDATE github_apps SET created_at = '2026-01-01 00:00:00' WHERE id = ?", older.id);
    rawRun(db, "UPDATE github_apps SET created_at = '2026-02-01 00:00:00' WHERE id = ?", newer.id);
    await store(db).softDeleteApp(deleted.id);
    const listed = await store(db).listApps();
    expect(listed.map((a) => a.slug)).toEqual(["newer", "older"]);
  });

  test("setAppStatus toggles active/disabled, bumps updated_at, and reports whether a row changed", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    rawRun(db, "UPDATE github_apps SET updated_at = '2026-01-01 00:00:00' WHERE id = ?", app.id);
    expect(await store(db).setAppStatus(app.id, "disabled")).toBe(true);
    const disabled = (await store(db).getAppById(app.id))!;
    expect(disabled.status).toBe("disabled");
    expect(disabled.updated_at).not.toBe("2026-01-01 00:00:00");
    expect(await store(db).setAppStatus(app.id, "active")).toBe(true);
    expect(await store(db).setAppStatus("no-such-id", "disabled")).toBe(false);
  });

  test("setAppStatus refuses to re-activate a soft-deleted app", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    await store(db).softDeleteApp(app.id);
    expect(await store(db).setAppStatus(app.id, "active")).toBe(false);
    const row = (await store(db).getAppById(app.id))!;
    expect(row.status).toBe("active"); // untouched by the refused update
    expect(row.deleted_at).not.toBeNull();
  });

  test("softDeleteApp stamps deleted_at once (idempotent) and reports the first delete", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    expect(await store(db).softDeleteApp(app.id)).toBe(true);
    const deleted = (await store(db).getAppById(app.id))!;
    expect(deleted.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Second delete is a no-op: the first timestamp wins.
    rawRun(db, "UPDATE github_apps SET deleted_at = '2026-01-01 00:00:00' WHERE id = ?", app.id);
    expect(await store(db).softDeleteApp(app.id)).toBe(false);
    const row = (await store(db).getAppById(app.id))!;
    expect(row.deleted_at).toBe("2026-01-01 00:00:00");
    expect(await store(db).softDeleteApp("no-such-id")).toBe(false);
  });

  test("upsertInstallation inserts, then refreshes seen_at and account_login on the same pair", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    await s.upsertInstallation({ appId: app.id, installationId: 777, accountLogin: "octocat" });
    let rows = db.raw
      .query("SELECT id, app_id, installation_id, account_login, seen_at FROM app_installations")
      .all() as Array<{
      id: string;
      app_id: string;
      installation_id: number;
      account_login: string | null;
      seen_at: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(UUID_RE.test(rows[0]!.id)).toBe(true);
    expect(rows[0]!.app_id).toBe(app.id);
    expect(rows[0]!.installation_id).toBe(777);
    expect(rows[0]!.account_login).toBe("octocat");
    expect(rows[0]!.seen_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // Simulate time passing, then touch: same pair → still ONE row, seen_at
    // refreshed, login updated when provided.
    db.raw
      .prepare("UPDATE app_installations SET seen_at = '2020-01-01 00:00:00'")
      .run();
    await s.upsertInstallation({ appId: app.id, installationId: 777, accountLogin: "octocat-2" });
    rows = db.raw.query("SELECT * FROM app_installations").all() as typeof rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_login).toBe("octocat-2");
    expect(rows[0]!.seen_at).not.toBe("2020-01-01 00:00:00");

    // A touch without a login must not wipe the stored account_login.
    db.raw.prepare("UPDATE app_installations SET seen_at = '2020-01-01 00:00:00'").run();
    await s.upsertInstallation({ appId: app.id, installationId: 777 });
    rows = db.raw.query("SELECT * FROM app_installations").all() as typeof rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_login).toBe("octocat-2");
    expect(rows[0]!.seen_at).not.toBe("2020-01-01 00:00:00");
  });

  test("upsertInstallation: distinct installation ids are distinct rows; unknown app fails FK", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    await s.upsertInstallation({ appId: app.id, installationId: 1 });
    await s.upsertInstallation({ appId: app.id, installationId: 2 });
    const n = db.raw.query("SELECT COUNT(*) AS n FROM app_installations").get() as { n: number };
    expect(n.n).toBe(2);
    await expect(
      s.upsertInstallation({ appId: "no-such-app", installationId: 3 }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});
describe("apps-store delivery read faces (plan 20 Task 2 consumption)", () => {
  /** The apps-store fixture + migration 0011 (the webhook_deliveries table). */
  function createDeliveryD1(): ReturnType<typeof createTestD1> {
    const db = createMigratedD1();
    applyMigration(db, "0011_webhook_deliveries.sql");
    return db;
  }

  test("deliverySummary + listRecentDeliveries serve the Task-2 UI faces over the apps-store fixture", async () => {
    const db = createDeliveryD1();
    const app = await seedApp(db);
    const s = store(db);
    await s.recordDelivery({ appId: app.id, eventName: "ping", outcome: "ignored", statusCode: null });
    await s.recordDelivery({ appId: app.id, eventName: "pull_request", outcome: "rejected", statusCode: 401 });
    // Backdate the ignored row so the rejected row is the LATEST.
    db.raw
      .prepare("UPDATE webhook_deliveries SET created_at = datetime('now', '-1 hour') WHERE outcome = 'ignored'")
      .run();

    const summary = await s.deliverySummary(app.id);
    expect(summary.latest).toMatchObject({
      event_name: "pull_request",
      outcome: "rejected",
      status_code: 401,
    });
    expect(summary.rejected24h).toBe(1);

    const recent = await s.listRecentDeliveries(app.id, 5);
    expect(recent.map((r) => r.outcome)).toEqual(["rejected", "ignored"]);
    expect(recent[0]!.created_at >= recent[1]!.created_at).toBe(true);
  });

  test("deliverySummaries batches latest row + 24h rejected count per app in ONE call (QC W-1), incl. zero-delivery apps", async () => {
    const db = createDeliveryD1();
    const appA = await seedApp(db);
    const appB = await seedApp(db, { slug: "app-b", githubAppId: 123457 });
    const appC = await seedApp(db, { slug: "app-c", githubAppId: 123458 }); // zero deliveries
    const s = store(db);
    // appA: latest = rejected (in-window) after an ok + an ignored.
    await s.recordDelivery({ appId: appA.id, eventName: "ping", outcome: "ignored", statusCode: null });
    await s.recordDelivery({ appId: appA.id, eventName: "pull_request", outcome: "ok", statusCode: null });
    await s.recordDelivery({ appId: appA.id, eventName: "pull_request", outcome: "rejected", statusCode: 401 });
    // appB: latest = ok; its one rejected row is aged OUT of the 24h window.
    await s.recordDelivery({ appId: appB.id, eventName: "pull_request", outcome: "rejected", statusCode: 500 });
    await s.recordDelivery({ appId: appB.id, eventName: "pull_request", outcome: "ok", statusCode: null });
    db.raw
      .prepare(
        `UPDATE webhook_deliveries SET created_at = datetime('now', '-25 hours')
         WHERE app_id = ? AND outcome = 'rejected'`,
      )
      .run(appB.id);

    const summaries = await s.deliverySummaries([appA.id, appB.id, appC.id]);

    expect(Object.keys(summaries).sort()).toEqual([appA.id, appB.id, appC.id].sort());
    expect(summaries[appA.id]).toMatchObject({
      latest: { event_name: "pull_request", outcome: "rejected", status_code: 401 },
      rejected24h: 1,
    });
    expect(summaries[appB.id]).toMatchObject({
      latest: { event_name: "pull_request", outcome: "ok", status_code: null },
      rejected24h: 0, // the rejected row is 25h old — outside the window
    });
    expect(summaries[appC.id]).toEqual({ latest: null, rejected24h: 0 });
  });

  test("deliverySummaries returns ONLY the requested apps; an empty list is an empty map", async () => {
    const db = createDeliveryD1();
    const appA = await seedApp(db);
    await seedApp(db, { slug: "app-b", githubAppId: 123459 }); // appB — never requested
    const s = store(db);
    await s.recordDelivery({ appId: appA.id, eventName: "ping", outcome: "ok", statusCode: null });

    expect(await s.deliverySummaries([appA.id])).toEqual(
      expect.objectContaining({ [appA.id]: { latest: expect.objectContaining({ outcome: "ok" }), rejected24h: 0 } }),
    );
    expect(Object.keys(await s.deliverySummaries([]))).toEqual([]);
  });
});

/** note: Unit tests: migrations 0004/0005 + the review_bots store layer
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
 *   - 0004 creates review_bots BEFORE bot_installations (same-file FK);
 *     status CHECK ('active','disabled'); github_app_id UNIQUE;
 *     NO ON DELETE clause anywhere (default NO ACTION — a hard DELETE of an
 *     app referenced by reviews must be refused; soft-delete is the only
 *     removal path).
 *   - 0005 is the metadata-only `ALTER TABLE reviews ADD COLUMN bot_id TEXT
 *     REFERENCES review_bots(id)`; existing rows keep bot_id NULL (legacy).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, createTestD1, execMigrationScript } from "../store/helpers";
import { AppCountExceededError, createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import type { D1Like } from "../../src/store/types";
import type {
  CreateAppInput,
  GithubAppMetadataInput,
  GithubAppRow,
  WebhookDeliveryRow,
} from "../../src/dashboard/apps-store";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

/** note: Parameterized write on the raw bun:sqlite handle (params go straight to
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

/** note: Apply one migration file through the fail-fast executor (filename order = wrangler order). */
function applyMigration(db: ReturnType<typeof createTestD1>, name: string): void {
  execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
}

/** note: A DB shaped like production at migration 0002: 0001/0002 + seeded rows. */function createSeededD1(): ReturnType<typeof createTestD1> {
  const db = createTestD1();
  // note: One M1-era row (raw_output, no envelope) and one v1 row (envelope).
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
/** note: Seed DB + every migration from 0003 on, in wrangler (filename) order. 0026
 * carries the workspace data plane `createApp` now writes into, so the fixture
 * applies the production shape from 0003; the rest of the chain is applied
 * whole because 0038 rebuilds `review_bots` from the columns the intervening
 * migrations add. Every store call here therefore runs against the column
 * names the store actually binds.
 */
function createMigratedD1(): ReturnType<typeof createTestD1> {
  const db = createSeededD1();
  for (const name of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql") && name >= "0003")
    .sort()) {
    applyMigration(db, name);
  }
  return db;
}

function store(db: D1Like) {
  return createReviewBotsStore(db);
}

const APP_INPUT: CreateAppInput = {
  // why: T1 review pin: the caller supplies the row PK so the secretbox AAD
  // (github_apps.<column>:<id>) is computable BEFORE insert.
  id: "018f4a2e-7c1d-4e5a-9b2f-3d6c8a1e4f70",
  // note: Migration 0036: GitHub's own slug is a separate cached column — NULL is
  // the honest "never synced" default for a freshly minted App.
  githubSlug: null,
  githubAppId: 123456,
  name: "mstar-inspector-octocat",
  privateKeyEnc: "v1.primary.aXZpdi.Y3QmIHRhZw==",
  webhookSecretEnc: "v1.primary.aXZpdi.d2ViaG9vaw==",
  createdBy: "octocat",
  // invariant: Required: ownership is a caller input, never a store lookup.
  workspaceId: "default",
  // note: Fixture seeding: these cases are about identity and storage shape, not the
  // plan's App cap.
  maxApps: null,
};

async function seedApp(db: D1Like, overrides: Partial<CreateAppInput> = {}): Promise<GithubAppRow> {
  // note: Every seed mints its OWN caller-supplied id (the T1 pin shape) unless
  // the test explicitly pins one; APP_INPUT.id documents a fixed example.
  return store(db).createApp({ ...APP_INPUT, id: crypto.randomUUID(), ...overrides });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("migration 0004_github_apps.sql (on a seeded production-shaped DB)", () => {
  test("applies cleanly after 0001/0002 over existing review rows", () => {
    expect(() => createMigratedD1()).not.toThrow();
  });

  test("review_bots columns follow the spec data model", () => {
    const db = createMigratedD1();
    const cols = db.raw.query("PRAGMA table_info(review_bots)").all() as Array<{
      name: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    for (const name of [
      "id",
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
    // note: Migration 0036: GitHub's own slug is its own nullable column. Migration
    // 0038 dropped the old local route key — the row id carries that role now.
    expect(byName.has("slug")).toBe(false);
    expect(byName.has("webhook_path")).toBe(false);
    expect(byName.get("github_slug")!.notnull).toBe(0);
    expect(byName.get("github_app_id")!.notnull).toBe(1);
    expect(byName.get("private_key_enc")!.notnull).toBe(1);
    expect(byName.get("webhook_secret_enc")!.notnull).toBe(1);
    expect(byName.get("status")!.notnull).toBe(1);
    expect(byName.get("status")!.dflt_value).toBe("'active'");
    expect(byName.get("deleted_at")!.notnull).toBe(0); // note: NULL = not deleted
    expect(byName.get("created_at")!.notnull).toBe(1);
    expect(byName.get("updated_at")!.notnull).toBe(1);
  });

  test("status CHECK allows only 'active' | 'disabled'", async () => {
    const db = createMigratedD1();
    await seedApp(db);
    await expect(
      db.prepare("UPDATE review_bots SET status = 'paused'").run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await db.prepare("UPDATE review_bots SET status = 'disabled'").run();
  });

  test("github_app_id is UNIQUE (the one remaining identity constraint)", async () => {
    const db = createMigratedD1();
    await seedApp(db);
    await expect(seedApp(db, { githubAppId: APP_INPUT.githubAppId })).rejects.toThrow(
      /UNIQUE constraint failed: review_bots.github_app_id/,
    );
  });

  test("bot_installations: FK to review_bots enforced, UNIQUE (bot_id, installation_id)", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    // invariant: Unknown bot_id → FK failure (review_bots created before bot_installations).
    await expect(
      db
        .prepare(
          `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at)
           VALUES ('inst-x', 'no-such-app', 1, 'octocat', '2026-01-01 00:00:00')`,
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await db
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at)
         VALUES ('inst-1', ?, 777, 'octocat', '2026-01-01 00:00:00')`,
      )
      .bind(app.id)
      .run();
    await expect(
      db
        .prepare(
          `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at)
           VALUES ('inst-2', ?, 777, 'octocat', '2026-01-01 00:00:00')`,
        )
        .bind(app.id)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});

describe("migration 0005_reviews_app_id.sql (on a seeded production-shaped DB)", () => {
  test("existing reviews keep working: bot_id NULL (legacy) after the ALTER", () => {
    const db = createMigratedD1();
    const rows = db.raw
      .query("SELECT id, bot_id FROM reviews ORDER BY id")
      .all() as Array<{ id: string; bot_id: string | null }>;
    expect(rows).toEqual([
      { id: "review-1", bot_id: null },
      { id: "review-2", bot_id: null },
    ]);
  });

  test("the legacy insert path (no bot_id) still works after the ALTER", async () => {
    const db = createMigratedD1();
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict)
         VALUES ('review-3', 123, 'acme', 'widgets', 44, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'comment')`,
      )
      .run();
    const row = db.raw.query("SELECT bot_id FROM reviews WHERE id = 'review-3'").get() as {
      bot_id: string | null;
    };
    expect(row.bot_id).toBeNull();
  });

  test("new rows may reference an app; unknown references are refused (FK)", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    rawRun(
      db,
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, bot_id)
       VALUES ('review-4', 123, 'acme', 'widgets', 45, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'comment', ?)`,
      app.id,
    );
    const joined = db.raw
      .query(
        `SELECT r.id, a.name FROM reviews r JOIN review_bots a ON a.id = r.bot_id WHERE r.id = 'review-4'`,
      )
      .get() as { id: string; name: string };
    expect(joined.name).toBe(APP_INPUT.name);
    expect(() =>
      rawRun(
        db,
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, bot_id)
         VALUES ('review-5', 123, 'acme', 'widgets', 46, 'cccccccccccccccccccccccccccccccccccccccc', 'comment', 'no-such-app')`,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  test("NO ACTION: hard-deleting an app with review history is refused (soft-delete is the only path)", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    rawRun(
      db,
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, bot_id)
       VALUES ('review-6', 123, 'acme', 'widgets', 47, 'dddddddddddddddddddddddddddddddddddddddd', 'comment', ?)`,
      app.id,
    );
    expect(() => rawRun(db, "DELETE FROM review_bots WHERE id = ?", app.id)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    // note: Since 0026 every App has an `bot_workspaces` ownership row (NO ACTION),
    // so even an App without review history cannot be hard-deleted: the
    // ownership map outlives the review history, and soft delete is the only
    // removal path at the schema level.
    const orphan = await seedApp(db, { githubAppId: 42 });
    expect(() => rawRun(db, "DELETE FROM review_bots WHERE id = ?", orphan.id)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});

describe("apps-store (createReviewBotsStore)", () => {
  test("createApp persists a full active row with the CALLER-SUPPLIED id and timestamps", async () => {
    const db = createMigratedD1();
    // why: Direct call (not seedApp) so the pinned APP_INPUT.id is the row PK.
    const app = await store(db).createApp(APP_INPUT);
    // invariant: T1 review pin: the row PK is exactly the caller's id — never a
    // store-generated default that would break the pre-computed AAD.
    expect(app.id).toBe(APP_INPUT.id);
    expect(UUID_RE.test(app.id)).toBe(true);
    expect(app.github_app_id).toBe(APP_INPUT.githubAppId);
    expect(app.name).toBe(APP_INPUT.name);
    // note: The store treats encrypted payloads as opaque strings — no peeking.
    expect(app.private_key_enc).toBe(APP_INPUT.privateKeyEnc);
    expect(app.webhook_secret_enc).toBe(APP_INPUT.webhookSecretEnc);
    expect(app.created_by).toBe(APP_INPUT.createdBy);
    expect(app.status).toBe("active");
    expect(app.deleted_at).toBeNull();
    expect(app.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(app.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("createApp writes the caller's id and the cached github_slug independently (migration 0036)", async () => {
    const db = createMigratedD1();
    const id = crypto.randomUUID();
    const app = await store(db).createApp({
      ...APP_INPUT,
      id,
      githubSlug: "acme-inspector",
      githubAppId: 5150,
    });
    // safety: The two identities are NOT interchangeable: the local UID never leaks
    // into the GitHub column and vice versa.
    expect(app.id).toBe(id);
    expect(app.github_slug).toBe("acme-inspector");
    const raw = db.raw
      .query("SELECT id, github_slug FROM review_bots WHERE id = ?")
      .get(app.id) as { id: string; github_slug: string | null };
    expect(raw).toEqual({ id, github_slug: "acme-inspector" });
    // invariant: Omitted github_slug stays NULL: "never synced" is the honest default.
    const bare = await seedApp(db, { githubAppId: 5151, githubSlug: null });
    expect(bare.github_slug).toBeNull();
  });

  test("two Apps may cache the SAME github_slug (migration 0036 leaves it unindexed)", async () => {
    const db = createMigratedD1();
    // note: GitHub reuses a freed slug, so a stale cached copy plus a live one is a
    // legitimate state: the cache is not an identity and must not gate a write.
    const first = await seedApp(db, { githubAppId: 6161, githubSlug: "shared-slug" });
    const second = await seedApp(db, { githubAppId: 6162, githubSlug: "shared-slug" });
    expect(first.github_slug).toBe("shared-slug");
    expect(second.github_slug).toBe("shared-slug");
  });

  test("T1 review pin: secretbox AAD rowKey equals the row PK across create+read-back (end-to-end)", async () => {
    const db = createMigratedD1();
    const id = crypto.randomUUID();
    const box = createSecretbox(Buffer.alloc(32, 9).toString("base64"));
    // invariant: Caller encrypts BEFORE insert, with the caller-supplied id in the AAD.
    const privateKeyEnc = await box.encryptSecret("pem-plaintext", `github_apps.private_key_enc:${id}`);
    const row = await store(db).createApp({
      ...APP_INPUT,
      id,
      githubAppId: 424242,
      privateKeyEnc,
      webhookSecretEnc: "v1.primary.aXZpdi.cGxhY2Vob2xkZXI=",
    });
    // note: Read back and decrypt with the AAD derived from the RETURNED row PK:
    // decryptSecret(row.private_key_enc, `github_apps.private_key_enc:${row.id}`)
    // must succeed — the row is NOT undecryptable.
    const readBack = await store(db).getAppById(row.id);
    expect(readBack?.id).toBe(id);
    expect(
      await box.decryptSecret(readBack!.private_key_enc, `github_apps.private_key_enc:${readBack!.id}`),
    ).toBe("pem-plaintext");
    // note: And the tamper anchor: any other rowKey fails the GCM tag.
    await expect(
      box.decryptSecret(readBack!.private_key_enc, "github_apps.private_key_enc:not-this-row"),
    ).rejects.toThrow(/AAD mismatch/);
  });

  test("getAppForWebhook / getAppById round-trip; a mismatched pair returns null", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    expect((await store(db).getAppForWebhook(APP_INPUT.workspaceId, app.id))?.id).toBe(app.id);
    // note: The pair is the key: the right App under another workspace is unknown.
    expect(await store(db).getAppForWebhook("other-workspace", app.id)).toBeNull();
    expect(await store(db).getAppForWebhook(APP_INPUT.workspaceId, "no-such-app")).toBeNull();
    expect((await store(db).getAppById(app.id))?.id).toBe(app.id);
    expect(await store(db).getAppById("no-such-id")).toBeNull();
  });

  test("getAppForWebhook / getAppById still resolve soft-deleted rows (callers filter)", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    await store(db).softDeleteApp(app.id);
    const byPair = await store(db).getAppForWebhook(APP_INPUT.workspaceId, app.id);
    expect(byPair?.deleted_at).not.toBeNull();
    expect((await store(db).getAppById(app.id))?.deleted_at).not.toBeNull();
  });

  test("getAppByGithubId finds the row by GitHub's numeric id, and only through the tenant join", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db, { githubAppId: 987654 });
    expect((await store(db).getAppByGithubId(987654))?.id).toBe(app.id);
    expect(await store(db).getAppByGithubId(1)).toBeNull();
  });

  test("getAppByGithubId resolves a soft-deleted row but NOT a soft-deleted workspace", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db, { githubAppId: 987655 });
    await store(db).softDeleteApp(app.id);
    // note: Soft delete is the caller's filter — the read face still resolves it.
    expect((await store(db).getAppByGithubId(987655))?.deleted_at).not.toBeNull();

    rawRun(
      db,
      `INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES ('second', 'second', 'Second', NULL, '2026-10-21T00:00:00.000Z')`,
    );
    const second = await seedApp(db, { githubAppId: 987656, workspaceId: "second" });
    expect((await store(db).getAppByGithubId(987656))?.id).toBe(second.id);
    rawRun(db, "UPDATE workspaces SET deleted_at = datetime('now') WHERE id = 'second'");
    // invariant: A retired tenant can never start a review — same guard as getAppById.
    expect(await store(db).getAppByGithubId(987656)).toBeNull();
  });

  test("a soft-deleted workspace makes both resolution reads null; listApps still sees the App", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    db.raw
      .prepare("UPDATE workspaces SET deleted_at = datetime('now') WHERE id = ?")
      .run(APP_INPUT.workspaceId!);
    expect(await store(db).getAppForWebhook(APP_INPUT.workspaceId, app.id)).toBeNull();
    expect(await store(db).getAppById(app.id)).toBeNull();
    // invariant: The operator list has no execution face — a retired tenant stays visible.
    expect((await store(db).listApps()).map((row) => row.id)).toEqual([app.id]);
  });

  test("listApps returns non-deleted apps, newest first", async () => {
    const db = createMigratedD1();
    const older = await seedApp(db, { githubAppId: 1 });
    const newer = await seedApp(db, { githubAppId: 2 });
    const deleted = await seedApp(db, { githubAppId: 3 });
    // note: Distinct timestamps (datetime('now') has second resolution).
    rawRun(db, "UPDATE review_bots SET created_at = '2026-01-01 00:00:00' WHERE id = ?", older.id);
    rawRun(db, "UPDATE review_bots SET created_at = '2026-02-01 00:00:00' WHERE id = ?", newer.id);
    await store(db).softDeleteApp(deleted.id);
    const listed = await store(db).listApps();
    expect(listed.map((a) => a.id)).toEqual([newer.id, older.id]);
  });

  test("setAppStatus toggles active/disabled, bumps updated_at, and reports whether a row changed", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    rawRun(db, "UPDATE review_bots SET updated_at = '2026-01-01 00:00:00' WHERE id = ?", app.id);
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
    expect(row.status).toBe("active"); // invariant: untouched by the refused update
    expect(row.deleted_at).not.toBeNull();
  });

  test("softDeleteApp stamps deleted_at once (idempotent) and reports the first delete", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    expect(await store(db).softDeleteApp(app.id)).toBe(true);
    const deleted = (await store(db).getAppById(app.id))!;
    expect(deleted.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // note: Second delete is a no-op: the first timestamp wins.
    rawRun(db, "UPDATE review_bots SET deleted_at = '2026-01-01 00:00:00' WHERE id = ?", app.id);
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
      .query("SELECT id, bot_id, installation_id, account_login, seen_at FROM bot_installations")
      .all() as Array<{
      id: string;
      bot_id: string;
      installation_id: number;
      account_login: string | null;
      seen_at: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(UUID_RE.test(rows[0]!.id)).toBe(true);
    expect(rows[0]!.bot_id).toBe(app.id);
    expect(rows[0]!.installation_id).toBe(777);
    expect(rows[0]!.account_login).toBe("octocat");
    expect(rows[0]!.seen_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{3})?$/);

    // note: Simulate time passing, then touch: same pair → still ONE row, seen_at
    // refreshed, login replaced because the writer is authoritative.
    db.raw
      .prepare("UPDATE bot_installations SET seen_at = '2020-01-01 00:00:00'")
      .run();
    await s.upsertInstallation({
      appId: app.id,
      installationId: 777,
      accountLogin: "octocat-2",
      authoritative: true,
    });
    rows = db.raw.query("SELECT * FROM bot_installations").all() as typeof rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_login).toBe("octocat-2");
    expect(rows[0]!.seen_at).not.toBe("2020-01-01 00:00:00");

    // invariant: A touch without a login must not wipe the stored account_login.
    db.raw.prepare("UPDATE bot_installations SET seen_at = '2020-01-01 00:00:00'").run();
    await s.upsertInstallation({ appId: app.id, installationId: 777 });
    rows = db.raw.query("SELECT * FROM bot_installations").all() as typeof rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_login).toBe("octocat-2");
    expect(rows[0]!.seen_at).not.toBe("2020-01-01 00:00:00");
  });

  test("upsertInstallation: an authoritative login overwrites, an inferred one never does", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    // note: The store's own typed read face — no raw-shape assertion needed.
    const loginOf = async (): Promise<string | null> =>
      (await s.listInstallations(app.id))[0]?.account_login ?? null;

    // note: An installation event states the account → it wins.
    await s.upsertInstallation({ appId: app.id, installationId: 1, accountLogin: "alice", authoritative: true });
    expect(await loginOf()).toBe("alice");
    // note: A review delivery's inference cannot replace it.
    await s.upsertInstallation({ appId: app.id, installationId: 1, accountLogin: "inferred-owner" });
    expect(await loginOf()).toBe("alice");
    // note: A later installation event overwrites the authoritative value too.
    await s.upsertInstallation({ appId: app.id, installationId: 1, accountLogin: "octo-org", authoritative: true });
    expect(await loginOf()).toBe("octo-org");
  });

  test("upsertInstallation: an inferred login fills an empty column; an authoritative NULL preserves", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    // note: The store's own typed read face — no raw-shape assertion needed.
    const loginOf = async (): Promise<string | null> =>
      (await s.listInstallations(app.id))[0]?.account_login ?? null;

    // note: A bare touch creates the row with a NULL login.
    await s.upsertInstallation({ appId: app.id, installationId: 2 });
    expect(await loginOf()).toBeNull();
    // note: The first review delivery fills that gap…
    await s.upsertInstallation({ appId: app.id, installationId: 2, accountLogin: "inferred-owner" });
    expect(await loginOf()).toBe("inferred-owner");
    // note: …and an authoritative write with no login preserves it (COALESCE).
    await s.upsertInstallation({ appId: app.id, installationId: 2, accountLogin: null, authoritative: true });
    expect(await loginOf()).toBe("inferred-owner");
    expect(await s.listInstallations(app.id)).toHaveLength(1);
  });

  test("markInstallationRemoved: the row survives, leaves listInstallations, and only an AUTHORITATIVE upsert restores it", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    await s.upsertInstallation({ appId: app.id, installationId: 9, accountLogin: "old-org" });

    await s.markInstallationRemoved(app.id, 9);
    expect(await s.listInstallations(app.id)).toHaveLength(0);
    // safety: The row itself survives — the credential-routing / attribution joins
    // read bot_installations, so an uninstall may never delete it.
    const rows = db.raw
      .query("SELECT account_login, removed_at FROM bot_installations")
      .all() as Array<{ account_login: string | null; removed_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_login).toBe("old-org");
    expect(rows[0]!.removed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{3})?$/);

    // invariant: Ordinary review traffic (INFERRED) says nothing about install state…
    await s.upsertInstallation({ appId: app.id, installationId: 9, accountLogin: "inferred-owner" });
    expect(await s.listInstallations(app.id)).toHaveLength(0);
    // note: …an installation event (AUTHORITATIVE) is a reinstall: the row returns.
    await s.upsertInstallation({ appId: app.id, installationId: 9, accountLogin: "new-org", authoritative: true });
    expect(await s.listInstallations(app.id)).toEqual([
      expect.objectContaining({ installation_id: 9, account_login: "new-org" }),
    ]);
  });

  test("reconcileInstallations: stamps absent rows, clears present ones, never deletes a row", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const sibling = await seedApp(db, { githubAppId: 654321 });
    const s = store(db);
    // note: Two rows for this App (1 = still installed, 2 = uninstalled while no
    // delivery arrived) and one row of a SIBLING App that must stay untouched.
    await s.upsertInstallation({ appId: app.id, installationId: 1, accountLogin: "still-there" });
    await s.upsertInstallation({ appId: app.id, installationId: 2, accountLogin: "gone" });
    await s.upsertInstallation({ appId: sibling.id, installationId: 3, accountLogin: "other-app" });
    const observedAt = await s.currentTimestamp();

    await s.reconcileInstallations(app.id, [1], observedAt);

    expect(await s.listInstallations(app.id)).toEqual([
      expect.objectContaining({ installation_id: 1 }),
    ]);
    const n = db.raw.query("SELECT COUNT(*) AS n FROM bot_installations").get() as { n: number };
    expect(n.n).toBe(3); // invariant: nothing deleted, the sibling untouched
    const siblingRows = await s.listInstallations(sibling.id);
    expect(siblingRows).toEqual([expect.objectContaining({ installation_id: 3 })]);

    // note: GitHub lists 2 again (a reinstall): the stored stamp is cleared. The
    // stamp was written moments ago; let the store clock pass it by one
    // millisecond so the clear is a strict later observation (a same-ms
    // observation is the safe no-clear case, pinned separately below).
    await Bun.sleep(2);
    await s.reconcileInstallations(app.id, [1, 2], await s.currentTimestamp());
    const restored = await s.listInstallations(app.id);
    expect(restored.map((row) => row.installation_id).sort()).toEqual([1, 2]);
  });

  test("reconcileInstallations: an empty authoritative list stamps every active row and clears none", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    await s.upsertInstallation({ appId: app.id, installationId: 1, accountLogin: "still-there" });
    await s.upsertInstallation({ appId: app.id, installationId: 2, accountLogin: "gone" });

    await s.reconcileInstallations(app.id, [], await s.currentTimestamp());

    expect(await s.listInstallations(app.id)).toHaveLength(0);
    const n = db.raw.query("SELECT COUNT(*) AS n FROM bot_installations").get() as { n: number };
    expect(n.n).toBe(2); // invariant: stamped, never deleted
  });

  test("reconcileInstallations: a full page of live ids (150) binds two parameters and still classifies every row", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    // note: Three local rows inside the 1..150 live set (150 already stamped removed,
    // so it must come back) and two outside it (151, 999).
    await s.upsertInstallation({ appId: app.id, installationId: 1, accountLogin: "in-1" });
    await s.upsertInstallation({ appId: app.id, installationId: 100, accountLogin: "in-100" });
    await s.upsertInstallation({ appId: app.id, installationId: 150, accountLogin: "in-150" });
    await s.markInstallationRemoved(app.id, 150);
    await s.upsertInstallation({ appId: app.id, installationId: 151, accountLogin: "out-151" });
    await s.upsertInstallation({ appId: app.id, installationId: 999, accountLogin: "out-999" });
    const live = Array.from({ length: 150 }, (_, index) => index + 1);

    // invariant: The removal was stamped above; the observation must be strictly later.
    await Bun.sleep(2);
    await s.reconcileInstallations(app.id, live, await s.currentTimestamp());

    // invariant: The binding shape the test is named after: each statement binds one
    // value pair (appId + the JSON snapshot), NOT one placeholder per id. A
    // revert to per-id placeholders binds 151 values per statement here and
    // fails this line.
    expect(db.boundValueCounts!.slice(-2)).toEqual([2, 2]);
    const rows = await s.listInstallations(app.id);
    expect(rows.map((row) => row.installation_id).sort((a, b) => a - b)).toEqual([1, 100, 150]);
    const n = db.raw.query("SELECT COUNT(*) AS n FROM bot_installations").get() as { n: number };
    expect(n.n).toBe(5); // invariant: nothing deleted
  });

  test("reconcileInstallations: a LEGACY second-resolution removal in the observation second is still cleared", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    // invariant: A removal written before the fractional marker existed: `datetime('now')`
    // has no sub-second part, so it must sort BEFORE an observation taken in
    // the same second — otherwise the row stays hidden until the next TTL.
    db.raw
      .prepare(
        "INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at) VALUES ('legacy', ?, 7, 'legacy-org', datetime('now'), datetime('now'))",
      )
      .run(app.id);
    const observedAt = await s.currentTimestamp();

    await s.reconcileInstallations(app.id, [7], observedAt);

    expect(await s.listInstallations(app.id)).toEqual([
      expect.objectContaining({ installation_id: 7 }),
    ]);
  });

  test("reconcileInstallations: a row created with a fractional seen_at after the observation is not stamped", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    const observedAt = await s.currentTimestamp();
    // invariant: An in-flight `installation.created`: written AFTER the snapshot, so its
    // fractional seen_at is strictly greater and the stamp leg must skip it
    // even though the fetched live set cannot contain it yet.
    db.raw
      .prepare(
        "INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('in-flight', ?, 11, 'new-org', strftime('%Y-%m-%d %H:%M:%f','now','+0.010 seconds'))",
      )
      .run(app.id);

    await s.reconcileInstallations(app.id, [], observedAt);

    expect(await s.listInstallations(app.id)).toEqual([
      expect.objectContaining({ installation_id: 11 }),
    ]);
  });

  test("reconcileInstallations: rows newer than the observation stamp are neither stamped nor cleared", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    const observedAt = await s.currentTimestamp();
    // invariant: Created AFTER the snapshot (seen_at is later than it): absent from the
    // live set only because it did not exist yet — it must stay present.
    db.raw
      .prepare(
        "INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('late', ?, 10, 'late-org', datetime('now', '+10 seconds'))",
      )
      .run(app.id);
    // invariant: A removal observed AFTER the snapshot is newer news than the live set,
    // so the clear leg must leave it stamped even though 20 is present.
    db.raw
      .prepare(
        "INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at) VALUES ('fresh-removal', ?, 20, 'gone-org', datetime('now'), datetime('now', '+10 seconds'))",
      )
      .run(app.id);
    // note: …while a row older than the snapshot and absent from the live set is
    // exactly what the stamping leg exists for.
    db.raw
      .prepare(
        "INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('old', ?, 30, 'old-org', '2020-01-01 00:00:00')",
      )
      .run(app.id);

    await s.reconcileInstallations(app.id, [20], observedAt);

    const rows = db.raw
      .query("SELECT installation_id, removed_at IS NOT NULL AS removed FROM bot_installations ORDER BY installation_id")
      .all() as Array<{ installation_id: number; removed: number }>;
    expect(rows).toEqual([
      { installation_id: 10, removed: 0 },
      { installation_id: 20, removed: 1 },
      { installation_id: 30, removed: 1 },
    ]);
  });

  test("upsertInstallation: distinct installation ids are distinct rows; unknown app fails FK", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    await s.upsertInstallation({ appId: app.id, installationId: 1 });
    await s.upsertInstallation({ appId: app.id, installationId: 2 });
    const n = db.raw.query("SELECT COUNT(*) AS n FROM bot_installations").get() as { n: number };
    expect(n.n).toBe(2);
    await expect(
      s.upsertInstallation({ appId: "no-such-app", installationId: 3 }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe("apps-store workspace dual write (migration 0026)", () => {
  type CountRow = { n: number };
  type MappingRow = { bot_id: string; workspace_id: string };
  /** note: Minimal statement face for the SQL-recording double below. */
  type RecordingStatement = {
    bind(...values: unknown[]): RecordingStatement;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    run<T = Record<string, unknown>>(): Promise<{
      results: T[];
      meta: { changes: number; last_row_id: number };
    }>;
  };

  function appCount(db: ReturnType<typeof createTestD1>): number {
    const row = db.raw.query("SELECT COUNT(*) AS n FROM review_bots").get() as CountRow;
    return row.n;
  }

  function mappingRows(db: ReturnType<typeof createTestD1>): MappingRow[] {
    return db.raw.query("SELECT bot_id, workspace_id FROM bot_workspaces").all() as MappingRow[];
  }

  test("createApp writes the App row AND its default-workspace mapping", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    expect(mappingRows(db)).toEqual([{ bot_id: app.id, workspace_id: "default" }]);
    expect(appCount(db)).toBe(1);
  });

  test("one transaction: a failing bot_workspaces insert rolls the App row back", async () => {
    const db = createMigratedD1();
    // note: A split-write implementation (INSERT then a separate mapping run) leaves
    // the review_bots row behind when this ABORT fires — the test then fails.
    rawRun(
      db,
      `CREATE TRIGGER fail_mapping BEFORE INSERT ON bot_workspaces
       BEGIN SELECT RAISE(ABORT, 'mapping fail'); END;`,
    );
    await expect(seedApp(db)).rejects.toThrow(/mapping fail/);
    expect(appCount(db)).toBe(0);
    expect(mappingRows(db)).toEqual([]);
  });

  test("the mapping write is in the same batch: a github_app_id conflict rolls back both rows", async () => {
    const db = createMigratedD1();
    const first = await seedApp(db);
    // note: Same GitHub App id, fresh row id — the identity conflict the store refuses.
    await expect(seedApp(db, { githubAppId: APP_INPUT.githubAppId })).rejects.toThrow(
      /UNIQUE constraint failed: review_bots.github_app_id/,
    );
    // note: The failed batch left no mapping behind for the rejected id...
    expect(mappingRows(db)).toEqual([{ bot_id: first.id, workspace_id: "default" }]);
    expect(appCount(db)).toBe(1);
  });

  test("CreateAppInput.workspaceId is required (compile-time, strict-only)", async () => {
    const { workspaceId: _omitted, ...input } = APP_INPUT;
    // @ts-expect-error
    // note: workspaceId is required; omitting it must not compile (the sole-workspace fallback is deleted)
    await expect(store(createMigratedD1()).createApp(input)).rejects.toThrow();
  });

  test("CreateAppInput.maxApps is required: an omitted cap cannot mean unlimited", async () => {
    const { maxApps: _omitted, ...input } = APP_INPUT;
    // @ts-expect-error
    // note: maxApps is required; an omitted cap would be a silent bypass
    await expect(store(createMigratedD1()).createApp(input)).rejects.toThrow(/AppCountExceededError|already owns/);
  });

  test("a NAMED workspace target receives the App's mapping", async () => {
    const db = createMigratedD1();
    rawRun(
      db,
      `INSERT INTO workspaces (id, slug, name, created_by, created_at)
       VALUES ('second', 'second', 'Second', NULL, '2026-10-21T00:00:00.000Z')`,
    );
    // invariant: The named path is the multi-workspace answer: the App lands exactly where
    // the caller said, whichever workspace that is.
    const app = await seedApp(db, { workspaceId: "second" });
    expect(mappingRows(db)).toEqual([{ bot_id: app.id, workspace_id: "second" }]);
  });

  test("a soft-deleted workspace row is never the write target: the named live one receives the mapping", async () => {
    const db = createMigratedD1();
    rawRun(
      db,
      `INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
       VALUES ('retired', 'retired', 'Retired', NULL, '2026-10-21T00:00:00.000Z', '2026-10-21T01:00:00.000Z')`,
    );
    const app = await seedApp(db);
    expect(mappingRows(db)).toEqual([{ bot_id: app.id, workspace_id: "default" }]);
  });

  test("a soft-deleted NAMED target refuses the write with zero rows and the pinned message", async () => {
    const db = createMigratedD1();
    rawRun(db, "UPDATE workspaces SET deleted_at = '2026-10-21T01:00:00.000Z' WHERE id = 'default'");
    await expect(seedApp(db)).rejects.toThrow("apps-store: createApp target workspace is not live");
    expect(appCount(db)).toBe(0);
    expect(mappingRows(db)).toEqual([]);
  });

  test("repeated createApp never creates a workspace: the seeded row is the only one", async () => {
    const db = createMigratedD1();
    await seedApp(db, { githubAppId: 1 });
    await seedApp(db, { githubAppId: 2 });
    const row = db.raw.query("SELECT COUNT(*) AS n FROM workspaces").get() as CountRow;
    expect(row.n).toBe(1);
    expect(mappingRows(db)).toHaveLength(2);
  });

  test("maxApps caps the write: the insert past the cap lands no row of either kind", async () => {
    const db = createMigratedD1();
    await seedApp(db, { githubAppId: 7101, maxApps: 1 });
    await expect(seedApp(db, { githubAppId: 7102, maxApps: 1 })).rejects.toThrow(AppCountExceededError);
    expect(appCount(db)).toBe(1);
    expect(mappingRows(db)).toHaveLength(1);
  });

  test("maxApps: 0 refuses every creation", async () => {
    const db = createMigratedD1();
    await expect(seedApp(db, { githubAppId: 7201, maxApps: 0 })).rejects.toThrow(AppCountExceededError);
    expect(appCount(db)).toBe(0);
    expect(mappingRows(db)).toEqual([]);
  });

  test("a soft-deleted App frees its cap slot: the mapping row alone does not count", async () => {
    const db = createMigratedD1();
    const first = await seedApp(db, { githubAppId: 7301, maxApps: 1 });
    rawRun(db, "UPDATE review_bots SET deleted_at = datetime('now') WHERE id = ?", first.id);
    // invariant: The mapping row survives the soft delete; only the LIVE bot counts.
    const second = await seedApp(db, { githubAppId: 7302, maxApps: 1 });
    expect(mappingRows(db)).toEqual([
      { bot_id: first.id, workspace_id: "default" },
      { bot_id: second.id, workspace_id: "default" },
    ]);
  });

  test("a github_app_id conflict is still a UNIQUE error, never reclassified as a cap hit", async () => {
    const db = createMigratedD1();
    await seedApp(db, { githubAppId: 7401, maxApps: null });
    await expect(seedApp(db, { githubAppId: 7401, maxApps: null })).rejects.toThrow(
      /UNIQUE constraint failed: review_bots.github_app_id/,
    );
    expect(appCount(db)).toBe(1);
  });

  test("a NULL cap is unlimited: an eleventh App still lands", async () => {
    const db = createMigratedD1();
    for (let at = 0; at < 11; at += 1) await seedApp(db, { githubAppId: 7600 + at, maxApps: null });
    expect(appCount(db)).toBe(11);
    expect(mappingRows(db)).toHaveLength(11);
  });

  test("every execution-facing read joins bot_workspaces in ONE statement", async () => {
    const queries: string[] = [];
    const statement: RecordingStatement = {
      bind: () => statement,
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ results: [], meta: { changes: 0, last_row_id: 0 } }),
    };
    const db = {
      prepare(query: string): RecordingStatement {
        queries.push(query);
        return statement;
      },
      batch: async () => [],
    };
    const s = createReviewBotsStore(db);
    await s.getAppForWebhook("workspace", "app");
    await s.getAppByGithubId(1);
    await s.getAppById("id");
    await s.listApps();
    expect(queries).toHaveLength(4);
    for (const query of queries) {
      expect(query).toContain("INNER JOIN bot_workspaces");
      expect(query).toContain("w.workspace_id");
    }
  });

  test("src/ has exactly one INSERT INTO review_bots site (createApp is the only creation path)", () => {
    const sites: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) {
          const hits = readFileSync(path, "utf8").match(/INSERT INTO review_bots\b/g)?.length ?? 0;
          if (hits > 0) sites.push(`${path}:${hits}`);
        }
      }
    };
    walk(join(import.meta.dir, "../../src"));
    expect(sites).toHaveLength(1);
    expect(sites[0]).toEndWith(`apps-store.ts:1`);
  });
});

describe("apps-store sandbox image selection (migration 0018)", () => {
  test("createApp materializes the migration 0018 default: sandbox_image_id 'omp'", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    expect(app.sandbox_image_id).toBe("omp");
  });

  test("setSandboxImage stores an enabled registry id, bumps updated_at, and reports the change", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    rawRun(db, "UPDATE review_bots SET updated_at = '2026-01-01 00:00:00' WHERE id = ?", app.id);
    expect(await store(db).setSandboxImage(app.id, "omp")).toBe(true);
    const row = (await store(db).getAppById(app.id))!;
    expect(row.sandbox_image_id).toBe("omp");
    expect(row.updated_at).not.toBe("2026-01-01 00:00:00");
    // invariant: An unknown app id changed nothing (the setAppStatus convention).
    expect(await store(db).setSandboxImage("no-such-id", "omp")).toBe(false);
  });

  test("setSandboxImage refuses a non-registry id BEFORE any write (the store-enforced value domain)", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    await expect(store(db).setSandboxImage(app.id, "not-a-registry-id")).rejects.toThrow(
      /not an enabled registry entry/,
    );
    await expect(store(db).setSandboxImage(app.id, "")).rejects.toThrow(/not an enabled registry entry/);
    const row = (await store(db).getAppById(app.id))!;
    expect(row.sandbox_image_id).toBe("omp"); // invariant: untouched — zero rows written
  });

  test("setSandboxImage refuses soft-deleted apps (a deleted app is never mutated)", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    await store(db).softDeleteApp(app.id);
    const deleted = (await store(db).getAppById(app.id))!;
    expect(await store(db).setSandboxImage(app.id, "omp")).toBe(false);
    const row = (await store(db).getAppById(app.id))!;
    expect(row.deleted_at).not.toBeNull();
    expect(row.updated_at).toBe(deleted.updated_at); // invariant: the refused write bumped nothing
  });
});

describe("apps-store delivery read faces (consumption)", () => {
  test("deliverySummary + listDeliveries serve the delivery UI faces over the apps-store fixture", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    await s.recordDelivery({ appId: app.id, eventName: "ping", outcome: "ignored", statusCode: null, repositoryFullName: null, reason: null });
    await s.recordDelivery({ appId: app.id, eventName: "pull_request", outcome: "rejected", statusCode: 401, repositoryFullName: null, reason: null });
    // why: Backdate the ignored row so the rejected row is the LATEST.
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

    const page = await s.listDeliveries(app.id, {
      repo: null,
      sinceDays: null,
      eventName: null,
      limit: 5,
      offset: 0,
    });
    expect(page.total).toBe(2);
    expect(page.rows.map((r) => r.outcome)).toEqual(["rejected", "ignored"]);
    expect(page.rows[0]!.created_at >= page.rows[1]!.created_at).toBe(true);
  });

  test("listDeliveries surfaces a review verdict ahead of newer bypass noise", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    // note: The staging shape: one real review verdict buried under a torrent of
    // check_run rows that all land in `ignored`.
    await s.recordDelivery({ appId: app.id, eventName: "pull_request", outcome: "ok", statusCode: null, repositoryFullName: null, reason: null });
    for (let i = 0; i < 6; i++) {
      await s.recordDelivery({ appId: app.id, eventName: "check_run", outcome: "ignored", statusCode: null, repositoryFullName: null, reason: null });
    }
    // why: The verdict is the OLDEST row, so plain newest-first would never show it.
    db.raw
      .prepare("UPDATE webhook_deliveries SET created_at = datetime('now', '-1 hour') WHERE outcome = 'ok'")
      .run();

    const page = await s.listDeliveries(app.id, {
      repo: null,
      sinceDays: null,
      eventName: null,
      limit: 5,
      offset: 0,
    });

    expect(page.rows).toHaveLength(5);
    expect(page.rows[0]).toMatchObject({ event_name: "pull_request", outcome: "ok" });
    // invariant: The remaining four are bypass rows — the list is never five identical
    // ignored lines while a verdict exists anywhere in the App's history.
    expect(page.rows.slice(1).every((r) => r.event_name === "check_run" && r.outcome === "ignored")).toBe(true);
  });

  test("listDeliveries still shows rows for an App whose ONLY traffic is bypass noise", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    for (let i = 0; i < 6; i++) {
      await s.recordDelivery({ appId: app.id, eventName: "check_run", outcome: "ignored", statusCode: null, repositoryFullName: null, reason: null });
    }

    const page = await s.listDeliveries(app.id, {
      repo: null,
      sinceDays: null,
      eventName: null,
      limit: 5,
      offset: 0,
    });

    // why: No verdict exists, so the ranking has nothing to hoist: the newest rows
    // still render (never an empty list just because the traffic is noise).
    expect(page.rows).toHaveLength(5);
    expect(page.rows.every((r) => r.event_name === "check_run" && r.outcome === "ignored")).toBe(true);
  });

  test("deliverySummaries batches latest row + 24h rejected count per app in ONE call (QC W-1), incl. zero-delivery apps", async () => {
    const db = createMigratedD1();
    const appA = await seedApp(db);
    const appB = await seedApp(db, { githubAppId: 123457 });
    const appC = await seedApp(db, { githubAppId: 123458 }); // invariant: zero deliveries
    const s = store(db);
    // invariant: appA: latest = rejected (in-window) after an ok + an ignored.
    await s.recordDelivery({ appId: appA.id, eventName: "ping", outcome: "ignored", statusCode: null, repositoryFullName: null, reason: null });
    await s.recordDelivery({ appId: appA.id, eventName: "pull_request", outcome: "ok", statusCode: null, repositoryFullName: null, reason: null });
    await s.recordDelivery({ appId: appA.id, eventName: "pull_request", outcome: "rejected", statusCode: 401, repositoryFullName: null, reason: null });
    // note: appB: latest = ok; its one rejected row is aged OUT of the 24h window.
    await s.recordDelivery({ appId: appB.id, eventName: "pull_request", outcome: "rejected", statusCode: 500, repositoryFullName: null, reason: null });
    await s.recordDelivery({ appId: appB.id, eventName: "pull_request", outcome: "ok", statusCode: null, repositoryFullName: null, reason: null });
    db.raw
      .prepare(
        `UPDATE webhook_deliveries SET created_at = datetime('now', '-25 hours')
         WHERE bot_id = ? AND outcome = 'rejected'`,
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
      rejected24h: 0, // note: the rejected row is 25h old — outside the window
    });
    expect(summaries[appC.id]).toEqual({ latest: null, rejected24h: 0 });
  });

  test("deliverySummaries returns ONLY the requested apps; an empty list is an empty map", async () => {
    const db = createMigratedD1();
    const appA = await seedApp(db);
    await seedApp(db, { githubAppId: 123459 }); // invariant: appB — never requested
    const s = store(db);
    await s.recordDelivery({ appId: appA.id, eventName: "ping", outcome: "ok", statusCode: null, repositoryFullName: null, reason: null });

    expect(await s.deliverySummaries([appA.id])).toEqual(
      expect.objectContaining({ [appA.id]: { latest: expect.objectContaining({ outcome: "ok" }), rejected24h: 0 } }),
    );
    expect(Object.keys(await s.deliverySummaries([]))).toEqual([]);
  });

  test("deliverySummaries preserves window-query results across tiers, timestamp ties and missing apps", async () => {
    const db = createMigratedD1();
    const apps = [];
    for (const githubAppId of [123460, 123461, 123462]) {
      apps.push(await seedApp(db, { githubAppId }));
    }
    const insert = db.raw.prepare(
      `INSERT INTO webhook_deliveries (id, bot_id, event_name, outcome, status_code, repository_full_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 300; i++) {
      const app = apps[i % 2]!;
      const outcome = i % 2 === 0
        ? ["ok", "paused", "rejected", "ignored", "skipped"][i % 5]!
        : ["ignored", "skipped"][i % 3 === 0 ? 0 : 1]!;
      insert.run(
        `delivery-${i}`, app.id, i % 3 === 0 ? null : "pull_request", outcome,
        outcome === "rejected" ? 403 : null, i % 3 === 0 ? null : "acme/widgets",
        i % 4 === 0 ? "2020-01-02 00:00:00" : "2020-01-01 00:00:00",
      );
    }
    const ids = [...apps.map((app) => app.id), "missing-app", apps[0]!.id];
    const summaries = await store(db).deliverySummaries(ids);
    for (const id of ids) {
      const latest = db.raw.prepare<WebhookDeliveryRow, [string]>(
        `SELECT bot_id, id, event_name, outcome, status_code, repository_full_name, created_at FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY bot_id
             ORDER BY CASE WHEN outcome IN ('ok', 'paused', 'rejected') THEN 0 ELSE 1 END,
                      created_at DESC, rowid DESC) AS rn
           FROM webhook_deliveries WHERE bot_id = ?
         ) WHERE rn = 1`,
      ).get(id) ?? null;
      expect(summaries[id]).toEqual({ latest, rejected24h: 0 });
    }
    expect(summaries["missing-app"]).toEqual({ latest: null, rejected24h: 0 });
    expect(summaries[apps[2]!.id]).toEqual({ latest: null, rejected24h: 0 });
    expect(summaries[apps[0]!.id]!.latest!.id).toBe("delivery-296");
    expect(summaries[apps[1]!.id]!.latest!.id).toBe("delivery-299");
  });

  test("deliverySummaries uses health indexes without sorting delivery history", async () => {
    const db = createMigratedD1();
    const statements: string[] = [];
    const s = store({
      ...db,
      prepare(sql: string) {
        statements.push(sql);
        return db.prepare(sql);
      },
    });
    const ids = ["app-a", "app-b"];
    await s.deliverySummaries(ids);
    expect(statements).toHaveLength(2);
    for (const [i, index] of [
      "idx_webhook_deliveries_bot_health",
      "idx_webhook_deliveries_bot_outcome_created",
    ].entries()) {
      const plan = db.raw.query(`EXPLAIN QUERY PLAN ${statements[i]!}`)
        .all(...ids) as Array<{ detail: string }>;
      const details = plan.map((row) => row.detail).join("\n");
      expect(details).toContain(`USING COVERING INDEX ${index}`);
      expect(details).not.toContain("TEMP B-TREE");
    }
  });

  test("deliverySummaries propagates database read errors", async () => {
    const db = createMigratedD1();
    db.raw.exec("DROP TABLE webhook_deliveries");
    await expect(store(db).deliverySummaries(["missing-app"])).rejects.toThrow("no such table");
  });

  test("deliverySummaries ranks by outcome tier: a newer ignored bypass row never outranks an older ok", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    await s.recordDelivery({ appId: app.id, eventName: "pull_request", outcome: "ok", statusCode: null, repositoryFullName: null, reason: null });
    await s.recordDelivery({ appId: app.id, eventName: "check_run", outcome: "ignored", statusCode: null, repositoryFullName: null, reason: null });
    // note: The check_run row is genuinely newer, so an unconditionally-newest pick returns it.
    db.raw
      .prepare(
        `UPDATE webhook_deliveries SET created_at = datetime('now', '-1 hour')
         WHERE event_name = 'pull_request'`,
      )
      .run();

    const summaries = await s.deliverySummaries([app.id]);

    expect(summaries[app.id]!.latest).toMatchObject({ event_name: "pull_request", outcome: "ok" });
  });

  test("deliverySummaries prefers an older ok over a newer ignored row from a WHITELISTED event", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    await s.recordDelivery({ appId: app.id, eventName: "pull_request", outcome: "ok", statusCode: null, repositoryFullName: null, reason: null });
    // note: issue_comment is whitelisted and still ignored: no App mention, a bot
    // author, or a comment outside a PR thread all land in `ignored`.
    await s.recordDelivery({ appId: app.id, eventName: "issue_comment", outcome: "ignored", statusCode: null, repositoryFullName: null, reason: null });
    db.raw
      .prepare(
        `UPDATE webhook_deliveries SET created_at = datetime('now', '-1 hour')
         WHERE event_name = 'pull_request'`,
      )
      .run();

    const summaries = await s.deliverySummaries([app.id]);

    expect(summaries[app.id]!.latest).toMatchObject({ event_name: "pull_request", outcome: "ok" });
  });

  test("deliverySummaries keeps a newer paused row over an older ok (switch-off is a state, not noise)", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    await s.recordDelivery({ appId: app.id, eventName: "pull_request", outcome: "ok", statusCode: null, repositoryFullName: null, reason: null });
    await s.recordDelivery({ appId: app.id, eventName: "pull_request", outcome: "paused", statusCode: null, repositoryFullName: null, reason: null });
    db.raw
      .prepare(`UPDATE webhook_deliveries SET created_at = datetime('now', '-1 hour') WHERE outcome = 'ok'`)
      .run();

    const summaries = await s.deliverySummaries([app.id]);

    expect(summaries[app.id]!.latest).toMatchObject({ event_name: "pull_request", outcome: "paused" });
  });

  test("deliverySummaries falls back to the newest row when an app has only ever produced ignored traffic", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    await s.recordDelivery({ appId: app.id, eventName: "ping", outcome: "ignored", statusCode: null, repositoryFullName: null, reason: null });

    const summaries = await s.deliverySummaries([app.id]);

    expect(summaries[app.id]).toMatchObject({ latest: { event_name: "ping", outcome: "ignored" }, rejected24h: 0 });
  });
});

describe("saveGithubMetadata (migrations 0019/0036)", () => {
  // note: `satisfies` pins the saveGithubMetadata input shape while keeping the
  // literal's non-null field types for exact-value assertions below.
  const METADATA = {
    githubName: "Acme Inspector",
    githubDescription: "PR review bot for Acme",
    githubHtmlUrl: "https://github.com/apps/acme-inspector",
    githubAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    githubSlug: "acme-inspector",
  } satisfies GithubAppMetadataInput;

  test("a freshly created app reads every profile column — github_slug included — as NULL (never synced)", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db);
    const row = await store(db).getAppById(app.id);
    expect(row).toMatchObject({
      github_name: null,
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_slug: null,
      github_metadata_synced_at: null,
    });
  });

  test("writes the four profile fields + github_slug + synced_at, and does NOT touch updated_at", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db);
    // note: Pin updated_at to a known past value: the write is machine-triggered
    // (the touchLastWebhook L5 precedent) and must leave the operator
    // timestamp alone — a same-second datetime('now') would mask a wrongly
    // touched column, so the pin makes the assertion deterministic.
    db.raw.prepare("UPDATE review_bots SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(app.id);

    const changed = await store(db).saveGithubMetadata(app.id, METADATA);
    expect(changed).toBe(true);

    const row = db.raw
      .query(
        `SELECT github_name, github_description, github_html_url, github_avatar_url,
                github_slug, github_metadata_synced_at, updated_at
         FROM review_bots WHERE id = ?`,
      )
      .get(app.id) as {
      github_name: string;
      github_description: string;
      github_html_url: string;
      github_avatar_url: string;
      github_slug: string;
      github_metadata_synced_at: string;
      updated_at: string;
    };
    expect(row.github_name).toBe(METADATA.githubName);
    expect(row.github_description).toBe(METADATA.githubDescription);
    expect(row.github_html_url).toBe(METADATA.githubHtmlUrl);
    expect(row.github_avatar_url).toBe(METADATA.githubAvatarUrl);
    expect(row.github_slug).toBe(METADATA.githubSlug);
    expect(row.github_metadata_synced_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.updated_at).toBe("2000-01-01 00:00:00");
  });

  test("null metadata fields persist as NULL while synced_at still records the sync (per-item degradation)", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db);
    const changed = await store(db).saveGithubMetadata(app.id, {
      githubName: "Bare App",
      githubDescription: null,
      githubHtmlUrl: null,
      githubAvatarUrl: null,
      githubSlug: null,
    });
    expect(changed).toBe(true);
    const row = await store(db).getAppById(app.id);
    expect(row!.github_name).toBe("Bare App");
    expect(row!.github_description).toBeNull();
    expect(row!.github_html_url).toBeNull();
    expect(row!.github_avatar_url).toBeNull();
    expect(row!.github_slug).toBeNull();
    expect(row!.github_metadata_synced_at).not.toBeNull();
  });

  test("a null github_slug bind preserves the cached slug (COALESCE — the bot-mention target)", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db);
    const s = store(db);
    expect(await s.saveGithubMetadata(app.id, METADATA)).toBe(true);

    // note: A degraded later fetch (upstream shape change / bot lookup failure)
    // carries no slug; the cached one is the only mention target, so it stays.
    expect(
      await s.saveGithubMetadata(app.id, { ...METADATA, githubName: "Renamed App", githubSlug: null }),
    ).toBe(true);
    const row = await s.getAppById(app.id);
    expect(row!.github_name).toBe("Renamed App"); // note: other columns still overwrite
    expect(row!.github_slug).toBe(METADATA.githubSlug);
  });

  test("refuses soft-deleted rows exactly like setAppStatus (false, zero columns written)", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db);
    expect(await store(db).softDeleteApp(app.id)).toBe(true);
    expect(await store(db).saveGithubMetadata(app.id, METADATA)).toBe(false);
    const row = await store(db).getAppById(app.id);
    expect(row!.github_name).toBeNull();
    expect(row!.github_slug).toBeNull();
    expect(row!.github_metadata_synced_at).toBeNull();
  });

  test("an unknown id is a false-returning no-op (the setAppStatus convention)", async () => {
    const db = createMigratedTestD1();
    expect(await store(db).saveGithubMetadata(crypto.randomUUID(), METADATA)).toBe(false);
  });
});

describe("touchGithubMetadataAttempt (migration 0037)", () => {
  test("stamps only github_metadata_attempted_at — never the profile columns or updated_at", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db);
    db.raw.prepare("UPDATE review_bots SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(app.id);

    await store(db).touchGithubMetadataAttempt(app.id);

    const row = await store(db).getAppById(app.id);
    expect(row!.github_metadata_attempted_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row!.github_metadata_synced_at).toBeNull();
    expect(row!.github_name).toBeNull();
    expect(row!.github_slug).toBeNull();
    expect(row!.updated_at).toBe("2000-01-01 00:00:00");
  });

  test("an unknown or soft-deleted id is a silent no-op", async () => {
    const db = createMigratedTestD1();
    const app = await seedApp(db);
    expect(await store(db).softDeleteApp(app.id)).toBe(true);

    // note: The attempt already happened upstream; refusing to record it would
    // re-open the per-read fetch loop. Neither call may throw.
    await store(db).touchGithubMetadataAttempt(app.id);
    await store(db).touchGithubMetadataAttempt(crypto.randomUUID());

    expect((await store(db).getAppById(app.id))!.github_metadata_attempted_at).toBeNull();
  });
});

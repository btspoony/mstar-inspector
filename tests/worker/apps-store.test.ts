import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, createTestD1, execMigrationScript, seedTarget, syncReviewBotColumn, applyMigration as applyMigrationShared } from "../store/helpers";
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

function rawRun(
  db: ReturnType<typeof createTestD1>,
  sql: string,
  ...params: (string | number | null)[]
): void {
  db.raw.prepare(sql).run(...params);
}

function applyMigration(db: ReturnType<typeof createTestD1>, name: string): void {
  applyMigrationShared(db.raw, [name]);
}

function createSeededD1(): ReturnType<typeof createTestD1> {
  const db = createTestD1();
  db.raw
    .prepare(
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md, raw_output)
       VALUES ('review-1', 123, 'acme', 'widgets', 42, '0123456789abcdef0123456789abcdef01234567', 'comment', 'ok', 'raw'),
              ('review-2', 123, 'acme', 'widgets', 43, 'ffffffffffffffffffffffffffffffffffffffff', 'approve', 'fine', NULL)`,
    )
    .run();
  syncReviewBotColumn(db);
  db.raw
    .prepare(`UPDATE reviews SET envelope = '{"schema":"mstar.review/v1"}' WHERE id = 'review-2'`)
    .run();
  return db;
}
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
  id: "018f4a2e-7c1d-4e5a-9b2f-3d6c8a1e4f70",
  githubSlug: null,
  githubAppId: 123456,
  name: "mstar-inspector-octocat",
  privateKeyEnc: "v1.primary.aXZpdi.Y3QmIHRhZw==",
  webhookSecretEnc: "v1.primary.aXZpdi.d2ViaG9vaw==",
  createdBy: "octocat",
  workspaceId: "default",
  maxApps: null,
};

async function seedApp(db: D1Like, overrides: Partial<CreateAppInput> = {}): Promise<GithubAppRow> {
  return store(db).createApp({ ...APP_INPUT, id: crypto.randomUUID(), ...overrides });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The name of the function whose BODY contains `at`, or `<module>`.
 *
 * Line-scanning for the nearest `    async x(` credits an INSERT to whatever
 * member was declared above it, so a hit moved into a later non-async function
 * still read as its async neighbour. This instead finds every declaration,
 * walks its body to the matching close brace, and returns the innermost
 * declaration whose body spans `at`. Body braces are matched by depth; the
 * `${…}` splices inside the store's template literals are themselves balanced,
 * so the depth stays true.
 */
function enclosingFunction(text: string, at: number): string {
  let best: { name: string; start: number } | null = null;
  for (const decl of text.matchAll(/\b(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\s*\(/g)) {
    const name = decl[1]!;
    // Control-flow keywords and member CALLS (`store.replaceInstallChain(`)
    // look like declarations to a regex; both are rejected below, so a call
    // nearer the hit can never win the innermost test.
    if (/^(?:if|for|while|switch|catch|do|else|return|typeof|await|with)$/.test(name)) continue;
    if (/\.\s*$/.test(text.slice(Math.max(0, decl.index! - 3), decl.index!))) continue;
    // The parameter list's own close paren, then the body's opening brace.
    let depth = 0;
    let open = -1;
    for (let i = decl.index! + decl[0].length - 1; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          open = text.indexOf("{", i);
          // A trailing `;` (or another `)`) before the brace means this was a
          // CALL, not a declaration with a body.
          const between = text.slice(i + 1, open === -1 ? text.length : open);
          if (open === -1 || /[;)]/.test(between)) open = -1;
          break;
        }
      }
    }
    if (open === -1 || open > at) continue;
    depth = 0;
    let close = -1;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1 || close < at) continue;
    // Innermost wins: the declaration that starts closest before the hit.
    if (best === null || decl.index! >= best.start) best = { name, start: decl.index! };
  }
  return best?.name ?? "<module>";
}

describe("migration 0004_github_apps.sql (on a seeded production-shaped DB)", () => {
  test("applies cleanly after 0001/0002 over existing review rows", () => {
    expect(() => createMigratedD1()).not.toThrow();
  });

  test("the migration-0004 table (today github_apps) carries the spec data model", () => {
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
    expect(byName.has("slug")).toBe(false);
    expect(byName.has("webhook_path")).toBe(false);
    expect(byName.get("github_slug")!.notnull).toBe(0);
    expect(byName.get("github_app_id")!.notnull).toBe(1);
    expect(byName.get("private_key_enc")!.notnull).toBe(1);
    expect(byName.get("webhook_secret_enc")!.notnull).toBe(1);
    expect(byName.get("status")!.notnull).toBe(1);
    expect(byName.get("status")!.dflt_value).toBe("'active'");
    expect(byName.get("deleted_at")!.notnull).toBe(0);
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

  test("github_app_id is UNIQUE (the one remaining identity constraint)", async () => {
    const db = createMigratedD1();
    await seedApp(db);
    await expect(seedApp(db, { githubAppId: APP_INPUT.githubAppId })).rejects.toThrow(
      /UNIQUE constraint failed: github_apps.github_app_id/,
    );
  });

  test("github_app_installations: FK to github_apps enforced, UNIQUE (app_id, installation_id)", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    await expect(
      db
        .prepare(
          `INSERT INTO github_app_installations (id, app_id, installation_id, account_login, seen_at)
           VALUES ('inst-x', 'no-such-app', 1, 'octocat', '2026-01-01 00:00:00')`,
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await db
      .prepare(
        `INSERT INTO github_app_installations (id, app_id, installation_id, account_login, seen_at)
         VALUES ('inst-1', ?, 777, 'octocat', '2026-01-01 00:00:00')`,
      )
      .bind(app.id)
      .run();
    await expect(
      db
        .prepare(
          `INSERT INTO github_app_installations (id, app_id, installation_id, account_login, seen_at)
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

  test("the legacy insert path (no bot_id) still works after the ALTER", async () => {
    const db = createMigratedD1();
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict)
         VALUES ('review-3', 123, 'acme', 'widgets', 44, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'comment')`,
      )
      .run();
  syncReviewBotColumn(db);
    const row = db.raw.query("SELECT app_id, bot_id FROM reviews WHERE id = 'review-3'").get() as {
      app_id: string | null;
      bot_id: string | null;
    };
    expect(row.app_id).toBeNull();
    expect(row.bot_id).toBeNull();
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
        `SELECT r.id, a.name FROM reviews r JOIN github_apps a ON a.id = r.app_id WHERE r.id = 'review-4'`,
      )
      .get() as { id: string; name: string };
    expect(joined.name).toBe(APP_INPUT.name);
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
    const orphan = await seedApp(db, { githubAppId: 42 });
    expect(() => rawRun(db, "DELETE FROM github_apps WHERE id = ?", orphan.id)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});

describe("apps-store (createReviewBotsStore)", () => {
  test("createApp persists a full active row with the CALLER-SUPPLIED id and timestamps", async () => {
    const db = createMigratedD1();
    const app = await store(db).createApp(APP_INPUT);
    expect(app.id).toBe(APP_INPUT.id);
    expect(UUID_RE.test(app.id)).toBe(true);
    expect(app.github_app_id).toBe(APP_INPUT.githubAppId);
    expect(app.name).toBe(APP_INPUT.name);
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
    expect(app.id).toBe(id);
    expect(app.github_slug).toBe("acme-inspector");
    const raw = db.raw
      .query("SELECT id, github_slug FROM github_apps WHERE id = ?")
      .get(app.id) as { id: string; github_slug: string | null };
    expect(raw).toEqual({ id, github_slug: "acme-inspector" });
    const bare = await seedApp(db, { githubAppId: 5151, githubSlug: null });
    expect(bare.github_slug).toBeNull();
  });

  test("two Apps may cache the SAME github_slug (migration 0036 leaves it unindexed)", async () => {
    const db = createMigratedD1();
    const first = await seedApp(db, { githubAppId: 6161, githubSlug: "shared-slug" });
    const second = await seedApp(db, { githubAppId: 6162, githubSlug: "shared-slug" });
    expect(first.github_slug).toBe("shared-slug");
    expect(second.github_slug).toBe("shared-slug");
  });

  test("T1 review pin: secretbox AAD rowKey equals the row PK across create+read-back (end-to-end)", async () => {
    const db = createMigratedD1();
    const id = crypto.randomUUID();
    const box = createSecretbox(Buffer.alloc(32, 9).toString("base64"));
    const privateKeyEnc = await box.encryptSecret("pem-plaintext", `github_apps.private_key_enc:${id}`);
    const row = await store(db).createApp({
      ...APP_INPUT,
      id,
      githubAppId: 424242,
      privateKeyEnc,
      webhookSecretEnc: "v1.primary.aXZpdi.cGxhY2Vob2xkZXI=",
    });
    const readBack = await store(db).getAppById(row.id);
    expect(readBack?.id).toBe(id);
    expect(
      await box.decryptSecret(readBack!.private_key_enc, `github_apps.private_key_enc:${readBack!.id}`),
    ).toBe("pem-plaintext");
    await expect(
      box.decryptSecret(readBack!.private_key_enc, "github_apps.private_key_enc:not-this-row"),
    ).rejects.toThrow(/AAD mismatch/);
  });

  test("getAppForWebhook / getAppById round-trip; a mismatched pair returns null", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    expect((await store(db).getAppForWebhook(APP_INPUT.workspaceId, app.id))?.id).toBe(app.id);
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
    expect((await store(db).getAppByGithubId(987655))?.deleted_at).not.toBeNull();

    rawRun(
      db,
      `INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES ('second', 'second', 'Second', NULL, '2026-10-21T00:00:00.000Z')`,
    );
    const second = await seedApp(db, { githubAppId: 987656, workspaceId: "second" });
    expect((await store(db).getAppByGithubId(987656))?.id).toBe(second.id);
    rawRun(db, "UPDATE workspaces SET deleted_at = datetime('now') WHERE id = 'second'");
    expect(await store(db).getAppByGithubId(987656)).toBeNull();
  });

  test("a soft-deleted workspace makes both resolution reads null; listApps still sees the App", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    db.raw
      .prepare("UPDATE workspaces SET deleted_at = datetime('now') WHERE id = ?")
      .run(APP_INPUT.workspaceId!);
  syncReviewBotColumn(db);
    expect(await store(db).getAppForWebhook(APP_INPUT.workspaceId, app.id)).toBeNull();
    expect(await store(db).getAppById(app.id)).toBeNull();
    expect((await store(db).listApps()).map((row) => row.id)).toEqual([app.id]);
  });

  test("listApps returns non-deleted apps, newest first", async () => {
    const db = createMigratedD1();
    const older = await seedApp(db, { githubAppId: 1 });
    const newer = await seedApp(db, { githubAppId: 2 });
    const deleted = await seedApp(db, { githubAppId: 3 });
    rawRun(db, "UPDATE github_apps SET created_at = '2026-01-01 00:00:00' WHERE id = ?", older.id);
    rawRun(db, "UPDATE github_apps SET created_at = '2026-02-01 00:00:00' WHERE id = ?", newer.id);
    await store(db).softDeleteApp(deleted.id);
    const listed = await store(db).listApps();
    expect(listed.map((a) => a.id)).toEqual([newer.id, older.id]);
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
    expect(row.status).toBe("active");
    expect(row.deleted_at).not.toBeNull();
  });

  test("softDeleteApp stamps deleted_at once (idempotent) and reports the first delete", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    expect(await store(db).softDeleteApp(app.id)).toBe(true);
    const deleted = (await store(db).getAppById(app.id))!;
    expect(deleted.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
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
      .query("SELECT id, app_id, installation_id, account_login, seen_at FROM github_app_installations")
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
    expect(rows[0]!.seen_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{3})?$/);

    db.raw
      .prepare("UPDATE github_app_installations SET seen_at = '2020-01-01 00:00:00'")
      .run();
    await s.upsertInstallation({
      appId: app.id,
      installationId: 777,
      accountLogin: "octocat-2",
      authoritative: true,
    });
    rows = db.raw.query("SELECT * FROM github_app_installations").all() as typeof rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_login).toBe("octocat-2");
    expect(rows[0]!.seen_at).not.toBe("2020-01-01 00:00:00");

    db.raw.prepare("UPDATE github_app_installations SET seen_at = '2020-01-01 00:00:00'").run();
    await s.upsertInstallation({ appId: app.id, installationId: 777 });
    rows = db.raw.query("SELECT * FROM github_app_installations").all() as typeof rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_login).toBe("octocat-2");
    expect(rows[0]!.seen_at).not.toBe("2020-01-01 00:00:00");
  });

  test("upsertInstallation: an authoritative login overwrites, an inferred one never does", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    const loginOf = async (): Promise<string | null> =>
      (await s.listInstallations(app.id))[0]?.account_login ?? null;

    await s.upsertInstallation({ appId: app.id, installationId: 1, accountLogin: "alice", authoritative: true });
    expect(await loginOf()).toBe("alice");
    await s.upsertInstallation({ appId: app.id, installationId: 1, accountLogin: "inferred-owner" });
    expect(await loginOf()).toBe("alice");
    await s.upsertInstallation({ appId: app.id, installationId: 1, accountLogin: "octo-org", authoritative: true });
    expect(await loginOf()).toBe("octo-org");
  });

  test("upsertInstallation: an inferred login fills an empty column; an authoritative NULL preserves", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    const loginOf = async (): Promise<string | null> =>
      (await s.listInstallations(app.id))[0]?.account_login ?? null;

    await s.upsertInstallation({ appId: app.id, installationId: 2 });
    expect(await loginOf()).toBeNull();
    await s.upsertInstallation({ appId: app.id, installationId: 2, accountLogin: "inferred-owner" });
    expect(await loginOf()).toBe("inferred-owner");
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
    const rows = db.raw
      .query("SELECT account_login, removed_at FROM github_app_installations")
      .all() as Array<{ account_login: string | null; removed_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_login).toBe("old-org");
    expect(rows[0]!.removed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{3})?$/);

    await s.upsertInstallation({ appId: app.id, installationId: 9, accountLogin: "inferred-owner" });
    expect(await s.listInstallations(app.id)).toHaveLength(0);
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
    await s.upsertInstallation({ appId: app.id, installationId: 1, accountLogin: "still-there" });
    await s.upsertInstallation({ appId: app.id, installationId: 2, accountLogin: "gone" });
    await s.upsertInstallation({ appId: sibling.id, installationId: 3, accountLogin: "other-app" });
    const observedAt = await s.currentTimestamp();

    await s.reconcileInstallations(app.id, [1], observedAt);

    expect(await s.listInstallations(app.id)).toEqual([
      expect.objectContaining({ installation_id: 1 }),
    ]);
    const n = db.raw.query("SELECT COUNT(*) AS n FROM github_app_installations").get() as { n: number };
    expect(n.n).toBe(3);
    const siblingRows = await s.listInstallations(sibling.id);
    expect(siblingRows).toEqual([expect.objectContaining({ installation_id: 3 })]);

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
    const n = db.raw.query("SELECT COUNT(*) AS n FROM github_app_installations").get() as { n: number };
    expect(n.n).toBe(2);
  });

  test("reconcileInstallations: a full page of live ids (150) binds two parameters and still classifies every row", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    await s.upsertInstallation({ appId: app.id, installationId: 1, accountLogin: "in-1" });
    await s.upsertInstallation({ appId: app.id, installationId: 100, accountLogin: "in-100" });
    await s.upsertInstallation({ appId: app.id, installationId: 150, accountLogin: "in-150" });
    await s.markInstallationRemoved(app.id, 150);
    await s.upsertInstallation({ appId: app.id, installationId: 151, accountLogin: "out-151" });
    await s.upsertInstallation({ appId: app.id, installationId: 999, accountLogin: "out-999" });
    const live = Array.from({ length: 150 }, (_, index) => index + 1);

    await Bun.sleep(2);
    await s.reconcileInstallations(app.id, live, await s.currentTimestamp());

    // The batch is reconcile's two snapshot statements followed by the
    // install-state sweep: the two that classify rows bind the App id and the
    // snapshot (2 each, whatever the list length), and the sweep's two bind the
    // App id alone (1 each).
    expect(db.boundValueCounts!.slice(-4)).toEqual([2, 2, 1, 1]);
    const rows = await s.listInstallations(app.id);
    expect(rows.map((row) => row.installation_id).sort((a, b) => a - b)).toEqual([1, 100, 150]);
    const n = db.raw.query("SELECT COUNT(*) AS n FROM github_app_installations").get() as { n: number };
    expect(n.n).toBe(5);
  });

  test("reconcileInstallations: a LEGACY second-resolution removal in the observation second is still cleared", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    db.raw
      .prepare(
        "INSERT INTO github_app_installations (id, app_id, installation_id, account_login, seen_at, removed_at) VALUES ('legacy', ?, 7, 'legacy-org', datetime('now'), datetime('now'))",
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
    db.raw
      .prepare(
        "INSERT INTO github_app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('in-flight', ?, 11, 'new-org', strftime('%Y-%m-%d %H:%M:%f','now','+0.010 seconds'))",
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
    db.raw
      .prepare(
        "INSERT INTO github_app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('late', ?, 10, 'late-org', datetime('now', '+10 seconds'))",
      )
      .run(app.id);
    db.raw
      .prepare(
        "INSERT INTO github_app_installations (id, app_id, installation_id, account_login, seen_at, removed_at) VALUES ('fresh-removal', ?, 20, 'gone-org', datetime('now'), datetime('now', '+10 seconds'))",
      )
      .run(app.id);
    db.raw
      .prepare(
        "INSERT INTO github_app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('old', ?, 30, 'old-org', '2020-01-01 00:00:00')",
      )
      .run(app.id);

    await s.reconcileInstallations(app.id, [20], observedAt);

    const rows = db.raw
      .query("SELECT installation_id, removed_at IS NOT NULL AS removed FROM github_app_installations ORDER BY installation_id")
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
    const n = db.raw.query("SELECT COUNT(*) AS n FROM github_app_installations").get() as { n: number };
    expect(n.n).toBe(2);
    await expect(
      s.upsertInstallation({ appId: "no-such-app", installationId: 3 }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe("apps-store workspace dual write (migration 0026)", () => {
  type CountRow = { n: number };
  type MappingRow = { app_id: string; workspace_id: string };
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
    return db.raw.query("SELECT app_id, workspace_id FROM app_workspaces").all() as MappingRow[];
  }

  test("createApp writes the App row AND its default-workspace mapping", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    expect(mappingRows(db)).toEqual([{ app_id: app.id, workspace_id: "default" }]);
    expect(appCount(db)).toBe(1);
  });

  test("one transaction: a failing app_workspaces insert rolls the App row back", async () => {
    const db = createMigratedD1();
    rawRun(
      db,
      `CREATE TRIGGER fail_mapping BEFORE INSERT ON app_workspaces
       BEGIN SELECT RAISE(ABORT, 'mapping fail'); END;`,
    );
    await expect(seedApp(db)).rejects.toThrow(/mapping fail/);
    expect(appCount(db)).toBe(0);
    expect(mappingRows(db)).toEqual([]);
  });

  test("the mapping write is in the same batch: a github_app_id conflict rolls back both rows", async () => {
    const db = createMigratedD1();
    const first = await seedApp(db);
    await expect(seedApp(db, { githubAppId: APP_INPUT.githubAppId })).rejects.toThrow(
      /UNIQUE constraint failed: github_apps.github_app_id/,
    );
    expect(mappingRows(db)).toEqual([{ app_id: first.id, workspace_id: "default" }]);
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
    const app = await seedApp(db, { workspaceId: "second" });
    expect(mappingRows(db)).toEqual([{ app_id: app.id, workspace_id: "second" }]);
  });

  test("a soft-deleted workspace row is never the write target: the named live one receives the mapping", async () => {
    const db = createMigratedD1();
    rawRun(
      db,
      `INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
       VALUES ('retired', 'retired', 'Retired', NULL, '2026-10-21T00:00:00.000Z', '2026-10-21T01:00:00.000Z')`,
    );
    const app = await seedApp(db);
    expect(mappingRows(db)).toEqual([{ app_id: app.id, workspace_id: "default" }]);
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
    rawRun(db, "UPDATE github_apps SET deleted_at = datetime('now') WHERE id = ?", first.id);
    const second = await seedApp(db, { githubAppId: 7302, maxApps: 1 });
    expect(mappingRows(db)).toEqual([
      { app_id: first.id, workspace_id: "default" },
      { app_id: second.id, workspace_id: "default" },
    ]);
  });

  test("a github_app_id conflict is still a UNIQUE error, never reclassified as a cap hit", async () => {
    const db = createMigratedD1();
    await seedApp(db, { githubAppId: 7401, maxApps: null });
    await expect(seedApp(db, { githubAppId: 7401, maxApps: null })).rejects.toThrow(
      /UNIQUE constraint failed: github_apps.github_app_id/,
    );
    expect(appCount(db)).toBe(1);
  });

  test("a NULL cap is unlimited: an eleventh App still lands", async () => {
    const db = createMigratedD1();
    for (let at = 0; at < 11; at += 1) await seedApp(db, { githubAppId: 7600 + at, maxApps: null });
    expect(appCount(db)).toBe(11);
    expect(mappingRows(db)).toHaveLength(11);
  });

  test("every execution-facing read joins app_workspaces in ONE statement", async () => {
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
      expect(query).toContain("INNER JOIN app_workspaces");
      expect(query).toContain("w.workspace_id");
    }
  });

  // Two creation paths, both in the store and both legitimate: `createApp`
  // (an App plus its same-id bot) and `createBot` (a standalone bot). The pin
  // keeps every other module out of the table — an ad-hoc INSERT elsewhere
  // fails here — so the intent survives the second path.
  //
  // A per-file count alone does not pin the PATHS: moving one INSERT to another
  // function in the same file kept the count at 2 and the test green. Neither
  // does remembering the nearest preceding `    async x(` line: an INSERT moved
  // into a later NON-async member was still credited to the async one above
  // it. Each hit is therefore attributed to the function whose BODY contains
  // it, found by brace depth from that function's opening brace, and the whole
  // map must be exactly the two creation functions.
  test("an INSERT is attributed to the function whose body encloses it, not the nearest member line", () => {
    // The shape that broke line-scanning: a non-async function after an async
    // one, holding the INSERT.
    const source = [
      "function outer() {",
      "  return {",
      "    async createBot(input: string): Promise<boolean> {",
      "      const sql = `INSERT INTO review_bots (id) SELECT 'unused'`;",
      "      return sql.length > 0;",
      "    },",
      "    createLater(input: string): void {",
      "      void `INSERT INTO review_bots (id) SELECT ?1`;",
      "      void input;",
      "    },",
      "  };",
      "}",
    ].join("\n");
    expect([...source.matchAll(/INSERT INTO review_bots\b/g)].map((hit) => enclosingFunction(source, hit.index!))).toEqual([
      "createBot",
      "createLater",
    ]);
  });

  test("src/ holds exactly the two creation-path INSERT INTO review_bots sites, one per creation function", () => {
    const root = join(import.meta.dir, "../../");
    const owners = new Map<string, string[]>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) {
          const text = readFileSync(path, "utf8");
          const relative = path.slice(root.length);
          for (const match of text.matchAll(/INSERT INTO review_bots\b/g)) {
            const list = owners.get(relative) ?? [];
            list.push(enclosingFunction(text, match.index!));
            owners.set(relative, list);
          }
        }
      }
    };
    walk(join(root, "src"));
    expect([...owners.entries()].map(([file, fns]) => `${file} ${fns.sort().join(",")}`)).toEqual([
      "src/dashboard/apps-store.ts createApp,createBot",
    ]);
  });
});

describe("apps-store sandbox image selection (migration 0018)", () => {
  test("createApp materializes the migration 0018 default: sandbox_image_id 'omp'", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const botRow = db.raw.query("SELECT sandbox_image_id FROM review_bots WHERE id = ?").get(app.id) as {
      sandbox_image_id: string;
    };
    expect(botRow.sandbox_image_id).toBe("omp");
  });

  test("setSandboxImage stores an enabled registry id, bumps updated_at, and reports the change", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    rawRun(db, "UPDATE review_bots SET updated_at = '2026-01-01 00:00:00' WHERE id = ?", app.id);
    expect(await store(db).setSandboxImage(app.id, "omp")).toBe(true);
    const botRow = db.raw.query("SELECT sandbox_image_id, updated_at FROM review_bots WHERE id = ?").get(app.id) as {
      sandbox_image_id: string;
      updated_at: string;
    };
    expect(botRow.sandbox_image_id).toBe("omp");
    expect(botRow.updated_at).not.toBe("2026-01-01 00:00:00");
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
    const botRow = db.raw.query("SELECT sandbox_image_id FROM review_bots WHERE id = ?").get(app.id) as {
      sandbox_image_id: string;
    };
    expect(botRow.sandbox_image_id).toBe("omp");
  });

  test("setSandboxImage refuses soft-deleted apps (a deleted app is never mutated)", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    await store(db).softDeleteApp(app.id);
    const deleted = (await store(db).getAppById(app.id))!;
    expect(await store(db).setSandboxImage(app.id, "omp")).toBe(false);
    const row = (await store(db).getAppById(app.id))!;
    expect(row.deleted_at).not.toBeNull();
    expect(row.updated_at).toBe(deleted.updated_at);
  });
});

describe("apps-store delivery read faces (consumption)", () => {
  test("deliverySummary + listDeliveries serve the delivery UI faces over the apps-store fixture", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    await s.recordDelivery({ appId: app.id, eventName: "ping", outcome: "ignored", statusCode: null, repositoryFullName: null, reason: null });
    await s.recordDelivery({ appId: app.id, eventName: "pull_request", outcome: "rejected", statusCode: 401, repositoryFullName: null, reason: null });
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
    await s.recordDelivery({ appId: app.id, eventName: "pull_request", outcome: "ok", statusCode: null, repositoryFullName: null, reason: null });
    for (let i = 0; i < 6; i++) {
      await s.recordDelivery({ appId: app.id, eventName: "check_run", outcome: "ignored", statusCode: null, repositoryFullName: null, reason: null });
    }
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

    expect(page.rows).toHaveLength(5);
    expect(page.rows.every((r) => r.event_name === "check_run" && r.outcome === "ignored")).toBe(true);
  });

  test("deliverySummaries batches latest row + 24h rejected count per app in ONE call (QC W-1), incl. zero-delivery apps", async () => {
    const db = createMigratedD1();
    const appA = await seedApp(db);
    const appB = await seedApp(db, { githubAppId: 123457 });
    const appC = await seedApp(db, { githubAppId: 123458 });
    const s = store(db);
    await s.recordDelivery({ appId: appA.id, eventName: "ping", outcome: "ignored", statusCode: null, repositoryFullName: null, reason: null });
    await s.recordDelivery({ appId: appA.id, eventName: "pull_request", outcome: "ok", statusCode: null, repositoryFullName: null, reason: null });
    await s.recordDelivery({ appId: appA.id, eventName: "pull_request", outcome: "rejected", statusCode: 401, repositoryFullName: null, reason: null });
    await s.recordDelivery({ appId: appB.id, eventName: "pull_request", outcome: "rejected", statusCode: 500, repositoryFullName: null, reason: null });
    await s.recordDelivery({ appId: appB.id, eventName: "pull_request", outcome: "ok", statusCode: null, repositoryFullName: null, reason: null });
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
      rejected24h: 0,
    });
    expect(summaries[appC.id]).toEqual({ latest: null, rejected24h: 0 });
  });

  test("deliverySummaries returns ONLY the requested apps; an empty list is an empty map", async () => {
    const db = createMigratedD1();
    const appA = await seedApp(db);
    await seedApp(db, { githubAppId: 123459 });
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
      `INSERT INTO webhook_deliveries (id, app_id, event_name, outcome, status_code, repository_full_name, created_at)
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
        `SELECT app_id, id, event_name, outcome, status_code, repository_full_name, created_at FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY app_id
             ORDER BY CASE WHEN outcome IN ('ok', 'paused', 'rejected') THEN 0 ELSE 1 END,
                      created_at DESC, rowid DESC) AS rn
           FROM webhook_deliveries WHERE app_id = ?
         ) WHERE rn = 1`,
      ).get(id) ?? null;
      expect(summaries[id]).toEqual({ latest, rejected24h: 0 });
    }
    expect(summaries["missing-app"]).toEqual({ latest: null, rejected24h: 0 });
    expect(summaries[apps[2]!.id]).toEqual({ latest: null, rejected24h: 0 });
    expect(summaries[apps[0]!.id]!.latest!.id).toBe("delivery-296");
    expect(summaries[apps[1]!.id]!.latest!.id).toBe("delivery-299");
  });

  test("deliverySummaries splits a large scoped batch under the D1 bound-parameter cap", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db, { githubAppId: 123470 });
    seedTarget(db, app.id, { workspaceId: "default", repoOwner: "acme", repoName: "widgets" });
    const insert = db.raw.prepare(
      `INSERT INTO webhook_deliveries (id, app_id, event_name, outcome, status_code, repository_full_name)
       VALUES (?, ?, 'pull_request', ?, ?, ?)`,
    );
    insert.run("visible", app.id, "rejected", 401, "acme/widgets");
    insert.run("hidden", app.id, "ok", null, "globex/secret-repo");
    const ids = [...Array.from({ length: 149 }, (_, index) => `missing-${index}`), app.id];

    const before = db.boundValueCounts!.length;
    const summaries = await store(db).deliverySummaries(ids, "default");

    expect(Math.max(...db.boundValueCounts!.slice(before))).toBeLessThanOrEqual(100);
    expect(Object.keys(summaries)).toHaveLength(150);
    expect(summaries[app.id]!.latest!.id).toBe("visible");
    expect(summaries[app.id]!.rejected24h).toBe(1);
    expect(summaries["missing-148"]).toEqual({ latest: null, rejected24h: 0 });
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
      "idx_webhook_deliveries_app_health",
      "idx_webhook_deliveries_app_outcome_created",
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
    db.raw.run("DROP TABLE webhook_deliveries");
    await expect(store(db).deliverySummaries(["missing-app"])).rejects.toThrow("no such table");
  });

  test("deliverySummaries ranks by outcome tier: a newer ignored bypass row never outranks an older ok", async () => {
    const db = createMigratedD1();
    const app = await seedApp(db);
    const s = store(db);
    await s.recordDelivery({ appId: app.id, eventName: "pull_request", outcome: "ok", statusCode: null, repositoryFullName: null, reason: null });
    await s.recordDelivery({ appId: app.id, eventName: "check_run", outcome: "ignored", statusCode: null, repositoryFullName: null, reason: null });
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
    db.raw.prepare("UPDATE github_apps SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(app.id);

    const changed = await store(db).saveGithubMetadata(app.id, METADATA);
    expect(changed).toBe(true);

    const row = db.raw
      .query(
        `SELECT github_name, github_description, github_html_url, github_avatar_url,
                github_slug, github_metadata_synced_at, updated_at
         FROM github_apps WHERE id = ?`,
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

    expect(
      await s.saveGithubMetadata(app.id, { ...METADATA, githubName: "Renamed App", githubSlug: null }),
    ).toBe(true);
    const row = await s.getAppById(app.id);
    expect(row!.github_name).toBe("Renamed App");
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
    db.raw.prepare("UPDATE github_apps SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(app.id);

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

    await store(db).touchGithubMetadataAttempt(app.id);
    await store(db).touchGithubMetadataAttempt(crypto.randomUUID());

    expect((await store(db).getAppById(app.id))!.github_metadata_attempted_at).toBeNull();
  });
});

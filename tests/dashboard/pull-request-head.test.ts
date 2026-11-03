/**
 * PR head watermark (migration 0044):
 *   - `upsertPullRequest` writes `head_sha` + `head_at` as ONE pair, ordered by
 *     the payload stamp, so an out-of-order delivery cannot rewind the ledger;
 *   - `selectPrHead` reads that pair as one point read on the ledger's own
 *     UNIQUE key, `null` when the row is absent.
 *
 * The fixture is the real migration DDL (`createMigratedTestD1` walks
 * `migrations/`), so 0044's ALTER TABLE is what these assertions run against.
 * Stamps use the `.000Z` spelling `pullRequestRecord` emits
 * (`normalizeRfc3339` → `new Date(v).toISOString()`); the write compares them
 * as text, so the fixture spelling is the one the ledger actually holds.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { createAppsStore, type UpsertPullRequestInput } from "../../src/dashboard/apps-store";

const APP_ID = "app-pr-head";

function seedApp(db: TestD1): void {
  const now = "2026-01-01T00:00:00.000Z";
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, created_at, updated_at)
       VALUES (?, NULL, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
               'octocat', 'active', ?, ?)`,
    )
    .run(APP_ID, 3001, APP_ID, now, now);
}

const ADDRESS = { appId: APP_ID, owner: "acme", repo: "widgets", prNumber: 132 };

function delivery(over: Partial<UpsertPullRequestInput> = {}): UpsertPullRequestInput {
  return { ...ADDRESS, title: "Add a thing", state: "open", headSha: "sha-1", ...over };
}

describe("upsertPullRequest head watermark (0044)", () => {
  test("a first delivery naming a sha stores the sha and the stamp it arrived with", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(delivery({ updatedAt: "2026-03-01T10:00:00.000Z" }));
    expect(await createAppsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-1",
      headAt: "2026-03-01T10:00:00.000Z",
    });
  });

  test("a newer stamp advances BOTH the sha and the watermark", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(delivery({ updatedAt: "2026-03-01T10:00:00.000Z" }));
    await createAppsStore(db).upsertPullRequest(
      delivery({ headSha: "sha-2", updatedAt: "2026-03-01T10:05:00.000Z" }),
    );
    expect(await createAppsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-2",
      headAt: "2026-03-01T10:05:00.000Z",
    });
  });

  test("an out-of-order (older) delivery rewinds neither the sha nor the watermark", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(
      delivery({ headSha: "sha-new", updatedAt: "2026-03-01T10:05:00.000Z" }),
    );
    await createAppsStore(db).upsertPullRequest(
      delivery({ headSha: "sha-old", updatedAt: "2026-03-01T10:00:00.000Z" }),
    );
    expect(await createAppsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-new",
      headAt: "2026-03-01T10:05:00.000Z",
    });
  });

  test("an equal stamp takes the arriving delivery (the tie the state predicate also takes)", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(
      delivery({ headSha: "sha-a", updatedAt: "2026-03-01T10:00:00.000Z" }),
    );
    await createAppsStore(db).upsertPullRequest(
      delivery({ headSha: "sha-b", updatedAt: "2026-03-01T10:00:00.000Z" }),
    );
    expect(await createAppsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-b",
      headAt: "2026-03-01T10:00:00.000Z",
    });
  });

  test("a delivery with no usable stamp still fills an unknown sha and leaves the watermark unknown", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest({ ...ADDRESS, title: null, state: "open", headSha: null });
    await createAppsStore(db).upsertPullRequest(delivery({ updatedAt: null }));
    expect(await createAppsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-1",
      headAt: null,
    });
  });

  test("a stamped delivery fills a pre-0044 row's unknown watermark", async () => {
    // The upgrade path: a row written before 0044 has a sha but no stamp, and
    // only the `head_at IS NULL` disjunct of the write CASE can ever fill it.
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest({ ...ADDRESS, title: null, state: "open", headSha: null });
    await createAppsStore(db).upsertPullRequest(delivery({ updatedAt: null }));
    await createAppsStore(db).upsertPullRequest(
      delivery({ headSha: "sha-2", updatedAt: "2026-03-01T10:00:00.000Z" }),
    );
    expect(await createAppsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-2",
      headAt: "2026-03-01T10:00:00.000Z",
    });
  });

  test("a newer stamp for the SAME sha advances only the watermark", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(delivery({ updatedAt: "2026-03-01T10:00:00.000Z" }));
    await createAppsStore(db).upsertPullRequest(delivery({ updatedAt: "2026-03-01T10:05:00.000Z" }));
    expect(await createAppsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-1",
      headAt: "2026-03-01T10:05:00.000Z",
    });
  });

  test("a stamp without a sha dates no sha it never had", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(delivery({ updatedAt: "2026-03-01T10:00:00.000Z" }));
    // A later delivery that carries only a state change (no head sha).
    await createAppsStore(db).upsertPullRequest({
      ...ADDRESS,
      state: "open",
      updatedAt: "2026-03-01T11:00:00.000Z",
    });
    expect(await createAppsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-1",
      headAt: "2026-03-01T10:00:00.000Z",
    });
  });

  test("selectPrHead answers null for a row that does not exist", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    expect(await createAppsStore(db).selectPrHead(ADDRESS)).toBeNull();
  });
});

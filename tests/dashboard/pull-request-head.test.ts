import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, seedTarget, syncSplitPair, type TestD1 } from "../store/helpers";
import { createReviewBotsStore, type UpsertPullRequestInput } from "../../src/dashboard/apps-store";

const APP_ID = "app-pr-head";
const TARGET_ID = "target-app-pr-head";

function seedApp(db: TestD1, id = APP_ID, githubAppId = 3001): void {
  const now = "2026-01-01T00:00:00.000Z";
  db.raw.prepare(
      `INSERT INTO github_apps
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, created_at, updated_at)
       VALUES (?, NULL, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
               'octocat', 'active', ?, ?)`,
    )
    .run(id, githubAppId, id, now, now);
  // The split pair: the bot row and the default-workspace mapping the
  // same-id invariant of this release requires beside the App row.
  syncSplitPair(db);
  seedTarget(db, id, { id: `target-${id}` });
}

const ADDRESS = { targetId: TARGET_ID, owner: "acme", repo: "widgets", prNumber: 132 };

function delivery(over: Partial<UpsertPullRequestInput> = {}): UpsertPullRequestInput {
  return { ...ADDRESS, appId: APP_ID, title: "Add a thing", state: "open", headSha: "sha-1", ...over };
}

describe("upsertPullRequest head watermark (0044)", () => {
  test("a first delivery naming a sha stores the sha and the stamp it arrived with", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(delivery({ updatedAt: "2026-03-01T10:00:00.000Z" }));
    expect(await createReviewBotsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-1",
      headAt: "2026-03-01T10:00:00.000Z",
    });
  });

  test("a newer stamp advances BOTH the sha and the watermark", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(delivery({ updatedAt: "2026-03-01T10:00:00.000Z" }));
    await createReviewBotsStore(db).upsertPullRequest(
      delivery({ headSha: "sha-2", updatedAt: "2026-03-01T10:05:00.000Z" }),
    );
    expect(await createReviewBotsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-2",
      headAt: "2026-03-01T10:05:00.000Z",
    });
  });

  test("an out-of-order (older) delivery rewinds neither the sha nor the watermark", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(
      delivery({ headSha: "sha-new", updatedAt: "2026-03-01T10:05:00.000Z" }),
    );
    await createReviewBotsStore(db).upsertPullRequest(
      delivery({ headSha: "sha-old", updatedAt: "2026-03-01T10:00:00.000Z" }),
    );
    expect(await createReviewBotsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-new",
      headAt: "2026-03-01T10:05:00.000Z",
    });
  });

  test("an equal stamp takes the arriving delivery (the tie the state predicate also takes)", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(
      delivery({ headSha: "sha-a", updatedAt: "2026-03-01T10:00:00.000Z" }),
    );
    await createReviewBotsStore(db).upsertPullRequest(
      delivery({ headSha: "sha-b", updatedAt: "2026-03-01T10:00:00.000Z" }),
    );
    expect(await createReviewBotsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-b",
      headAt: "2026-03-01T10:00:00.000Z",
    });
  });

  test("a delivery with no usable stamp still fills an unknown sha and leaves the watermark unknown", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(delivery({ title: null, headSha: null }));
    await createReviewBotsStore(db).upsertPullRequest(delivery({ updatedAt: null }));
    expect(await createReviewBotsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-1",
      headAt: null,
    });
  });

  test("a stamped delivery fills a pre-0044 row's unknown watermark", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(delivery({ title: null, headSha: null }));
    await createReviewBotsStore(db).upsertPullRequest(delivery({ updatedAt: null }));
    await createReviewBotsStore(db).upsertPullRequest(
      delivery({ headSha: "sha-2", updatedAt: "2026-03-01T10:00:00.000Z" }),
    );
    expect(await createReviewBotsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-2",
      headAt: "2026-03-01T10:00:00.000Z",
    });
  });

  test("a newer stamp for the SAME sha advances only the watermark", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(delivery({ updatedAt: "2026-03-01T10:00:00.000Z" }));
    await createReviewBotsStore(db).upsertPullRequest(delivery({ updatedAt: "2026-03-01T10:05:00.000Z" }));
    expect(await createReviewBotsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-1",
      headAt: "2026-03-01T10:05:00.000Z",
    });
  });

  test("a stamp without a sha dates no sha it never had", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(delivery({ updatedAt: "2026-03-01T10:00:00.000Z" }));
    await createReviewBotsStore(db).upsertPullRequest(
      delivery({ headSha: undefined, updatedAt: "2026-03-01T11:00:00.000Z" }),
    );
    expect(await createReviewBotsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-1",
      headAt: "2026-03-01T10:00:00.000Z",
    });
  });

  test("a stamp-less delivery cannot rewind a known sha", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(
      delivery({ headSha: "sha-new", updatedAt: "2026-03-01T10:05:00.000Z" }),
    );
    await createReviewBotsStore(db).upsertPullRequest(delivery({ headSha: "sha-old", updatedAt: null }));
    expect(await createReviewBotsStore(db).selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-new",
      headAt: "2026-03-01T10:05:00.000Z",
    });
  });

  test("selectPrHead is scoped to one target's rows", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    const otherId = "app-pr-head-other";
    seedApp(db, otherId, 3002);
    await createReviewBotsStore(db).upsertPullRequest(delivery({ updatedAt: "2026-03-01T10:00:00.000Z" }));
    await createReviewBotsStore(db).upsertPullRequest(
      delivery({
        appId: otherId,
        targetId: `target-${otherId}`,
        headSha: "sha-other",
        updatedAt: "2026-03-01T10:05:00.000Z",
      }),
    );

    const store = createReviewBotsStore(db);
    expect(await store.selectPrHead(ADDRESS)).toEqual({
      headSha: "sha-1",
      headAt: "2026-03-01T10:00:00.000Z",
    });
    expect(await store.selectPrHead({ ...ADDRESS, targetId: "target-with-no-rows" })).toBeNull();
  });

  test("a numeric-offset stamp is rewritten to UTC inside the write, not trusted from the caller", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(delivery({ updatedAt: "2026-03-01T12:00:00+02:00" }));
    expect((await createReviewBotsStore(db).selectPrHead(ADDRESS))?.headAt).toBe("2026-03-01T10:00:00.000Z");
  });

  test("selectPrHead answers null for a row that does not exist", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    expect(await createReviewBotsStore(db).selectPrHead(ADDRESS)).toBeNull();
  });
});

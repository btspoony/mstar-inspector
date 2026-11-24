import { describe, expect, spyOn, test } from "bun:test";
import { createMigratedTestD1, seedTarget, type TestD1 } from "../store/helpers";
import {
  createReviewBotsStore,
  PULL_REQUEST_LIST_LIMIT,
  type LedgerScope,
} from "../../src/dashboard/apps-store";
import { releaseInflight } from "../../src/store/inflight-store";

const APP_ID = "app-pr-ledger";
const WORKSPACE = "default";
const TARGET_ID = "target-app-pr-ledger";
const SCOPE: LedgerScope = { kind: "target", targetId: TARGET_ID, workspaceId: WORKSPACE };
const SCOPE_FOREIGN: LedgerScope = { ...SCOPE, workspaceId: "another-workspace" };

function seedApp(db: TestD1, id = APP_ID, githubAppId = 2001): string {
  const now = "2026-01-01T00:00:00.000Z";
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, created_at, updated_at)
       VALUES (?, NULL, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
               'octocat', 'active', ?, ?)`,
    )
    .run(id, githubAppId, id, now, now);
  db.raw.prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, 'default')").run(id);
  return seedTarget(db, id, { id: `target-${id}` });
}

const PR = {
  appId: APP_ID,
  targetId: TARGET_ID,
  owner: "acme",
  repo: "widgets",
  prNumber: 131,
  title: "Add a thing",
  state: "open",
  headSha: "sha-1",
};

async function ledgerRead(
  db: TestD1,
  filter?: { owner: string; repo: string },
): Promise<{ rows: number; prepares: number }> {
  let prepares = 0;
  const counted = {
    prepare(query: string) {
      prepares += 1;
      return db.prepare(query);
    },
    batch: db.batch.bind(db),
  };
  const { rows } = await createReviewBotsStore(counted as never).listPullRequests(SCOPE, filter);
  return { rows: rows.length, prepares };
}

describe("upsertPullRequest", () => {
  test("insert then re-delivery keeps ONE row on the (app, owner, repo, number) key", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, updatedAt: "2026-01-01T00:00:00.000Z" });
    await createReviewBotsStore(db).upsertPullRequest({
      ...PR,
      headSha: "sha-2",
      updatedAt: "2026-01-01T00:05:00.000Z",
    });
    const rows = db.raw.prepare("SELECT * FROM pull_requests WHERE bot_id = ?").all(APP_ID) as Array<{
      head_sha: string;
      title: string;
      state: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.head_sha).toBe("sha-2");
  });

  test("a second delivery advances last_seen_at and leaves first_seen_at alone", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(PR);
    db.raw.prepare("UPDATE pull_requests SET first_seen_at = '2020-01-01 00:00:00', last_seen_at = '2020-01-01 00:00:00'").run();
    await createReviewBotsStore(db).upsertPullRequest(PR);
    const row = db.raw
      .prepare("SELECT first_seen_at, last_seen_at FROM pull_requests WHERE bot_id = ?")
      .get(APP_ID) as { first_seen_at: string; last_seen_at: string };
    expect(row.first_seen_at).toBe("2020-01-01 00:00:00");
    expect(row.last_seen_at).not.toBeNull();
    expect(row.last_seen_at > "2020-01-01 00:00:00").toBe(true);
  });

  test("an omitted title / head_sha keeps the stored value; state overwrites while non-terminal", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(PR);
    await createReviewBotsStore(db).upsertPullRequest({
      appId: APP_ID,
      targetId: TARGET_ID,
      owner: "acme",
      repo: "widgets",
      prNumber: 131,
      state: "merged",
    });
    const row = db.raw
      .prepare("SELECT title, state, head_sha FROM pull_requests WHERE bot_id = ?")
      .get(APP_ID) as { title: string; state: string; head_sha: string };
    expect(row.title).toBe("Add a thing");
    expect(row.head_sha).toBe("sha-1");
    expect(row.state).toBe("merged");
  });

  test("a merged PR stays merged: a late `opened` delivery cannot reopen it", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, state: "merged" });
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, state: "open", updatedAt: "2020-01-01T00:00:00Z" });
    const row = db.raw
      .prepare("SELECT state FROM pull_requests WHERE bot_id = ? AND owner = ? AND repo = ? AND pr_number = ?")
      .get(APP_ID, "acme", "widgets", 131) as { state: string };
    expect(row.state).toBe("merged");
  });

  test("last_seen_at follows the payload's updated_at and never moves backwards", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, updatedAt: "2026-03-04T05:06:07Z" });
    const first = db.raw
      .prepare("SELECT last_seen_at FROM pull_requests WHERE bot_id = ?")
      .get(APP_ID) as { last_seen_at: string };
    expect(first.last_seen_at).toBe("2026-03-04 05:06:07");

    await createReviewBotsStore(db).upsertPullRequest({ ...PR, updatedAt: "2026-01-01T00:00:00Z" });
    const after = db.raw
      .prepare("SELECT last_seen_at FROM pull_requests WHERE bot_id = ?")
      .get(APP_ID) as { last_seen_at: string };
    expect(after.last_seen_at).toBe("2026-03-04 05:06:07");
  });
});

describe("listPullRequests", () => {
  test("attaches the newest review, counts failures, and reads [] for a PR with neither", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(PR);
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, prNumber: 132, title: "Second", headSha: "sha-b" });
    db.raw
      .prepare("INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('i1', ?, 77, 'acme', datetime('now'))")
      .run(APP_ID);
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, bot_id, target_id, reviewed_at)
         VALUES ('r-old', 77, 'acme', 'widgets', 131, 'sha-0', 'comment', ?, ?, '2026-01-01 00:00:00'),
                ('r-new', 77, 'acme', 'widgets', 131, 'sha-1', 'approve', ?, ?, '2026-02-01 00:00:00')`,
      )
      .run(APP_ID, TARGET_ID, APP_ID, TARGET_ID);
    for (const id of ["f1", "f2"]) {
      db.raw
        .prepare(
          `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, target_id)
           VALUES (?, 77, 'acme', 'widgets', 131, 'sha-1', 'runner', 'boom', 'target-app-pr-ledger')`,
        )
        .run(id);
    }

    const { rows } = await createReviewBotsStore(db).listPullRequests(SCOPE);
    expect(rows.length).toBe(2);
    const byNumber = new Map(rows.map((row) => [row.number, row]));
    expect(byNumber.get(131)!.latest_review).toEqual({ verdict: "approve", reviewed_at: "2026-02-01 00:00:00" });
    expect(byNumber.get(131)!.failure_count).toBe(2);
    expect(byNumber.get(132)!.latest_review).toBeNull();
    expect(byNumber.get(132)!.failure_count).toBe(0);
  });

  for (const [stage, error] of [
    ["recheck", "skipped: budget: null"],
    ["usage", "D1_ERROR: no such table"],
  ] as const) {
    test(`${stage} attribution rows are not review failures: counted 0 and paged 0`, async () => {
      const db = createMigratedTestD1();
      seedApp(db);
      await createReviewBotsStore(db).upsertPullRequest(PR);
      db.raw
        .prepare("INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('i1', ?, 77, 'acme', datetime('now'))")
        .run(APP_ID);
      db.raw
        .prepare(
          `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, target_id)
           VALUES ('f-attribution', 77, 'acme', 'widgets', 131, 'sha-1', ?, ?, 'target-app-pr-ledger')`,
        )
        .run(stage, error);

      const store = createReviewBotsStore(db);
      expect((await store.listPullRequests(SCOPE)).rows[0]!.failure_count).toBe(0);
      expect((await store.countPullRequestRecords(SCOPE, "acme", "widgets", 131)).failures).toBe(0);
      const history = await store.listPullRequestFailures(SCOPE, "acme", "widgets", 131, {
        offset: 0,
        limit: 10,
      });
      expect(history!.total).toBe(0);
      expect(history!.items).toEqual([]);
      expect(db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 1 });
    });
  }

  test("quota rows stay visible on every dashboard failure face", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(PR);
    db.raw
      .prepare("INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('i1', ?, 77, 'acme', datetime('now'))")
      .run(APP_ID);
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, target_id)
         VALUES ('f-quota', 77, 'acme', 'widgets', 131, 'sha-1', 'quota', 'quota exceeded', 'target-app-pr-ledger')`,
      )
      .run();

    const store = createReviewBotsStore(db);
    expect((await store.listPullRequests(SCOPE)).rows[0]!.failure_count).toBe(1);
    expect((await store.countPullRequestRecords(SCOPE, "acme", "widgets", 131)).failures).toBe(1);
    const history = await store.listPullRequestFailures(SCOPE, "acme", "widgets", 131, {
      offset: 0,
      limit: 10,
    });
    expect(history!.total).toBe(1);
    expect(history!.items.map((item) => item.stage)).toEqual(["quota"]);
  });

  test("the failure count and the failures section total agree when both an attribution row and an ordinary one exist", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(PR);
    db.raw
      .prepare("INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('i1', ?, 77, 'acme', datetime('now'))")
      .run(APP_ID);
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, target_id)
         VALUES ('f-recheck', 77, 'acme', 'widgets', 131, 'sha-1', 'recheck', 'skipped: budget: null', 'target-app-pr-ledger'),
                ('f-runner', 77, 'acme', 'widgets', 131, 'sha-1', 'runner', 'boom', 'target-app-pr-ledger')`,
      )
      .run();

    const store = createReviewBotsStore(db);
    const counts = await store.countPullRequestRecords(SCOPE, "acme", "widgets", 131);
    const page = await store.listPullRequestFailures(SCOPE, "acme", "widgets", 131, { offset: 0, limit: 10 });
    expect(counts.failures).toBe(1);
    expect(page!.total).toBe(counts.failures);
    expect(page!.items.map((item) => item.stage)).toEqual(["runner"]);
  });

  test("a sibling App's reviews and failures never leak into the list", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    seedApp(db, "other-app", 2002);
    await createReviewBotsStore(db).upsertPullRequest(PR);
    db.raw
      .prepare("INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('i2', 'other-app', 88, 'acme', datetime('now'))")
      .run();
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, bot_id, target_id)
         VALUES ('r-other', 88, 'acme', 'widgets', 131, 'sha-x', 'request-changes', 'other-app', 'target-other-app')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, target_id)
         VALUES ('f-other', 88, 'acme', 'widgets', 131, 'sha-x', 'runner', 'boom', 'target-other-app')`,
      )
      .run();

    const { rows } = await createReviewBotsStore(db).listPullRequests(SCOPE);
    expect(rows.length).toBe(1);
    expect(rows[0]!.latest_review).toBeNull();
    expect(rows[0]!.failure_count).toBe(0);
  });

  test("the right target id under a workspace that does not own it reads nothing", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(PR);
    const store = createReviewBotsStore(db);
    const list = await store.listPullRequests(SCOPE_FOREIGN);
    expect(list.rows).toEqual([]);
    expect(list.repos).toEqual([]);
    expect(await store.getPullRequestHead(SCOPE_FOREIGN, "acme", "widgets", 131)).toBeNull();
  });

  test("a workspace scope reads every live target's rows, and only its own workspace", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    const second = seedTarget(db, APP_ID, { id: "target-pr-ledger-second", repoName: "gadgets" });
    const store = createReviewBotsStore(db);
    await store.upsertPullRequest(PR);
    await store.upsertPullRequest({ ...PR, targetId: second, repo: "gadgets", prNumber: 132 });

    const both = await store.listPullRequests({ kind: "workspace", workspaceId: WORKSPACE });
    expect(both.rows.map((row) => row.number).sort()).toEqual([131, 132]);
    expect(both.repos).toEqual(["acme/gadgets", "acme/widgets"]);

    const crossed = await store.listPullRequests({ kind: "workspace", workspaceId: "another-workspace" });
    expect(crossed.rows).toEqual([]);
    expect(crossed.repos).toEqual([]);
    expect(
      await store.getPullRequestHead(
        { kind: "target", targetId: second, workspaceId: "another-workspace" },
        "acme",
        "gadgets",
        132,
      ),
    ).toBeNull();
  });

  test("a workspace with no live target reads nothing on every face, never throwing", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(PR);
    const store = createReviewBotsStore(db);
    db.raw.prepare("UPDATE review_targets SET deleted_at = datetime('now')").run();
    const empty = { kind: "workspace", workspaceId: WORKSPACE } as const;

    expect(await store.listPullRequests(empty)).toEqual({ rows: [], repos: [] });
    expect(await store.getPullRequestHead(empty, "acme", "widgets", 131)).toBeNull();
    expect(await store.countPullRequestRecords(empty, "acme", "widgets", 131)).toEqual({
      findings: 0,
      reviews: 0,
      failures: 0,
      must_fix: 0,
    });
    expect(await store.listPullRequestFindings(empty, "acme", "widgets", 131, { offset: 0, limit: 10 })).toBeNull();
    expect(await store.listPullRequestReviews(empty, "acme", "widgets", 131, { offset: 0, limit: 10 })).toBeNull();
    expect(await store.listPullRequestFailures(empty, "acme", "widgets", 131, { offset: 0, limit: 10 })).toBeNull();
  });

  test("a delivery that names no target is refused, never written unattributed", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await expect(
      createReviewBotsStore(db).upsertPullRequest({
        appId: APP_ID,
        owner: "acme",
        repo: "widgets",
        prNumber: 131,
        state: "open",
      } as never),
    ).rejects.toThrow(/targetId is required/);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM pull_requests").get()).toEqual({ n: 0 });
  });

  test("is not N+1: a wider window costs the same statements, not one per row", async () => {
    const one = createMigratedTestD1();
    seedApp(one);
    await createReviewBotsStore(one).upsertPullRequest(PR);
    const three = createMigratedTestD1();
    seedApp(three);
    for (const n of [1, 2, 3]) await createReviewBotsStore(three).upsertPullRequest({ ...PR, prNumber: n });

    const single = await ledgerRead(one);
    const triple = await ledgerRead(three);
    expect(triple.rows).toBe(3);
    expect(triple.prepares).toBe(single.prepares);
  });

  test("the aggregates are scoped to the window (mechanism, not just the payload)", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(PR);

    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const recording = {
      prepare(sql: string) {
        const record = { sql, values: [] as unknown[] };
        statements.push(record);
        const inner = db.prepare(sql);
        return {
          bind(...values: unknown[]) {
            record.values = values;
            return inner.bind(...values);
          },
          first: inner.first.bind(inner),
          all: inner.all.bind(inner),
          run: inner.run.bind(inner),
        };
      },
      batch: db.batch.bind(db),
    };
    await createReviewBotsStore(recording as never).listPullRequests(SCOPE);

    const aggregates = statements.filter(
      (stmt) => stmt.sql.includes("FROM reviews") || stmt.sql.includes("FROM review_failures"),
    );
    expect(aggregates.length).toBeGreaterThan(0);
    for (const stmt of aggregates) {
      expect(stmt.values.slice(-5)).toEqual([
        TARGET_ID,
        WORKSPACE,
        TARGET_ID,
        WORKSPACE,
        PULL_REQUEST_LIST_LIMIT,
      ]);
    }
  });

  test("the payload lists only the window, newest first", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    const total = PULL_REQUEST_LIST_LIMIT + 1;
    for (let n = 1; n <= total; n++) {
      await createReviewBotsStore(db).upsertPullRequest({
        ...PR,
        prNumber: n,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
      });
    }
    db.raw
      .prepare("INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('i1', ?, 77, 'acme', datetime('now'))")
      .run(APP_ID);
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, bot_id, target_id)
         VALUES ('r-in', 77, 'acme', 'widgets', ?, 'sha-1', 'approve', ?, ?)`,
      )
      .run(total, APP_ID, TARGET_ID);
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, target_id)
         VALUES ('f-in', 77, 'acme', 'widgets', ?, 'sha-1', 'runner', 'boom', 'target-app-pr-ledger')`,
      )
      .run(total);

    const { rows } = await createReviewBotsStore(db).listPullRequests(SCOPE);
    expect(rows.length).toBe(PULL_REQUEST_LIST_LIMIT);
    expect(rows[0]!.number).toBe(total);
    expect(rows[0]!.latest_review).toEqual({ verdict: "approve", reviewed_at: expect.any(String) });
    expect(rows[0]!.failure_count).toBe(1);
    expect(rows.some((row) => row.number === 1)).toBe(false);
  });

  test("is bounded: never more than PULL_REQUEST_LIST_LIMIT rows, newest first", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    const total = PULL_REQUEST_LIST_LIMIT + 1;
    for (let n = 1; n <= total; n++) {
      await createReviewBotsStore(db).upsertPullRequest({
        ...PR,
        prNumber: n,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
      });
    }
    const { rows } = await createReviewBotsStore(db).listPullRequests(SCOPE);
    expect(rows.length).toBe(PULL_REQUEST_LIST_LIMIT);
    expect(rows[0]!.number).toBe(total);
    expect(rows.some((row) => row.number === 1)).toBe(false);
  });
});

describe("listPullRequests repository filter + option set", () => {
  const BEHIND = { ...PR, repo: "behind" };

  async function seedCappedLedger(db: TestD1) {
    seedApp(db);
    const store = createReviewBotsStore(db);
    for (let n = 1; n <= PULL_REQUEST_LIST_LIMIT; n++) {
      await store.upsertPullRequest({
        ...PR,
        prNumber: n,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
      });
    }
    for (const n of [9001, 9002]) {
      await store.upsertPullRequest({
        ...BEHIND,
        prNumber: n,
        updatedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, n)).toISOString(),
      });
    }
    db.raw
      .prepare("INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('i1', ?, 77, 'acme', datetime('now'))")
      .run(APP_ID);
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, bot_id, target_id, reviewed_at)
         VALUES ('r-behind', 77, 'acme', 'behind', 9002, 'sha-1', 'approve', ?, ?, '2026-02-01 00:00:00')`,
      )
      .run(APP_ID, TARGET_ID);
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, target_id)
         VALUES ('f-behind', 77, 'acme', 'behind', 9002, 'sha-1', 'runner', 'boom', 'target-app-pr-ledger')`,
      )
      .run();
    return store;
  }

  test("a repository behind the cap is still an option, and filtering reaches its rows", async () => {
    const db = createMigratedTestD1();
    const store = await seedCappedLedger(db);

    const unfiltered = await store.listPullRequests(SCOPE);
    expect(unfiltered.repos).toEqual(["acme/behind", "acme/widgets"]);
    expect(unfiltered.rows.length).toBe(PULL_REQUEST_LIST_LIMIT);
    expect(unfiltered.rows.some((row) => row.repo === "behind")).toBe(false);

    const filtered = await store.listPullRequests(SCOPE, { owner: "acme", repo: "behind" });
    expect(filtered.rows.map((row) => row.number).sort()).toEqual([9001, 9002]);
    expect(filtered.repos).toEqual(["acme/behind", "acme/widgets"]);
    const newest = filtered.rows.find((row) => row.number === 9002)!;
    expect(newest.latest_review).toEqual({ verdict: "approve", reviewed_at: "2026-02-01 00:00:00" });
    expect(newest.failure_count).toBe(1);
  });

  test("a filtered read is still a fixed-size batch", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    const store = createReviewBotsStore(db);
    for (const n of [1, 2, 3]) await store.upsertPullRequest({ ...PR, prNumber: n });
    await store.upsertPullRequest({ ...PR, repo: "other", prNumber: 901 });

    const all = await ledgerRead(db);
    const wide = await ledgerRead(db, { owner: "acme", repo: "widgets" });
    const narrow = await ledgerRead(db, { owner: "acme", repo: "other" });
    expect([all.rows, wide.rows, narrow.rows]).toEqual([4, 3, 1]);
    expect(wide.prepares).toBe(all.prepares);
    expect(wide.prepares).toBe(narrow.prepares);
  });

  test("the option set is one App's ledger, never a sibling App's", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    seedApp(db, "other-app", 2002);
    await createReviewBotsStore(db).upsertPullRequest(PR);
    await createReviewBotsStore(db).upsertPullRequest({
      ...PR,
      appId: "other-app",
      targetId: "target-other-app",
      repo: "theirs",
    });
    expect((await createReviewBotsStore(db).listPullRequests(SCOPE)).repos).toEqual(["acme/widgets"]);
  });
});

describe("sweepTerminalPullRequests", () => {
  const RETENTION = { days: 90, cap: 500 };

  test("an older `closed` cannot mark a reopened PR, and it survives retention", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, state: "closed", updatedAt: "2020-01-01T00:00:00Z" });
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, state: "open", updatedAt: "2026-01-01T00:00:00Z" });
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, state: "closed", updatedAt: "2020-06-01T00:00:00Z" });

    const row = db.raw
      .prepare("SELECT state, last_seen_at FROM pull_requests WHERE bot_id = ?")
      .get(APP_ID) as { state: string; last_seen_at: string };
    expect(row.state).toBe("open");
    expect(row.last_seen_at).toBe("2026-01-01 00:00:00");

    expect(await createReviewBotsStore(db).sweepTerminalPullRequests(RETENTION)).toBe(0);
  });

  test("a newer `closed` after `open` DOES close it (and is not swept inside the window)", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    const fresh = new Date(Date.now() - 60_000).toISOString();
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, state: "open", updatedAt: "2020-01-01T00:00:00Z" });
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, state: "closed", updatedAt: fresh });
    const row = db.raw.prepare("SELECT state FROM pull_requests WHERE bot_id = ?").get(APP_ID) as {
      state: string;
    };
    expect(row.state).toBe("closed");
    expect(await createReviewBotsStore(db).sweepTerminalPullRequests(RETENTION)).toBe(0);
  });

  test("drops terminal rows past the window and keeps open ones however old", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    const old = "2020-01-01T00:00:00Z";
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, prNumber: 1, state: "merged", updatedAt: old });
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, prNumber: 2, state: "closed", updatedAt: old });
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, prNumber: 3, state: "open", updatedAt: old });
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, prNumber: 4, state: "closed" });

    expect(await createReviewBotsStore(db).sweepTerminalPullRequests(RETENTION)).toBe(2);
    const remaining = db.raw
      .prepare("SELECT pr_number FROM pull_requests ORDER BY pr_number")
      .all() as Array<{ pr_number: number }>;
    expect(remaining.map((row) => row.pr_number)).toEqual([3, 4]);
  });

  test("is idempotent — a second run deletes nothing", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, state: "merged", updatedAt: "2020-01-01T00:00:00Z" });
    expect(await createReviewBotsStore(db).sweepTerminalPullRequests(RETENTION)).toBe(1);
    expect(await createReviewBotsStore(db).sweepTerminalPullRequests(RETENTION)).toBe(0);
  });
});

describe("pull request detail reads", () => {
  function seedReview(db: TestD1, id: string, reviewedAt: string, verdict = "approve", round: number | null = null): void {
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md, model, provider, reviewed_at, bot_id, target_id, round)
         VALUES (?, 99, 'acme', 'widgets', 131, ?, ?, 'looks good', 'm1', 'p1', ?, ?, ?, ?)`,
      )
      .run(id, `sha-${id}`, verdict, reviewedAt, APP_ID, TARGET_ID, round);
  }

  async function detailFixture(): Promise<TestD1> {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(PR);
    db.raw
      .prepare("INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('i3', ?, 99, 'acme', datetime('now'))")
      .run(APP_ID);
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, target_id)
         VALUES ('fx', 99, 'acme', 'widgets', 131, 'sha-1', 'sandbox', 'timeout', 'target-app-pr-ledger')`,
      )
      .run();
    seedFinding(db, { findingId: "F-1", mergeClass: "must-fix", title: "Null deref", filePath: "src/a.ts", lineStart: 12, body: "guard it" });
    return db;
  }

  test("the must-fix tally counts every must-fix row, whatever the page or filter", async () => {
    const db = await detailFixture();
    for (let index = 2; index <= 12; index += 1) {
      seedFinding(
        db,
        { findingId: `F-${index}`, mergeClass: "must-fix", title: `t${index}`, filePath: "src/a.ts", lineStart: index, body: "b" },
        `row-${index}`,
      );
    }
    seedFinding(
      db,
      { findingId: "N-1", mergeClass: "nit", title: "n", filePath: "src/a.ts", lineStart: 1, body: "b" },
      "row-nit",
    );
    const store = createReviewBotsStore(db);
    expect(await store.countPullRequestRecords(SCOPE, "acme", "widgets", 131)).toEqual({
      findings: 13,
      reviews: 0,
      failures: 1,
      must_fix: 12,
    });
    const page = await store.listPullRequestFindings(SCOPE, "acme", "widgets", 131, {
      offset: 0,
      limit: 10,
      severity: "nit",
    });
    expect(page!.total).toBe(1);
  });

  test("an addressed or dismissed finding is excluded from the page and from both tallies", async () => {
    const db = await detailFixture();
    const addressed = { findingId: "F-2", mergeClass: "must-fix", title: "a", filePath: "src/a.ts", lineStart: 2, body: "b" };
    const dismissed = { findingId: "F-3", mergeClass: "must-fix", title: "d", filePath: "src/a.ts", lineStart: 3, body: "b" };
    seedFinding(db, addressed, "row-2", "addressed");
    seedFinding(db, dismissed, "row-3", "dismissed");
    const store = createReviewBotsStore(db);

    expect(await store.countPullRequestRecords(SCOPE, "acme", "widgets", 131)).toEqual({
      findings: 1,
      reviews: 0,
      failures: 1,
      must_fix: 1,
    });

    const page = await store.listPullRequestFindings(SCOPE, "acme", "widgets", 131, { offset: 0, limit: 10 });
    expect(page!.total).toBe(1);
    expect(page!.items.map((finding) => finding.finding_id)).toEqual(["F-1"]);

    const filtered = await store.listPullRequestFindings(SCOPE, "acme", "widgets", 131, {
      offset: 0,
      limit: 10,
      severity: "must-fix",
    });
    expect(filtered!.total).toBe(1);
    expect(filtered!.items.map((finding) => finding.finding_id)).toEqual(["F-1"]);
  });

  test("the head, the counts and each record page read the same PR", async () => {
    const db = await detailFixture();
    seedReview(db, "r1", "2026-01-02 00:00:00");
    const store = createReviewBotsStore(db);

    const head = await store.getPullRequestHead(SCOPE, "acme", "widgets", 131);
    expect(head?.title).toBe("Add a thing");
    expect(head?.latest_review).toEqual({
      verdict: "approve",
      model: "m1",
      provider: "p1",
      reviewed_at: "2026-01-02 00:00:00",
      head_sha: "sha-r1",
    });

    expect(await store.countPullRequestRecords(SCOPE, "acme", "widgets", 131)).toEqual({
      findings: 1,
      reviews: 1,
      failures: 1,
      must_fix: 1,
    });

    const page = { offset: 0, limit: 10 };
    const findings = await store.listPullRequestFindings(SCOPE, "acme", "widgets", 131, page);
    expect(findings!.total).toBe(1);
    expect(findings!.items).toEqual([
      {
        finding_id: "F-1",
        severity: "must-fix",
        title: "Null deref",
        file_path: "src/a.ts",
        line: 12,
        body: "guard it",
        review_round: 1,
      },
    ]);

    const reviews = await store.listPullRequestReviews(SCOPE, "acme", "widgets", 131, page);
    expect(reviews!.total).toBe(1);

    const failures = await store.listPullRequestFailures(SCOPE, "acme", "widgets", 131, page);
    expect(failures!.total).toBe(1);
    expect(failures!.items).toEqual([
      { stage: "sandbox", error: "timeout", message: null, error_code: null, track_id: null, created_at: expect.any(String) },
    ]);
  });

  test("a severity filter narrows the findings page and its total", async () => {
    const db = await detailFixture();
    seedFinding(
      db,
      { findingId: "F-2", mergeClass: "nit", title: "Rename a thing", filePath: "src/b.ts", lineStart: 3, body: "style" },
      "row-2",
    );
    const store = createReviewBotsStore(db);
    const page = { offset: 0, limit: 10 };
    expect((await store.listPullRequestFindings(SCOPE, "acme", "widgets", 131, page))!.total).toBe(2);
    const filtered = await store.listPullRequestFindings(SCOPE, "acme", "widgets", 131, {
      ...page,
      severity: "must-fix",
    });
    expect(filtered!.total).toBe(1);
    expect(filtered!.items.map((finding) => finding.finding_id)).toEqual(["F-1"]);
    const missing = await store.listPullRequestFindings(SCOPE, "acme", "widgets", 131, {
      ...page,
      severity: "blocker",
    });
    expect(missing).toEqual({ items: [], total: 0 });
  });

  test("an unclassified filter selects the findings outside the vocabulary", async () => {
    const db = await detailFixture();
    seedFinding(
      db,
      { findingId: "F-9", mergeClass: "blocker", title: "Unmapped class", filePath: "src/c.ts", lineStart: 1, body: "" },
      "row-9",
    );
    const store = createReviewBotsStore(db);
    const page = { offset: 0, limit: 10 };
    const unclassified = await store.listPullRequestFindings(SCOPE, "acme", "widgets", 131, {
      ...page,
      unclassified: true,
    });
    expect(unclassified!.total).toBe(1);
    expect(unclassified!.items.map((finding) => finding.finding_id)).toEqual(["F-9"]);
    const mustFix = await store.listPullRequestFindings(SCOPE, "acme", "widgets", 131, {
      ...page,
      severity: "must-fix",
    });
    expect(mustFix!.items.map((finding) => finding.finding_id)).toEqual(["F-1"]);
  });

  test("findings keep their insert order when a re-report advances updated_ms", async () => {
    const db = await detailFixture();
    seedFinding(
      db,
      { findingId: "F-2", mergeClass: "nit", title: "t2", filePath: "src/a.ts", lineStart: 2, body: "b" },
      "row-2",
    );
    seedFinding(
      db,
      { findingId: "F-3", mergeClass: "nit", title: "t3", filePath: "src/a.ts", lineStart: 3, body: "b" },
      "row-3",
    );
    const store = createReviewBotsStore(db);
    const ids = async (offset: number) =>
      (await store.listPullRequestFindings(SCOPE, "acme", "widgets", 131, { offset, limit: 2 }))!.items.map(
        (finding) => finding.finding_id,
      );
    expect(await ids(0)).toEqual(["F-3", "F-2"]);

    db.raw.prepare("UPDATE review_findings SET updated_ms = 99 WHERE finding_id = 'F-1'").run();
    expect(await ids(0)).toEqual(["F-3", "F-2"]);
    expect(await ids(2)).toEqual(["F-1"]);
  });

  test("limit/offset step through a section without moving its total", async () => {
    const db = await detailFixture();
    seedReview(db, "r1", "2026-01-02 00:00:00");
    seedReview(db, "r2", "2026-01-03 00:00:00");
    seedReview(db, "r3", "2026-01-04 00:00:00");
    const store = createReviewBotsStore(db);
    const first = await store.listPullRequestReviews(SCOPE, "acme", "widgets", 131, { offset: 0, limit: 2 });
    expect(first!.total).toBe(3);
    expect(first!.items.map((review) => review.reviewed_at)).toEqual(["2026-01-04 00:00:00", "2026-01-03 00:00:00"]);
    const second = await store.listPullRequestReviews(SCOPE, "acme", "widgets", 131, { offset: 2, limit: 2 });
    expect(second!.total).toBe(3);
    expect(second!.items.map((review) => review.reviewed_at)).toEqual(["2026-01-02 00:00:00"]);
  });

  test("a review row carries its round ordinal, run time and that round's findings", async () => {
    const db = await detailFixture();
    seedReview(db, "r1", "2026-01-02 00:00:00");
    seedReview(db, "r2", "2026-01-03 00:00:00");
    seedReview(db, "r3", "2026-01-04 00:00:00");
    db.raw
      .prepare(
        `INSERT INTO findings (id, review_id, severity, title)
         VALUES ('f-1', 'r2', 'must-fix', 'a'), ('f-2', 'r2', 'nit', 'b')`,
      )
      .run();
    db.raw.prepare("UPDATE reviews SET duration_ms = 65000 WHERE id = 'r3'").run();
    seedFinding(db, { findingId: "F-2", mergeClass: "nit", title: "n", filePath: "src/a.ts", lineStart: 1, body: "b" }, "row-2");
    db.raw
      .prepare("UPDATE review_findings SET first_seen_sha = 'sha-r2', first_seen_round = 2 WHERE finding_id = 'F-1'")
      .run();
    const store = createReviewBotsStore(db);

    const first = await store.listPullRequestReviews(SCOPE, "acme", "widgets", 131, { offset: 0, limit: 2 });
    expect(first!.items.map((review) => [review.round, review.duration_ms])).toEqual([
      [3, 65_000],
      [2, null],
    ]);
    const second = await store.listPullRequestReviews(SCOPE, "acme", "widgets", 131, { offset: 2, limit: 2 });
    expect(second!.items.map((review) => review.round)).toEqual([1]);

    const findings = await store.listPullRequestFindings(SCOPE, "acme", "widgets", 131, {
      offset: 0,
      limit: 10,
    });
    expect(findings!.items.map((finding) => [finding.finding_id, finding.review_round])).toEqual([
      ["F-2", 1],
      ["F-1", 2],
    ]);

    const filtered = await store.listPullRequestFindings(SCOPE, "acme", "widgets", 131, {
      offset: 0,
      limit: 10,
      severity: "nit",
    });
    expect(filtered!.total).toBe(1);
    expect(filtered!.items.map((finding) => [finding.finding_id, finding.review_round])).toEqual([["F-2", 1]]);
  });

  test("a finding's round survives a round with no reviews row", async () => {
    const db = await detailFixture();
    seedReview(db, "r1", "2026-01-02 00:00:00");
    seedFinding(
      db,
      { findingId: "F-3", mergeClass: "nit", title: "n", filePath: "src/a.ts", lineStart: 2, body: "b" },
      "row-3",
      "open",
      3,
      5,
    );
    const store = createReviewBotsStore(db);
    const findings = await store.listPullRequestFindings(SCOPE, "acme", "widgets", 131, { offset: 0, limit: 10 });
    expect(findings!.items.map((finding) => [finding.finding_id, finding.review_round])).toEqual([
      ["F-3", 3],
      ["F-1", 1],
    ]);
  });

  test("the stored round wins over the ordinal the head sha would derive", async () => {
    const db = await detailFixture();
    seedReview(db, "r1", "2026-01-02 00:00:00");
    seedReview(db, "r2", "2026-01-03 00:00:00", "approve", 3);
    db.raw
      .prepare("UPDATE review_findings SET first_seen_sha = 'sha-r2', first_seen_round = 3 WHERE finding_id = 'F-1'")
      .run();
    const store = createReviewBotsStore(db);

    const findings = await store.listPullRequestFindings(SCOPE, "acme", "widgets", 131, { offset: 0, limit: 10 });
    expect(findings!.items.map((finding) => [finding.finding_id, finding.review_round])).toEqual([["F-1", 3]]);

    const reviews = await store.listPullRequestReviews(SCOPE, "acme", "widgets", 131, { offset: 0, limit: 10 });
    expect(reviews!.items.map((review) => [review.head_sha, review.round])).toEqual([
      ["sha-r2", 3],
      ["sha-r1", 1],
    ]);
  });

  test("unknown PR number → null head (the route's 404)", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    expect(await createReviewBotsStore(db).getPullRequestHead(SCOPE, "acme", "widgets", 999)).toBeNull();
  });

  test("a section read answers 'no such PR' inside its own batch (the routes' 404)", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(PR);
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, repo: "gadgets", title: "Other repo's #131" });
    const store = createReviewBotsStore(db);
    const page = { offset: 0, limit: 10 };
    expect(await store.listPullRequestFindings(SCOPE, "acme", "widgets", 131, page)).not.toBeNull();
    expect(await store.listPullRequestReviews(SCOPE, "acme", "gadgets", 131, page)).not.toBeNull();
    expect(await store.listPullRequestFindings(SCOPE, "acme", "sprockets", 131, page)).toBeNull();
    expect(
      await store.listPullRequestReviews(
        { ...SCOPE, targetId: "target-other-app" },
        "acme",
        "widgets",
        131,
        page,
      ),
    ).toBeNull();
    expect(await store.listPullRequestFailures(SCOPE, "acme", "widgets", 999, page)).toBeNull();
    for (const [repo, number] of [["widgets", 131], ["gadgets", 131], ["sprockets", 131], ["widgets", 999]] as const) {
      expect((await store.listPullRequestFailures(SCOPE, "acme", repo, number, page)) === null).toBe(
        (await store.getPullRequestHead(SCOPE, "acme", repo, number)) === null,
      );
    }
  });

  test("the same number in another repo of the SAME App → null, never a fallback", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(PR);
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, repo: "gadgets", title: "Other repo's #131" });
    expect(await createReviewBotsStore(db).getPullRequestHead(SCOPE, "acme", "sprockets", 131)).toBeNull();
    expect((await createReviewBotsStore(db).getPullRequestHead(SCOPE, "acme", "gadgets", 131))?.title).toBe(
      "Other repo's #131",
    );
  });

  test("a PR number that belongs to a sibling App → null", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    seedApp(db, "other-app", 2002);
    await createReviewBotsStore(db).upsertPullRequest({
      ...PR,
      appId: "other-app",
      targetId: "target-other-app",
    });
    expect(await createReviewBotsStore(db).getPullRequestHead(SCOPE, "acme", "widgets", 131)).toBeNull();
  });
});


describe("failure rows are scoped to the PR's current head", () => {
  function seedFailure(
    db: TestD1,
    id: string,
    headSha: string,
    error = `boom ${id}`,
    stage = "runner",
  ): void {
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, target_id)
         VALUES (?, 99, 'acme', 'widgets', 131, ?, ?, ?, 'target-app-pr-ledger')`,
      )
      .run(id, headSha, stage, error);
  }

  async function headScopedFixture(): Promise<TestD1> {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest(PR);
    db.raw
      .prepare("INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('i1', ?, 99, 'acme', datetime('now'))")
      .run(APP_ID);
    // 'sha-1' is PR.headSha: one live-head failure, one old-head failure, one headless row.
    seedFailure(db, "f-head", "sha-1");
    seedFailure(db, "f-old", "sha-0");
    seedFailure(db, "f-empty", "");
    return db;
  }

  test("the count and the default failures page follow only the current head", async () => {
    const db = await headScopedFixture();
    const store = createReviewBotsStore(db);

    expect((await store.countPullRequestRecords(SCOPE, "acme", "widgets", 131)).failures).toBe(1);
    expect((await store.listPullRequests(SCOPE)).rows[0]!.failure_count).toBe(1);
    const head = await store.listPullRequestFailures(SCOPE, "acme", "widgets", 131, { offset: 0, limit: 10 });
    expect(head!.total).toBe(1);
    expect(head!.items.map((row) => row.error)).toEqual(["boom f-head"]);
  });

  test("the history scope keeps old-head and empty-head rows reachable", async () => {
    const db = await headScopedFixture();
    const store = createReviewBotsStore(db);

    const all = await store.listPullRequestFailures(SCOPE, "acme", "widgets", 131, {
      offset: 0,
      limit: 10,
      history: true,
    });
    expect(all!.total).toBe(3);
    expect(all!.items.map((row) => row.error).sort()).toEqual(["boom f-empty", "boom f-head", "boom f-old"]);

    const explicitHead = await store.listPullRequestFailures(SCOPE, "acme", "widgets", 131, {
      offset: 0,
      limit: 10,
      history: false,
    });
    expect(explicitHead!.total).toBe(1);
  });

  test("a moved head re-attributes the count without touching history", async () => {
    const db = await headScopedFixture();
    const store = createReviewBotsStore(db);
    await store.upsertPullRequest({ ...PR, headSha: "sha-0", updatedAt: "2026-03-01T00:00:00.000Z" });

    expect((await store.countPullRequestRecords(SCOPE, "acme", "widgets", 131)).failures).toBe(1);
    const head = await store.listPullRequestFailures(SCOPE, "acme", "widgets", 131, { offset: 0, limit: 10 });
    expect(head!.items.map((row) => row.error)).toEqual(["boom f-old"]);
    expect(
      (await store.listPullRequestFailures(SCOPE, "acme", "widgets", 131, {
        offset: 0,
        limit: 10,
        history: true,
      }))!.total,
    ).toBe(3);
  });

  test("a headless PR attributes nothing: a NULL head and an empty head count zero", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createReviewBotsStore(db).upsertPullRequest({ ...PR, headSha: undefined });
    db.raw
      .prepare("INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('i1', ?, 99, 'acme', datetime('now'))")
      .run(APP_ID);
    seedFailure(db, "f-empty", "");
    seedFailure(db, "f-named", "sha-9");
    const store = createReviewBotsStore(db);

    // A NULL head names no head: no row may claim it — the empty-head row cannot
    // equal NULL, and a named head differs. History still shows both.
    expect((await store.countPullRequestRecords(SCOPE, "acme", "widgets", 131)).failures).toBe(0);
    expect(
      (await store.listPullRequestFailures(SCOPE, "acme", "widgets", 131, { offset: 0, limit: 10 }))!.total,
    ).toBe(0);
    expect(
      (await store.listPullRequestFailures(SCOPE, "acme", "widgets", 131, {
        offset: 0,
        limit: 10,
        history: true,
      }))!.total,
    ).toBe(2);

    await store.upsertPullRequest({ ...PR, headSha: "" });
    // An EMPTY head names no head either — it must not borrow the headless row.
    expect((await store.countPullRequestRecords(SCOPE, "acme", "widgets", 131)).failures).toBe(0);
    expect(
      (await store.listPullRequestFailures(SCOPE, "acme", "widgets", 131, { offset: 0, limit: 10 }))!.total,
    ).toBe(0);
  });
});

function seedFinding(
  db: TestD1,
  finding: { findingId: string; mergeClass: string; title: string; filePath: string; lineStart: number; body: string },
  rowId = "row-1",
  state: "open" | "addressed" | "dismissed" = "open",
  firstSeenRound = 1,
  lastSeenRound = firstSeenRound,
): void {
  db.raw
    .prepare(
      `INSERT OR IGNORE INTO review_publications
         (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase, payload_json, created_ms, updated_ms)
       VALUES ('p1', ?, 99, 'acme', 'widgets', 131, 'sha-1', 'review', 'applied', '{}', 1, 1)`,
    )
    .run(APP_ID);
  db.raw
    .prepare(
      `INSERT INTO review_findings
         (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
          first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
          first_seen_round, last_seen_round, state, created_ms, updated_ms, target_id)
       VALUES (?, ?, 99, 'acme', 'widgets', 131, ?, ?, 'p1', 'p1', 'sha-1', 'sha-1', ?, ?, ?, 1, 1, ?)`,
    )
    .run(
      rowId,
      APP_ID,
      finding.findingId,
      JSON.stringify({
        title: finding.title,
        body: finding.body,
        filePath: finding.filePath,
        lineStart: finding.lineStart,
        lineEnd: finding.lineStart,
        mergeClass: finding.mergeClass,
        category: null,
        fingerprintHint: null,
      }),
      firstSeenRound,
      lastSeenRound,
      state,
      TARGET_ID,
    );
}

describe("reviewing-now projection (D11/D16)", () => {
  const INSTALLATION_ID = 77;
  const KEY = {
    installation_id: INSTALLATION_ID,
    owner: "acme",
    repo: "widgets",
    pr_number: 131,
    workspace_id: "default",
  };

  function seedInstallation(db: TestD1): void {
    db.raw
      .prepare(
        "INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('i-lock', ?, ?, 'acme', datetime('now'))",
      )
      .run(APP_ID, INSTALLATION_ID);
  }

  function seedLock(
    db: TestD1,
    over: { owner?: string; repo?: string; headSha?: string; expiresInMs?: number } = {},
  ): { acquiredAt: string; attemptId: string } {
    const acquiredAt = new Date(Date.now() - 60_000).toISOString();
    const attemptId = crypto.randomUUID();
    db.raw
      .prepare(
        `INSERT INTO review_inflight
           (installation_id, owner, repo, pr_number, workspace_id, attempt_id, head_sha, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, 'default', ?, ?, ?, ?)`,
      )
      .run(
        INSTALLATION_ID,
        over.owner ?? "acme",
        over.repo ?? "widgets",
        KEY.pr_number,
        attemptId,
        over.headSha ?? "sha-live",
        acquiredAt,
        new Date(Date.now() + (over.expiresInMs ?? 60 * 60_000)).toISOString(),
      );
    return { acquiredAt, attemptId };
  }

  async function seedLedger(db: TestD1): Promise<void> {
    seedApp(db);
    seedInstallation(db);
    await createReviewBotsStore(db).upsertPullRequest(PR);
  }

  test("a still-held row is live on both faces, with its head sha and acquisition time", async () => {
    const db = createMigratedTestD1();
    await seedLedger(db);
    const { acquiredAt } = seedLock(db);
    const store = createReviewBotsStore(db);
    const live = { state: "live", head_sha: "sha-live", acquired_at: acquiredAt } as const;

    expect((await store.listPullRequests(SCOPE)).rows[0]!.reviewing).toEqual(live);
    expect((await store.getPullRequestHead(SCOPE, "acme", "widgets", 131))!.reviewing).toEqual(live);
    expect((await store.listPullRequests(SCOPE)).rows[0]!.reviewing.state).toBe("live");
  });

  test("a comment-triggered attempt carries no head sha but still reads live", async () => {
    const db = createMigratedTestD1();
    await seedLedger(db);
    const { acquiredAt } = seedLock(db, { headSha: "" });
    expect((await createReviewBotsStore(db).listPullRequests(SCOPE)).rows[0]!.reviewing).toEqual({
      state: "live",
      head_sha: "",
      acquired_at: acquiredAt,
    });
  });

  test("the ledger's GitHub spelling still matches the lowercase lock row", async () => {
    const db = createMigratedTestD1();
    await seedLedger(db);
    db.raw
      .prepare("UPDATE pull_requests SET owner = 'Acme', repo = 'Widgets' WHERE bot_id = ? AND pr_number = 131")
      .run(APP_ID);
    seedLock(db);
    const rows = (await createReviewBotsStore(db).listPullRequests(SCOPE)).rows;
    expect(rows[0]!.owner).toBe("Acme");
    expect(rows[0]!.reviewing.state).toBe("live");
  });

  const idle: Array<[string, (db: TestD1) => Promise<void>]> = [
    ["no row", async () => {}],
    ["expired row", async (db) => void seedLock(db, { expiresInMs: -60_000 })],
    [
      "released row",
      async (db) => {
        const { attemptId } = seedLock(db);
        await releaseInflight(db, KEY, attemptId);
      },
    ],
    [
      "queued without a lock",
      async (db) => {
        db.raw
          .prepare(
            `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, target_id)
             VALUES ('queued', ?, 'acme', 'widgets', 131, 'sha-1', 'pipeline',
                     'review dropped after 3 refused retries: system-cap (system cap reached)',
                     'target-app-pr-ledger')`,
          )
          .run(INSTALLATION_ID);
      },
    ],
    [
      "superseded before admission",
      async (db) => {
        db.raw
          .prepare("UPDATE pull_requests SET head_sha = 'sha-new', head_at = ? WHERE bot_id = ? AND pr_number = 131")
          .run(new Date().toISOString(), APP_ID);
      },
    ],
    [
      "abandoned after release",
      async (db) => {
        const { attemptId } = seedLock(db);
        await releaseInflight(db, KEY, attemptId);
      },
    ],
  ];

  for (const [disposition, seed] of idle) {
    test(`${disposition} reads none on both faces`, async () => {
      const db = createMigratedTestD1();
      await seedLedger(db);
      await seed(db);
      const store = createReviewBotsStore(db);
      expect((await store.listPullRequests(SCOPE)).rows[0]!.reviewing).toEqual({ state: "none" });
      expect((await store.getPullRequestHead(SCOPE, "acme", "widgets", 131))!.reviewing).toEqual({
        state: "none",
      });
    });
  }

  function lockFaultStore(db: TestD1) {
    return createReviewBotsStore({
      prepare(sql: string) {
        if (sql.includes("review_inflight")) throw new Error("D1_ERROR: dead binding");
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
    } as never);
  }

  test("a failed inflight read is unknown on both faces, never idle", async () => {
    const db = createMigratedTestD1();
    await seedLedger(db);
    seedLock(db);
    const store = lockFaultStore(db);
    expect((await store.listPullRequests(SCOPE)).rows[0]!.reviewing).toEqual({ state: "unknown" });
    expect((await store.getPullRequestHead(SCOPE, "acme", "widgets", 131))!.reviewing).toEqual({
      state: "unknown",
    });
  });

  test("a failed inflight read emits exactly one attributed warn; a good read none", async () => {
    const db = createMigratedTestD1();
    await seedLedger(db);
    seedLock(db);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await createReviewBotsStore(db).listPullRequests(SCOPE)).rows[0]!.reviewing.state).toBe("live");
      expect(warn).not.toHaveBeenCalled();

      expect((await lockFaultStore(db).listPullRequests(SCOPE)).rows[0]!.reviewing).toEqual({
        state: "unknown",
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({
        event: "dashboard_live_lock_read_failed",
        workspace_id: WORKSPACE,
      });
    } finally {
      warn.mockRestore();
    }
  });
});

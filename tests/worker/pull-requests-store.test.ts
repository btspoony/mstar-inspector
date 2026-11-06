/**
 * PR ledger store faces (migration 0039) — `upsertPullRequest`,
 * `listPullRequests`, and the detail split: `getPullRequestHead`,
 * `countPullRequestRecords` and the three paged record readers.
 *
 * The fixture is the full migration set (the store helper walks
 * `migrations/`), so 0039 is the real DDL. Rows for `reviews`,
 * `review_failures`, `app_installations` and `review_findings` are seeded raw:
 * this file pins the READ shape (latest review, failure count, findings
 * projection), not the pipeline that writes those tables.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { createAppsStore, PULL_REQUEST_LIST_LIMIT } from "../../src/dashboard/apps-store";
import { releaseInflight } from "../../src/store/inflight-store";

const APP_ID = "app-pr-ledger";

/** An App row + its workspace mapping (both reads join `app_workspaces`). */
function seedApp(db: TestD1, id = APP_ID, githubAppId = 2001): string {
  const now = "2026-01-01T00:00:00.000Z";
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, created_at, updated_at)
       VALUES (?, NULL, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
               'octocat', 'active', ?, ?)`,
    )
    .run(id, githubAppId, id, now, now);
  db.raw.prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, 'default')").run(id);
  return id;
}

const PR = { appId: APP_ID, owner: "acme", repo: "widgets", prNumber: 131, title: "Add a thing", state: "open", headSha: "sha-1" };

/**
 * One `listPullRequests` read with the statements it PREPARED counted — the
 * N+1 signal. The count is a property of the read's shape, so it is only ever
 * compared across two reads (a wider window, a filtered window), never against
 * a literal: a consolidated batch keeps passing, a per-row statement does not.
 */
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
  const { rows } = await createAppsStore(counted as never).listPullRequests(APP_ID, filter);
  return { rows: rows.length, prepares };
}

describe("upsertPullRequest", () => {
  test("insert then re-delivery keeps ONE row on the (app, owner, repo, number) key", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    // Stamped deliveries order themselves; the point of this test is the
    // UNIQUE key and the advance. A stamp-less re-delivery cannot be ordered,
    // so it deliberately keeps the stored sha (migration 0044).
    await createAppsStore(db).upsertPullRequest({ ...PR, updatedAt: "2026-01-01T00:00:00.000Z" });
    await createAppsStore(db).upsertPullRequest({
      ...PR,
      headSha: "sha-2",
      updatedAt: "2026-01-01T00:05:00.000Z",
    });
    const rows = db.raw.prepare("SELECT * FROM pull_requests WHERE app_id = ?").all(APP_ID) as Array<{
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
    await createAppsStore(db).upsertPullRequest(PR);
    db.raw.prepare("UPDATE pull_requests SET first_seen_at = '2020-01-01 00:00:00', last_seen_at = '2020-01-01 00:00:00'").run();
    await createAppsStore(db).upsertPullRequest(PR);
    const row = db.raw
      .prepare("SELECT first_seen_at, last_seen_at FROM pull_requests WHERE app_id = ?")
      .get(APP_ID) as { first_seen_at: string; last_seen_at: string };
    expect(row.first_seen_at).toBe("2020-01-01 00:00:00");
    // Strictly later than the stale pin: a NULL or garbage write is not an
    // advance, and `MAX(last_seen_at, excluded.last_seen_at)` is what the
    // column means.
    expect(row.last_seen_at).not.toBeNull();
    expect(row.last_seen_at > "2020-01-01 00:00:00").toBe(true);
  });

  test("an omitted title / head_sha keeps the stored value; state overwrites while non-terminal", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(PR);
    await createAppsStore(db).upsertPullRequest({ appId: APP_ID, owner: "acme", repo: "widgets", prNumber: 131, state: "merged" });
    const row = db.raw
      .prepare("SELECT title, state, head_sha FROM pull_requests WHERE app_id = ?")
      .get(APP_ID) as { title: string; state: string; head_sha: string };
    expect(row.title).toBe("Add a thing");
    expect(row.head_sha).toBe("sha-1");
    expect(row.state).toBe("merged");
  });

  test("a merged PR stays merged: a late `opened` delivery cannot reopen it", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest({ ...PR, state: "merged" });
    // Out-of-order / replayed `opened` for the same tuple, stamped OLDER than
    // the merge by GitHub's own clock.
    await createAppsStore(db).upsertPullRequest({ ...PR, state: "open", updatedAt: "2020-01-01T00:00:00Z" });
    const row = db.raw
      .prepare("SELECT state FROM pull_requests WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ?")
      .get(APP_ID, "acme", "widgets", 131) as { state: string };
    expect(row.state).toBe("merged");
  });

  test("last_seen_at follows the payload's updated_at and never moves backwards", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest({ ...PR, updatedAt: "2026-03-04T05:06:07Z" });
    const first = db.raw
      .prepare("SELECT last_seen_at FROM pull_requests WHERE app_id = ?")
      .get(APP_ID) as { last_seen_at: string };
    // ISO 8601 is normalised into the column's own datetime form.
    expect(first.last_seen_at).toBe("2026-03-04 05:06:07");

    await createAppsStore(db).upsertPullRequest({ ...PR, updatedAt: "2026-01-01T00:00:00Z" });
    const after = db.raw
      .prepare("SELECT last_seen_at FROM pull_requests WHERE app_id = ?")
      .get(APP_ID) as { last_seen_at: string };
    expect(after.last_seen_at).toBe("2026-03-04 05:06:07");
  });
});

describe("listPullRequests", () => {
  test("attaches the newest review, counts failures, and reads [] for a PR with neither", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(PR);
    await createAppsStore(db).upsertPullRequest({ ...PR, prNumber: 132, title: "Second", headSha: "sha-b" });
    db.raw
      .prepare("INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('i1', ?, 77, 'acme', datetime('now'))")
      .run(APP_ID);
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, app_id, reviewed_at)
         VALUES ('r-old', 77, 'acme', 'widgets', 131, 'sha-0', 'comment', ?, '2026-01-01 00:00:00'),
                ('r-new', 77, 'acme', 'widgets', 131, 'sha-1', 'approve', ?, '2026-02-01 00:00:00')`,
      )
      .run(APP_ID, APP_ID);
    for (const id of ["f1", "f2"]) {
      db.raw
        .prepare(
          `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
           VALUES (?, 77, 'acme', 'widgets', 131, 'sha-1', 'runner', 'boom')`,
        )
        .run(id);
    }

    const { rows } = await createAppsStore(db).listPullRequests(APP_ID);
    expect(rows.length).toBe(2);
    const byNumber = new Map(rows.map((row) => [row.number, row]));
    expect(byNumber.get(131)!.latest_review).toEqual({ verdict: "approve", reviewed_at: "2026-02-01 00:00:00" });
    expect(byNumber.get(131)!.failure_count).toBe(2);
    expect(byNumber.get(132)!.latest_review).toBeNull();
    expect(byNumber.get(132)!.failure_count).toBe(0);
  });

  // One parameterized case, one set of assertions: every attribution-only
  // stage projects the same way — out of the failure count AND out of the
  // failure page, so the tab's number always matches the pager.
  for (const [stage, error] of [
    ["recheck", "skipped: budget: null"],
    ["usage", "D1_ERROR: no such table"],
  ] as const) {
    test(`${stage} attribution rows are not review failures: counted 0 and paged 0`, async () => {
      const db = createMigratedTestD1();
      seedApp(db);
      await createAppsStore(db).upsertPullRequest(PR);
      db.raw
        .prepare("INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('i1', ?, 77, 'acme', datetime('now'))")
        .run(APP_ID);
      // The review itself continued; only this attribution row was written.
      db.raw
        .prepare(
          `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
           VALUES ('f-attribution', 77, 'acme', 'widgets', 131, 'sha-1', ?, ?)`,
        )
        .run(stage, error);

      const store = createAppsStore(db);
      expect((await store.listPullRequests(APP_ID)).rows[0]!.failure_count).toBe(0);
      expect((await store.countPullRequestRecords(APP_ID, "acme", "widgets", 131)).failures).toBe(0);
      const history = await store.listPullRequestFailures(APP_ID, "acme", "widgets", 131, {
        offset: 0,
        limit: 10,
      });
      expect(history!.total).toBe(0);
      expect(history!.items).toEqual([]);
      // Still in D1 as attribution — the failure face just does not page it.
      expect(db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 1 });
    });
  }

  test("the failure count and the failures section total agree when both an attribution row and an ordinary one exist", async () => {
    // The second face of the same rule: the recheck row is counted and paged
    // out on BOTH sides, so the tab's number is the pager's denominator.
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(PR);
    db.raw
      .prepare("INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('i1', ?, 77, 'acme', datetime('now'))")
      .run(APP_ID);
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
         VALUES ('f-recheck', 77, 'acme', 'widgets', 131, 'sha-1', 'recheck', 'skipped: budget: null'),
                ('f-runner', 77, 'acme', 'widgets', 131, 'sha-1', 'runner', 'boom')`,
      )
      .run();

    const store = createAppsStore(db);
    const counts = await store.countPullRequestRecords(APP_ID, "acme", "widgets", 131);
    const page = await store.listPullRequestFailures(APP_ID, "acme", "widgets", 131, { offset: 0, limit: 10 });
    expect(counts.failures).toBe(1);
    expect(page!.total).toBe(counts.failures);
    expect(page!.items.map((item) => item.stage)).toEqual(["runner"]);
  });

  test("a sibling App's reviews and failures never leak into the list", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    seedApp(db, "other-app", 2002);
    await createAppsStore(db).upsertPullRequest(PR);
    db.raw
      .prepare("INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('i2', 'other-app', 88, 'acme', datetime('now'))")
      .run();
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, app_id)
         VALUES ('r-other', 88, 'acme', 'widgets', 131, 'sha-x', 'request-changes', 'other-app')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
         VALUES ('f-other', 88, 'acme', 'widgets', 131, 'sha-x', 'runner', 'boom')`,
      )
      .run();

    const { rows } = await createAppsStore(db).listPullRequests(APP_ID);
    expect(rows.length).toBe(1);
    expect(rows[0]!.latest_review).toBeNull();
    expect(rows[0]!.failure_count).toBe(0);
  });

  test("is not N+1: a wider window costs the same statements, not one per row", async () => {
    const one = createMigratedTestD1();
    seedApp(one);
    await createAppsStore(one).upsertPullRequest(PR);
    const three = createMigratedTestD1();
    seedApp(three);
    for (const n of [1, 2, 3]) await createAppsStore(three).upsertPullRequest({ ...PR, prNumber: n });

    const single = await ledgerRead(one);
    const triple = await ledgerRead(three);
    expect(triple.rows).toBe(3);
    // The rows, the review window, both aggregates and the lock read ride one
    // fixed batch, so the three-row read prepares what the one-row read does.
    // A per-row statement makes the wider window cost more, which fails here.
    expect(triple.prepares).toBe(single.prepares);
  });

  test("the aggregates are scoped to the window (mechanism, not just the payload)", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(PR);

    // Capture what the store PREPARES and how it binds: an unscoped aggregate
    // scans every review/failure for the App and binds one parameter (appId);
    // a scoped one carries the window subquery and binds three (appId, appId,
    // LIMIT). The payload-shape assertions below hold either way, so this is
    // the assertion that fails when the scoping is reverted.
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
    await createAppsStore(recording as never).listPullRequests(APP_ID);

    // The App-wide live lock read (`review_inflight`) carries no window — it
    // is bounded by the concurrency caps, not by the row page — so only the
    // statements reading `reviews`/`review_failures` below are in scope. Each
    // one must carry the window: a new aggregate that skips it fails the loop.
    const aggregates = statements.filter(
      (stmt) => stmt.sql.includes("FROM reviews") || stmt.sql.includes("FROM review_failures"),
    );
    expect(aggregates.length).toBeGreaterThan(0);
    for (const stmt of aggregates) {
      // The bound VALUES, not the statement text: a splice that keeps the SQL
      // but permutes the slots satisfies any substring or count assertion.
      // The aggregate's own scope takes appId, then the window subquery takes
      // (appId, LIMIT) — in that order, which is the order the splice binds.
      expect(stmt.values).toEqual([APP_ID, APP_ID, PULL_REQUEST_LIST_LIMIT]);
    }
  });

  test("the payload lists only the window, newest first", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    const total = PULL_REQUEST_LIST_LIMIT + 1;
    for (let n = 1; n <= total; n++) {
      await createAppsStore(db).upsertPullRequest({
        ...PR,
        prNumber: n,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
      });
    }
    db.raw
      .prepare("INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('i1', ?, 77, 'acme', datetime('now'))")
      .run(APP_ID);
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, app_id)
         VALUES ('r-in', 77, 'acme', 'widgets', ?, 'sha-1', 'approve', ?)`,
      )
      .run(total, APP_ID);
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
         VALUES ('f-in', 77, 'acme', 'widgets', ?, 'sha-1', 'runner', 'boom')`,
      )
      .run(total);

    const { rows } = await createAppsStore(db).listPullRequests(APP_ID);
    expect(rows.length).toBe(PULL_REQUEST_LIST_LIMIT);
    expect(rows[0]!.number).toBe(total);
    expect(rows[0]!.latest_review).toEqual({ verdict: "approve", reviewed_at: expect.any(String) });
    expect(rows[0]!.failure_count).toBe(1);
    expect(rows.some((row) => row.number === 1)).toBe(false);
  });

  test("is bounded: never more than PULL_REQUEST_LIST_LIMIT rows, newest first", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    // One past the cap, each stamped a distinct second via the payload clock.
    const total = PULL_REQUEST_LIST_LIMIT + 1;
    for (let n = 1; n <= total; n++) {
      await createAppsStore(db).upsertPullRequest({
        ...PR,
        prNumber: n,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
      });
    }
    const { rows } = await createAppsStore(db).listPullRequests(APP_ID);
    expect(rows.length).toBe(PULL_REQUEST_LIST_LIMIT);
    // The oldest (prNumber 1, second 1) is the one dropped.
    expect(rows[0]!.number).toBe(total);
    expect(rows.some((row) => row.number === 1)).toBe(false);
  });
});

/**
 * The repository filter and its option set. The reported defect was a filter
 * applied AFTER the cap: a repository whose PRs all sit behind the newest
 * `PULL_REQUEST_LIST_LIMIT` rows never appeared — not as an option, and not as
 * a row once selected. Both halves are pinned here: the option set covers the
 * whole ledger, and the filter runs INSIDE the window.
 */
describe("listPullRequests repository filter + option set", () => {
  const BEHIND = { ...PR, repo: "behind" };

  /**
   * A FULL unfiltered window (`PULL_REQUEST_LIST_LIMIT` newest rows on
   * `acme/widgets`) plus two OLDER rows on `acme/behind`, which therefore sit
   * entirely behind the cap.
   */
  async function seedCappedLedger(db: TestD1) {
    seedApp(db);
    const store = createAppsStore(db);
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
      .prepare("INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('i1', ?, 77, 'acme', datetime('now'))")
      .run(APP_ID);
    // A review and a failure on the NEWEST behind-the-cap row: they can only
    // ride along if the aggregates are scoped to the FILTERED window.
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, app_id, reviewed_at)
         VALUES ('r-behind', 77, 'acme', 'behind', 9002, 'sha-1', 'approve', ?, '2026-02-01 00:00:00')`,
      )
      .run(APP_ID);
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
         VALUES ('f-behind', 77, 'acme', 'behind', 9002, 'sha-1', 'runner', 'boom')`,
      )
      .run();
    return store;
  }

  test("a repository behind the cap is still an option, and filtering reaches its rows", async () => {
    const db = createMigratedTestD1();
    const store = await seedCappedLedger(db);

    // The unfiltered list is unchanged: exactly the capped window, and the
    // behind-the-cap repository has no row in it. The option set is the whole
    // ledger (no LIMIT), so that repository is listed anyway.
    const unfiltered = await store.listPullRequests(APP_ID);
    expect(unfiltered.repos).toEqual(["acme/behind", "acme/widgets"]);
    expect(unfiltered.rows.length).toBe(PULL_REQUEST_LIST_LIMIT);
    expect(unfiltered.rows.some((row) => row.repo === "behind")).toBe(false);

    // Filtering runs BEFORE the cap, so it reaches rows the window dropped.
    const filtered = await store.listPullRequests(APP_ID, { owner: "acme", repo: "behind" });
    expect(filtered.rows.map((row) => row.number).sort()).toEqual([9001, 9002]);
    // The option set never narrows with the selection: the filtered read still
    // lists the App's whole distinct repository set — a predicate added to the
    // option statement would strand the user in the current filter.
    expect(filtered.repos).toEqual(["acme/behind", "acme/widgets"]);
    // …and the aggregates follow the same filtered window, so the tab's
    // verdict and failure count cannot disagree with the rows it shows.
    const newest = filtered.rows.find((row) => row.number === 9002)!;
    expect(newest.latest_review).toEqual({ verdict: "approve", reviewed_at: "2026-02-01 00:00:00" });
    expect(newest.failure_count).toBe(1);
  });

  test("a filtered read is still a fixed-size batch", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    const store = createAppsStore(db);
    for (const n of [1, 2, 3]) await store.upsertPullRequest({ ...PR, prNumber: n });
    await store.upsertPullRequest({ ...PR, repo: "other", prNumber: 901 });

    const all = await ledgerRead(db);
    const wide = await ledgerRead(db, { owner: "acme", repo: "widgets" });
    const narrow = await ledgerRead(db, { owner: "acme", repo: "other" });
    expect([all.rows, wide.rows, narrow.rows]).toEqual([4, 3, 1]);
    // Twice over: narrowing the window costs what reading the whole one does
    // (the predicate rides the existing statements, it adds none), and the
    // filtered read costs the same at one row as at three (nothing per row).
    expect(wide.prepares).toBe(all.prepares);
    expect(wide.prepares).toBe(narrow.prepares);
  });

  test("the option set is one App's ledger, never a sibling App's", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    seedApp(db, "other-app", 2002);
    await createAppsStore(db).upsertPullRequest(PR);
    await createAppsStore(db).upsertPullRequest({ ...PR, appId: "other-app", repo: "theirs" });
    expect((await createAppsStore(db).listPullRequests(APP_ID)).repos).toEqual(["acme/widgets"]);
  });
});

describe("sweepTerminalPullRequests", () => {
  test("an older `closed` cannot mark a reopened PR, and it survives retention", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    // 1. The PR closes in 2020 → its stamp is 2020.
    await createAppsStore(db).upsertPullRequest({ ...PR, state: "closed", updatedAt: "2020-01-01T00:00:00Z" });
    // 2. It reopens in 2026 → newer stamp, state open.
    await createAppsStore(db).upsertPullRequest({ ...PR, state: "open", updatedAt: "2026-01-01T00:00:00Z" });
    // 3. A replayed/out-of-order OLD `closed` arrives.
    await createAppsStore(db).upsertPullRequest({ ...PR, state: "closed", updatedAt: "2020-06-01T00:00:00Z" });

    // The stale delivery must not have rewritten the state (the timestamp is
    // the single arbiter for both columns).
    const row = db.raw
      .prepare("SELECT state, last_seen_at FROM pull_requests WHERE app_id = ?")
      .get(APP_ID) as { state: string; last_seen_at: string };
    expect(row.state).toBe("open");
    expect(row.last_seen_at).toBe("2026-01-01 00:00:00");

    // The predicate agrees with the write: an open row is never swept.
    expect(await createAppsStore(db).sweepTerminalPullRequests()).toBe(0);
  });

  test("a newer `closed` after `open` DOES close it (and is not swept inside the window)", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    // Relative to the real clock — a hard-coded date slides out of the 90-day
    // window and becomes a date bomb.
    const fresh = new Date(Date.now() - 60_000).toISOString();
    await createAppsStore(db).upsertPullRequest({ ...PR, state: "open", updatedAt: "2020-01-01T00:00:00Z" });
    await createAppsStore(db).upsertPullRequest({ ...PR, state: "closed", updatedAt: fresh });
    const row = db.raw.prepare("SELECT state FROM pull_requests WHERE app_id = ?").get(APP_ID) as {
      state: string;
    };
    expect(row.state).toBe("closed");
    expect(await createAppsStore(db).sweepTerminalPullRequests()).toBe(0);
  });

  test("drops terminal rows past the window and keeps open ones however old", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    const old = "2020-01-01T00:00:00Z";
    await createAppsStore(db).upsertPullRequest({ ...PR, prNumber: 1, state: "merged", updatedAt: old });
    await createAppsStore(db).upsertPullRequest({ ...PR, prNumber: 2, state: "closed", updatedAt: old });
    // An OPEN row is a live review target however stale its clock.
    await createAppsStore(db).upsertPullRequest({ ...PR, prNumber: 3, state: "open", updatedAt: old });
    // A terminal row INSIDE the window stays.
    await createAppsStore(db).upsertPullRequest({ ...PR, prNumber: 4, state: "closed" });

    expect(await createAppsStore(db).sweepTerminalPullRequests()).toBe(2);
    const remaining = db.raw
      .prepare("SELECT pr_number FROM pull_requests ORDER BY pr_number")
      .all() as Array<{ pr_number: number }>;
    expect(remaining.map((row) => row.pr_number)).toEqual([3, 4]);
  });

  test("is idempotent — a second run deletes nothing", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest({ ...PR, state: "merged", updatedAt: "2020-01-01T00:00:00Z" });
    expect(await createAppsStore(db).sweepTerminalPullRequests()).toBe(1);
    expect(await createAppsStore(db).sweepTerminalPullRequests()).toBe(0);
  });
});

describe("pull request detail reads", () => {
  /** One review row for `PR`'s repo. */
  function seedReview(db: TestD1, id: string, reviewedAt: string, verdict = "approve", round: number | null = null): void {
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md, model, provider, reviewed_at, app_id, round)
         VALUES (?, 99, 'acme', 'widgets', 131, ?, ?, 'looks good', 'm1', 'p1', ?, ?, ?)`,
      )
      .run(id, `sha-${id}`, verdict, reviewedAt, APP_ID, round);
  }

  async function detailFixture(): Promise<TestD1> {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(PR);
    db.raw
      .prepare("INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('i3', ?, 99, 'acme', datetime('now'))")
      .run(APP_ID);
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
         VALUES ('fx', 99, 'acme', 'widgets', 131, 'sha-1', 'sandbox', 'timeout')`,
      )
      .run();
    seedFinding(db, { findingId: "F-1", mergeClass: "must-fix", title: "Null deref", filePath: "src/a.ts", lineStart: 12, body: "guard it" });
    return db;
  }

  test("the must-fix tally counts every must-fix row, whatever the page or filter", async () => {
    const db = await detailFixture();
    // Two more findings behind the first page (limit 10): the tally is the
    // PR's, not the loaded page's, and a nit never enters it.
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
    const store = createAppsStore(db);
    expect(await store.countPullRequestRecords(APP_ID, "acme", "widgets", 131)).toEqual({
      findings: 13,
      reviews: 0,
      failures: 1,
      must_fix: 12,
    });
    // The page is paged and filtered; the tally does not move with either.
    const page = await store.listPullRequestFindings(APP_ID, "acme", "widgets", 131, {
      offset: 0,
      limit: 10,
      severity: "nit",
    });
    expect(page!.total).toBe(1);
  });

  test("an addressed or dismissed finding is excluded from the page and from both tallies", async () => {
    const db = await detailFixture();
    // Two more must-fix rows: one the pipeline already assessed as addressed,
    // one dismissed. They are history — the PR has no open work in them.
    const addressed = { findingId: "F-2", mergeClass: "must-fix", title: "a", filePath: "src/a.ts", lineStart: 2, body: "b" };
    const dismissed = { findingId: "F-3", mergeClass: "must-fix", title: "d", filePath: "src/a.ts", lineStart: 3, body: "b" };
    seedFinding(db, addressed, "row-2", "addressed");
    seedFinding(db, dismissed, "row-3", "dismissed");
    const store = createAppsStore(db);

    // Only the one OPEN finding is counted — neither the tab count nor the dot
    // may be kept alive by a finding the pipeline already closed out.
    expect(await store.countPullRequestRecords(APP_ID, "acme", "widgets", 131)).toEqual({
      findings: 1,
      reviews: 0,
      failures: 1,
      must_fix: 1,
    });

    // …and the page agrees with the tallies: the same single row, same total.
    const page = await store.listPullRequestFindings(APP_ID, "acme", "widgets", 131, { offset: 0, limit: 10 });
    expect(page!.total).toBe(1);
    expect(page!.items.map((finding) => finding.finding_id)).toEqual(["F-1"]);

    // The severity filter narrows the open set, never re-admits a closed row.
    const filtered = await store.listPullRequestFindings(APP_ID, "acme", "widgets", 131, {
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
    const store = createAppsStore(db);

    const head = await store.getPullRequestHead(APP_ID, "acme", "widgets", 131);
    expect(head?.title).toBe("Add a thing");
    // The newest review rides the head as a whole row — the header's one
    // authoritative verdict + attribution source.
    expect(head?.latest_review).toEqual({
      verdict: "approve",
      model: "m1",
      provider: "p1",
      reviewed_at: "2026-01-02 00:00:00",
      head_sha: "sha-r1",
    });

    expect(await store.countPullRequestRecords(APP_ID, "acme", "widgets", 131)).toEqual({
      findings: 1,
      reviews: 1,
      failures: 1,
      must_fix: 1,
    });

    const page = { offset: 0, limit: 10 };
    const findings = await store.listPullRequestFindings(APP_ID, "acme", "widgets", 131, page);
    expect(findings!.total).toBe(1);
    expect(findings!.items).toEqual([
      {
        finding_id: "F-1",
        severity: "must-fix",
        title: "Null deref",
        file_path: "src/a.ts",
        line: 12,
        body: "guard it",
        // The round that first reported it, read from the lifecycle row.
        review_round: 1,
      },
    ]);

    const reviews = await store.listPullRequestReviews(APP_ID, "acme", "widgets", 131, page);
    expect(reviews!.total).toBe(1);

    const failures = await store.listPullRequestFailures(APP_ID, "acme", "widgets", 131, page);
    expect(failures!.total).toBe(1);
    expect(failures!.items).toEqual([
      { stage: "sandbox", error: "timeout", created_at: expect.any(String) },
    ]);
  });

  test("a severity filter narrows the findings page and its total", async () => {
    const db = await detailFixture();
    seedFinding(
      db,
      { findingId: "F-2", mergeClass: "nit", title: "Rename a thing", filePath: "src/b.ts", lineStart: 3, body: "style" },
      "row-2",
    );
    const store = createAppsStore(db);
    const page = { offset: 0, limit: 10 };
    expect((await store.listPullRequestFindings(APP_ID, "acme", "widgets", 131, page))!.total).toBe(2);
    const filtered = await store.listPullRequestFindings(APP_ID, "acme", "widgets", 131, {
      ...page,
      severity: "must-fix",
    });
    expect(filtered!.total).toBe(1);
    expect(filtered!.items.map((finding) => finding.finding_id)).toEqual(["F-1"]);
    // An exact match: a spelling the PR does not carry is an empty page.
    const missing = await store.listPullRequestFindings(APP_ID, "acme", "widgets", 131, {
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
    const store = createAppsStore(db);
    const page = { offset: 0, limit: 10 };
    // The complement of the vocabulary: the row a `severity` filter can never
    // name, while the must-fix row the fixture seeds is excluded.
    const unclassified = await store.listPullRequestFindings(APP_ID, "acme", "widgets", 131, {
      ...page,
      unclassified: true,
    });
    expect(unclassified!.total).toBe(1);
    expect(unclassified!.items.map((finding) => finding.finding_id)).toEqual(["F-9"]);
    // The exact-match filter keeps its meaning beside the mode.
    const mustFix = await store.listPullRequestFindings(APP_ID, "acme", "widgets", 131, {
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
    const store = createAppsStore(db);
    const ids = async (offset: number) =>
      (await store.listPullRequestFindings(APP_ID, "acme", "widgets", 131, { offset, limit: 2 }))!.items.map(
        (finding) => finding.finding_id,
      );
    // Newest INSERT first: the page order neither reads nor ties on the
    // re-report clock.
    expect(await ids(0)).toEqual(["F-3", "F-2"]);

    // A review round re-sees F-1 (the oldest row) and advances its
    // `updated_ms`. The row's page position is unchanged, so an offset page
    // read before and after the re-report cannot duplicate or skip it.
    db.raw.prepare("UPDATE review_findings SET updated_ms = 99 WHERE finding_id = 'F-1'").run();
    expect(await ids(0)).toEqual(["F-3", "F-2"]);
    expect(await ids(2)).toEqual(["F-1"]);
  });

  test("limit/offset step through a section without moving its total", async () => {
    const db = await detailFixture();
    seedReview(db, "r1", "2026-01-02 00:00:00");
    seedReview(db, "r2", "2026-01-03 00:00:00");
    seedReview(db, "r3", "2026-01-04 00:00:00");
    const store = createAppsStore(db);
    // Newest first: the first page holds the two newest reviews.
    const first = await store.listPullRequestReviews(APP_ID, "acme", "widgets", 131, { offset: 0, limit: 2 });
    expect(first!.total).toBe(3);
    expect(first!.items.map((review) => review.reviewed_at)).toEqual(["2026-01-04 00:00:00", "2026-01-03 00:00:00"]);
    const second = await store.listPullRequestReviews(APP_ID, "acme", "widgets", 131, { offset: 2, limit: 2 });
    expect(second!.total).toBe(3);
    expect(second!.items.map((review) => review.reviewed_at)).toEqual(["2026-01-02 00:00:00"]);
  });

  test("a review row carries its round ordinal, run time and that round's findings", async () => {
    const db = await detailFixture();
    // Three rounds at increasing clocks: oldest-first numbering is 1..3.
    seedReview(db, "r1", "2026-01-02 00:00:00");
    seedReview(db, "r2", "2026-01-03 00:00:00");
    seedReview(db, "r3", "2026-01-04 00:00:00");
    // Legacy `findings` rows attributed to round 2 — the count is per review id.
    db.raw
      .prepare(
        `INSERT INTO findings (id, review_id, severity, title)
         VALUES ('f-1', 'r2', 'must-fix', 'a'), ('f-2', 'r2', 'nit', 'b')`,
      )
      .run();
    // Only the newest round carries a measured clock; the seeded history stays NULL.
    db.raw.prepare("UPDATE reviews SET duration_ms = 65000 WHERE id = 'r3'").run();
    // Choose the round that FIRST reported each finding.
    seedFinding(db, { findingId: "F-2", mergeClass: "nit", title: "n", filePath: "src/a.ts", lineStart: 1, body: "b" }, "row-2");
    db.raw
      .prepare("UPDATE review_findings SET first_seen_sha = 'sha-r2', first_seen_round = 2 WHERE finding_id = 'F-1'")
      .run();
    const store = createAppsStore(db);

    // Newest-first paging never renumbers: page 1 is rounds 3, 2; page 2 is
    // the oldest round alone.
    const first = await store.listPullRequestReviews(APP_ID, "acme", "widgets", 131, { offset: 0, limit: 2 });
    expect(first!.items.map((review) => [review.round, review.findings, review.duration_ms])).toEqual([
      [3, 0, 65_000],
      [2, 2, null],
    ]);
    const second = await store.listPullRequestReviews(APP_ID, "acme", "widgets", 131, { offset: 2, limit: 2 });
    expect(second!.items.map((review) => review.round)).toEqual([1]);

    // Each finding's round is its stored `first_seen_round`. F-2 was first
    // reported in round 1 and no `reviews` row carries its sha-1, which the
    // old derived read reported as NULL; the stored ordinal still names it.
    const findings = await store.listPullRequestFindings(APP_ID, "acme", "widgets", 131, {
      offset: 0,
      limit: 10,
    });
    expect(findings!.items.map((finding) => [finding.finding_id, finding.review_round])).toEqual([
      ["F-2", 1],
      ["F-1", 2],
    ]);

    // The severity predicate binds BETWEEN the scope and paging binds, so a
    // shifted bind would filter, page or count the wrong window.
    const filtered = await store.listPullRequestFindings(APP_ID, "acme", "widgets", 131, {
      offset: 0,
      limit: 10,
      severity: "nit",
    });
    expect(filtered!.total).toBe(1);
    expect(filtered!.items.map((finding) => [finding.finding_id, finding.review_round])).toEqual([["F-2", 1]]);
  });

  test("a finding's round survives a round with no reviews row", async () => {
    const db = await detailFixture();
    // One published round; a later round failed or only carried comments, so
    // it inserted no `reviews` row and the ledger ordinal would shift or
    // vanish. The finding's stored round still names the round that saw it.
    seedReview(db, "r1", "2026-01-02 00:00:00");
    seedFinding(
      db,
      { findingId: "F-3", mergeClass: "nit", title: "n", filePath: "src/a.ts", lineStart: 2, body: "b" },
      "row-3",
      "open",
      3,
      5,
    );
    const store = createAppsStore(db);
    const findings = await store.listPullRequestFindings(APP_ID, "acme", "widgets", 131, { offset: 0, limit: 10 });
    expect(findings!.items.map((finding) => [finding.finding_id, finding.review_round])).toEqual([
      ["F-3", 3],
      ["F-1", 1],
    ]);
  });

  test("the stored round wins over the ordinal the head sha would derive", async () => {
    const db = await detailFixture();
    // Two published heads. sha-r2's review row stored round 3 — two later
    // rounds re-reviewed a head the artifact upsert dedupes — while the
    // reviews ledger can only number it 2. Both faces must print the stored
    // value, so a derived-with-fallback read cannot pass this.
    seedReview(db, "r1", "2026-01-02 00:00:00");
    seedReview(db, "r2", "2026-01-03 00:00:00", "approve", 3);
    db.raw
      .prepare("UPDATE review_findings SET first_seen_sha = 'sha-r2', first_seen_round = 3 WHERE finding_id = 'F-1'")
      .run();
    const store = createAppsStore(db);

    const findings = await store.listPullRequestFindings(APP_ID, "acme", "widgets", 131, { offset: 0, limit: 10 });
    expect(findings!.items.map((finding) => [finding.finding_id, finding.review_round])).toEqual([["F-1", 3]]);

    const reviews = await store.listPullRequestReviews(APP_ID, "acme", "widgets", 131, { offset: 0, limit: 10 });
    // Newest first: r2 carries its stored round; r1 has none and keeps the
    // ledger fallback.
    expect(reviews!.items.map((review) => [review.head_sha, review.round])).toEqual([
      ["sha-r2", 3],
      ["sha-r1", 1],
    ]);
  });

  test("unknown PR number → null head (the route's 404)", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    expect(await createAppsStore(db).getPullRequestHead(APP_ID, "acme", "widgets", 999)).toBeNull();
  });

  test("a section read answers 'no such PR' inside its own batch (the routes' 404)", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(PR);
    await createAppsStore(db).upsertPullRequest({ ...PR, repo: "gadgets", title: "Other repo's #131" });
    const store = createAppsStore(db);
    const page = { offset: 0, limit: 10 };
    // Present on the ledger's own key…
    expect(await store.listPullRequestFindings(APP_ID, "acme", "widgets", 131, page)).not.toBeNull();
    expect(await store.listPullRequestReviews(APP_ID, "acme", "gadgets", 131, page)).not.toBeNull();
    // …and a miss for the same number in a repo, App or PR it never received.
    expect(await store.listPullRequestFindings(APP_ID, "acme", "sprockets", 131, page)).toBeNull();
    expect(await store.listPullRequestReviews("other-app", "acme", "widgets", 131, page)).toBeNull();
    expect(await store.listPullRequestFailures(APP_ID, "acme", "widgets", 999, page)).toBeNull();
    // The miss agrees with the head read on every case.
    for (const [repo, number] of [["widgets", 131], ["gadgets", 131], ["sprockets", 131], ["widgets", 999]] as const) {
      expect((await store.listPullRequestFailures(APP_ID, "acme", repo, number, page)) === null).toBe(
        (await store.getPullRequestHead(APP_ID, "acme", repo, number)) === null,
      );
    }
  });

  test("the same number in another repo of the SAME App → null, never a fallback", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(PR);
    await createAppsStore(db).upsertPullRequest({ ...PR, repo: "gadgets", title: "Other repo's #131" });
    // Both rows exist under #131; asking for a repo that has none must miss
    // rather than answer with either of them.
    expect(await createAppsStore(db).getPullRequestHead(APP_ID, "acme", "sprockets", 131)).toBeNull();
    expect((await createAppsStore(db).getPullRequestHead(APP_ID, "acme", "gadgets", 131))?.title).toBe(
      "Other repo's #131",
    );
  });

  test("a PR number that belongs to a sibling App → null", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    seedApp(db, "other-app", 2002);
    await createAppsStore(db).upsertPullRequest({ ...PR, appId: "other-app" });
    expect(await createAppsStore(db).getPullRequestHead(APP_ID, "acme", "widgets", 131)).toBeNull();
  });
});

/** One lifecycle finding row: `original_json` is the detail face's only source. */
function seedFinding(
  db: TestD1,
  finding: { findingId: string; mergeClass: string; title: string; filePath: string; lineStart: number; body: string },
  rowId = "row-1",
  state: "open" | "addressed" | "dismissed" = "open",
  firstSeenRound = 1,
  lastSeenRound = firstSeenRound,
): void {
  // Two findings can share one publication: the first call creates it.
  db.raw
    .prepare(
      `INSERT OR IGNORE INTO review_publications
         (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase, payload_json, created_ms, updated_ms)
       VALUES ('p1', ?, 99, 'acme', 'widgets', 131, 'sha-1', 'review', 'applied', '{}', 1, 1)`,
    )
    .run(APP_ID);
  db.raw
    .prepare(
      `INSERT INTO review_findings
         (id, app_id, installation_id, owner, repo, pr_number, finding_id, original_json,
          first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
          first_seen_round, last_seen_round, state, created_ms, updated_ms)
       VALUES (?, ?, 99, 'acme', 'widgets', 131, ?, ?, 'p1', 'p1', 'sha-1', 'sha-1', ?, ?, ?, 1, 1)`,
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
    );
}

/**
 * Reviewing-now (compass D11/D16): the badge is a LIVE `review_inflight` row
 * for that PR — the pipeline's own `expires_at > now` predicate, evaluated
 * server-side. One case per disposition D11 names, plus both faces and the
 * degraded read. The fixtures are the state each disposition actually leaves
 * in the database, so the disposition→projection mapping is what these pin.
 */
describe("reviewing-now projection (D11/D16)", () => {
  const INSTALLATION_ID = 77;
  const KEY = {
    installation_id: INSTALLATION_ID,
    owner: "acme",
    repo: "widgets",
    pr_number: 131,
    workspace_id: "default",
  };

  /** The App's installation mapping — the same join the failure count reads. */
  function seedInstallation(db: TestD1): void {
    db.raw
      .prepare(
        "INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('i-lock', ?, ?, 'acme', datetime('now'))",
      )
      .run(APP_ID, INSTALLATION_ID);
  }

  /**
   * One `review_inflight` row in the form the pipeline writes it
   * (ISO-8601-with-milliseconds). A negative `expiresInMs` is an expired row;
   * `headSha: ""` is a comment trigger, which carries none.
   */
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

  /** The ledger row + installation mapping every case starts from. */
  async function seedLedger(db: TestD1): Promise<void> {
    seedApp(db);
    seedInstallation(db);
    await createAppsStore(db).upsertPullRequest(PR);
  }

  test("a still-held row is live on both faces, with its head sha and acquisition time", async () => {
    const db = createMigratedTestD1();
    await seedLedger(db);
    const { acquiredAt } = seedLock(db);
    const store = createAppsStore(db);
    const live = { state: "live", head_sha: "sha-live", acquired_at: acquiredAt } as const;

    expect((await store.listPullRequests(APP_ID)).rows[0]!.reviewing).toEqual(live);
    expect((await store.getPullRequestHead(APP_ID, "acme", "widgets", 131))!.reviewing).toEqual(live);
    // Still held: the projection is a point-in-time read, not a release latch.
    expect((await store.listPullRequests(APP_ID)).rows[0]!.reviewing.state).toBe("live");
  });

  test("a comment-triggered attempt carries no head sha but still reads live", async () => {
    const db = createMigratedTestD1();
    await seedLedger(db);
    const { acquiredAt } = seedLock(db, { headSha: "" });
    expect((await createAppsStore(db).listPullRequests(APP_ID)).rows[0]!.reviewing).toEqual({
      state: "live",
      head_sha: "",
      acquired_at: acquiredAt,
    });
  });

  test("the ledger's GitHub spelling still matches the lowercase lock row", async () => {
    const db = createMigratedTestD1();
    await seedLedger(db);
    // `review_inflight` folds owner/repo to lower case; the ledger keeps the
    // delivery's spelling. The projection must join those two, not trust case.
    db.raw
      .prepare("UPDATE pull_requests SET owner = 'Acme', repo = 'Widgets' WHERE app_id = ? AND pr_number = 131")
      .run(APP_ID);
    seedLock(db);
    const rows = (await createAppsStore(db).listPullRequests(APP_ID)).rows;
    expect(rows[0]!.owner).toBe("Acme");
    expect(rows[0]!.reviewing.state).toBe("live");
  });

  // Every disposition that must NOT light the badge. The released pair shares
  // its final state on purpose: a completion release and the give-up path's
  // fenced release both delete the row, and the projection sees one absence.
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
        // The guard refused before any acquire: the attempt survives only as
        // its terminal drop row, and holds no lock.
        db.raw
          .prepare(
            `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
             VALUES ('queued', ?, 'acme', 'widgets', 131, 'sha-1', 'pipeline',
                     'review dropped after 3 refused retries: system-cap (system cap reached)')`,
          )
          .run(INSTALLATION_ID);
      },
    ],
    [
      "superseded before admission",
      async (db) => {
        // Acked before the guard because the ledger already held a newer
        // commit: no lock and no failure row.
        db.raw
          .prepare("UPDATE pull_requests SET head_sha = 'sha-new', head_at = ? WHERE app_id = ? AND pr_number = 131")
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
      const store = createAppsStore(db);
      expect((await store.listPullRequests(APP_ID)).rows[0]!.reviewing).toEqual({ state: "none" });
      expect((await store.getPullRequestHead(APP_ID, "acme", "widgets", 131))!.reviewing).toEqual({
        state: "none",
      });
    });
  }

  test("a failed inflight read is unknown on both faces, never idle", async () => {
    const db = createMigratedTestD1();
    await seedLedger(db);
    seedLock(db);
    // Only the LOCK read faults: the rest of the face still answers, so the
    // failure must degrade that one field instead of failing the payload.
    const failing = {
      prepare(sql: string) {
        if (sql.includes("review_inflight")) throw new Error("D1_ERROR: dead binding");
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
    };
    const store = createAppsStore(failing as never);
    expect((await store.listPullRequests(APP_ID)).rows[0]!.reviewing).toEqual({ state: "unknown" });
    expect((await store.getPullRequestHead(APP_ID, "acme", "widgets", 131))!.reviewing).toEqual({
      state: "unknown",
    });
  });
});
